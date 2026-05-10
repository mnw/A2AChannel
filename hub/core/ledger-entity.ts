// ledger-entity.ts — the ONE Module Kind code learns. External seam.
//
// Composes the load → decide → transact → emit lifecycle. Owns the database
// reference (closure) and the internal Store collaborator (closure). Kind code
// receives only the LedgerEntity surface defined in hub/core/types.ts:
//
//   - migrate(db)              — DDL via internal Store
//   - load(id)                 — primary-key lookup
//   - listByStatus(filter)     — single-query SELECT (no N+1; see store.ts)
//   - apply(...)               — common case: 5-line verbs
//   - applyWithSideEffect(...) — rare case: cross-table writes inside the same tx
//
// The Store reference is captured here and NEVER re-exposed (no `entity.store`
// getter, no `entity.unsafeStore` escape). Tests that need direct Store access
// hold their own reference before calling createLedgerEntity({ decl, db, store }).
//
// Idempotency policy (same-status-retry, first-verdict-wins, etc.) lives entirely
// inside each verb's `decide(prior, payload, actor, cap): Decision` callback —
// LedgerEntity itself carries no policy enum; it just dispatches on the Decision
// arms (idempotent | conflict | create | transition). See ADR-0004.

import type { Database } from "bun:sqlite";
import type {
  Snapshot,
  StateMachineDecl,
  VerbDecl,
  LedgerEntity,
  HubCapabilities,
  SideEffectCtx,
} from "./types";
import { LedgerConflict } from "./types";
import { createSqliteStore, type Store } from "./store";

/** Translate a thrown LedgerConflict into the standard HTTP response shape used by all Kind routes. */
export function ledgerConflictResponse(e: LedgerConflict): Response {
  const body: Record<string, unknown> = { error: e.message };
  if (e.snapshot) body.snapshot = e.snapshot;
  return Response.json(body, { status: e.httpStatus });
}

/**
 * Wrap a Kind's RouteDef[] so every route is auto-flagged `requiresLedger: true`.
 * Used by createXKind factories so authors don't have to set the flag per route.
 */
export function withLedgerRequired(routes: import("./types").RouteDef[]): import("./types").RouteDef[] {
  return routes.map((r) => ({ ...r, requiresLedger: true }));
}

export type CreateLedgerEntityOpts<S extends Snapshot> = {
  decl: StateMachineDecl<S>;
  db: Database;
  /** Override the default SQLite-backed Store. Used by tests with createInMemoryStore(). */
  store?: Store<S>;
};

export function createLedgerEntity<S extends Snapshot>(
  opts: CreateLedgerEntityOpts<S>,
): LedgerEntity<S> {
  const { decl, db } = opts;
  const store: Store<S> = opts.store ?? createSqliteStore(decl);

  function dispatch<P, R>(
    id: string,
    verb: VerbDecl<S, P>,
    payload: P,
    actor: string,
    cap: HubCapabilities,
    sideEffect?: (ctx: SideEffectCtx<S>) => R,
  ): { snapshot: S; version: number; emitted: boolean; sideEffectResult: R | null } {
    if (verb.validate) {
      const v = verb.validate(payload, cap);
      if (v) {
        return finalizeNonTransition(v, store.load(db, id));
      }
    }
    const prior = store.load(db, id);
    const decision = verb.decide(prior, payload, actor, cap);

    if (decision.kind === "idempotent") {
      if (!prior) {
        throw new Error(
          `${decl.kind} verb returned idempotent for missing id ${id}; verbs must check prior !== null first`,
        );
      }
      return { snapshot: prior, version: prior.version, emitted: false, sideEffectResult: null };
    }

    if (decision.kind === "conflict") {
      throw new LedgerConflict(decision.httpStatus, decision.message, prior);
    }

    const at = Date.now();

    if (decision.kind === "create") {
      const result = store.create(db, {
        initial: decision.initial,
        eventKind: decision.eventKind,
        actor,
        at,
        payload: decision.payload,
        sideEffect: sideEffect as ((ctx: SideEffectCtx<S>) => unknown) | undefined,
      });
      const entry = decision.entry(result.snapshot);
      cap.sse.emit(entry, verb.scope(result.snapshot));
      return {
        snapshot: result.snapshot,
        version: result.snapshot.version,
        emitted: true,
        sideEffectResult: result.sideEffectResult as R | null,
      };
    }

    // decision.kind === "transition"
    const result = store.transact(db, {
      id,
      next: decision.next,
      eventKind: decision.eventKind,
      actor,
      at,
      payload: decision.payload,
      sideEffect: sideEffect as ((ctx: SideEffectCtx<S>) => unknown) | undefined,
    });
    const entry = decision.entry(result.snapshot);
    cap.sse.emit(entry, verb.scope(result.snapshot));
    return {
      snapshot: result.snapshot,
      version: result.snapshot.version,
      emitted: true,
      sideEffectResult: result.sideEffectResult as R | null,
    };
  }

  function finalizeNonTransition<R>(
    decision: ReturnType<NonNullable<VerbDecl<S, never>["validate"]>>,
    prior: S | null,
  ): { snapshot: S; version: number; emitted: boolean; sideEffectResult: R | null } {
    if (!decision) {
      throw new Error(`${decl.kind}: validate returned a non-decision`);
    }
    if (decision.kind === "idempotent") {
      if (!prior) {
        throw new Error(
          `${decl.kind} validate returned idempotent for missing id; verbs must check prior !== null first`,
        );
      }
      return { snapshot: prior, version: prior.version, emitted: false, sideEffectResult: null };
    }
    if (decision.kind === "conflict") {
      throw new LedgerConflict(decision.httpStatus, decision.message, prior);
    }
    throw new Error(
      `${decl.kind}: validate must return idempotent or conflict; create/transition only allowed from decide`,
    );
  }

  return {
    migrate(targetDb: Database) {
      // Tolerate being called with a different db reference at startup (e.g. when migrate runs
      // before the entity is fully wired). Default to the constructor-time db otherwise.
      store.migrate(targetDb ?? db);
    },

    load(id) {
      return store.load(db, id);
    },

    listByStatus(filter) {
      return store.listByStatus(db, filter);
    },

    apply(id, verb, payload, actor, cap) {
      const r = dispatch(id, verb, payload, actor, cap);
      return { snapshot: r.snapshot, version: r.version, emitted: r.emitted };
    },

    applyWithSideEffect(id, verb, payload, actor, cap, sideEffect) {
      return dispatch(id, verb, payload, actor, cap, sideEffect);
    },
  };
}
