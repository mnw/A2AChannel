## ADDED Requirements

### Requirement: Mutating endpoints require bearer-token authentication

The hub SHALL reject `POST /send`, `POST /post`, `POST /remove`, and `POST /upload` requests that do not include `Authorization: Bearer <token>` where `<token>` exactly matches the current session's token. Rejected requests SHALL return HTTP `401` with a JSON body `{ "error": "unauthorized" }`. Requests that include the header with an invalid or stale token SHALL also return `401`. The token comparison SHALL be constant-time to avoid timing oracles.

#### Scenario: Unauthenticated POST is rejected

- **WHEN** a client issues `POST /send` without an `Authorization` header
- **THEN** the hub responds `401` with body `{"error":"unauthorized"}`
- **AND** no entry is written to the chat log

#### Scenario: Wrong token is rejected

- **GIVEN** the current session token is `T-current`
- **WHEN** a client issues `POST /post` with `Authorization: Bearer T-stale`
- **THEN** the hub responds `401`

#### Scenario: Read endpoints remain unauthenticated

- **WHEN** a client issues `GET /agents` or `GET /stream` with no `Authorization` header
- **THEN** the hub responds `200` and returns the expected body

### Requirement: JSON request bodies are capped at 256 KiB

The hub SHALL reject `POST /send`, `POST /post`, and `POST /remove` requests whose `Content-Length` header exceeds 262144 bytes (256 KiB) without reading the body. Responses SHALL be HTTP `413` with body `{ "error": "payload too large" }`. Requests without a `Content-Length` header (e.g. chunked encoding) SHALL be rejected with `411 Length Required` rather than being read speculatively.

#### Scenario: Oversized JSON body

- **WHEN** a client issues `POST /send` with `Content-Length: 300000`
- **THEN** the hub responds `413` without reading the body

#### Scenario: Chunked body without length

- **WHEN** a client issues `POST /post` with `Transfer-Encoding: chunked` and no `Content-Length`
- **THEN** the hub responds `411`

### Requirement: Upload rejects disallowed MIMEs and mismatched magic bytes

`POST /upload` SHALL accept only the following `Content-Type` values: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. `image/svg+xml` is no longer accepted. The hub SHALL read the first bytes of the uploaded payload and reject the upload with HTTP `400` if the bytes do not match the declared MIME. Payloads larger than `IMAGE_MAX_BYTES` (8 MiB) SHALL be rejected with `413`.

#### Scenario: SVG upload is rejected

- **WHEN** a client issues `POST /upload` with `Content-Type: image/svg+xml`
- **THEN** the hub responds `400` with body `{"error":"unsupported type: image/svg+xml"}`

#### Scenario: Mismatched magic bytes

- **WHEN** a client uploads a payload starting with `<script>alert(1)</script>` declared as `image/png`
- **THEN** the hub responds `400` with a body explaining the MIME mismatch
- **AND** nothing is added to the image store

#### Scenario: Valid PNG is accepted

- **WHEN** a client uploads a payload starting with `\x89PNG\r\n\x1a\n...` declared as `image/png`
- **THEN** the hub responds `200` with `{ url, id }`

### Requirement: Uploaded images are served with hardening headers

`GET /image/:id` SHALL respond with the stored bytes and set the following headers in addition to the existing `Content-Type`: `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, and `Cache-Control: public, max-age=3600`.

#### Scenario: Headers present on image responses

- **WHEN** a client issues `GET /image/<known-id>`
- **THEN** the response includes all three hardening headers
- **AND** the body is the stored image bytes

### Requirement: `/send` rejects non-local image URLs

`POST /send` SHALL reject requests whose `image` field, if present, does not match the regex `^/image/[A-Za-z0-9_-]+$`. Rejected requests SHALL return HTTP `400` with body `{ "error": "invalid image url" }`. The hub SHALL NOT accept absolute URLs, arbitrary paths, or `javascript:` / `data:` schemes in this field.

#### Scenario: Arbitrary URL rejected

- **WHEN** a client issues `POST /send` with `image: "http://evil.example.com/pixel.gif"`
- **THEN** the hub responds `400`
- **AND** no chat entry is created

#### Scenario: Valid local image URL accepted

- **WHEN** a client issues `POST /send` with `image: "/image/abc123_XYZ-def"`
- **THEN** the hub stores the chat entry with that image reference

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
