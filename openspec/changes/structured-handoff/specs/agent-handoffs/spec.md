## ADDED Requirements

### Requirement: Human is a first-class roster identity

The hub SHALL resolve a human identity name at startup from the `A2A_HUMAN_NAME` environment variable (set by the Rust shell from `config.json` → `human_name`, default `"human"`). The hub SHALL register that name in the roster as a permanent member (excluded from stale cleanup) and SHALL treat it identically to any other agent in queries, validation, mentions, and broadcast targeting. If the configured name equals any reserved word (`you`, `all`, `system`) or fails the existing `AGENT_NAME_RE` pattern, the hub SHALL refuse to start with a clear error.

#### Scenario: Default human identity registered at startup

- **WHEN** the hub starts with no `A2A_HUMAN_NAME` env set
- **THEN** the roster contains an agent named `"human"` immediately after startup, never to be stale-cleaned

#### Scenario: Configured human name honored

- **GIVEN** `config.json` contains `{ "human_name": "mnw" }`
- **WHEN** the hub starts
- **THEN** the roster contains an agent named `"mnw"`
- **AND** `get_human_name` (Tauri command) returns `"mnw"`

#### Scenario: Invalid human name fails startup

- **GIVEN** `config.json` contains `{ "human_name": "all" }`
- **WHEN** the hub starts
- **THEN** the hub logs an error and exits non-zero

### Requirement: Agents can send handoffs via the `send_handoff` MCP tool

`channel-bin` SHALL expose an MCP tool named `send_handoff` with the following JSON input schema:

```
{
  "type": "object",
  "properties": {
    "to":           { "type": "string", "description": "Recipient agent name (may be the human's configured name)" },
    "task":         { "type": "string", "minLength": 1, "maxLength": 500 },
    "context":      { "type": "object", "description": "Optional structured metadata; serialized max 1 MiB" },
    "ttl_seconds":  { "type": "integer", "minimum": 1, "maximum": 86400 }
  },
  "required": ["to", "task"]
}
```

The tool SHALL POST the fields to the hub `/handoffs` endpoint with the caller's agent name as `from`. On success, the tool SHALL return a text result containing the assigned `handoff_id`.

#### Scenario: Successful send returns handoff_id

- **WHEN** agent `alice` calls `send_handoff({"to":"bob", "task":"rotate staging DB creds"})`
- **THEN** the hub responds `201` with `{ "id": "h_<16hex>" }`
- **AND** the tool result contains that id

#### Scenario: Missing required field rejected before hub contact

- **WHEN** an agent calls `send_handoff({"to":"bob"})` (no `task`)
- **THEN** the MCP tool call fails client-side with a schema validation error

### Requirement: Agents can accept a handoff via `accept_handoff` MCP tool

`channel-bin` SHALL expose an MCP tool named `accept_handoff`:

```
{
  "type": "object",
  "properties": {
    "handoff_id": { "type": "string", "pattern": "^h_[0-9a-f]{16}$" },
    "comment":    { "type": "string", "maxLength": 500 }
  },
  "required": ["handoff_id"]
}
```

The tool SHALL POST to `/handoffs/:id/accept` with the caller's agent name as `by`.

#### Scenario: Accept resolves a pending handoff

- **GIVEN** a pending handoff `h_abc` with `to_agent=bob`
- **WHEN** bob calls `accept_handoff({"handoff_id":"h_abc"})`
- **THEN** the handoff transitions to `status=accepted`
- **AND** the tool result confirms success

### Requirement: Agents can decline a handoff via `decline_handoff` MCP tool

`channel-bin` SHALL expose an MCP tool named `decline_handoff`:

```
{
  "type": "object",
  "properties": {
    "handoff_id": { "type": "string", "pattern": "^h_[0-9a-f]{16}$" },
    "reason":     { "type": "string", "minLength": 1, "maxLength": 500 }
  },
  "required": ["handoff_id", "reason"]
}
```

The MCP schema requires `reason` so role prompts cannot issue a decline without providing one. The tool SHALL POST to `/handoffs/:id/decline` with the caller's agent name as `by`.

#### Scenario: Decline with reason resolves handoff

- **GIVEN** a pending handoff `h_abc` with `to_agent=bob`
- **WHEN** bob calls `decline_handoff({"handoff_id":"h_abc", "reason":"on incident call"})`
- **THEN** the handoff transitions to `status=declined` with `decline_reason="on incident call"`

#### Scenario: Decline without reason blocked at MCP layer

- **WHEN** an agent calls `decline_handoff({"handoff_id":"h_abc"})`
- **THEN** the MCP tool call fails client-side; the hub is not contacted

### Requirement: Sender (or human) can cancel a pending handoff via `cancel_handoff`

`channel-bin` SHALL expose an MCP tool named `cancel_handoff`:

```
{
  "type": "object",
  "properties": {
    "handoff_id": { "type": "string", "pattern": "^h_[0-9a-f]{16}$" },
    "reason":     { "type": "string", "maxLength": 500 }
  },
  "required": ["handoff_id"]
}
```

The tool SHALL POST to `/handoffs/:id/cancel` with the caller's agent name as `by`. The hub SHALL accept the call if `by` equals the handoff's `from_agent` OR equals the configured human name.

#### Scenario: Sender cancels own pending handoff

- **GIVEN** a pending handoff `h_abc` with `from_agent=alice`
- **WHEN** alice calls `cancel_handoff({"handoff_id":"h_abc"})`
- **THEN** the handoff transitions to `status=cancelled`
- **AND** the event row records `actor=alice`

#### Scenario: Human cancels agent's pending handoff

- **GIVEN** a pending handoff with `from_agent=alice` and the human name is `mnw`
- **WHEN** the UI posts `/handoffs/:id/cancel` with `by=mnw`
- **THEN** the handoff transitions to `status=cancelled`
- **AND** the event row records `actor=mnw`

#### Scenario: Third-party agent cancel rejected

- **GIVEN** a pending handoff with `from_agent=alice`
- **WHEN** agent `carol` calls `cancel_handoff({"handoff_id":"h_abc"})`
- **THEN** the hub responds `403 { "error": "not the sender" }`

### Requirement: `POST /handoffs` creates a handoff

The hub SHALL accept `POST /handoffs` with a JSON body containing `from`, `to`, `task`, optional `context`, optional `ttl_seconds`. The hub SHALL validate the input, mint a handoff_id (`h_<16 hex>`), insert the creation event and the derived handoffs row in a single transaction, and return `201` with `{ "id": "<handoff_id>" }`. Invalid input SHALL return `400`. Unauthenticated calls SHALL return `401`. The body size cap for this endpoint is 1 MiB (not the default 256 KiB).

#### Scenario: Creation side-effects

- **GIVEN** an authenticated request with valid payload
- **WHEN** the hub handles `POST /handoffs`
- **THEN** one row is added to `events` and one to `handoffs`
- **AND** a `handoff.new` notification is pushed to the recipient's `/agent-stream`
- **AND** a `handoff.new` chat event is broadcast on `/stream`
- **AND** the response is `201 { "id": "h_..." }`

#### Scenario: Body up to 1 MiB accepted

- **WHEN** a client posts `/handoffs` with `Content-Length: 900000` and valid body
- **THEN** the hub accepts and processes the request

#### Scenario: Body above 1 MiB rejected

- **WHEN** a client posts `/handoffs` with `Content-Length: 1200000`
- **THEN** the hub responds `413` without reading the body

#### Scenario: Context serialization too large rejected

- **WHEN** a client posts `/handoffs` where the `context` JSON serializes to > 1 MiB
- **THEN** the hub responds `400` with an error naming the `context` field

#### Scenario: Invalid `to` rejected

- **WHEN** a client posts `/handoffs` with a `to` that fails the agent-name regex
- **THEN** the hub responds `400 { "error": "invalid to" }`

### Requirement: `POST /handoffs/:id/accept` applies terminal-state policy

The hub SHALL accept `POST /handoffs/:id/accept` with body `{ by, comment? }`. The hub SHALL:

- Return `404` if no handoff exists with that id.
- Return `403 { "error": "not the recipient" }` if `by` ≠ `handoff.to_agent`.
- Return `200` with the existing snapshot if the handoff is already `status='accepted'` (idempotent retry).
- Return `409 { "error": "handoff already <status>" }` if the handoff is in any other terminal state (`declined`, `cancelled`, `expired`).
- Otherwise (handoff is `pending`): insert a `handoff.accepted` event, update the derived row, broadcast the state change with `version = new event seq`, and respond `200` with the new snapshot.

#### Scenario: Non-recipient accept rejected

- **GIVEN** a pending handoff with `to_agent=bob`
- **WHEN** an authenticated client posts `/handoffs/:id/accept` with `by=carol`
- **THEN** the hub responds `403 { "error": "not the recipient" }`
- **AND** no event is written

#### Scenario: Accept after accepted is idempotent

- **GIVEN** a handoff already `status=accepted`
- **WHEN** bob retries `/accept`
- **THEN** the hub responds `200` with the existing resolution
- **AND** no second event is written

#### Scenario: Accept on declined handoff → 409

- **GIVEN** a handoff with `status=declined`
- **WHEN** bob posts `/accept`
- **THEN** the hub responds `409 { "error": "handoff already declined" }`
- **AND** no event is written

### Requirement: `POST /handoffs/:id/decline` requires reason and applies terminal-state policy

The hub SHALL accept `POST /handoffs/:id/decline` with body `{ by, reason }`. `reason` is required; absence yields `400`. Authorization: recipient only (`by = handoff.to_agent`, otherwise `403`). Terminal-state policy:

- Idempotent (200 with existing snapshot) if the handoff is already `status='declined'`.
- `409 { "error": "handoff already <status>" }` if the handoff is `accepted`, `cancelled`, or `expired`.
- Otherwise: insert a `handoff.declined` event, update the row with the new reason, broadcast, respond `200` with the new snapshot.

#### Scenario: Decline without reason rejected

- **WHEN** an authenticated request hits `/handoffs/:id/decline` with body missing `reason`
- **THEN** the hub responds `400 { "error": "reason required" }`

#### Scenario: Decline by recipient resolves handoff

- **GIVEN** a pending handoff `h_abc` with `to_agent=bob`
- **WHEN** bob posts `/handoffs/h_abc/decline` with `{ "by":"bob", "reason":"already busy" }`
- **THEN** the hub inserts a `handoff.declined` event
- **AND** the handoffs row becomes `status=declined, decline_reason="already busy"`

#### Scenario: Decline on accepted handoff → 409

- **GIVEN** a handoff with `status=accepted`
- **WHEN** bob posts `/decline` with a valid reason
- **THEN** the hub responds `409 { "error": "handoff already accepted" }`

### Requirement: `POST /handoffs/:id/cancel` applies terminal-state policy

The hub SHALL accept `POST /handoffs/:id/cancel` with body `{ by, reason? }`. Authorization: `by` must equal `handoff.from_agent` OR the configured human name; otherwise `403`. Terminal-state policy:

- Idempotent (200 with existing snapshot) if the handoff is already `status='cancelled'`.
- `409 { "error": "handoff already <status>" }` if the handoff is `accepted`, `declined`, or `expired` — you cannot cancel a handoff that has already resolved.
- Otherwise: insert a `handoff.cancelled` event, update the row with the cancellation reason and `cancelled_by=<by>`, broadcast, respond `200` with the new snapshot.

The endpoint is directly reachable via `curl` with a valid bearer token; this is the v1 exercise path for human-override cancellation (no UI originates-from-human form yet):

```bash
TOKEN=$(cat ~/Library/Application\ Support/A2AChannel/hub.token)
HUB=$(cat  ~/Library/Application\ Support/A2AChannel/hub.url)
HUMAN=$(# read from get_human_name or config; default "human")
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d "{\"by\":\"$HUMAN\",\"reason\":\"override\"}" \
     "$HUB/handoffs/h_xyz/cancel"
```

#### Scenario: Cancel by non-sender, non-human rejected

- **GIVEN** a pending handoff with `from_agent=alice` and human name `human`
- **WHEN** an authenticated client posts `/handoffs/:id/cancel` with `by=bob`
- **THEN** the hub responds `403 { "error": "not the sender" }`

#### Scenario: Cancel on accepted handoff → 409

- **GIVEN** a handoff with `status=accepted`
- **WHEN** the sender posts `/cancel`
- **THEN** the hub responds `409 { "error": "handoff already accepted" }`
- **AND** no event is written

#### Scenario: Cancel after cancel is idempotent

- **GIVEN** a handoff already `status=cancelled`
- **WHEN** the sender retries `/cancel`
- **THEN** the hub responds `200` with the existing cancellation snapshot

#### Scenario: Human overrides via curl (v1 exercise path)

- **GIVEN** a pending handoff with `from_agent=alice` and the human name is `human`
- **WHEN** an authenticated curl request posts `/cancel` with `by=human`
- **THEN** the hub accepts, inserts `handoff.cancelled` with `actor=human`, and the handoffs row records `cancelled_by=human`

### Requirement: `GET /handoffs` returns a filtered list

The hub SHALL accept `GET /handoffs` with optional query parameters `status` (one of `pending`, `accepted`, `declined`, `expired`, `cancelled`, `all`; default `pending`), `for` (agent name; returns rows where `to_agent=<for> OR from_agent=<for>`), and `limit` (integer 1..1000, default 100). The hub SHALL return `200` with a JSON array of handoff snapshots (each including the `version` field) ordered by `created_at_ms` descending.

#### Scenario: Default query returns all pending

- **WHEN** an authenticated client calls `GET /handoffs`
- **THEN** the response is `200` with an array of all rows where `status=pending`
- **AND** each row includes a `version` field

#### Scenario: Filter by agent and status

- **WHEN** an authenticated client calls `GET /handoffs?for=alice&status=cancelled`
- **THEN** the response contains only cancelled handoffs where alice is `from_agent` or `to_agent`

### Requirement: Handoff notifications carry kind, handoff_id, and version as channel attributes

When the hub pushes a `handoff.new` or `handoff.update` notification into an agent's `/agent-stream`, `channel-bin` SHALL forward it as a `notifications/claude/channel` notification with `kind`, `handoff_id`, `version`, `from`, `to`, `expires_at_ms`, `status` (for `handoff.update`), and `replay` (for replayed events) as channel `meta` entries. The notification `content` SHALL be the JSON serialization of the handoff snapshot.

#### Scenario: Agent sees handoff.new attributes

- **GIVEN** a handoff created as `from=alice, to=bob, task="T"` with event seq 42
- **WHEN** bob's `channel-bin` receives the notification
- **THEN** the forwarded `notifications/claude/channel` params include `meta` with `kind="handoff.new"`, `handoff_id`, `version="42"`, `from="alice"`, `to="bob"`, `expires_at_ms`, and `replay="false"`
- **AND** the `content` string parses as JSON equal to the snapshot

### Requirement: The UI renders handoff cards with per-role actions

When the webview receives a `handoff.new` or `handoff.update` SSE event on `/stream`, the UI SHALL render a card (or update an existing one keyed by `handoff_id`). Card contents: sender → recipient, task, context (collapsible if non-empty), status badge, time-until-expiry for pending, version. Action buttons SHALL be rendered conditionally:

- `Accept` and `Decline` buttons when the handoff is `pending` and `to_agent` equals the configured human name.
- `Cancel` button when the handoff is `pending` and `from_agent` equals the configured human name.

Clicking `Accept` / `Decline` / `Cancel` SHALL call the matching `/handoffs/:id/<action>` endpoint via `authedFetch` with `by` set automatically to the value returned by `get_human_name` at bootstrap; the human SHALL NOT be prompted for their own identity. `reason` SHALL be prompted (via a lightweight modal) for `Decline` (required field) and `Cancel` (optional field).

#### Scenario: Card appears on handoff.new

- **WHEN** the webview receives a `handoff.new` SSE event addressed to the human
- **THEN** a card is appended to the message stream with Accept/Decline buttons

#### Scenario: Card updates in place on handoff.update

- **GIVEN** a card already rendered for `h_abc`
- **WHEN** the webview receives `handoff.update` for `h_abc` with higher `version` and `status=accepted`
- **THEN** the existing card's status badge updates to "Accepted"
- **AND** action buttons are hidden
- **AND** no duplicate card is added

#### Scenario: Out-of-order handoff.update with lower version ignored

- **GIVEN** a card has been updated to `version=10, status=accepted`
- **WHEN** a delayed `handoff.update` arrives with `version=7, status=pending` for the same `handoff_id`
- **THEN** the card is not reverted; the older event is discarded
