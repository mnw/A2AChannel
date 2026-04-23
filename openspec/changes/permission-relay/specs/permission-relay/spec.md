## ADDED Requirements

### Requirement: chatbridge declares the `claude/channel/permission` capability

The chatbridge MCP server (`hub/channel.ts`) SHALL declare `capabilities.experimental['claude/channel/permission'] = {}` in its `Server` constructor, in addition to the existing `claude/channel` capability. This opts the channel in to receive `notifications/claude/channel/permission_request` events from Claude Code 2.1.81+ and signals to Claude that permission verdicts emitted by this channel are authoritative.

chatbridge SHALL NOT declare this capability if the hub's bearer-token auth on mutating routes is disabled or removed. Sender gating via `hub.token` is the precondition for trusting verdicts that originate from the channel.

#### Scenario: Capability is declared at startup

- **WHEN** chatbridge boots with Claude Code 2.1.81 or later
- **THEN** its `capabilities.experimental` map contains both `claude/channel: {}` and `claude/channel/permission: {}`
- **AND** Claude Code's MCP startup log records the channel as permission-relay-capable

#### Scenario: Pre-2.1.81 Claude Code ignores the capability

- **GIVEN** Claude Code 2.1.80 or earlier
- **WHEN** chatbridge boots and declares `claude/channel/permission: {}`
- **THEN** Claude Code ignores the capability silently
- **AND** chatbridge continues to function as a two-way channel without permission relay
- **AND** approval prompts continue to render only in the local xterm dialog

### Requirement: chatbridge forwards `permission_request` notifications to the hub

chatbridge SHALL register a notification handler for `notifications/claude/channel/permission_request` (validated against a Zod schema mirroring the upstream contract: `request_id` string matching `^[a-km-z]{5}$/i`, `tool_name`, `description`, `input_preview`). On receipt, chatbridge SHALL POST the request to the hub's `POST /permissions` endpoint with an authenticated bearer token, including `{ agent: AGENT, request_id, tool_name, description, input_preview }`.

On network or HTTP error from the hub, chatbridge SHALL log the failure but SHALL NOT retry — the local terminal dialog remains open, the human can still answer there.

#### Scenario: Claude requests Bash approval, chatbridge forwards

- **GIVEN** a claude session with chatbridge loaded
- **WHEN** claude calls a `Bash` tool that requires approval
- **THEN** Claude Code emits `notifications/claude/channel/permission_request` with a new request_id
- **AND** chatbridge's handler POSTs to the hub's `/permissions` with the five fields
- **AND** the hub returns 201 Created with the permission's status="pending"
- **AND** the hub broadcasts a `permission.new` SSE event

#### Scenario: Hub unreachable — local dialog unaffected

- **GIVEN** the hub is temporarily unreachable (network error or 5xx)
- **WHEN** claude emits a `permission_request` and chatbridge tries to POST to `/permissions`
- **THEN** chatbridge logs the failure to stderr
- **AND** the user can still answer the approval in the local xterm dialog
- **AND** no retry loop fires (upstream has its own timeout)

### Requirement: Hub routes for permission lifecycle

The hub SHALL expose three HTTP routes, all requiring bearer-token auth:

- `POST /permissions` — creates a pending permission record. Body: `{ agent, request_id, tool_name, description, input_preview }`. All fields required. Body size cap 16 KiB. Response 201 with the created snapshot; 409 if the `request_id` already exists in a non-pending state.
- `POST /permissions/:request_id/verdict` — submits a verdict. Body: `{ by, behavior: "allow" | "deny" }`. 200 on first successful resolution; 200 (idempotent) on same-status retry; 409 on different-status retry; 404 if the id is unknown.
- `GET /permissions` — lists permissions with optional `?status=pending|allowed|denied|all`, `?for=<agent>`, `?limit=<n>` query params. Used by the UI on bootstrap and reconcile.

The hub SHALL broadcast `permission.new` on create and `permission.resolved` on verdict, via both `/stream` (UI) and EVERY non-permanent agent's `/agent-stream`. The fan-out is symmetric — all peer chatbridges receive the event so any agent can relay a verdict via `ack_permission` without additional discovery. Each broadcast includes a `version` field sourced from the `events.seq` monotonic counter.

Same-transaction invariant from structured-handoff applies: each state change writes exactly one `events` row and one `permissions` update in a single SQLite transaction.

#### Scenario: Successful approval from chat UI

- **GIVEN** a pending permission for agent `alice` with id `abcde`
- **WHEN** the human clicks Allow on the UI card
- **THEN** the UI POSTs to `/permissions/abcde/verdict` with `{ by: "human", behavior: "allow" }`
- **AND** the hub transitions the permission to `status="allowed", behavior="allow", resolved_by="human"`
- **AND** a `permission.resolved` event fires on `/stream` with the new snapshot
- **AND** alice's `/agent-stream` receives the same event (so chatbridge can relay it upstream)
- **AND** the hub response is 200 with the resolved snapshot

#### Scenario: Double-verdict is idempotent or conflicts

- **GIVEN** a permission already resolved as `allowed`
- **WHEN** another `POST /permissions/:id/verdict` arrives with `{ behavior: "allow" }`
- **THEN** the hub returns 200 with `{ snapshot, idempotent: true }` (same-status retry)
- **WHEN** instead it arrives with `{ behavior: "deny" }`
- **THEN** the hub returns 409 with `{ error: "permission already allowed", snapshot }`

#### Scenario: Unknown request_id

- **WHEN** a verdict arrives for a `request_id` the hub has no record of
- **THEN** the hub returns 404 with `{ error: "not found" }`

### Requirement: chatbridge relays resolved verdicts back to Claude

chatbridge SHALL tail the agent's `/agent-stream` (as it already does for handoff/interrupt events) for `permission.resolved` events. On receipt, chatbridge SHALL emit `notifications/claude/channel/permission` with `{ request_id, behavior }` back to Claude Code, so Claude can apply the verdict and close the local dialog.

If the verdict arrives after Claude's local dialog has already been answered, Claude's verdict de-duplication (request_id lookup on the upstream side) SHALL silently drop the duplicate; no error is logged.

#### Scenario: Chat-first verdict closes the local dialog

- **GIVEN** Claude has a pending `Bash` approval showing in both the xterm (local) and the A2AChannel UI (chat)
- **WHEN** the human clicks Allow in the UI first
- **THEN** the hub broadcasts `permission.resolved`
- **AND** chatbridge emits `notifications/claude/channel/permission` to Claude
- **AND** Claude applies the verdict, proceeds with the Bash call
- **AND** the local xterm dialog closes automatically

#### Scenario: Terminal-first answer leaves a ghost pending card, cleared via dismiss

- **GIVEN** the same pending permission
- **WHEN** the human answers Y in the xterm before anyone clicks in the UI
- **THEN** Claude applies the verdict locally and proceeds with the tool call
- **AND** Claude does NOT emit a reciprocal `notifications/claude/channel/permission` through the channel (verified behavior in Claude Code 2.1.x)
- **AND** the hub's permission row stays `pending` indefinitely (no TTL)
- **WHEN** the human clicks the card's `×` dismiss button
- **THEN** the hub transitions the row to `status="dismissed"` via `POST /permissions/:id/dismiss`
- **AND** the card drops out of the sticky pinned area

The dismiss primitive is the primary user-facing fix for xterm-first ghosts. A future auto-detection mechanism (chatbridge observes its own MCP transcript and auto-dismisses when it sees the tool-use actually executed) may reduce the manual-click burden but is out of scope for v0.8.

### Requirement: `dismiss` terminal state for xterm-first ghost cards

The permission state machine SHALL include a `dismissed` terminal state alongside `allowed` and `denied`, reachable from `pending` via `POST /permissions/:id/dismiss`. The hub exposes the route:

- `POST /permissions/:id/dismiss` — body `{ by }`. Transitions `pending → dismissed`. Terminal-state policy: same-status retry → idempotent 200; non-pending-and-not-dismissed → 409; unknown id → 404.

Dismissed records preserve the audit trail (an events row with `kind='permission.dismissed'` is written alongside the row update in the same transaction) but indicate "outcome unknown, no longer tracking" — distinct from `allowed` (tool was permitted to run) and `denied` (tool was blocked). The `behavior` column remains `NULL` on dismissed rows since no verdict was recorded.

The hub broadcasts `permission.dismissed` on transition via both `/stream` and every non-permanent agent `/agent-stream`. Chatbridge SHALL NOT emit `notifications/claude/channel/permission` on receipt of a `permission.dismissed` event — there is no verdict to relay upstream and Claude Code's local state already reflects whatever the user did in the xterm.

The primary use case is clearing the "ghost card" left behind when a user answers Claude Code's approval prompt in the embedded xterm before the chat UI. Claude Code does not emit a reciprocal channel notification in that path, so the hub row would otherwise stay `pending` forever.

#### Scenario: Human clears a ghost card

- **GIVEN** a pending permission for agent `alice` (id `abcde`) whose xterm approval was already answered locally (ghost)
- **WHEN** the human clicks the `×` button on the chat card
- **THEN** the UI POSTs to `/permissions/abcde/dismiss` with `{ by: "human" }`
- **AND** the hub transitions the row to `status="dismissed", behavior=null, resolved_by="human"`
- **AND** a `permission.dismissed` event fires on `/stream` and all agent streams
- **AND** chatbridge ignores the event (no upstream notification)
- **AND** the card transitions out of its sticky state and drops into the chat timeline as grey/dim

#### Scenario: Dismiss on an already-resolved record conflicts

- **GIVEN** a permission already resolved as `allowed`
- **WHEN** `POST /permissions/:id/dismiss` arrives
- **THEN** the hub returns 409 with `{ error: "permission already allowed", snapshot }`

#### Scenario: Dismiss on a dismissed record is idempotent

- **GIVEN** a permission already dismissed
- **WHEN** another dismiss request arrives
- **THEN** the hub returns 200 with `{ snapshot, idempotent: true }`

### Requirement: Ledger schema v4 adds a `permissions` table

The hub's `migrateLedger` SHALL include a `schema_version 3 → 4` migration that creates a `permissions` table:

```sql
CREATE TABLE permissions (
  id              TEXT PRIMARY KEY,
  agent           TEXT    NOT NULL,
  tool_name       TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  input_preview   TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK(status IN ('pending','allowed','denied')),
  created_at_ms   INTEGER NOT NULL,
  resolved_at_ms  INTEGER,
  resolved_by     TEXT,
  behavior        TEXT    CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
);
CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
```

and updates `meta.schema_version` to `4`. The migration is additive — no existing tables are modified.

A v0.7 ledger opened by v0.8 code SHALL auto-migrate; a v0.8 ledger opened by v0.7 code SHALL remain readable (the new table is not referenced by v0.7, nor is v0.7 expected to read v0.8 data — downgrade is best-effort rollback).

#### Scenario: Upgrade from v0.7

- **GIVEN** a v0.7 ledger with `schema_version=3` (claude_sessions migration already applied)
- **WHEN** v0.8 opens the ledger via `openLedger()`
- **THEN** `migrateLedger` detects `current < 4`
- **AND** creates the `permissions` table and updates `schema_version` to `4`
- **AND** the migration runs inside one `db.transaction`
- **AND** existing handoffs/interrupts/nutshell/claude_sessions rows are preserved byte-identically

#### Scenario: Downgrade to v0.7

- **GIVEN** a v0.8 ledger that includes a `permissions` table
- **WHEN** v0.7's `openLedger` opens it
- **THEN** v0.7 reads `schema_version=4` and emits a warning via `migrateLedger` ("ledger newer than this binary; refusing to downgrade")
- **AND** v0.7 refuses to proceed — this matches existing downgrade protection

### Requirement: `ack_permission` MCP tool on chatbridge

chatbridge SHALL expose a new MCP tool named `ack_permission` with this input schema:

```json
{
  "type": "object",
  "properties": {
    "request_id": { "type": "string", "pattern": "^[a-km-z]{5}$" },
    "behavior": { "enum": ["allow", "deny"] }
  },
  "required": ["request_id", "behavior"]
}
```

The tool's handler SHALL POST to the hub's `/permissions/:request_id/verdict` with `{ by: AGENT, behavior }`. The agent identity is the calling sidecar's `CHATBRIDGE_AGENT` env — not separately validated. This matches the trust-on-self-assertion pattern of existing accept_handoff/decline_handoff/cancel_handoff tools.

The onboarding briefing (from the `agent-onboarding` capability) SHALL include `ack_permission` in its tool-list, so agents know the tool exists.

#### Scenario: Agent acknowledges another agent's permission

- **GIVEN** agent `alice` has a pending `Bash` permission
- **AND** agent `reviewer` is online in the same room
- **WHEN** `reviewer` calls `ack_permission({ request_id: "abcde", behavior: "allow" })`
- **THEN** chatbridge POSTs to `/permissions/abcde/verdict` with `{ by: "reviewer", behavior: "allow" }`
- **AND** the hub resolves the permission with `resolved_by="reviewer"`
- **AND** the SSE broadcast's snapshot shows `resolved_by="reviewer"` so the UI can credit the approver

#### Scenario: Unknown request_id from agent

- **WHEN** an agent calls `ack_permission` with a `request_id` the hub has no record of
- **THEN** the hub returns 404
- **AND** chatbridge throws "ack_permission failed: 404 not found" back to the calling claude

### Requirement: UI renders pending permissions as sticky red cards at the top of the chat

The A2AChannel UI SHALL render pending permissions as sticky cards at the top of `#messages`, above any interrupt cards, with the same structural grid and state-badge treatment as handoff/interrupt cards. Each card SHALL include:

- Header: `<agent> · <tool_name>` route line, `PENDING` / `ALLOWED` / `DENIED` status badge, replay-badge on reconnect.
- Body: the `description` field, styled as the primary text of the card.
- Detail: `input_preview` in a monospace block.
- Actions: `Allow` (orange, primary) and `Deny` (red, secondary) buttons. On click, POST to `/permissions/:id/verdict`. On success, the hub's broadcast reconciles the card into a resolved state.

Resolved cards (`status != pending`) SHALL lose the blinking-border animation, show the verdict badge, display `resolved by <actor>`, and drop back into chronological position in the timeline.

Multiple pending permissions SHALL stack newest-at-top of the pending block.

#### Scenario: Pending card renders

- **GIVEN** a `permission.new` event arrives on the UI's SSE stream
- **WHEN** `renderPermissionCard(event)` runs
- **THEN** a sticky card appears at the top of `#messages` above interrupt cards
- **AND** the card header shows `alice · Bash` with a pulsing red PENDING badge
- **AND** Allow and Deny buttons are active

#### Scenario: Clicking Allow resolves the card

- **WHEN** the human clicks Allow on a pending card
- **THEN** the UI calls `authedFetch('/permissions/abcde/verdict', { method: 'POST', body: JSON.stringify({ by: HUMAN_NAME, behavior: 'allow' }) })`
- **AND** on 200, the card optimistically transitions to status="allowed" (the SSE broadcast reconciles if it diverges)
- **AND** the button set disappears
- **AND** the card unsticky's from the top and takes its chronological slot

#### Scenario: Multiple concurrent permissions stack

- **GIVEN** two agents each hit a permission approval within seconds
- **WHEN** both `permission.new` events arrive
- **THEN** both cards render, newest at the top of the pending stack
- **AND** answering one does not affect the other; each resolves independently

### Requirement: Reconnect replay for pending permissions

On `/agent-stream` reconnect for agent X, the hub SHALL replay every currently-pending permission (regardless of which agent requested it, flagged `replay=true` in the SSE event) so every reconnecting chatbridge lands with complete visibility of the room's approval backlog and can call `ack_permission` autonomously.

On `/stream` connect for the UI, the hub SHALL similarly replay all pending permissions (across all agents) so the UI bootstraps its sticky-card state from hub truth.

#### Scenario: chatbridge reconnects with pending permission

- **GIVEN** alice has a pending permission and chatbridge's SSE tail drops
- **WHEN** chatbridge reconnects to `/agent-stream?agent=alice`
- **THEN** the hub emits the pending permission as a `permission.new` event with `replay=true`
- **AND** chatbridge treats the replay identically to a fresh request (it just re-emits to claude; claude's request_id de-duplication handles the double-render cleanly)
