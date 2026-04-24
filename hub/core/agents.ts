// Agent registry — in-memory roster + per-agent event queues + stale-timer
// lifecycle. Factory-scoped so the state isn't module-level globals; `hub.ts`
// creates one instance at startup and passes it into `HubCapabilities`.
//
// Roster changes (add/remove) and connection-count changes (open/close) invoke
// caller-provided callbacks so `hub.ts` can trigger `broadcastRoster()` /
// `broadcastPresence()` without circular imports.

import { DropQueue } from "./sse";
import { colorFromName, validName } from "./ids";
import type { Agent, Entry } from "./types";

export type AgentRegistryOptions = {
  defaultRoom: string;
  staleMs: number;
  queueMax: number;
  resolveRoom: (raw: string | null | undefined) => string;
  onRosterChange: () => void;
  onPresenceChange: () => void;
};

export type AgentRegistry = {
  // Raw state — exposed so hub.ts can iterate during broadcasts. Mutate only
  // through the methods below.
  knownAgents: Map<string, Agent>;
  agentQueues: Map<string, DropQueue<Entry>>;
  agentConnections: Map<string, number>;
  permanentAgents: Set<string>;

  // Lifecycle
  ensure: (name: string, room?: string | null) => Agent | null;
  remove: (name: string, reason: string) => boolean;
  scheduleStaleRemoval: (name: string) => void;
  cancelStaleTimer: (name: string) => void;
  markPermanent: (name: string) => void;

  // Read snapshots
  rosterSnapshot: () => Entry;
  presenceSnapshot: () => Entry;
};

export function createAgentRegistry(opts: AgentRegistryOptions): AgentRegistry {
  const knownAgents = new Map<string, Agent>();
  const agentQueues = new Map<string, DropQueue<Entry>>();
  const agentConnections = new Map<string, number>();
  const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const permanentAgents = new Set<string>();

  function cancelStaleTimer(name: string): void {
    const t = staleTimers.get(name);
    if (t) {
      clearTimeout(t);
      staleTimers.delete(name);
    }
  }

  function ensure(name: string, room: string | null = opts.defaultRoom): Agent | null {
    if (!validName(name)) return null;
    const existing = knownAgents.get(name);
    if (existing) {
      cancelStaleTimer(name);
      return existing;
    }
    const resolvedRoom = room === null ? null : opts.resolveRoom(room);
    const a: Agent = { name, color: colorFromName(name), room: resolvedRoom };
    knownAgents.set(name, a);
    agentQueues.set(name, new DropQueue<Entry>(opts.queueMax));
    agentConnections.set(name, 0);
    console.log(`[hub] agent joined: ${name} (${a.color}) room=${resolvedRoom ?? "*"}`);
    opts.onRosterChange();
    return a;
  }

  function remove(name: string, reason: string): boolean {
    if (!knownAgents.has(name)) return false;
    cancelStaleTimer(name);
    knownAgents.delete(name);
    agentQueues.delete(name);
    agentConnections.delete(name);
    console.log(`[hub] agent removed: ${name} (${reason})`);
    opts.onRosterChange();
    opts.onPresenceChange();
    return true;
  }

  function scheduleStaleRemoval(name: string): void {
    if (permanentAgents.has(name)) return;  // permanent members never stale-clean
    cancelStaleTimer(name);
    const t = setTimeout(() => {
      staleTimers.delete(name);
      if ((agentConnections.get(name) ?? 0) > 0) return;
      if (permanentAgents.has(name)) return;
      remove(name, "stale (no connection)");
    }, opts.staleMs);
    staleTimers.set(name, t);
  }

  function markPermanent(name: string): void {
    permanentAgents.add(name);
  }

  function rosterSnapshot(): Entry {
    return { type: "roster", agents: [...knownAgents.values()] as unknown as Entry["agents"] };
  }

  function presenceSnapshot(): Entry {
    const map: Record<string, boolean> = {};
    for (const name of knownAgents.keys()) {
      // Permanent members (e.g. human) have no channel-bin → force online whenever the hub is up.
      map[name] = permanentAgents.has(name) ? true : (agentConnections.get(name) ?? 0) > 0;
    }
    return { type: "presence", agents: map };
  }

  return {
    knownAgents,
    agentQueues,
    agentConnections,
    permanentAgents,
    ensure,
    remove,
    scheduleStaleRemoval,
    cancelStaleTimer,
    markPermanent,
    rosterSnapshot,
    presenceSnapshot,
  };
}
