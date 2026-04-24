// The KindModule runtime contract and the dependency-injection surface kinds
// consume. Defined here so every module (hub.ts, hub/kinds/*.ts, tests) imports
// from one place.
//
// Narrow by design: kinds formalize persistent state-machine entities backed by
// the event ledger. Ephemeral broadcasts (presence/typing), single-row documents
// (nutshell), and config/rules do NOT use this contract — see design.md §1 / §8.

import type { Database } from "bun:sqlite";

// --------------------------------------------------------------------------
// Shared entities
// --------------------------------------------------------------------------

export type Agent = {
  name: string;
  color: string;
  room: string | null;  // null = human (super-user; visible in every room)
};

// Snapshot of an agent at a point in time, passed to kind hooks. A projection
// of the Agent record plus any flags a kind might care about.
export type AgentCtx = {
  name: string;
  room: string | null;
  permanent: boolean;   // true for human
};

// The Entry shape mirrors what's broadcast on /stream and /agent-stream today.
// Kinds build Entry objects with kind-specific fields layered on (handoff_id,
// interrupt_id, permission_id, etc.) — the Entry type below is the common core.
export type Entry = {
  id?: number;
  from?: string;
  to?: string;
  text?: string;
  ts?: string;
  image?: string | null;
  type?: string;
  kind?: string;
  version?: number;
  replay?: boolean;
  room?: string | null;
  // Kind-specific payload fields land as additional properties on Entry objects;
  // keep the type open at this layer.
  [extra: string]: unknown;
};

// --------------------------------------------------------------------------
// SSE broadcast scope
// --------------------------------------------------------------------------

export type Scope =
  | { kind: "broadcast" }                    // UI + all non-permanent agents
  | { kind: "to-agents"; agents: string[] }  // UI + specific agents
  | { kind: "ui-only" }                      // UI subscribers only
  | { kind: "room"; room: string };          // v0.9 rooms: same-room agents + human

// --------------------------------------------------------------------------
// HTTP route declaration
// --------------------------------------------------------------------------

export type RouteDef = {
  method: "GET" | "POST";
  path: string | RegExp;
  auth: "mutating" | "read";
  bodyMax?: number;
  handler(
    req: Request,
    cap: HubCapabilities,
    params: Record<string, string>,
  ): Promise<Response> | Response;
};

// --------------------------------------------------------------------------
// Hub capabilities — the sole access path kinds have to shared hub services.
// Each hook receives only what it needs:
//   - migrate(db)                         → DB only
//   - handler(req, cap, params)           → full cap
//   - pendingFor(agent, cap)              → DB + SSE accessors
// --------------------------------------------------------------------------

export type HubCapabilities = {
  db: Database;
  agents: {
    get(name: string): AgentCtx | null;
    isPermanent(name: string): boolean;
    all(): AgentCtx[];
    // Auto-register an agent if not already in the roster. `room` defaults to
    // the hub's DEFAULT_ROOM; pass null to register a permanent member (human).
    ensure(name: string, room?: string | null): AgentCtx | null;
  };
  sse: {
    emit(entry: Entry, scope: Scope): void;
    emitWhere(entry: Entry, predicate: (ctx: AgentCtx) => boolean): void;
  };
  auth: {
    requireAuth(req: Request): Response | null;
    requireReadAuth(req: Request, url: URL): Response | null;
    requireJsonBody(req: Request, max?: number): Response | null;
  };
  ids: {
    mint(prefix: string, bytes?: number): string;
  };
  events: {
    insert(
      db: Database,
      entity_id: string,
      kind: string,
      actor: string,
      payload: unknown,
      at_ms: number,
    ): number;
  };
  config: {
    humanName: string;
    attachmentsDir: string;
    defaultRoom: string;
  };
};

// --------------------------------------------------------------------------
// KindModule — the integration contract
// --------------------------------------------------------------------------

export type KindModule = {
  // Unique kind identifier. Becomes the prefix for SSE event kinds
  // (e.g. "handoff" → "handoff.new", "handoff.update").
  kind: string;

  // Idempotent schema migration invoked once at hub startup.
  migrate(db: Database): void;

  // Static HTTP route declarations. Orchestrator iterates these at startup.
  routes: RouteDef[];

  // Reconnect-replay: entries to emit to a reconnecting agent. Kinds set
  // replay: true on each returned Entry (the orchestrator does not remark them).
  pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[];

  // MCP tool names this kind exposes. Briefing aggregates across kinds.
  toolNames: string[];

  // Optional replay-ordering hint. Undefined = 0. Orchestrator sorts ascending
  // before iterating. Kinds MUST NOT depend on cross-kind ordering for
  // correctness; this is an escape hatch for rare cases (design.md §6).
  priority?: number;

  // Optional background-work disposer. Kinds that run timers (e.g. handoff
  // expire sweep) register cleanup here; orchestrator calls on shutdown.
  dispose?: () => void;
};
