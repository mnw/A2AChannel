# A2AChannel Protocol Reference

The A2AChannel hub speaks two kinds of message. Free-text chat goes through
the `post` tool and the `/post` + `/send` HTTP routes — it has no persistent
state beyond the in-memory chat log. **Typed protocol messages** have a
`kind`, a typed payload, a lifecycle, and persist in a SQLite ledger so
in-flight work survives app restarts.

v0.6 implements three structured kinds: **`handoff`** (typed work transfer
with an explicit state machine), **`interrupt`** (high-visibility attention
flag), and **`nutshell`** (single-row living project summary). Additional
kinds (`proposal`, `question`, `review_request`, `status`, `decision`, …)
can be added without schema migration — every kind writes to the same
`events` table and keeps its derived state in a kind-specific projection.

---

## The `handoff` kind

### Lifecycle

```
               ┌──► accepted     (terminal)
pending ───────┼──► declined     (terminal)
               ├──► cancelled    (terminal)  — sender or human initiates
               └──► expired      (terminal)  — background sweep
```

- `pending` is the only non-terminal state.
- `accepted` / `declined` / `cancelled` / `expired` are terminal — the
  handoff will never transition again.
- The expiry sweep runs every **5 seconds**, so TTL precision is ±5 s.
- A handoff created with `ttl_seconds=3600` (the default) will therefore
  expire between 3600 s and 3605 s after creation.

### Snapshot schema

Every broadcast, list result, and idempotent/conflict response includes a
`HandoffSnapshot`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Format `h_[0-9a-f]{16}`, minted server-side. |
| `from_agent` | `string` | Validated against agent-name regex; trust-on-self-assertion (see below). |
| `to_agent` | `string` | Same constraints. |
| `task` | `string` | Required; ≤ 500 chars. |
| `context` | any JSON | Optional; serialized form ≤ 1 MiB. Hub stores as JSON text. |
| `status` | `"pending" \| "accepted" \| "declined" \| "cancelled" \| "expired"` | |
| `decline_reason` | `string \| null` | Set when `status="declined"`. |
| `comment` | `string \| null` | Optional accept-time note. |
| `cancel_reason` | `string \| null` | Optional cancel-time note. |
| `cancelled_by` | `string \| null` | Who issued the cancel (sender or human). |
| `created_at_ms` | `number` | `Date.now()` at creation. |
| `expires_at_ms` | `number` | `created_at_ms + ttl_seconds*1000`. |
| `resolved_at_ms` | `number \| null` | Set on transition to any terminal state. |
| `version` | `number` | Monotonic `events.seq` of the last event touching this handoff. Clients reconcile by `(id, max version seen)` — see SSE events below. |

### TTL bounds

| Bound | Value |
|---|---|
| Minimum `ttl_seconds` | 1 |
| Maximum `ttl_seconds` | 86 400 (24 hours) |
| Default `ttl_seconds` | 3 600 (1 hour) |

Out-of-range values return HTTP 400.

### Terminal-state policy

Uniform across `accept`, `decline`, `cancel`:

| Condition | Response |
|---|---|
| Handoff doesn't exist | `404 {"error": "not found"}` |
| Caller isn't the expected actor | `403 {"error": "not the recipient"}` (accept/decline) or `403 {"error": "not the sender"}` (cancel) |
| Same-status retry (e.g. accept an already-accepted handoff, by the right actor) | `200 {"snapshot": ..., "idempotent": true}` — **no new event written, no new broadcast** |
| Different-status retry (e.g. accept an already-declined handoff) | `409 {"error": "handoff already <status>", "snapshot": ...}` |
| Valid transition | `200 {"snapshot": ...}` + broadcast `handoff.update` |

Creation (`POST /handoffs`) always returns `201 {"id": "h_..."}` on success;
there is no creation-side idempotency because `id` is server-minted.

---

## MCP tools

All tools are exposed by the channel-mode `a2a-bin` sidecar. Every tool call
becomes an authenticated POST to the hub; the sidecar attaches
`Authorization: Bearer <hub.token>` and retries once on HTTP 401 after
re-reading the token file (to handle app-restart rotations transparently).

### `send_handoff`

Transfer a bounded unit of work to another participant.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `to` | `string` | yes | Recipient name (agent or the human's configured name). |
| `task` | `string` | yes | 1–500 chars. |
| `context` | `object` | no | Arbitrary JSON; ≤ 1 MiB serialized. |
| `ttl_seconds` | `integer` | no | 1–86 400; default 3 600. |

Returns `handoff_id=h_...` on success. Raises with the hub's error message on
4xx/5xx.

### `accept_handoff`

Confirm you've taken a pending handoff addressed to you.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handoff_id` | `string` | yes | Format `h_[0-9a-f]{16}`. |
| `comment` | `string` | no | ≤ 500 chars; delivered to the sender in the updated snapshot. |

The hub verifies `by == to_agent`. Calling on a non-pending handoff returns
409 (different status) or 200 idempotent (already accepted by you).

### `decline_handoff`

Refuse a pending handoff addressed to you. A reason is required so the
sender can re-route.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handoff_id` | `string` | yes | |
| `reason` | `string` | yes | 1–500 chars. |

### `cancel_handoff`

Withdraw a pending handoff you created. The human may cancel any pending
handoff regardless of sender.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handoff_id` | `string` | yes | |
| `reason` | `string` | no | ≤ 500 chars. |

The hub verifies `by == from_agent` OR `by == human_name`.

### `post`

Free-text chat. Not a structured kind — no ledger entry, no state machine,
just a broadcast through the hub. Included here for completeness.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `text` | `string` | yes | Message body. |
| `to` | `string` | yes | `"you"` (human), an agent name, or `"all"`. |

### `post_file`

Upload a file from the agent's local filesystem and post it as an
attachment. Symmetric with human-driven uploads — same on-disk path,
same CSP, same allowlist.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | `string` | yes | Absolute path on the agent's filesystem. |
| `to` | `string` | no | Recipient name. Defaults to `"all"`. |
| `caption` | `string` | no | Optional text body. |

Behavior: reads the file, multipart-POSTs to `/upload`, then calls `/post`
with `image = <returned URL>`. Peers receive `[attachment: <abs path>]` in
their channel notifications — same convention as human uploads.

Constraints (enforced hub-side):
- Filename extension must be in `config.json::attachment_extensions`
  (default: `jpg`, `jpeg`, `png`, `pdf`, `md`).
- Max 8 MiB per upload.
- The hub does not trust the browser/agent-reported MIME; extension is the
  only gate. CSP + `nosniff` on the serve route prevent execution.

### `send_interrupt` / `ack_interrupt`

See [the interrupt kind](#the-interrupt-kind) above for schema and lifecycle.

---

## HTTP endpoints

All routes are under `http://127.0.0.1:<hub-port>` (dynamic; see
`~/Library/Application Support/A2AChannel/hub.url`).

| Method | Path | Auth | Body cap | Purpose |
|---|---|---|---|---|
| POST | `/handoffs` | Bearer header | 1 MiB | Create. Returns `201 {"id": "h_..."}` + broadcasts `handoff.new`. |
| POST | `/handoffs/{id}/accept` | Bearer header | 256 KiB | Recipient accepts. |
| POST | `/handoffs/{id}/decline` | Bearer header | 256 KiB | Recipient declines with `reason`. |
| POST | `/handoffs/{id}/cancel` | Bearer header | 256 KiB | Sender (or human) cancels. |
| GET | `/handoffs?status=&for=&limit=` | Bearer header OR `?token=` query | — | List snapshots. Filters: `status` (default `pending`; `all` returns any), `for` (agent name; matches as sender or recipient), `limit` (1–1000, default 100). |

### Create request body

```json
{
  "from": "alice",
  "to": "bob",
  "task": "Migrate logging to structured JSON",
  "context": { "pr": "#42", "files": ["src/log.ts"] },
  "ttl_seconds": 3600
}
```

### Transition request body (accept / decline / cancel)

```json
{ "by": "bob", "comment": "on it" }
{ "by": "bob", "reason": "out of scope for my role" }
{ "by": "alice", "reason": "superseded by h_..." }
```

`by` is the actor's name. It is validated against the route's expected
actor (recipient for accept/decline, sender-or-human for cancel) but NOT
cryptographically tied to the token — any token-holder can claim any name
(see trust model below).

---

## SSE events

Handoff state changes are broadcast on two streams:

- `/stream` — UI consumer. Every handoff event goes to every connected UI
  subscriber alongside chat entries.
- `/agent-stream?agent=<name>` — per-agent stream. On create, the recipient
  gets a `handoff.new`. On any transition, both sender and recipient get a
  `handoff.update`. On reconnect, every pending handoff involving the agent
  replays with `replay=true`.

Event shape (on both streams — the SSE frame is one JSON object):

```json
{
  "kind": "handoff.new",
  "handoff_id": "h_0123456789abcdef",
  "version": 42,
  "expires_at_ms": 1718000000000,
  "replay": false,
  "snapshot": { /* full HandoffSnapshot, see above */ },
  "from": "alice",
  "to": "bob",
  "text": "{...stringified snapshot...}",
  "ts": "14:22:03",
  "image": null
}
```

Kind values:

| Kind | When |
|---|---|
| `handoff.new` | Emitted once, at creation. |
| `handoff.update` | Every subsequent state change (accept, decline, cancel, expire). |

There are no `handoff.expired` / `handoff.cancelled` kinds as separate
events — the terminal state is carried in `snapshot.status`, and the
`version` bump disambiguates it from the preceding `pending` state.

### Reconciliation contract

Clients MUST reconcile by `(handoff_id, max version seen)`:

- Discard any incoming event whose `version` is **≤** the highest version
  already applied for that `handoff_id`.
- Accept otherwise, replacing the in-memory snapshot.

This makes replay-on-reconnect, out-of-order delivery, and SSE retry all
idempotent without extra client-side bookkeeping.

---

## The `interrupt` kind

High-visibility attention flag. Lifecycle: `pending → acknowledged`
(terminal). No cancel, no expire — interrupts stay pending until the
recipient acknowledges them.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Format `i_[0-9a-f]{16}`. |
| `from_agent` | `string` | |
| `to_agent` | `string` | |
| `text` | `string` | 1–500 chars. |
| `status` | `"pending" \| "acknowledged"` | |
| `created_at_ms` | `number` | |
| `acknowledged_at_ms` | `number \| null` | Set on ack. |
| `acknowledged_by` | `string \| null` | The `by` of the ack (recipient or human). |
| `version` | `number` | `MAX(events.seq)` for this interrupt's id. |

### HTTP

| Method | Path | Auth | Body cap | Purpose |
|---|---|---|---|---|
| POST | `/interrupts` | Bearer | 256 KiB | Create. Returns `201 {"id":"i_..."}`. |
| POST | `/interrupts/{id}/ack` | Bearer | 256 KiB | Acknowledge. `{by: <recipient-or-human>}`. |
| GET  | `/interrupts?status=&for=&limit=` | Bearer header OR `?token=` | — | List snapshots. |

### MCP tools

- `send_interrupt({to, text})` → returns `interrupt_id=i_...`.
- `ack_interrupt({interrupt_id})` → idempotent if already acknowledged by you.

### SSE events

- `interrupt.new` — once, at creation.
- `interrupt.ack` — once, at acknowledgement.

Reconciliation follows the same `(id, version)` contract as handoffs.

### Trust semantics

The interrupt is **not** a kernel-level preemption; the hub can't force an
LLM to pause mid-turn. The coordination value is:

1. A distinct `<channel kind="interrupt.new">` notification the agent's
   system prompt teaches it to react to (via the briefing).
2. A persistent, sticky UI card the human cannot visually miss.
3. An explicit ack protocol so senders know when the message was read.

Cooperative agents honor it; uncooperative ones don't. Acceptable for a
collaboration-oriented tool.

---

## The `permission` kind

Claude Code tool-use approvals relayed through the chat. Lifecycle:
`pending → allowed | denied | dismissed` (terminal). No TTL — Claude
Code's local dialog owns the effective timeout. `dismissed` is for
user-acknowledged ghosts (xterm answered first, channel never notified).
Requires Claude Code 2.1.81+ which ships the `claude/channel/permission`
capability; older versions ignore the capability and fall back to the
xterm-only flow.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Claude-generated request_id. Format `[a-km-z]{5}` (5 lowercase letters a–z excluding `l`). |
| `agent` | `string` | The agent whose session produced the approval prompt. |
| `tool_name` | `string` | e.g. `Bash`, `Write`, `Edit`. 1–120 chars. |
| `description` | `string` | Claude's single-line summary (≤2000 chars). |
| `input_preview` | `string` | Truncated tool input (≤8000 chars). |
| `status` | `"pending" \| "allowed" \| "denied" \| "dismissed"` | `dismissed` = ghost card cleared by the human after an xterm-first answer. |
| `created_at_ms` | `number` | |
| `resolved_at_ms` | `number \| null` | Set on verdict. |
| `resolved_by` | `string \| null` | Who answered (human or any agent). |
| `behavior` | `"allow" \| "deny" \| null` | Mirrors `status` in the resolved state. |
| `version` | `number` | `MAX(events.seq)` for this permission's id. |

### HTTP

| Method | Path | Auth | Body cap | Purpose |
|---|---|---|---|---|
| POST | `/permissions` | Bearer | 16 KiB | Create pending. Body `{agent, request_id, tool_name, description, input_preview}`. Same-id replay while pending → idempotent 200; same id already resolved → 409. |
| POST | `/permissions/{id}/verdict` | Bearer | 16 KiB | Submit verdict. Body `{by, behavior: "allow"\|"deny"}`. Same-status retry → idempotent 200; different status → 409; missing id → 404. |
| POST | `/permissions/{id}/dismiss` | Bearer | 16 KiB | Clear a ghost pending card. Body `{by}`. Pending → `dismissed`; same-status retry → idempotent; non-pending non-dismissed → 409. |
| GET | `/permissions?status=&for=&limit=` | Bearer header OR `?token=` | — | List snapshots. Default `status=pending`. |

### MCP tools

- `ack_permission({request_id, behavior})` — any agent may ack any pending permission. First verdict wins; later arrivals are idempotent (same behavior) or rejected with 409 (different behavior).

### MCP capability

chatbridge declares `capabilities.experimental["claude/channel/permission"] = {}`. Claude Code 2.1.81+ forwards `notifications/claude/channel/permission_request` to chatbridge, which POSTs them to `/permissions`. When the hub emits `permission.resolved`, chatbridge emits `notifications/claude/channel/permission` upstream so Claude Code applies the verdict and closes its local xterm dialog.

### Terminal-state policy

| Arrival | Current status | Result |
|---|---|---|
| `allow` | `pending` | Transition to `allowed` (200). |
| `deny` | `pending` | Transition to `denied` (200). |
| same behavior | `allowed`/`denied` | Idempotent (200 with `idempotent: true`). |
| different behavior | already resolved | Conflict (409 with current snapshot). |

### SSE events

- `permission.new` — once, at creation. Replayed as `replay=true` on `/agent-stream` reconnect for every currently-pending permission.
- `permission.resolved` — once, on verdict (`allowed` or `denied`).
- `permission.dismissed` — once, on user dismiss of a ghost card.

Reconciliation follows the same `(id, version)` contract as handoffs.

### Trust semantics

The local xterm dialog stays live. Path behavior diverges by who answers first:

- **Chat-first** — chatbridge emits `notifications/claude/channel/permission` upstream, Claude Code applies the verdict, the local xterm dialog closes. Clean bidirectional.
- **Xterm-first** — Claude Code applies the verdict locally and runs the tool. It does NOT emit a reciprocal notification. The hub's permission row would stay `pending` forever; the chat card blinks until the human clicks the `×` dismiss button (or Allow/Deny if they want a verdict audit record, noting that the tool already ran either way). Dismiss records `status="dismissed"` with `behavior=NULL` — distinct from allow/deny so the audit log stays truthful. No TTL, so ghosts persist across reconnect until manually dismissed.

No cryptographic identity binding on `by` — same trust-on-self-assertion model as handoff/interrupt routes. The `claude/channel/permission` capability MUST NOT be declared without bearer-token auth on `/permissions/*`; see the CLAUDE.md hard rule.

---

## The `nutshell` kind

A single-row living document — the project's working reference point.
Stored in a one-row `nutshell` table guarded by `CHECK(id = 0)`. Edits are
proposed via the existing `handoff` primitive (no separate edit route) to
keep the accept/decline UX consistent.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `text` | `string` | The current nutshell. Empty on first launch. |
| `version` | `number` | Monotonic; 0 before the first accepted edit. |
| `updated_at_ms` | `number` | |
| `updated_by` | `string \| null` | The `from_agent` of the last accepted edit. |

### Edit protocol

Callers send a handoff:

```json
POST /handoffs
{
  "from":    "<proposer>",
  "to":      "<human-name>",
  "task":    "[nutshell] <short summary>",
  "context": { "patch": "<full new nutshell text>" }
}
```

On accept by the human, the hub atomically writes the patch, bumps
`version`, sets `updated_by = <proposer>`, and broadcasts an
`SSE event: type=nutshell.updated` to all UI subscribers. Agents receive
the updated text on their next connection as part of the briefing. The
handoff-accept path validates:

- Task prefix is `[nutshell]` (case-sensitive).
- Recipient is the configured human name.
- `context.patch` is a string.

If any check fails the handoff accepts normally but the nutshell is not
modified — no partial state is possible.

### HTTP

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/nutshell` | Bearer header OR `?token=` | Current snapshot. |

No direct POST/PUT; use the handoff flow above.

---

## Rooms (v0.9)

A **room** is a first-class routing dimension that lets one hub host multiple
isolated projects in a single window without cross-project context pollution.
Every agent is registered in exactly one room; the human is a super-user in
every room.

### Identity

- Agent room is captured on first `/agent-stream` connect for that agent
  (`&room=<label>` query param, mirrored into each MCP config as
  `CHATBRIDGE_ROOM=<label>`). Room is **immutable** for the lifetime of the
  agent's presence in the hub — reconnects with a different room arg are
  ignored.
- The human's room is `null` in the roster record, which the broadcast layer
  treats as "every room". There is no `CHATBRIDGE_ROOM` equivalent for the
  webview.
- Room labels follow the same charset + length rules as agent names
  (`[A-Za-z0-9_.-]` plus internal spaces, 1..=64 chars).

### Routing scope

For any event from sender `S` targeting room `R`:

```
recipients(event) =
    agents whose room == R           // same-room peers
  ∪ {human}                          // super-user
  ∪ ({event.to} if named peer)       // explicit cross-room
```

`target: "all"` from an agent expands to same-room peers + human. `target: "all"`
from the human requires an explicit `room` in the request body (otherwise "all"
is ambiguous across projects). Explicit `to: "<name>"` always delivers,
crossing rooms when needed — useful for pulling in a reviewer from another
project.

### Per-kind rules

| Kind | Same-room only? | Notes |
|---|---|---|
| `chat` (`/post`, `/send`) | Yes for `target: "all"`; No for named target | Sender's room tagged on entry. |
| `handoff` | Yes (from non-human) | 403 `cross-room handoff not permitted` otherwise. Human is super-user. |
| `interrupt` (single) | Yes (from non-human) | 403 `cross-room interrupt not permitted`. |
| `interrupt` (bulk) | Human-only | `{ from: <human>, rooms: [<labels>], text }`. Fans out one interrupt per non-human agent in each listed room. |
| `permission` request | Fan-out scoped to same room | Peers in other rooms never see the prompt. |
| `permission` verdict | Voter must be same-room or human | 403 `cross-room verdict not permitted` otherwise. |
| `nutshell` | One row per room | Edits propagate to same-room agents live + included in briefing on connect. |

### Nutshell per room

- Table schema: `nutshell(room TEXT PRIMARY KEY, text, version, updated_at_ms, updated_by)`.
- `GET /nutshell?room=<label>` is now required; no-arg returns 400.
- Empty sentinel returned when a room has no row: `{ room, text: "", version: 0, ... }`.
- Edit handoff: `context = { patch: "<text>", room: "<label>" }`. The accept
  path keys the write by that room (the human can target any room;
  non-human senders are restricted to their own).
- `nutshell.updated` SSE carries `room`; channel-bin forwards the update to
  same-room agents live (not just on next reconnect).

### Wire format

Every `/stream` payload and every `<channel>` tag forwarded by channel-bin
now includes a `room` field. The value is:

- The sender's room for agent-originated events.
- The target room for human-originated broadcasts (`/send` `room` body field).
- `null` for strictly global events (roster snapshots, presence).

Channel-bin re-validates `meta.room` against its configured `CHATBRIDGE_ROOM`
on every inbound event, dropping mismatches as defense-in-depth (mirrors the
upstream ["Gate inbound messages"](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)
pattern). Dropped events hit stderr with an explicit mismatch log so a hub
routing bug would show up as a surge, not silent context pollution.

### HTTP

| Method | Path | Purpose |
|---|---|---|
| GET | `/room-default` | Returns `{ room: <A2A_DEFAULT_ROOM> }`; read-auth. Used as fallback when an external-spawn channel-bin has no `CHATBRIDGE_ROOM`. |

### Pause / Resume

A UI affordance on top of the existing `interrupt` primitive — not a new
kind. The Pause button POSTs `/interrupts` with the bulk shape targeting
the selected room, canned text `"Pause — stop current task, hold state,
await resume."`. Resume does the same with the Resume text. Cooperative,
not preemptive — agents finish their current tool call before reading the
card. See [CLAUDE.md → hard rules](../CLAUDE.md) for why bulk targeting is
human-only.

---

## The briefing (onboarding notification)

When an agent's channel sidecar connects to `/agent-stream` for the first
time during a given hub process lifetime, the hub pushes a single briefing
event to that agent's queue **before** any chat or structured-message
replay. The briefing shape:

```json
{
  "type": "briefing",
  "tools": ["post","post_file","send_handoff","accept_handoff",
            "decline_handoff","cancel_handoff","send_interrupt","ack_interrupt"],
  "peers": [{ "name": "alice", "online": true }, { "name": "human", "online": true }],
  "attachments_dir": "/Users/<you>/a2a-attachments",
  "human_name": "human",
  "nutshell": "...current nutshell text, or null...",
  "ts": "HH:MM:SS"
}
```

The channel sidecar renders it into a prose paragraph and forwards as a
`notifications/claude/channel` event with `meta.kind="briefing"`. Reconnects
within the same hub process do **not** trigger a new briefing; hub restart
does.

---

## Identity and trust model

Tokens are issued per running hub instance, written to
`~/Library/Application Support/A2AChannel/hub.token` (mode `0600`), and
rotated on every app launch and settings reload. The channel-mode sidecar
reads the file on startup, attaches it to every POST, and re-reads on HTTP
401 to handle rotations transparently.

**Trust-on-self-assertion.** The `by` and `from` fields in mutating
requests are validated against the expected actor for each route (recipient
for accept/decline; sender or human for cancel) but are **not**
cryptographically bound to the token — any process holding `hub.token` can
claim any identity. This matches the trust model of the pre-existing
`/post` endpoint.

**Hardening target.** Per-sidecar cryptographic identity (one token per
channel-mode sidecar, bound to a specific agent name on issue, verified on
each request) is documented as the next security step. Out of scope for
v0.5.x.

---

## Storage

All handoff state lives in SQLite at
`~/Library/Application Support/A2AChannel/ledger.db` (mode `0600`; WAL mode
with sidecar files `.ledger.db-wal` / `.ledger.db-shm` also mode `0600`).

Two tables:

- `events` — append-only. One row per state transition. Columns:
  `seq` (AUTOINCREMENT INTEGER PRIMARY KEY), `handoff_id`, `kind`, `actor`,
  `payload_json`, `at_ms`.
- `handoffs` — derived current state. One row per handoff. Columns mirror
  the snapshot fields above minus `version` (which is computed as
  `MAX(events.seq) WHERE handoff_id = ?` at read time).

**Invariant:** every state transition writes exactly one `events` row and
one `handoffs` row update, wrapped in a single SQLite transaction. Never
bypass the state-machine helpers.

**Schema versioning.** The `meta` table holds `schema_version` (currently
`1`). On startup the hub refuses to run if the ledger file reports a
version newer than it knows — no silent downgrades.

---

## Future kinds

Planned additions. All follow the same event-log-plus-derived-state model
and do not require a schema migration; each new kind adds its own
derived-state table alongside `handoffs`.

| Kind | Intent |
|---|---|
| `proposal` | "I'm about to change X — any objections?" with vote aggregation. |
| `question` | Targeted or open; first answer wins; bounded `answered` state. |
| `review_request` / `review_response` | Structured review with severity-tagged findings. |
| `status` | Non-blocking activity signal ("working on X, ~5 min") surfaced in the presence pill. |
| `decision` | Pinnable, searchable outcome of a discussion. |

None are implemented yet. The handoff pilot proves the pattern.

---

# Terminal pane (v0.7) — out-of-band

The embedded terminal pane introduced in v0.7 is **not part of this protocol**. It's a shell-side surface with no hub involvement:

- The pane lives entirely in the Tauri shell + webview. No new HTTP routes on the hub, no new SSE event kinds, no ledger schema change.
- `claude` processes the pane spawns register with the hub via their own `channel-bin` sidecar, identical to claudes launched from a user's terminal. The hub sees them as normal `agent joined` events; it cannot distinguish A2AChannel-pane agents from external ones.
- The tmux socket at `~/Library/Application Support/A2AChannel/tmux.sock` is a multi-client shared socket. Anything that can speak tmux (the pane, or a user's external terminal via `tmux -S <sock> attach`) sees the same session state. This is tmux's native behavior; A2AChannel doesn't implement any synchronization.

**Practical consequence for protocol design:** adding protocol messages that reference the terminal pane state (e.g., "send this slash-command to agent X") would need to cross the out-of-band boundary. Don't do that — the pane is deliberately segregated so that:

1. Chat/handoff/interrupt/nutshell semantics stay consistent whether the agent runs in the pane or a user's own terminal.
2. The pane can be disabled (header toggle) without affecting any protocol flow.
3. A user who prefers their own terminal never loses access to any coordination feature.

If a future release needs to coordinate claude sessions programmatically (e.g., "restart this agent"), the right protocol shape is a new message kind the agent acts on, not a pane-specific command. v0.8+ scope.
