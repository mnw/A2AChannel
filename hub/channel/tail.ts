// Tails the hub's /agent-stream SSE endpoint and forwards every event into
// claude's context as a `notifications/claude/channel` notification. Recovers
// from hub restarts by re-reading discovery files on each retry.
//
// Also acts as a room-gate: events carrying a cross-room `room` attribute are
// dropped with a log (mirrors the upstream "Gate inbound messages" pattern
// from the channels-reference — defense in depth against hub routing bugs).

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveHub, URL_PATH, TOKEN_PATH } from "./hub-client";

const BUF_MAX = 1 << 20;

export type TailContext = {
  mcp: Server;
  agent: string;
  room: string;
  hubEnv: string;
};

type ChannelEvent = {
  type?: string;
  from?: string;
  to?: string;
  text?: string;
  ts?: string;
  room?: string | null;
  kind?: string;
  handoff_id?: string;
  interrupt_id?: string;
  permission_id?: string;
  version?: number;
  expires_at_ms?: number;
  status?: string;
  replay?: boolean;
  snapshot?: {
    id?: string;
    behavior?: "allow" | "deny" | null;
    status?: string;
  };
  tools?: string[];
  peers?: Array<{ name: string; online: boolean; room?: string | null }>;
  attachments_dir?: string;
  human_name?: string;
  nutshell?: string | null;
};

async function handleEvent(ctx: TailContext, evt: ChannelEvent): Promise<void> {
  const { mcp, agent, room } = ctx;

  // Defense-in-depth room gate — drop cross-room events even if the hub made a
  // routing mistake. evt.room==null means system/global (presence/roster/human
  // chatter without room context) — let through.
  if (evt.room !== undefined && evt.room !== null && evt.room !== room) {
    console.error(
      `[channel] dropped cross-room event: mine=${room} theirs=${evt.room} kind=${evt.kind ?? evt.type ?? "?"}`,
    );
    return;
  }

  // Briefings ship as regular chat notifications with a recognizable prose
  // prefix — Claude Code's channel client silently drops unknown `type`s.
  if (evt.type === "briefing") {
    const parts: string[] = [
      `[A2AChannel briefing] You are "${agent}" in room "${room}".`,
    ];
    if (evt.human_name) parts.push(`The human's name is "${evt.human_name}".`);
    if (evt.peers?.length) {
      const onlinePeers = evt.peers.filter((p) => p.online).map((p) => p.name);
      const offlinePeers = evt.peers.filter((p) => !p.online).map((p) => p.name);
      if (onlinePeers.length) parts.push(`Online peers in your room: ${onlinePeers.join(", ")}.`);
      if (offlinePeers.length) parts.push(`Known but offline peers: ${offlinePeers.join(", ")}.`);
    }
    if (evt.tools?.length) {
      parts.push(`Available chatbridge tools: ${evt.tools.join(", ")}.`);
    }
    if (evt.attachments_dir) {
      parts.push(
        `Attachments dir: ${evt.attachments_dir}. Incoming files arrive as [attachment: <path>] suffixes you can Read directly.`,
      );
    }
    if (evt.nutshell && evt.nutshell.trim()) {
      parts.push(`Current project summary (nutshell for room "${room}"):\n${evt.nutshell.trim()}`);
    }
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: parts.join("\n\n"),
        meta: { from: "system", to: agent, ts: evt.ts ?? "", room },
      },
    });
    return;
  }

  if (evt.type === "nutshell.updated") {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `[A2AChannel nutshell update]\n${evt.text ?? ""}`,
        meta: { from: "system", to: agent, ts: evt.ts ?? "" },
      },
    });
    return;
  }

  const meta: Record<string, string> = {
    from: evt.from ?? "",
    to: evt.to ?? "",
    ts: evt.ts ?? "",
    // Always surface room so claude's reasoning can trust the <channel room=...> attr.
    room: (evt.room ?? room) as string,
  };
  if (evt.kind) {
    meta.kind = evt.kind;
    if (evt.handoff_id) meta.handoff_id = evt.handoff_id;
    if (evt.interrupt_id) meta.interrupt_id = evt.interrupt_id;
    if (evt.permission_id) meta.permission_id = evt.permission_id;
    if (evt.version !== undefined) meta.version = String(evt.version);
    if (evt.expires_at_ms !== undefined) meta.expires_at_ms = String(evt.expires_at_ms);
    if (evt.status) meta.status = evt.status;
    // Reconnect catch-ups are marked `catchup="1"` rather than `replay="true"`.
    // The real F9 fix is the cold-start delay in channel.ts (frames sent
    // before Claude is warm get swallowed); the rename is defense in depth
    // since `replay` is an undocumented key whose handling inside Claude Code
    // is opaque. `catchup` is namespaced to A2AChannel and won't collide.
    if (evt.replay === true) meta.catchup = "1";
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: evt.text ?? "",
      meta,
    },
  });

  // Relay permission verdicts back upstream so claude's local dialog closes.
  // Claude dedupes by request_id, so re-emitting after a local-first answer is safe.
  if (evt.kind === "permission.resolved" && evt.permission_id) {
    const behavior = evt.snapshot?.behavior;
    if (behavior === "allow" || behavior === "deny") {
      try {
        await mcp.notification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: evt.permission_id,
            behavior,
          },
        });
      } catch (e) {
        console.error("[channel] permission verdict upstream failed:", e);
      }
    }
  }
}

export async function tailHub(ctx: TailContext): Promise<void> {
  const { agent, room, hubEnv } = ctx;
  let loggedMissingOnce = false;

  while (true) {
    const hub = resolveHub(hubEnv);
    if (!hub) {
      if (!loggedMissingOnce) {
        console.error(
          `[channel] hub not found; waiting for A2AChannel.app to start (expects ${URL_PATH} and ${TOKEN_PATH})`,
        );
        loggedMissingOnce = true;
      }
      await new Promise((s) => setTimeout(s, 2000));
      continue;
    }
    loggedMissingOnce = false;

    try {
      // Use ?token= for symmetry with the UI (EventSource can't send headers).
      const url =
        `${hub.url}/agent-stream` +
        `?agent=${encodeURIComponent(agent)}` +
        `&room=${encodeURIComponent(room)}` +
        `&token=${encodeURIComponent(hub.token)}`;
      const r = await fetch(url);
      if (!r.ok || !r.body) {
        // On 401 the next iteration re-reads the discovery file and picks up the rotated token.
        await new Promise((s) => setTimeout(s, 2000));
        continue;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.length > BUF_MAX) buf = buf.slice(-BUF_MAX);
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let evt: ChannelEvent;
          try {
            evt = JSON.parse(dataLine.slice(6));
          } catch (e) {
            console.error("[channel] SSE JSON parse failed:", e);
            continue;
          }
          try {
            await handleEvent(ctx, evt);
          } catch (e) {
            console.error("[channel] notification failed:", e);
          }
        }
      }
    } catch (e) {
      console.error("[channel] tail error:", (e as Error).message ?? e);
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
}
