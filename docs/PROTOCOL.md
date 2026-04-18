# A2AChannel Protocol Reference

The A2AChannel hub speaks two kinds of message. Free-text chat goes through
the `post` tool and the `/post` + `/send` HTTP routes — it has no persistent
state beyond the in-memory chat log. **Typed protocol messages** have a
`kind`, a typed payload, a lifecycle, and persist in a SQLite ledger so
in-flight work survives app restarts.

The first and currently only implemented kind is `handoff`. The protocol is
designed so additional kinds (`proposal`, `question`, `review_request`,
`status`, `decision`, …) can be added without schema migration — every kind
writes to the same `events` table and keeps its derived state in a
kind-specific projection.

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
