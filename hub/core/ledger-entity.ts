// External seam: load → decide → transact → emit. Wraps internal Store closure. See ADR-0004.

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

// Standard HTTP response shape for LedgerConflict, used by every Kind route.
export function ledgerConflictResponse(e: LedgerConflict): Response {
  const body: Record<string, unknown> = { error: e.message };
  if (e.snapshot) body.snapshot = e.snapshot;
  return Response.json(body, { status: e.httpStatus });
}

// Auto-flag every route as requiresLedger so per-Kind factories don't have to.
export function withLedgerRequired(routes: import("./types").RouteDef[]): import("./types").RouteDef[] {
  return routes.map((r) => ({ ...r, requiresLedger: true }));
}

export type CreateLedgerEntityOpts<S extends Snapshot> = {
  decl: StateMachineDecl<S>;
  db: Database;
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
