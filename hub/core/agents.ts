// Agent registry — owns the four-structure invariant (knownAgents,
// agentQueues, agentConnections, staleTimers). All four are SEALED inside this
// module: external callers never see the Maps. Mutation is only possible
// through the methods exposed below, which keeps the four structures in sync
// atomically and makes the CLAUDE.md "never mutate individually" rule a
// structural fact rather than a convention.
//
// Roster changes (add/remove) and connection-count changes (open/close) invoke
// caller-provided callbacks so `hub.ts` can trigger broadcastRoster() /
// broadcastPresence() without circular imports.

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
  // Reads
  get(name: string): Agent | null;
  has(name: string): boolean;
  isPermanent(name: string): boolean;
  values(): IterableIterator<Agent>;
  entries(): IterableIterator<[string, Agent]>;
  connectionCount(name: string): number;

  // Lifecycle
  ensure(name: string, room?: string | null): Agent | null;
  remove(name: string, reason: string): boolean;
  markPermanent(name: string): void;

  // Connection accounting. disconnect() auto-schedules stale removal when the
  // count hits 0 — callers no longer need to remember that bookkeeping.
  connect(name: string): number;
  disconnect(name: string): number;

  // Per-agent queue access — sealed substitutes for `agentQueues.get(...).push(...)`
  // and `agentQueues.get(...).pull(signal)`. enqueueFor returns false when the
  // agent has no queue (already removed); subscribe yields entries until signal
  // aborts or the queue drains (after removal it no longer receives).
  enqueueFor(name: string, entry: Entry): boolean;
  subscribe(name: string, signal: AbortSignal): AsyncGenerator<Entry>;

  // Snapshots
  rosterSnapshot(): Entry;
  presenceSnapshot(): Entry;
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

  function scheduleStaleRemoval(name: string): void {
    if (permanentAgents.has(name)) return;
    cancelStaleTimer(name);
    const t = setTimeout(() => {
      staleTimers.delete(name);
      if ((agentConnections.get(name) ?? 0) > 0) return;
      if (permanentAgents.has(name)) return;
      remove(name, "stale (no connection)");
    }, opts.staleMs);
    staleTimers.set(name, t);
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

  function markPermanent(name: string): void {
    permanentAgents.add(name);
  }

  function connect(name: string): number {
    const next = (agentConnections.get(name) ?? 0) + 1;
    agentConnections.set(name, next);
    cancelStaleTimer(name);
    return next;
  }

  function disconnect(name: string): number {
    const next = Math.max(0, (agentConnections.get(name) ?? 1) - 1);
    agentConnections.set(name, next);
    if (next === 0 && knownAgents.has(name)) scheduleStaleRemoval(name);
    return next;
  }

  function enqueueFor(name: string, entry: Entry): boolean {
    const q = agentQueues.get(name);
    if (!q) return false;
    q.push(entry);
    return true;
  }

  async function* subscribe(name: string, signal: AbortSignal): AsyncGenerator<Entry> {
    // Capture queue ref ONCE — survives map removal so an in-flight pull doesn't
    // get orphaned mid-stream when the agent is stale-cleaned. The SSE handler
    // aborts via `signal` when the connection drops.
    const q = agentQueues.get(name);
    if (!q) return;
    while (!signal.aborted) {
      yield await q.pull(signal);
    }
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
    get: (name) => knownAgents.get(name) ?? null,
    has: (name) => knownAgents.has(name),
    isPermanent: (name) => permanentAgents.has(name),
    values: () => knownAgents.values(),
    entries: () => knownAgents.entries(),
    connectionCount: (name) => agentConnections.get(name) ?? 0,
    ensure,
    remove,
    markPermanent,
    connect,
    disconnect,
    enqueueFor,
    subscribe,
    rosterSnapshot,
    presenceSnapshot,
  };
}
