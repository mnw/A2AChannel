## Context

Coordination between Claude Code agents today routes through free-text messages. Every coordination pattern (handoff, proposal, question, status update) is re-invented per-conversation in natural language, and consumed by reading prose. That works for ambient chat; it doesn't work for operations where the receiver needs to take a specific, bounded action whose outcome the sender needs back programmatically.

The product framing shift: A2AChannel is not "chat with AI" — it's a **runtime for agent coordination patterns** with a chat surface for human participation. The first concrete pattern we're formalizing is **handoff**: agent A transfers work to agent B; B accepts or declines with reason; the sender (or the human) may cancel while pending; the hub auto-expires stale items; everyone involved is notified of every transition.

Everything that makes a handoff useful beyond "just a chat message" needs state: who sent it, who was supposed to receive it, is it still open, when does it expire, what was the disposition. That state has to survive a hub restart (the handoff was about work in flight; losing it silently is a correctness bug, not a UX bug). That's the wedge that brings persistence into the app for the first time — but **only for protocol state**, not for chat log.

Existing foundations this change sits on:
- Dynamic roster (`ensureAgent` / `removeAgent`, 15s stale cleanup). Handoffs reference agents by name, same model. The human is added as a permanent roster member in this change.
- Bearer-token auth on mutating routes. New endpoints slot into that policy unchanged.
- Hub-URL discovery + `hub.token`. Ledger DB location follows the same convention.
- `channel-bin`'s existing `notifications/claude/channel` stream. Extended with `kind` / `handoff_id` / `version` attributes, not replaced.

## Goals / Non-Goals

**Goals:**
- Introduce a transport for typed structured messages to and from agents.
- Ship `handoff` end-to-end as the first concrete kind: create, accept, decline, cancel, expire, reconnect-replay.
- Make the ledger a self-contained subsystem reusable for future kinds (`proposal`, `question`, `review_request`) without further schema migrations.
- Make the human a first-class roster identity so the same code paths route handoffs to/from the human with no "magic recipient" special cases.
- Preserve every existing behavior: free-text chat, presence, mentions, image storage, auth, SSE dedup, stale-agent cleanup.
- Maintain the "chat is ephemeral" invariant. Only protocol state persists.

**Non-Goals:**
- Other structured kinds. This change is handoff-only; additional kinds are separate changes.
- Multi-recipient / bidding handoffs.
- Handoff amendment. Cancel + re-send is the pattern.
- A UI form for *originating* handoffs from the human. Accept/Decline/Cancel from the UI are in scope; "New handoff…" dialog is deferred. The backend is fully ready for it (human is just another agent name), so this becomes a pure UI addition in a future change.
- Ledger export / backup / pruning. Rows stay forever in v1.
- Agent-side query tool ("list my pending handoffs" as an MCP tool). Agents receive pending items on reconnect replay; that's enough for v1.
- Thread-and-reply semantics for free-text chat.

## Decisions

### 1. Event log + derived state, not current-state-only

The ledger has two tables:

```
events         immutable, append-only, source of truth
handoffs       derived, updated within the same transaction as the event
```

**Why both:**
- Derived table gives O(1) reads for the hot queries ("pending handoffs for X", "what's in flight").
- Event log gives us audit + reconstruction + future queries without re-engineering the schema.
- Single transaction per state change keeps them consistent; losing the derived table is recoverable by replaying events.

**Why not only events:** computing "pending for X" from events requires scan-and-fold on every query, which is both slow and bug-prone.

**Why not only current state:** we lose the audit story. Reading it out of a versioned `handoffs` row gets gnarly fast.

### 2. SQLite via `bun:sqlite`

Zero new dependency — built into Bun. Synchronous API fits our single-process hub. WAL mode enabled for concurrent reads while writing.

**Alternative considered:** one JSON file per handoff. Rejected — reinventing query/index filtering.

### 3. ID shapes stay disjoint

- **Messages**: integer sequence (existing `entrySeq`).
- **Handoffs**: `h_<16 hex chars>`. Prefix declares the namespace; fixed length plays well with CSS/UI width.
- **Events**: integer `seq` in the ledger. Also surfaced as `version` on every handoff snapshot we broadcast (see decision 11).

### 4. Per-kind tools with self-contained schemas

Four tools exposed by `channel-bin`:

```
post(text, to)
  — free-text channel, unchanged.

send_handoff(to, task, context?, ttl_seconds?)
  — returns { handoff_id }. Creates the ledger row and fires notifications.

accept_handoff(handoff_id, comment?)
  — recipient path. No reason required.

decline_handoff(handoff_id, reason)
  — recipient path. `reason` is required at the MCP schema level —
    the schema declares it as required, so role prompts can call this
    tool confident they have to supply one. Decline becomes as cheap
    to call as accept, which matters for adoption.

cancel_handoff(handoff_id, reason?)
  — sender path. Withdraws a pending handoff. Reason optional.
```

**Why split accept and decline into distinct tools instead of one `ack_handoff(status, reason?)`:**
- Each tool has a self-contained JSON schema: accept's `comment` is optional; decline's `reason` is required. The MCP protocol enforces required-ness at the schema level; an agent can't call `decline_handoff` without a reason, and the model sees that rule in the tool listing. A single polymorphic tool would have to encode "required-when" logic in prose, which defeats the point.
- Symmetry: role prompts can say "call `decline_handoff` with your reason" without having to also say "and set status to 'declined' don't forget". Lower cognitive overhead == higher adoption.
- No cost on the wire — both tools still hit their respective HTTP endpoints and the hub does the same work.

**Why keep `post` as a separate free-text tool:** free-form chat is real and valuable; it doesn't want a schema.

### 5. HTTP endpoints symmetric with tools

Five new endpoints:

```
POST /handoffs                  create
POST /handoffs/:id/accept       recipient accepts
POST /handoffs/:id/decline      recipient declines
POST /handoffs/:id/cancel       sender (or human) cancels
GET  /handoffs                  query
```

**Why per-action endpoints instead of a single `/ack`:** same reasoning as the tool split — each endpoint's body schema is self-contained and validates its specific required fields. Zero ambiguity about which action is being taken. Cheaper to evolve.

**Single writer to the ledger**: `channel-bin` doesn't open the DB directly. It calls these endpoints on the hub, authenticated. The hub is the single process writing to the ledger, avoiding any multi-writer concurrency question.

**Why a GET endpoint for queries:** the webview wants to populate its pending-items view at startup; a separate query is cheaper than bundling it into the initial SSE snapshot, and supports future filtered views.

### 6. Human as first-class roster identity, not a magic string

The human participates in the protocol as another named agent. Default name `human`; overridden by `config.json`:

```json
{ "human_name": "mnw" }
```

The hub:
- Reads `A2A_HUMAN_NAME` env (set by Rust shell from config, default `"human"`).
- At startup, does `ensureAgent(humanName)` and marks that agent **permanent** (stale cleanup skips it).
- Treats that name identically to any other agent in every query, validation, and broadcast path.

The UI:
- Fetches the human name via a new `get_human_name` Tauri command during bootstrap.
- Uses that name as `by` on `/accept`, `/decline`, `/cancel` requests.
- Displays the name in the legend pill, the @mention autocomplete, etc.

**Why drop `to: "you"` as the handoff target for the human:**
- `"you"` is still a **chat-routing keyword** meaning "address the human" in the free-text `post` tool. That keyword stays for backward compat.
- For structured messages, using a magic string would mean: querying pending handoffs for the human requires special-casing (`WHERE to_agent = 'you' OR to_agent = <human_name>`); future human-originated handoffs need the magic unwrapped at the UI layer; the agent schema has to document the magic. None of that pays off.
- Treating the human as an agent in the roster collapses all those questions into the existing dynamic-roster machinery.

**Future-proofing:** when v2 adds a "New handoff" UI form, it becomes a pure UI addition — the `from=<human_name>` path is already legal at the protocol layer.

**Interaction with reserved names:** `you`, `all`, `system` remain reserved (can't be an agent name). `human` is *not* reserved — it's just the default value for `human_name`. Users can choose their own name, and a user whose name happens to match a reserved word gets a clear config error on startup.

### 7. Explicit expiry sweep, 5-second cadence

Pending → expired transition happens by background task, not on read. Every **5 seconds**:

```sql
BEGIN;
  -- indexed scan: WHERE status='pending' AND expires_at_ms < :now
  -- for each, insert event + update row
COMMIT;
-- broadcast each transition
```

**Why 5s not 30s:** the sweep query hits `idx_handoffs_status` and typically returns zero rows. At 5-second cadence it's still negligible CPU, and it removes a surprising 30-second latency from TTL semantics — a handoff with `ttl_seconds=60` should look expired within seconds of the deadline, not 30 seconds later. Sweep interval is a tuning knob; starting at 5s is a better default.

**Why explicit sweep, not lazy:** the sender needs timely notification when their handoff expires so they can re-route. Lazy expiry only fires when someone reads, leaving senders waiting on unrelated traffic.

**Why events written for expiry:** audit symmetry. A reader of `events WHERE handoff_id=X` sees four rows for any closed handoff (created + terminal), no inference required.

### 8. Cancel semantics

A pending handoff can transition to `cancelled` via `POST /handoffs/:id/cancel` when called by:
- `handoff.from_agent` — the sender retracts their own handoff.
- The configured human name — the human can retract any agent's pending handoff (human-in-the-loop override).

The event row records `actor=<caller>` so the audit log shows who cancelled. Reason is optional; when absent, the event payload is `{}`.

**Why the human can cancel on behalf of anyone:** the human is the supervisor, not a peer. Giving the human a "kill switch" for pending handoffs closes a failure mode where an agent opens a handoff, gets stuck, and can't self-retract.

**v1 UI surface:** because this change doesn't add a "human originates" UI, the Cancel button only appears on pending cards where `from=<human_name>`. In v1 no such handoffs exist, so the button never appears — but the backend support is complete and the UI ships the code for it. When v2 adds human-originated handoffs, the button is already wired.

**Terminal-state policy (applies uniformly to accept, decline, cancel):**

- Retrying the **same** terminal action on an already-in-that-state handoff is **idempotent** (200 with existing snapshot, no new event). Covers network-retry safety.
- Attempting a **different** terminal action on an already-terminal handoff returns **409 Conflict** with the current status named. E.g. accepting a declined handoff → 409. Canceling an accepted handoff → 409. No revival of closed handoffs by any path.

This policy is explicit in each endpoint's spec and uniformly enforced in the state-machine helpers. Racing operations (accept vs. cancel on the same handoff) resolve whoever writes first; the loser sees 409.

**v1 exercise path for cancel (no UI origination yet):** because this change doesn't add a "new handoff from human" form, the Cancel button only renders on cards where `from_agent = HUMAN_NAME` — which, in v1, is never. To exercise the backend end-to-end the `cancel` endpoint is reachable via `curl` with the bearer token and `by = <human_name>`. Documented as a verification step and in the README, so the feature isn't dead code until v2.

### 9. Reconnect replay scope: pending-only, same wire format

On `/agent-stream?agent=X` reconnect, after presence increment:

```sql
SELECT * FROM handoffs
WHERE (to_agent = X OR from_agent = X)
  AND status = 'pending';
```

Each row pushed as `handoff.new` with `replay=true`. Both recipient-side and sender-side pending items included (the sender wants to see in-flight work they've sent).

**Not replayed:** chat messages, resolved handoffs. Resolved items aren't actionable; the agent queries if curious.

### 10. SSE event ordering and version reconciliation

Every handoff snapshot broadcast (over `/stream` to the UI, or to any `/agent-stream` subscriber) carries a `version` field equal to the ledger's `event.seq` for the event that produced this state. Receivers MUST reconcile by `handoff_id`, keeping only the snapshot with the highest `version` seen. Events with a lower version are ignored.

**Why this matters:**
- Reconnect replay pushes pending snapshots with their *creation* version. The live stream may simultaneously push updates. Without version ordering, a stale pending snapshot could arrive after a live "accepted" and overwrite it.
- Network jitter, SSE reconnects, and the heartbeat loop can deliver events out of order under pathological conditions. Version reconciliation makes the client's view deterministic.

**Implementation cost:** one extra column in broadcasts, one compare-and-apply on the client. Trivial, and pays for itself the first time a race happens.

### 11. Wire format — channel notification for structured messages

Today:
```
<channel source="chatbridge" from="alice" to="bob" ts="10:05">text body</channel>
```

For structured messages:
```
<channel source="chatbridge" kind="handoff.new"
         handoff_id="h_abc123def456..." version="42"
         from="alice" to="bob" replay="false"
         expires_at_ms="1761823200000">
{"task":"migrate logging","context":{"files":["log.ts"]}}
</channel>
```

Meta attributes carry routing + protocol info; body is the JSON payload. Free-text messages unchanged.

### 12. Body-size cap carve-out for `POST /handoffs`

The general JSON body cap is 256 KiB (established in `hub-request-safety`). For `POST /handoffs` specifically, the cap is **1 MiB** — the `context` object will often carry diffs, API contracts, or other structured payloads that blow past 256 KiB in legitimate use. Other handoff endpoints (`/accept`, `/decline`, `/cancel`) use the default 256 KiB cap (their bodies are small by nature).

**Why not make `context` a reference to an already-uploaded file:** that defers the size problem to the upload path, which is already covered at 8 MiB. But it forces agents to do an upload-then-send dance for a common case ("here's the diff, please review"). Larger `/handoffs` cap is simpler for the pilot; we can revisit if handoffs routinely need more than 1 MiB.

### 13. Ledger placement + permissions

```
~/Library/Application Support/A2AChannel/
├── config.json           (existing)
├── hub.url               (existing, 0600)
├── hub.token             (existing, 0600)
└── ledger.db             (new, 0600)
    + ledger.db-wal       (WAL mode, 0600)
    + ledger.db-shm       (WAL mode, 0600)
```

Mode `0600` applied after create; WAL sidecars get the same mode if they exist after the first write.

## Risks / Trade-offs

- **[Shared token means ack-identity check is trust-on-self-assertion]** → The `by` field on ack/decline/cancel endpoints is validated against the handoff's expected actor, but any process holding `hub.token` can claim any `by`. Matches today's `/post` which trusts `from` unchecked. On a single-user loopback machine this is acceptable; for any multi-user or multi-host deployment the hardening target is **per-sidecar tokens** — each `channel-bin` process gets a unique token at spawn time, bound to a specific agent identity, and the hub validates that binding. Not in scope for this change. Documented in the `hub-request-safety` spec, the README, and CLAUDE.md so the upgrade path is visible.

- **[Ledger corruption]** → If `ledger.db` corrupts, the hub fails to open it. Mitigation: on open failure, rename to `.db.broken.<timestamp>` and start fresh, logging loudly. User loses pending handoffs; the app recovers. SQLite is robust; this is a rare tail case.

- **[Ledger growth is unbounded]** → ~200 bytes/event × ~10 events per active handoff per day × 365 days ≈ a few MB/year of continuous use. Not a real concern in v1; revisit with a pruning policy if it ever matters.

- **[Schema migrations]** → Payload JSON is flexible; column schema is not. Strategy: `meta.schema_version` row, bump on every release that changes columns, migrations run idempotently on open. Hook is in place from v1 (current version = 1); future renames will test it.

- **[Sweep cadence + CPU]** → 5s cadence; indexed query. Worst case a few hundred cycles per second when nothing to expire. Negligible.

- **[Human-name collision with reserved words]** → If a user sets `human_name` to `you`, `all`, or `system`, the hub refuses to start with a clear error. Cheap check; prevents silent weird behavior.

- **[Human-name change across sessions]** → If a user changes `human_name` between runs, old pending handoffs with the old name orphan: the hub no longer considers them addressed to the human. Two options: (a) log and let them expire; (b) rewrite the historical rows. v1 picks (a) — cleaner, reversible (just change the name back). Documented in the migration plan.

- **[Idempotent operations under network retry]** → If `channel-bin` retries an `accept_handoff` after a 5xx, the second call must not double-write events. Hub checks `if handoff.status != 'pending'` **before** starting the transaction; returns the existing resolution.

- **[Version reconciliation on the client adds complexity]** → One more piece of state (the `max_seen[handoff_id]` map). Small; pays for itself the first time a reconnect races with a live update.

## Migration Plan

1. User installs the new version.
2. On first launch: `hub-bin` opens `ledger.db`, runs initial migration (create tables, set `schema_version=1`). Nothing to migrate in.
3. Rust shell reads `human_name` from `config.json` (or uses `"human"` default); passes it to `hub-bin` via `A2A_HUMAN_NAME`. Hub registers the human in the roster as a permanent member.
4. Existing agents' chat stays unchanged. They can start calling the new tools whenever their operator decides.
5. UI bootstrap fetches `get_human_name` alongside `get_hub_url`; uses it for identity in ack/decline/cancel requests and in the legend.

Rollback: reinstall the prior DMG. Ledger file becomes stale/orphaned but harmless; user can delete manually.

## Open Questions

- **Default TTL.** 1 hour is a guess. Worth surveying actual use — fast handoffs want seconds, "review this PR by EOD" wants 8+ hours.
- **Sweep cadence lower bound.** 5s is the starting point. If handoffs with very short TTLs become common, could go as low as 1s without material CPU impact.
- **`handoff.update` granularity.** Current design emits one broadcast per state change. If we ever see high throughput, consider coalescing rapid sequential updates.
- **Should the sweep also expire handoffs whose recipient has been offline > N minutes?** Different trigger (agent-absence, not deadline). Probably yes eventually; defer to v2.
- **UI: inline cards vs. dedicated side panel.** v1 is inline; revisit if the chat stream feels cluttered with many pending cards.
