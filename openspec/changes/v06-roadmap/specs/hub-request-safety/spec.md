## ADDED Requirements

### Requirement: New mutating routes inherit the bearer-auth rule

The hub SHALL require `Authorization: Bearer <token>` on all new mutating routes introduced by v0.6:

- `POST /interrupts`
- `POST /interrupts/:id/ack`
- `POST /nutshell/edit` (only if exposed as a direct route; if nutshell edits are exclusively gated through the handoff primitive per the `project-nutshell` capability, this route may be omitted)

Rejected requests return HTTP `401` with body `{"error": "unauthorized"}`. The same constant-time comparison rule applies.

#### Scenario: Unauthenticated interrupt creation is rejected

- **WHEN** a client issues `POST /interrupts` without `Authorization`
- **THEN** the hub responds `401`
- **AND** no ledger event is written

### Requirement: New read routes accept header OR query-param token

New read routes introduced by v0.6 SHALL accept authentication via either the `Authorization: Bearer` header OR a `?token=<token>` query parameter, matching the existing rule for `/stream`, `/agent-stream`, `/agents`, `/presence`, `/image/:id`:

- `GET /interrupts`
- `GET /nutshell`

#### Scenario: Read via query param

- **WHEN** a client issues `GET /nutshell?token=<valid>`
- **THEN** the hub responds `200` with the current nutshell JSON

### Requirement: Body caps apply uniformly to new routes

- `POST /interrupts` SHALL use the existing 256 KiB JSON cap.
- `POST /interrupts/:id/ack` SHALL use the existing 256 KiB JSON cap.
- Handoff-gated nutshell edits ride on `POST /handoffs` and inherit its 1 MiB cap (which applies because `context.patch` may be large).

#### Scenario: Oversized interrupt body

- **WHEN** a client issues `POST /interrupts` with `Content-Length: 300000`
- **THEN** the hub responds `413` with `{"error": "payload too large"}`

## MODIFIED Requirements

### Requirement: Mutating endpoints require bearer-token authentication

The hub SHALL reject `POST /send`, `POST /post`, `POST /remove`, `POST /upload`, `POST /handoffs`, `POST /handoffs/:id/accept`, `POST /handoffs/:id/decline`, `POST /handoffs/:id/cancel`, `POST /interrupts`, and `POST /interrupts/:id/ack` requests that do not include `Authorization: Bearer <token>` where `<token>` exactly matches the current session's token. Rejected requests SHALL return HTTP `401` with a JSON body `{ "error": "unauthorized" }`. Requests that include the header with an invalid or stale token SHALL also return `401`. The token comparison SHALL be constant-time to avoid timing oracles.

The same token is valid whether presented by the webview or by any channel-mode sidecar (human and agent uploads share the bearer auth surface).

#### Scenario: Unauthenticated POST is rejected

- **WHEN** a client issues `POST /send` without an `Authorization` header
- **THEN** the hub responds `401` with body `{"error":"unauthorized"}`
- **AND** no entry is written to the chat log

#### Scenario: Wrong token is rejected

- **GIVEN** the current session token is `T-current`
- **WHEN** a client issues `POST /post` with `Authorization: Bearer T-stale`
- **THEN** the hub responds `401`

#### Scenario: Agent and human tokens are the same

- **GIVEN** `A2A_TOKEN=abc`
- **WHEN** the webview POSTs `/upload` with `Bearer abc`
- **AND** a channel-mode sidecar POSTs `/upload` with `Bearer abc`
- **THEN** both requests succeed

#### Scenario: Read endpoints require auth via header or query token

- **WHEN** a client issues `GET /agents`, `/presence`, `/stream`, `/agent-stream`, `/image/<id>`, `/handoffs`, `/interrupts`, or `/nutshell` with no `Authorization` header and no `?token=` query parameter
- **THEN** the hub responds `401`
- **WHEN** the same client retries with `?token=<valid>`
- **THEN** the hub responds `200` with the expected body
