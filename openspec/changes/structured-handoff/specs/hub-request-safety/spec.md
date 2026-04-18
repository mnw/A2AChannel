## ADDED Requirements

### Requirement: Handoff endpoints are auth-required

The hub SHALL require a valid `Authorization: Bearer <token>` header on `POST /handoffs`, `POST /handoffs/:id/accept`, `POST /handoffs/:id/decline`, `POST /handoffs/:id/cancel`, and `GET /handoffs`. Unauthenticated requests SHALL return `401`.

#### Scenario: Unauthenticated POST /handoffs rejected

- **WHEN** a client issues `POST /handoffs` without an `Authorization` header
- **THEN** the hub responds `401 { "error": "unauthorized" }`

#### Scenario: Unauthenticated GET /handoffs rejected

- **WHEN** a client issues `GET /handoffs` without an `Authorization` header
- **THEN** the hub responds `401`

### Requirement: Handoff endpoints enforce per-route body size caps

`POST /handoffs` SHALL accept bodies up to 1 MiB (1,048,576 bytes), larger than the default 256 KiB cap, to accommodate diffs and structured contracts in the `context` field. `POST /handoffs/:id/accept`, `POST /handoffs/:id/decline`, and `POST /handoffs/:id/cancel` SHALL use the default 256 KiB cap (their bodies are small by nature). `GET /handoffs` carries no body and is exempt.

#### Scenario: Oversized create body rejected

- **WHEN** a client issues `POST /handoffs` with `Content-Length: 2000000` (2 MiB)
- **THEN** the hub responds `413 { "error": "payload too large" }` without reading the body

#### Scenario: Create body up to 1 MiB accepted

- **WHEN** a client issues `POST /handoffs` with `Content-Length: 900000` (≈ 900 KiB) and valid payload
- **THEN** the hub processes the request

#### Scenario: Oversized accept body rejected

- **WHEN** a client issues `POST /handoffs/:id/accept` with `Content-Length: 300000` (≈ 300 KiB)
- **THEN** the hub responds `413` (default 256 KiB cap applies)

### Requirement: Handoff actor identity is trust-on-self-assertion

The hub SHALL validate the `by` and `from` fields on handoff endpoints against the **expected actor for the route** (recipient for accept/decline; sender-or-human for cancel; any valid agent name for create). The hub SHALL NOT cryptographically verify that the caller controls the claimed identity — any process holding the shared bearer token in `hub.token` can claim any `by` or `from`. This is explicit policy and matches the existing trust model of `POST /post`, which already trusts `from` unchecked. Documentation SHALL describe this as **trust-on-self-assertion** and MUST name the hardening target: **per-sidecar tokens**, where each `channel-bin` process is issued a unique token bound to a specific agent identity at spawn time, and the hub validates that binding. Implementing per-sidecar tokens is out of scope for this change; the requirement is that the caveat and upgrade target be surfaced in both the user-facing README and the contributor-facing CLAUDE.md.

#### Scenario: Token-holder claims arbitrary identity

- **GIVEN** a client has the hub's bearer token
- **WHEN** the client issues `POST /handoffs` with `from="anyone-i-want"`
- **THEN** the hub accepts the call (subject to agent-name validation)
- **AND** the event row records `actor="anyone-i-want"`
- **AND** nothing in the hub cryptographically disputes the claim

#### Scenario: Caveat is surfaced in README and CLAUDE.md

- **WHEN** a reader opens the documentation
- **THEN** the trust-on-self-assertion caveat is visible in both README (user-facing) and CLAUDE.md (contributor-facing) with the hardening target named
