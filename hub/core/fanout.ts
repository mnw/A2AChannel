// Single owner of every SSE broadcast path: chatLog + transcript + UI + per-Agent queues per Scope.

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

  function persist(entry: Entry): void {
    entry.id = nextEntryId();
    if (chatLog.length >= historyLimit) chatLog.shift();
    chatLog.push(entry);
    persistTranscript(entry);
  }

  // Canonical <private>-redaction call site. Skips when ledger off, no room, or room not opt-in.
  function persistTranscript(entry: Entry): void {
    if (!ledgerDb) return;
    const room = typeof entry.room === "string" && entry.room ? entry.room : null;
    if (!room) return;
    const settings = getRoomSettings(ledgerDb, room);
    if (!settings?.persist_transcript) return;
    try {
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
