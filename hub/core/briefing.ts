// briefing.ts — Briefing assembly for new-agent reconnect (Concern B).
//
// Replaces the inline buildBriefing() in hub.ts. Composes layers:
//   1. Nutshell (existing — hand-curated)
//   2. L2 rollups (Phase 3 — auto, deepest history compressed)
//   3. Unrolled L1 entries (Phase 3 — auto, recent granular)
//   4. Peers + tool list + dirs (existing infrastructure)
//
// Lazy-hydrate trigger and maybeBackfill are NOT inside this module — the
// Briefing path stays read-only. hub.ts kicks them off fire-and-forget AFTER
// Briefing is sent (Concern F).

import type { Database } from "bun:sqlite";

import type { AgentRegistry } from "./agents";
import type { KindModule } from "./types";
import type { RoomSummariser, SummaryRow } from "./room-summariser";
import { readNutshell } from "../nutshell";
import { ts } from "./ids";

export type BriefingPayload = {
  type: "briefing";
  ts: string;
  room: string | null;
  tools: string[];
  peers: Array<{ name: string; online: boolean; room: string | null }>;
  attachments_dir: string;
  human_name: string;
  nutshell: string | null;
  // Phase 3 layers — null when summariser is disabled.
  room_summary: {
    rollups: Array<{ start_line: number; end_line: number; model: string; summary: string }>;
    recent_blocks: Array<{ start_line: number; end_line: number; model: string; summary: string }>;
  } | null;
};

export type BriefingBuilderOptions = {
  agents: AgentRegistry;
  kinds: readonly KindModule[];
  ledgerDb: Database | null;
  ledgerEnabled: boolean;
  roomSummariser: RoomSummariser | null;
  defaultRoom: string;
  attachmentsDir: string;
  humanName: string;
};

export type BriefingBuilder = {
  build(agent: string): BriefingPayload;
};

export function createBriefingBuilder(opts: BriefingBuilderOptions): BriefingBuilder {
  function build(agent: string): BriefingPayload {
    const me = opts.agents.get(agent);
    const myRoom = me?.room ?? opts.defaultRoom;

    const peers: Array<{ name: string; online: boolean; room: string | null }> = [];
    for (const [name, a] of opts.agents.entries()) {
      if (name === agent) continue;
      // Same-room peers + cross-room permanent members (human = room null).
      if (a.room !== null && a.room !== myRoom) continue;
      peers.push({
        name,
        online: opts.agents.isPermanent(name) ? true : opts.agents.connectionCount(name) > 0,
        room: a.room,
      });
    }

    const nutshell = opts.ledgerEnabled ? readNutshell(opts.ledgerDb, myRoom).text : "";

    let room_summary: BriefingPayload["room_summary"] = null;
    if (opts.roomSummariser && myRoom) {
      const rollups = opts.roomSummariser.listL2(myRoom).map(toBriefingRow);
      const recent_blocks = opts.roomSummariser.listUnrolledL1(myRoom).map(toBriefingRow);
      if (rollups.length > 0 || recent_blocks.length > 0) {
        room_summary = { rollups, recent_blocks };
      }
    }

    return {
      type: "briefing",
      ts: ts(),
      room: myRoom,
      tools: ["post", "post_file", ...opts.kinds.flatMap((k) => k.toolNames)],
      peers,
      attachments_dir: opts.attachmentsDir,
      human_name: opts.humanName,
      nutshell: nutshell || null,
      room_summary,
    };
  }

  return { build };
}

function toBriefingRow(
  r: SummaryRow,
): { start_line: number; end_line: number; model: string; summary: string } {
  return {
    start_line: r.start_line,
    end_line: r.end_line,
    model: r.model,
    summary: r.summary,
  };
}

// Lightweight signature for briefing dedup (carries layer counts so signature
// changes when summary state advances, even if peer/nutshell stayed the same).
export function briefingSignature(b: BriefingPayload): string {
  const peers = b.peers
    .map((p) => `${p.name}:${p.online ? 1 : 0}:${p.room ?? ""}`)
    .sort()
    .join(",");
  const summary = b.room_summary
    ? `r=${b.room_summary.rollups.length},u=${b.room_summary.recent_blocks.length}`
    : "off";
  return `${b.room ?? ""}|${peers}|${b.nutshell ?? ""}|${summary}`;
}
