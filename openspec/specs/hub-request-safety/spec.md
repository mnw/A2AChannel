# hub-request-safety Specification

## Purpose
TBD - created by archiving change security-hardening. Update Purpose after archive.
## Requirements
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

### Requirement: JSON request bodies are capped at 256 KiB

The hub SHALL reject `POST /send`, `POST /post`, and `POST /remove` requests whose `Content-Length` header exceeds 262144 bytes (256 KiB) without reading the body. Responses SHALL be HTTP `413` with body `{ "error": "payload too large" }`. Requests without a `Content-Length` header (e.g. chunked encoding) SHALL be rejected with `411 Length Required` rather than being read speculatively.

#### Scenario: Oversized JSON body

- **WHEN** a client issues `POST /send` with `Content-Length: 300000`
- **THEN** the hub responds `413` without reading the body

#### Scenario: Chunked body without length

- **WHEN** a client issues `POST /post` with `Transfer-Encoding: chunked` and no `Content-Length`
- **THEN** the hub responds `411`

### Requirement: Upload rejects disallowed MIMEs and mismatched magic bytes

`POST /upload` SHALL accept only the following `Content-Type` values: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. `image/svg+xml` is no longer accepted. The hub SHALL read the first bytes of the uploaded payload and reject the upload with HTTP `400` if the bytes do not match the declared MIME. Payloads larger than `IMAGE_MAX_BYTES` (8 MiB) SHALL be rejected with `413`. On success, the hub SHALL persist the bytes to disk at `<A2A_IMAGES_DIR>/<id>.<ext>` and respond `{ url: "/image/<id>.<ext>", id: "<id>" }`, where `<ext>` is derived from the validated MIME.

#### Scenario: SVG upload is rejected

- **WHEN** a client issues `POST /upload` with `Content-Type: image/svg+xml`
- **THEN** the hub responds `400` with body `{"error":"unsupported type: image/svg+xml"}`

#### Scenario: Mismatched magic bytes

- **WHEN** a client uploads a payload starting with `<script>alert(1)</script>` declared as `image/png`
- **THEN** the hub responds `400` with a body explaining the MIME mismatch
- **AND** nothing is written to disk

#### Scenario: Valid PNG is accepted

- **WHEN** a client uploads a payload starting with `\x89PNG\r\n\x1a\n...` declared as `image/png`
- **THEN** the hub responds `200` with `{ url: "/image/<id>.png", id: "<id>" }`
- **AND** the file `<A2A_IMAGES_DIR>/<id>.png` contains the uploaded bytes

### Requirement: Uploaded images are served with hardening headers

`GET /image/:id` SHALL respond with the stored bytes and set the following headers in addition to the existing `Content-Type`: `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, and `Cache-Control: public, max-age=3600`.

#### Scenario: Headers present on image responses

- **WHEN** a client issues `GET /image/<known-id>`
- **THEN** the response includes all three hardening headers
- **AND** the body is the stored image bytes

### Requirement: `/send` rejects non-local image URLs

`POST /send` SHALL reject requests whose `image` field, if present, does not match the regex `/^\/image\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i`. Rejected requests SHALL return HTTP `400` with body `{ "error": "invalid image url" }`. The hub SHALL NOT accept absolute URLs, arbitrary paths, or `javascript:` / `data:` schemes in this field.

#### Scenario: Arbitrary URL rejected

- **WHEN** a client issues `POST /send` with `image: "http://evil.example.com/pixel.gif"`
- **THEN** the hub responds `400`
- **AND** no chat entry is created

#### Scenario: Valid local image URL accepted

- **WHEN** a client issues `POST /send` with `image: "/image/abc123_XYZ-def.png"`
- **THEN** the hub stores the chat entry with that image reference

#### Scenario: URL without extension rejected

- **WHEN** a client issues `POST /send` with `image: "/image/abc123"`
- **THEN** the hub responds `400 invalid image url`

### Requirement: `/post` matches agent names case-sensitively

`POST /post` SHALL resolve the `to` field as follows: compare `to.toLowerCase()` against the reserved set `{you, all}` for routing semantics, but match against `knownAgents` using the original (case-sensitive) string. Agents registered with mixed-case names SHALL receive messages sent to their exact name.

#### Scenario: Mixed-case agent receives its message

- **GIVEN** agents registered as `Drupal` and `django`
- **WHEN** agent `Bot` issues `POST /post` with `to: "Drupal"`
- **THEN** the message is enqueued to the `Drupal` agent queue

#### Scenario: Case mismatch is rejected

- **GIVEN** an agent registered as `Drupal` (capital D)
- **WHEN** a client issues `POST /post` with `to: "drupal"` (lowercase)
- **AND** no agent named `drupal` is registered
- **THEN** the hub responds `400` with `{"error":"unknown to: drupal"}`

### Requirement: `/send` validates every entry in `targets` before resolving "all"

`POST /send` SHALL validate each element of `body.targets` against the current roster before expanding `"all"`. If any element is neither `"all"` nor a known agent name, the hub SHALL respond `400` with body `{"error":"unknown target: <name>"}`. `"all"` SHALL resolve to the current known agents only after all other elements have been validated.

#### Scenario: Unknown name alongside "all"

- **GIVEN** agents `Alice` and `Bob` are registered
- **WHEN** a client issues `POST /send` with `targets: ["all", "Charlie"]`
- **THEN** the hub responds `400` with `{"error":"unknown target: Charlie"}`
- **AND** no chat entry is created

#### Scenario: All-only broadcast succeeds

- **WHEN** a client issues `POST /send` with `targets: ["all"]`
- **THEN** the hub resolves targets to the current roster and delivers the message

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

