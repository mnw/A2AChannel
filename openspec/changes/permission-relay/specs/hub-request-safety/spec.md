## ADDED Requirements

### Requirement: `/permissions` routes honor the same auth + body-size contract as other mutating routes

The three permission routes (`POST /permissions`, `POST /permissions/:id/verdict`, `GET /permissions`) SHALL require bearer-token auth:

- Mutating routes (`POST /permissions`, `POST /permissions/:id/verdict`) MUST present `Authorization: Bearer <token>` header. Route fails with 401 otherwise.
- Read route (`GET /permissions`) MAY present the token via header OR `?token=<token>` query param — matching the read-auth pattern for `/stream`, `/agents`, `/handoffs`, `/interrupts`.

Request body cap is 16 KiB (`PERMISSION_BODY_MAX = 16_384`), enforced via `requireJsonBody(req, 16_384)` before `req.json()`. Oversized requests return 413.

Trust-on-self-assertion applies to the `by` field on the verdict route: validated against `AGENT_NAME_RE` and the current roster, but not cryptographically bound to the calling sidecar. Token-holder can claim any identity. This matches the existing trust model for accept/decline/cancel handoff routes.

#### Scenario: Missing token on mutating route

- **WHEN** a request arrives at `POST /permissions` without `Authorization: Bearer <token>`
- **THEN** the hub returns 401 with `{ error: "unauthorized" }`
- **AND** no permission record is created

#### Scenario: Oversized body

- **WHEN** a `POST /permissions` arrives with `Content-Length: 32768` (32 KiB)
- **THEN** the hub returns 413 with `{ error: "payload too large" }`
- **AND** `req.json()` is not called

#### Scenario: Invalid `by` on verdict

- **WHEN** `POST /permissions/:id/verdict` arrives with `{ by: "/etc/passwd", behavior: "allow" }`
- **THEN** the hub returns 400 with `{ error: "invalid by" }` (validName check fails)

### Requirement: `claude/channel/permission` capability requires hub bearer-token auth

chatbridge SHALL NOT declare the `claude/channel/permission` capability if the hub's bearer-token auth on mutating routes is disabled. This is a deploy-time invariant, not a runtime check — the hub's `A2A_TOKEN` env is always set by the Rust shell in the shipping configuration, so the capability is safe to declare unconditionally. A future deployment mode that disables auth would need to remove the capability declaration in tandem.

This requirement is documented as a hard rule in `CLAUDE.md` so a future refactor that relaxes auth does not accidentally expose the permission-relay path to unauthenticated callers.

#### Scenario: Capability is safe in the shipping config

- **GIVEN** A2AChannel running under its default configuration
- **THEN** `A2A_TOKEN` is set, all mutating routes enforce bearer auth
- **AND** chatbridge's capability declaration is safe — no unauthenticated path to verdict submission exists
