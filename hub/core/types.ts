// types.ts — KindModule runtime contract + LedgerEntity types + DI surface for persistent state-machine kinds.

import type { Database } from "bun:sqlite";

// ---------- LedgerEntity / Kind orchestration types (architecture-cycle-2a) ----------
//
// Contract surfaces Kind authors learn:
//   - StateMachineDecl<S>  — Kind's table + columns + terminal-status set
//   - VerbDecl<S, P>       — one verb's decide callback + scope resolver
//   - Decision<S>          — discriminated union returned by decide; idempotency policy lives here
//   - LedgerEntity<S>      — the one Module Kind code uses for storage + orchestration
//   - SideEffectCtx<S>     — passed to applyWithSideEffect's sideEffect callback
//   - TxHandle             — transaction-scoped DB handle (no new tx, no Store reads)
//   - LedgerConflict       — thrown by apply when decide returns the conflict arm
//
// Internal `Store<S>` collaborator lives in hub/core/store.ts and is NOT exported from this file.

export type Snapshot = {
  id: string;
  status: string;
  version: number; // = events.seq of the last transition
};

export type ColumnType = "TEXT" | "INTEGER" | "JSON" | "TEXT_NULL" | "INTEGER_NULL";

export type StateMachineDecl<S extends Snapshot> = {
  /** Type tag, e.g. "handoff" — used as event-kind prefix. */
  kind: string;
  /** Derived-table name. */
  table: string;
  /** Column spec; the order is the table's column order. `id` and `version` are handled by the Store. */
  columns: Record<string, ColumnType>;
  /** Terminal statuses — `decide` typically maps any of these to idempotent or conflict. */
  terminalStatuses: ReadonlySet<string>;
  /** Optional column to filter listByStatus by `for=<actor>`. */
  forColumn?: string;
  /** Maps a SQLite row (raw) to the kind's typed Snapshot. */
  rowToSnapshot: (row: Record<string, unknown>) => S;
  /** Maps a Snapshot (or Partial<S>) to a row dict for INSERT/UPDATE. */
  snapshotToRow: (snap: Partial<S>) => Record<string, unknown>;
};

export type Decision<S extends Snapshot> =
  | { kind: "idempotent" }
  | { kind: "conflict"; httpStatus: number; message: string }
  | {
      kind: "create";
      initial: S;
      eventKind: string;
      payload: (post: S) => Record<string, unknown>;
      entry: (post: S) => Entry;
    }
  | {
      kind: "transition";
      next: Partial<S>;
      eventKind: string;
      payload: (post: S) => Record<string, unknown>;
      entry: (post: S) => Entry;
    };

export type VerbDecl<S extends Snapshot, P> = {
  /** Pre-load validation; return Decision to short-circuit, or null to proceed to decide. */
  validate?(payload: P, cap: HubCapabilities): Decision<S> | null;
  /** Core decision against the loaded prior. Pure — no I/O. */
  decide(prior: S | null, payload: P, actor: string, cap: HubCapabilities): Decision<S>;
  /** Broadcast scope resolver — receives the post-transition snapshot. */
  scope(post: S): Scope;
};

/** Transaction-scoped DB handle exposed inside SideEffectCtx. Cannot open new transactions. */
export type TxHandle = {
  run(sql: string, params?: unknown[]): void;
  query<R = unknown>(sql: string, params?: unknown[]): R[];
};

export type SideEffectCtx<S extends Snapshot> = {
  prior: S;
  next: S;
  seq: number;
  tx: TxHandle;
};

export type AdditionalEmit = { entry: Entry; scope: Scope };

export class LedgerConflict extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly snapshot: Snapshot | null,
  ) {
    super(message);
  }
}

export type LedgerEntity<S extends Snapshot> = {
  /** One-shot DDL via the internal Store. Idempotent. */
  migrate(db: Database): void;
  /** Read-only snapshot lookup. */
  load(id: string): S | null;
  /** Single-query SELECT against the (status, for_col) index; no per-row subquery. */
  listByStatus(filter: { status: string; for?: string; room?: string; limit?: number }): S[];
  /** Common case: load → decide → transact → emit. Throws LedgerConflict on conflict arm. */
  apply<P>(
    id: string,
    verb: VerbDecl<S, P>,
    payload: P,
    actor: string,
    cap: HubCapabilities,
  ): { snapshot: S; version: number; emitted: boolean };
  /** Rare case: cross-table writes inside the same transaction (today: handoff `accept` → nutshell). */
  applyWithSideEffect<P, R>(
    id: string,
    verb: VerbDecl<S, P>,
    payload: P,
    actor: string,
    cap: HubCapabilities,
    sideEffect: (ctx: SideEffectCtx<S>) => R,
  ): { snapshot: S; version: number; emitted: boolean; sideEffectResult: R | null };
};

// ---------- Existing types (Agent, Entry, Scope, RouteDef, HubCapabilities, KindModule) ----------

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
  | { kind: "broadcast" }                    // UI + all non-permanent agents; persisted to chatLog
  | { kind: "to-agents"; agents: string[] }  // UI + specific agents; persisted
  | { kind: "ui-only" }                      // UI subscribers only; persisted
  | { kind: "room"; room: string }           // UI + same-room agents; persisted
  | { kind: "ui-only-ambient" }              // UI only; NO chatLog, NO transcript (presence/roster)
  | { kind: "room-ambient"; room: string };  // UI + same-room agents; NO chatLog, NO transcript (nutshell)

export type RouteDef = {
  method: "GET" | "POST" | "PUT";
  path: string | RegExp;
  auth: "mutating" | "read";
  bodyMax?: number;
  /**
   * If true, dispatcher returns 503 when ledger is disabled. Default: false (in-memory
   * routes like /agents, /presence, /upload, /image work without a ledger). Kind routes
   * are auto-flagged true by the createXKind factory wrapper.
   */
  requiresLedger?: boolean;
  handler(
    req: Request,
    cap: HubCapabilities,
    params: Record<string, string>,
  ): Promise<Response> | Response;
};

/**
 * Parent contract: every Hub HTTP route lives inside a HubFeature module under
 * `hub/features/`. The dispatcher consumes `HubFeature[]`. Kinds are the persistent-
 * state-machine subset of HubFeature (extending it with `entity`, `pendingFor`,
 * `toolNames`, `priority?`). See ADR-0005.
 *
 * SSE long-lived handlers (`/stream`, `/agent-stream`) do NOT use this shape — they
 * register directly with Bun.serve via a separate `StreamHandlers` shape (see Decision
 * 3 in design.md).
 */
export type HubFeature = {
  routes: RouteDef[];
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
  };
  auth: {
    requireAuth(req: Request): Response | null;
    requireReadAuth(req: Request, url: URL): Response | null;
    requireJsonBody(req: Request, max?: number): Response | null;
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

/**
 * KindModule = HubFeature & {kind-specific fields}. Per ADR-0005, every Kind IS a
 * HubFeature (contributes routes to the dispatcher) and adds the persistent-state-
 * machine bits on top: a `kind` prefix for SSE event names, a `migrate(db)` hook,
 * `pendingFor()` for /agent-stream replay, `toolNames` for briefing aggregation, an
 * optional `priority?` replay hint, and an optional `dispose?` shutdown hook.
 *
 * `routes: RouteDef[]` is inherited from `HubFeature`. The Kind's `LedgerEntity`
 * lives privately inside the Kind's factory closure — KindModule does NOT surface
 * it (variance: LedgerEntity<S> is invariant in S and can't widen to
 * LedgerEntity<Snapshot> across heterogeneous KINDS arrays).
 */
export type KindModule = HubFeature & {
  kind: string;
  migrate(db: Database): void;
  pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[];
  toolNames: string[];
  priority?: number;
  dispose?: () => void;
};
