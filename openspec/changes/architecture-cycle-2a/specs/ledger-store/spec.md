## ADDED Requirements

### Requirement: Each Kind owns a typed `LedgerEntity<Snapshot>`

Every persistent state-machine Kind in the hub SHALL define a `LedgerEntity<Snapshot>` instance that is the SOLE Module Kind code uses for storage and orchestration. `LedgerEntity` owns the derived-table schema, the atomic write of `(event row, derived-table row update)`, and the load → decide → transact → emit lifecycle. Kinds MUST NOT execute raw `db.run("INSERT INTO <kind>_table ...")` or `db.transaction(...)` calls outside `LedgerEntity`. The external interface exposes `apply(id, verb, payload, cap, scope)`, `applyWithSideEffect(id, verb, payload, cap, scope, sideEffect)`, `listByStatus(filter)`, `load(id)`, and `sweep(selector, verb, cap)` for TTL bulk transitions.

The internal `Store<Snapshot>` Module exists only inside `LedgerEntity`'s closure (created via `createSqliteStore` for production / `createInMemoryStore` for tests) and MUST NOT be exposed via any property or getter on `LedgerEntity`. Tests that need the Store hold their own reference before passing it to `createLedgerEntity({ decl, store })` — they do not extract it from a constructed entity.

#### Scenario: Kind reads + writes go through LedgerEntity

- **WHEN** a kind handler accepts an HTTP transition (e.g. `POST /handoffs/:id/accept`)
- **THEN** it calls `entity.apply(id, verb, payload, cap, scope)` (or `applyWithSideEffect` for the rare cross-table-write case)
- **AND** the kind handler does NOT contain raw `db.run`, `db.query`, or `db.transaction` calls against the kind's derived table

#### Scenario: Schema migrations live behind LedgerEntity

- **WHEN** the hub starts and `openLedger()` runs
- **THEN** each `LedgerEntity` is constructed with a state-machine declaration that includes its derived-table DDL
- **AND** kind files (e.g. `hub/kinds/handoff.ts`) contain no `CREATE TABLE` or `ALTER TABLE` statements

#### Scenario: Internal Store is not reachable from Kind code

- **WHEN** the codebase is grepped for `entity.store`, `entity.unsafeStore`, or `LedgerEntity.prototype.store`
- **THEN** zero matches are found
- **AND** no Kind file imports `Store`, `createSqliteStore`, or `createInMemoryStore` directly (only `createLedgerEntity` is imported by Kind code)

### Requirement: `LedgerEntity.apply` carries `events.seq` forward atomically

`LedgerEntity.apply` and `LedgerEntity.applyWithSideEffect` SHALL use `cap.events.insert()`'s returned `seq` value as the broadcast `version`, materialized into the derived row's `version` column inside the same SQLite transaction. The transaction guarantees that the inserted event row, the updated derived row's `version` column, and the version returned to the caller all reference the same `seq`. The derived row's `version` column is the canonical version source for subsequent reads — `LedgerEntity` MUST NOT compute version via `SELECT MAX(seq) FROM events` on read paths.

#### Scenario: No race between insert and version query

- **WHEN** `apply` is called concurrently from two HTTP requests for the same kind row
- **THEN** SQLite write-lock serialization ensures one transaction's snapshot is visible to the other's `decide` callback
- **AND** each `apply` returns a snapshot with a distinct `version` matching its own event's `seq`
- **AND** the broadcast emitted from each apply carries the apply's own `version`

### Requirement: `listByStatus` performs a single SQL query, no per-row version subqueries

`LedgerEntity.listByStatus(filter)` SHALL execute exactly ONE SQL statement against the database, regardless of result-row count. Because `version` is materialized as a column on the derived row by every `apply`, no per-row `SELECT MAX(seq) FROM events WHERE entity_id=?` subquery is needed (eliminating today's N+1). The query is a flat `SELECT * FROM <table> WHERE status = ? [AND for_col = ?] [AND room = ?] ORDER BY ... LIMIT ?` against the composite index `(status, for_col)`.

#### Scenario: List of N rows runs O(1) queries

- **GIVEN** a Kind with 100 derived-table rows in `pending` status
- **WHEN** `listByStatus({ status: "pending" })` is invoked
- **THEN** exactly 1 SQL query is executed against the database
- **AND** the returned snapshots each carry a correct `version` read from the derived row's `version` column
- **AND** the test asserts via a query-counting fake or SQLite trace that no per-row subquery was issued

#### Scenario: Filter by `for` agent uses indexed columns, not full scan

- **GIVEN** a Kind whose derived table has an index on `(status, to_agent)` or equivalent
- **WHEN** `listByStatus({ status: "pending", for: "Drupal" })` is invoked
- **THEN** the SQL query uses the available index (verified via `EXPLAIN QUERY PLAN`)
- **AND** does not scan rows of other agents

### Requirement: `LedgerEntity` is testable via `createInMemoryStore`

The `Store<Snapshot>` interface SHALL be implementable by `createInMemoryStore(decl)` suitable for unit testing kind verb functions without a SQLite database. Kind verb tests construct `createLedgerEntity({ decl, store: createInMemoryStore(decl) })` — they receive a real `LedgerEntity` whose internal collaborator is the in-memory fake. Tests MUST NOT stub `LedgerEntity` itself — its `apply` decision dispatch is the logic under test. The internal Store seam is acknowledged as currently hypothetical (one production adapter + one test fake) per LANGUAGE.md's "two adapters means a real seam" rule, accepted because the test-velocity benefit (sub-millisecond verb tests) justifies the ~80 LOC of `Store` interface + factory.

#### Scenario: Kind verb test runs without SQLite

- **GIVEN** a unit test for `acceptHandoff(cap, id, payload)` that constructs `cap.handoffs = createLedgerEntity({ decl: handoffDecl, store: createInMemoryStore(handoffDecl) })`
- **WHEN** the verb is invoked
- **THEN** the test runs to completion without opening a SQLite database
- **AND** the test holds its own reference to the `store` (passed in to the factory) for direct read assertions
- **AND** assertions on the resulting snapshot pass against the in-memory state

### Requirement: Cross-table writes use the named `applyWithSideEffect` seam

Cross-table writes within a single Kind transition (today: handoff accept's nutshell patch) SHALL go through `LedgerEntity.applyWithSideEffect(id, verb, payload, cap, scope, sideEffect)`. The `SideEffectCtx` exposes `prior`, `next`, `seq`, and a transaction-scoped `tx: TxHandle` (NOT the raw `Database`) — the side-effect can run additional SQL inside the open transaction but MUST NOT open a new transaction or call `Store.load` / `Store.list`. `apply` (without side-effect) is the common case and MUST be used for any verb that does not need cross-table writes.

#### Scenario: Nutshell patch lands in the same transaction as handoff accept

- **GIVEN** a handoff with `task: "[nutshell]"` and `context.patch: "..."`
- **WHEN** `acceptHandoffWithNutshell` invokes `entity.applyWithSideEffect(...)` with a sideEffect that updates the nutshell row
- **THEN** the handoff event insert, the handoffs-row UPDATE, and the nutshell-row UPSERT all occur in one `db.transaction`
- **AND** if any of the three fail, none commit
- **AND** the `SideEffectCtx.tx` handle cannot be used to open a new transaction or read from the Store

#### Scenario: Verbs without side-effects use the simpler `apply`

- **WHEN** `acceptHandoff` (no nutshell coupling) is invoked
- **THEN** it calls `entity.apply(...)` (without the `sideEffect` parameter)
- **AND** the verb body is ≤10 LOC of decide logic + the apply call
