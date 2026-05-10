# Hybrid `LedgerEntity<Snapshot>` with private `Store` closure for the persistent-state-machine Kind layer

The three Kind files (`hub/kinds/handoff.ts` 603 LOC, `interrupt.ts` 365, `permission.ts` 481) reimplemented the same load → version-capture → guard → transact (event + derived row) → emit skeleton plus per-Kind verbs. The CLAUDE.md hard rule "exactly one event + one derived-table update in one SQLite transaction" was enforced by convention, not by interface. `listByStatus` ran an N+1 with a per-row `SELECT MAX(seq)` subquery on the events table. The architecture-cycle-2a pre-grill (1.1) ran INTERFACE-DESIGN.md's parallel sub-agent flow on three competing shapes; the chosen shape is **hybrid `LedgerEntity<Snapshot>` with a private internal `Store` closure** — one external Module, one internal collaborator that Kind code never sees.

## Considered Options

- **Fused `LedgerEntity` (no internal Store seam).** Single Module with all SQL inside its closure. Rejected: the nutshell-coupling case (handoff `accept` with `task: "[nutshell]"` requires patching the nutshell row in the same transaction as the handoff event + handoff-row UPDATE) had no clean shape — the only proposal was an undocumented `cap.db.run` escape "limited to one extra UPDATE." That kind of unscoped discipline is not maintainable; the escape would propagate beyond nutshell within months.
- **Pure-split `KindBase` + `KindStore<Snapshot>` (two external Modules).** Ports-and-adapters shape. Rejected: (i) every `VerbDecl` has to carry an `aux` field whether used or not, polluting the common case (only handoff `accept` actually needs cross-table writes); (ii) idempotency policy demands a discriminated `IdempotencyPolicy` enum on every verb (`same-status-retry | first-verdict-wins | ...`) when the same logic folds cleanly inside a `decide` callback for the hybrid shape; (iii) "two adapters means a real seam" — today we'd have one production SQLite store + one in-memory test store, which is a hypothetical seam. Paying the publicity cost (an exported `KindStore` interface to learn) for a hypothetical seam is not earned.
- **No abstraction (status quo).** Continue duplicating the load → guard → transact → emit skeleton across three files plus future Kinds. Rejected: the CLAUDE.md hard rule remains convention-enforced; the N+1 stays; new-Kind cost is 400+ LOC of boilerplate.

## Consequences

- **`LedgerEntity<Snapshot>` is the ONE Module Kind code learns.** External interface: `apply(id, verb, payload, cap, scope)` for the common case; `applyWithSideEffect(...)` for cross-table writes (the `SideEffectCtx.tx` is transaction-scoped and cannot open new transactions or call `Store.load` / `listByStatus`); `listByStatus(filter)`; `load(id)`; `sweep(selector, verb, cap)` for TTL bulk transitions; `migrate(db)` (delegates to internal Store). No `entity.store` / `entity.unsafeStore` property — the Store reference lives in the closure returned by `createLedgerEntity({ decl, store })`.
- **Idempotency policy lives in each verb's `decide(prior, payload, cap): Decision` callback,** not as a per-Kind enum. All three Kinds use the same underlying policy — **same-status-retry** — expressed in terms of the verb's TARGET status (which for permission is derived from the request's `behavior` payload: `allow → allowed`, `deny → denied`):
  - **Same target → idempotent:** `if (prior.status === verb.targetStatus(payload)) return { kind: "idempotent" }`. The Hub returns 200 with the prior snapshot, no event written, no broadcast.
  - **Different terminal → 409 conflict:** `if (PERM_TERMINAL_OR_KIND_TERMINAL.has(prior.status)) return { kind: "conflict", httpStatus: 409, message: "..." }`. The first verdict / first state-change is the source of truth.
  - **Pending + valid actor → transition.**
  - **Not found / forbidden actor:** `{ kind: "conflict", httpStatus: 404 | 403, ... }`.

  This corrects an earlier "first-verdict-wins" framing in design.md / pre-grill notes that misleadingly suggested permission allowed "any terminal status returns prior regardless of new verdict." The actual behavior (verified by the existing `permission-lifecycle` integration test) is uniform same-status-retry across all three Kinds. CLAUDE.md's "Terminal-state policy on handoff accept/decline/cancel and interrupt ack. Same-status-retry → idempotent 200. Different-status-retry → 409 Conflict. Uniform across all transition routes." applies to permission as well.
- **`version = events.seq` materializes as a column on the derived row** inside the same `db.transaction` as the event insert. `listByStatus` is one flat SELECT against the composite `(status, for_col)` index — no per-row `MAX(seq)` subquery. Today's N+1 disappears.
- **The internal Store seam is acknowledged hypothetical** under LANGUAGE.md's "two adapters means a real seam" rule (today: one production `createSqliteStore` + one test `createInMemoryStore`). The cost (~80 LOC of `Store` interface + factories) is justified by the test-velocity benefit (sub-millisecond verb tests + idempotency edge case coverage). The seam becomes "earned" the day a second production adapter (e.g. multi-process / Postgres / cross-machine replication) appears.
- **Per-Kind LOC after migration** (POST-IMPLEMENTATION CORRECTION). Pre-grill estimates were optimistic; actual outcomes:

  | Kind       | Before | After | Pre-grill estimate | Delta vs estimate |
  |------------|--------|-------|---------------------|--------------------|
  | handoff    | 603    | 672   | 165                 | +507 (4× miss)     |
  | interrupt  | 365    | 330   | 110                 | +220 (3× miss)     |
  | permission | 481    | 404   | 140                 | +264 (3× miss)     |

  The boilerplate WAS extracted into shared infrastructure (`hub/core/ledger-entity.ts` + `hub/core/store.ts` ≈ 510 LOC), but each Kind retained its full `StateMachineDecl` + per-verb `VerbDecl` + route-handler input parsing/auth/validation. Handoff also kept the 30-LOC standalone `expireHandoff` + `findExpirable` helpers used by hub.ts's TTL sweep loop.

  **The cycle traded LOC for encapsulation, testability, and N+1 elimination — not LOC reduction.** Net change across the three Kinds: -60 LOC. New shared infrastructure: +510 LOC. The structural wins (single `db.transaction` call site, `version` materialized atomically, `Decision`-discriminated dispatch, in-memory `Store` for sub-millisecond verb tests) are the load-bearing payoff. Future Kinds reuse the infra at zero per-Kind cost.
- **Three CLAUDE.md hard rules become structural:** "Every state change writes exactly one event + one derived-table update in one SQLite transaction" (enforced by `LedgerEntity.apply`'s exclusive ownership of the transaction call site); "Same-status retry → idempotent 200, different-status → 409" (enforced by `Decision` discriminated-union dispatch inside `apply`); "Never enumerate agent queues from inside a kind" (a separate rule, enforced by `Fanout` in §5). All three are deletable from CLAUDE.md after this cycle.
- **`apply` is sole transactional entry point.** Forgetting to UPDATE the `version` column or to write the event in the same transaction is impossible — the Store's `transact` method is the only path.
- **Bulk operations (TTL sweep, bulk-ack) use `entity.sweep` or per-row iteration over `entity.apply`,** not a separate transactional bulk API. Acceptable trade given expiry runs every 30s on small N. Adding `transactBulk` is a future change if profiling demands it.
- **`createLedgerEntity` is the only factory Kind code imports.** `Store`, `createSqliteStore`, `createInMemoryStore` live in `hub/core/store.ts` and are not exported from the `hub/core` barrel.

## Recorded by

`architecture-cycle-2a`, pre-grill task 1.1 (closed 2026-05-10). Full sub-agent grill outputs are preserved in the change's task notification stream; this ADR is the load-bearing summary. The ADR file lands alongside the `feat(ledger): LedgerEntity<Snapshot> + private Store closure` commit in §2D of the cycle's task list.
