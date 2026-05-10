// Fanout — single owner of every SSE broadcast path. Carved from hub.ts in
// architecture-cycle-2a §5.
//
// Responsibilities (all in one place per CLAUDE.md hard rule):
//   1. Assign monotonic `entry.id` (mutates the entry).
//   2. Append to in-memory chatLog ring (evict oldest at HISTORY_LIMIT).
//   3. Write-through to opt-in JSONL transcript — `redactPrivate` called HERE,
//      not in `transcript.appendEntry`, so live agents/UI see unredacted text
//      and only disk gets the stripped version.
//   4. UI fan-out (uiSubscribers).
//   5. Per-Agent queue fan-out scoped per the Scope enum. Permanent agents
//      (human) are skipped — they read via /stream.
//
// Scope enum (extends the original four with two ambient variants):
//   - { kind: "broadcast" }                    — UI + every non-permanent agent; persisted to chatLog
//   - { kind: "to-agents", agents: [...] }     — UI + named agents; persisted
//   - { kind: "ui-only" }                      — UI only; persisted to chatLog
//   - { kind: "room", room }                   — UI + same-room agents; persisted
//   - { kind: "ui-only-ambient" }              — UI only; NO chatLog, NO transcript (presence/roster)
//   - { kind: "room-ambient", room }           — UI + same-room agents; NO chatLog, NO transcript (nutshell)

import type { Database } from "bun:sqlite";
import type { Entry, Scope } from "./types";
import type { AgentRegistry } from "./agents";
import type { DropQueue } from "./sse";
import { getRoomSettings } from "./ledger";
import * as transcriptStore from "./transcript";
import { redactPrivate } from "./redaction";

export type FanoutDeps = {
  chatLog: Entry[];
  uiSubscribers: Set<DropQueue<Entry>>;
  agents: AgentRegistry;
  historyLimit: number;
  ledgerDb: Database | null;
  /** Bumped on every persisted entry; passed by reference via the closure. */
  nextEntryId: () => number;
};

export type Fanout = {
  send(entry: Entry, scope: Scope): void;
};

function isAmbientScope(scope: Scope): boolean {
  return scope.kind === "ui-only-ambient" || scope.kind === "room-ambient";
}

export function createFanout(deps: FanoutDeps): Fanout {
  const { chatLog, uiSubscribers, agents, historyLimit, ledgerDb, nextEntryId } = deps;

  /** chatLog push + transcript write-through. Only for non-ambient scopes. */
  function persist(entry: Entry): void {
    entry.id = nextEntryId();
    if (chatLog.length >= historyLimit) chatLog.shift();
    chatLog.push(entry);
    persistTranscript(entry);
  }

  /** Write-through to opt-in JSONL transcript with `<private>` stripped. No-op if room
   *  isn't opt-in or has no concrete room label (super-user broadcast from human). */
  function persistTranscript(entry: Entry): void {
    if (!ledgerDb) return;
    const room = typeof entry.room === "string" && entry.room ? entry.room : null;
    if (!room) return;
    const settings = getRoomSettings(ledgerDb, room);
    if (!settings?.persist_transcript) return;
    try {
      // Redact <private>...</private> here (not inside transcript.appendEntry) so the
      // canonical redaction call site is one place. The transcript layer is now a thin
      // file appender; live agents + UI subscribers got the unredacted entry already
      // (or will get it via the UI broadcast below — order is: persist → fan-out, but
      // the entries the live consumers see are the ORIGINAL, not the redacted version).
      transcriptStore.appendEntry(room, redactPrivate(entry));
    } catch (e) {
      console.error(`[transcript] append failed for ${room}:`, e);
    }
  }

  function pushToAgent(name: string, entry: Entry): void {
    if (agents.isPermanent(name)) return;
    agents.enqueueFor(name, entry);
  }

  function fanOutToAgents(entry: Entry, scope: Scope): void {
    switch (scope.kind) {
      case "ui-only":
      case "ui-only-ambient":
        return;
      case "broadcast":
        for (const [name] of agents.entries()) pushToAgent(name, entry);
        return;
      case "to-agents":
        for (const name of new Set(scope.agents)) pushToAgent(name, entry);
        return;
      case "room":
      case "room-ambient":
        for (const [name, agent] of agents.entries()) {
          if (agent.room !== scope.room) continue;
          pushToAgent(name, entry);
        }
        return;
    }
  }

  function send(entry: Entry, scope: Scope): void {
    if (!isAmbientScope(scope)) {
      persist(entry);
    }
    for (const q of uiSubscribers) q.push(entry);
    fanOutToAgents(entry, scope);
  }

  return { send };
}
