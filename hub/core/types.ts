// types.ts — KindModule runtime contract + DI surface for persistent state-machine kinds.

import type { Database } from "bun:sqlite";

export type Agent = {
  name: string;
  color: string;
  room: string | null;  // null = human (super-user; visible in every room)
};

// Projection passed to kind hooks.
export type AgentCtx = {
  name: string;
  room: string | null;
  permanent: boolean;
};

// Mirrors what's broadcast on /stream and /agent-stream; kinds layer their fields on top.
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
  [extra: string]: unknown;
};

export type Scope =
  | { kind: "broadcast" }                    // UI + all non-permanent agents
  | { kind: "to-agents"; agents: string[] }  // UI + specific agents
  | { kind: "ui-only" }                      // UI subscribers only
  | { kind: "room"; room: string };          // same-room agents + human

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

// Sole access path kinds have to shared hub services.
export type HubCapabilities = {
  db: Database;
  agents: {
    get(name: string): AgentCtx | null;
    isPermanent(name: string): boolean;
    all(): AgentCtx[];
    // `room` defaults to DEFAULT_ROOM; pass null for permanent member (human).
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

export type KindModule = {
  // Prefix for SSE event kinds (e.g. "handoff" → "handoff.new").
  kind: string;

  // Idempotent; invoked once at hub startup.
  migrate(db: Database): void;

  routes: RouteDef[];

  // Replay entries on reconnect; kinds must set replay: true themselves.
  pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[];

  // Briefing aggregates across kinds.
  toolNames: string[];

  // Sort-ascending hint for replay; kinds MUST NOT depend on cross-kind ordering.
  priority?: number;

  // Cleanup hook for background timers; orchestrator calls on shutdown.
  dispose?: () => void;
};
