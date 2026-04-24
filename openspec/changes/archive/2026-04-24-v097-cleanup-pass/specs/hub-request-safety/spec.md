## ADDED Requirements

### Requirement: Enum query params are narrowed by type-guard functions

The hub SHALL validate enumerated query parameters (e.g., `status` on list endpoints, `behavior` on permission verdict) using a type-guard function of the form `isXFilter(s: string): s is X` that (a) checks set membership at runtime and (b) narrows the TypeScript type in one step. Handlers MUST NOT use `as` casts to convert a raw string to an enum type without first calling the corresponding type guard. Handlers MUST return HTTP `400` with `{ "error": "invalid <param>: <value>" }` when the guard rejects a value.

This requirement formalizes the validation pattern introduced by v0.9.7's cleanup pass. Before v0.9.7, each handler mixed ad-hoc `Set.has` + inline string comparisons with `as` casts. The guard pattern consolidates validation + narrowing into one call and makes invalid-cast bugs structurally impossible.

#### Scenario: Invalid status value is rejected with a guard-based 400

- **GIVEN** the handler for `GET /handoffs?status=<value>`
- **WHEN** a client requests `GET /handoffs?status=bogus`
- **THEN** the hub calls `isHandoffStatusFilter("bogus")`, which returns `false`
- **AND** the hub responds `400` with body `{ "error": "invalid status: bogus" }`
- **AND** no list is computed

#### Scenario: Valid status value narrows and proceeds

- **WHEN** a client requests `GET /handoffs?status=pending`
- **THEN** the hub calls `isHandoffStatusFilter("pending")`, which returns `true` and narrows the parameter to `HandoffStatus | "all"`
- **AND** the handler calls `listHandoffs(cap.db, { status: "pending" })` without any `as` cast
- **AND** the hub responds `200` with the pending-handoff snapshots

#### Scenario: Permission verdict behavior uses the guard

- **GIVEN** the handler for `POST /permissions/:id/verdict` with body `{ by, behavior }`
- **WHEN** a client POSTs `{ by: "human", behavior: "maybe" }`
- **THEN** the hub calls `isPermissionBehavior("maybe")`, which returns `false`
- **AND** the hub responds `400` with body `{ "error": "invalid behavior" }`
- **AND** no permission state transitions

#### Scenario: Type guard enforces one validation call site per enum

- **GIVEN** the handler code for any kind's list endpoint
- **THEN** validation of the `status` query param SHALL be exactly one call to the corresponding `isXStatusFilter` function
- **AND** the handler SHALL NOT repeat an inline `Set.has` check alongside the guard
- **AND** the handler SHALL NOT fall back to `as` cast after a guard-false path
