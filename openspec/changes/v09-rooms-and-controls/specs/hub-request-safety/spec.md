## ADDED Requirements

### Requirement: Mutating routes that accept `from` or `by` validate room membership

For every mutating route that accepts a `from` (chat, handoffs, interrupts, permissions, nutshell proposals) or `by` (handoff accept/decline/cancel, interrupt ack, permission verdict) field, the hub SHALL validate that the named actor is a registered roster member AND — if the route's broadcast scope involves a target room — that the actor is in that room, or that the actor is the human (who transcends rooms).

Specifically:
- `POST /post` / `POST /send`: sender's room determines broadcast scope; no cross-room permission check beyond the routing rule in `rooms` capability.
- `POST /handoffs`: sender and recipient MUST be in the same room, or sender MUST be the human. Cross-room: HTTP 403 `{"error": "cross-room handoff not permitted"}`.
- `POST /interrupts`: same rule as handoffs; bulk-shape `rooms: [...]` is accepted only when `from == human_name`.
- `POST /handoffs/:id/accept|decline|cancel`: `by` must match the expected actor (recipient/sender) as today; no new room check here since the handoff carries its own room from creation time.
- `POST /interrupts/:id/ack`: `by` must match `to_agent` or the human; no new room check.
- `POST /permissions`: forwarded by channel-bin, so the `agent` field is validated against channel-bin's authenticated identity (existing trust-on-self-assertion model). The event carries the agent's room for routing.
- `POST /permissions/:id/verdict`: `by` must be in the same room as the requesting agent, OR be the human.

The trust-on-self-assertion model (CLAUDE.md) is unchanged: the hub does not cryptographically bind a caller to an identity. Room membership validation adds another axis to the same trust boundary.

#### Scenario: Cross-room handoff rejected

- **GIVEN** agent `backend` is in room `neb-2026` and agent `marketing` is in room `brand`
- **WHEN** `backend` POSTs `/handoffs` with `{from: "backend", to: "marketing", task: "please review"}`
- **THEN** the response is 403 `{"error": "cross-room handoff not permitted"}`
- **AND** no ledger row is written

#### Scenario: Human crosses rooms freely on mutating routes

- **WHEN** the human POSTs `/handoffs` with `{from: "<human_name>", to: "marketing", task: "approved"}` where marketing is in room `brand`
- **THEN** the handoff is created

#### Scenario: Bulk interrupt refused for non-human

- **WHEN** agent `backend` POSTs `/interrupts` with `{from: "backend", rooms: ["brand"], text: "..."}`
- **THEN** the response is 403 `{"error": "bulk interrupt restricted to human"}`

### Requirement: `GET /room-default` is read-authenticated and returns the fallback room

A new read endpoint `GET /room-default` SHALL return `{ room: "<label>" }` where `<label>` is the hub's `A2A_DEFAULT_ROOM` env value (default `"default"`). The endpoint SHALL accept the same authentication as other read routes (Authorization bearer OR `?token=` query param). The endpoint is used by channel-bin to resolve a fallback room when `CHATBRIDGE_ROOM` is not set in its environment.

#### Scenario: Read-auth applies

- **WHEN** a client issues `GET /room-default` with no auth
- **THEN** the response is 401
- **WHEN** the client retries with `?token=<valid>`
- **THEN** the response is 200 with `{"room": "default"}` (or the configured default)
