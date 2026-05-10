## ADDED Requirements

### Requirement: `LedgerEntity` owns the load → decide → transact → emit lifecycle

Every Kind handler SHALL delegate the load → decide → transact-via-internal-Store → emit lifecycle to `LedgerEntity.apply` (or `applyWithSideEffect`). Kinds supply only kind-specific declarations: a `StateMachineDecl` (table name, columns, terminal-status set), one or more `VerbDecl<Snapshot, Payload>` objects each carrying a pure `decide(prior, payload, cap)` function, the broadcast scope per verb, and the snapshot-to-Entry projection. The skeleton (transaction wrapping, version capture, idempotent same-status response, 409 different-status response, broadcast emission with `version = events.seq`) lives once inside `LedgerEntity`'s implementation.

#### Scenario: Same-status retry returns idempotent 200

- **GIVEN** a handoff in `accepted` state
- **WHEN** an HTTP request hits `POST /handoffs/:id/accept` again with the same actor
- **THEN** the verb's `decide` callback returns `{ kind: "idempotent", entry: replayEntry(prior) }`
- **AND** `LedgerEntity.apply` returns 200 OK with the existing snapshot
- **AND** no new event row is written
- **AND** no broadcast is emitted

#### Scenario: Different-status retry returns 409 Conflict

- **GIVEN** a handoff in `accepted` state
- **WHEN** an HTTP request hits `POST /handoffs/:id/decline`
- **THEN** the decline verb's `decide` callback returns `{ kind: "conflict", httpStatus: 409, message: "..." }`
- **AND** `LedgerEntity.apply` throws `LedgerConflict` (translated to 409 by the route handler)
- **AND** the response body carries the current snapshot
- **AND** no new event row is written
- **AND** no broadcast is emitted

#### Scenario: Successful transition writes event + derived row + broadcasts

- **GIVEN** a handoff in `pending` state
- **WHEN** an HTTP request hits `POST /handoffs/:id/accept` with a valid actor
- **THEN** the accept verb's `decide` callback returns `{ kind: "transition", next: {...}, entry: (seq) => Entry }`
- **AND** `LedgerEntity.apply` opens a `db.transaction` and: updates the derived row with `next`, calls `cap.events.insert` to receive `seq`, writes `seq` to the derived row's `version` column, builds the entry via the verb's `entry(seq)` thunk, commits
- **AND** post-commit, `cap.sse.emit(entry, scope(next))` fires
- **AND** the response is 200 OK with the new snapshot whose `version` matches the new event's `seq`

### Requirement: Idempotency policy lives in the verb's `decide` callback

Each verb's idempotency policy SHALL be expressed declaratively inside its `decide(prior, payload, actor, cap): Decision` callback, returning the appropriate `Decision` discriminated-union arm. All three Kinds use the same policy — **same-status-retry**, applied to the TARGET status of the verb (which for permission is derived from the request's `behavior` field: `allow → allowed`, `deny → denied`). Reduces to:

- **Same target → idempotent:** `if (prior.status === verb.targetStatus(payload)) return { kind: "idempotent" }`. Returns 200 with prior snapshot; no event; no broadcast.
- **Different terminal → 409:** `if (TERMINAL.has(prior.status)) return { kind: "conflict", httpStatus: 409, message: \`already \${prior.status}\` }`.
- **Pending + valid actor → transition.**
- **Not found → 404.** **Forbidden actor → 403.** Both as conflict-arm with the appropriate `httpStatus`.

`LedgerEntity` itself MUST NOT carry a per-policy enum or switch — the discriminated union of `Decision` arms is the seam. Idempotency variations across Kinds slot in by adjusting the `decide` callback's logic, not by editing `LedgerEntity`.

#### Scenario: Permission verdict same-target idempotent

- **GIVEN** a permission with `status: "allowed"` (resolved by a prior `verdict("allow")` request)
- **WHEN** a new `POST /permissions/:id/verdict` request arrives with `{ behavior: "allow" }` (same target)
- **THEN** the verdict verb's `decide` computes `targetStatus = "allowed"`, observes `prior.status === targetStatus`, returns `{ kind: "idempotent" }`
- **AND** `LedgerEntity.apply` returns 200 OK carrying the prior snapshot — no new event written

#### Scenario: Permission verdict different-target → 409

- **GIVEN** a permission with `status: "allowed"`
- **WHEN** a new `POST /permissions/:id/verdict` request arrives with `{ behavior: "deny" }` (different target)
- **THEN** the verdict verb's `decide` computes `targetStatus = "denied"`, observes `prior.status !== targetStatus` AND `prior.status` is terminal, returns `{ kind: "conflict", httpStatus: 409, message: "permission already allowed" }`
- **AND** `LedgerEntity.apply` throws `LedgerConflict`; route handler returns 409 carrying the prior snapshot
- **AND** the audit trail records the first verdict only

### Requirement: Per-Kind state machines are declarative

Each Kind file SHALL declare its state machine as data (`StateMachineDecl`: table name, column spec, terminal-status set) and its verbs as data (`VerbDecl[]`: each carrying `decide`, broadcast `scope`, optional `validate` pre-load guard) rather than imperative if-else chains in route handlers. `LedgerEntity` consumes the declarations to wire dispatch uniformly. Kinds may attach verb-specific same-transaction side-effects via `applyWithSideEffect` (today: handoff accept's nutshell patch); the dispatch policy itself is not per-Kind code.

#### Scenario: Kind declares status set and verbs

- **GIVEN** the handoff Kind module
- **THEN** it exports a `StateMachineDecl` listing statuses `pending | accepted | declined | cancelled | expired`
- **AND** it declares which statuses are terminal
- **AND** it declares one `VerbDecl` per verb (accept/decline/cancel/expire)
- **AND** each `VerbDecl.decide` function returns a `Decision` consumed by `LedgerEntity.apply`
- **AND** no kind-specific status-comparison code exists in route-handler files (route handlers are 1-3 LOC: parse params, call `acceptHandoff(cap, id, payload)`, return result)

### Requirement: `pendingFor` defaults to `LedgerEntity.listByStatus`

`KindModule`'s `pendingFor(agent, cap)` field SHALL default to a thin call into `entity.listByStatus({ status: "pending", for: agent.name })` followed by the kind's snapshot-to-Entry projection with `replay: true`. Kinds MAY override only when they need cross-status replay (none today), in which case the override is explicit and reasoned.

#### Scenario: Kind reconnect replay uses default impl

- **WHEN** an agent reconnects to `/agent-stream`
- **THEN** the orchestrator iterates `KINDS` and calls `pendingFor` on each
- **AND** each kind's default `pendingFor` returns its `pending`-status entries scoped to the agent
- **AND** every entry carries `replay: true`
- **AND** no kind file defines a custom `pendingFor` unless cross-status replay is needed
