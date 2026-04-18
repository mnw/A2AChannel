## Why

Messages in A2AChannel are free text. Agents parse prose to figure out what a peer wants — "lgtm", "go ahead", "wait till migration lands" — which is brittle and loses information at every hop. Coordination patterns that need more than one bit of state (who owns what, did they accept, why did they decline) leak into ad-hoc conventions that differ per prompt, per session, per agent.

Adding a structured-message transport with a first concrete kind (`handoff`) turns coordination from "prose-parsing" into "protocol". Agents emit and consume typed JSON. The app renders each kind as a rich UI card. The pattern becomes machine-actionable without losing any of today's free-form channel.

This is also the feature that makes A2AChannel meaningfully different from an MCP message bus: the bus moves text, the app now moves *typed coordination primitives* with durable state and a human in the loop.

## What Changes

- **New durable ledger** at `~/Library/Application Support/A2AChannel/ledger.db` (SQLite) alongside `config.json` / `hub.url` / `hub.token`. Holds an immutable event log plus a derived current-state table for handoffs.
- **Human becomes a first-class roster member.** Default name `human`, overridable via `config.json` → `{ "human_name": "mnw" }`. The hub registers this identity at startup; it can be `@mention`ed, queried (`GET /handoffs?for=human`), and named as a handoff `from`/`to` with no special-casing. The chat-routing keyword `to: "you"` (used by free-text `post`) is retained for backward compatibility but is no longer how structured messages identify the human.
- **Four new MCP tools** in `channel-bin`: `send_handoff(to, task, context?, ttl_seconds?)`, `accept_handoff(handoff_id, comment?)`, `decline_handoff(handoff_id, reason)`, `cancel_handoff(handoff_id, reason?)`. Plus the existing `post` tool, unchanged. Each tool's MCP schema directly encodes its required fields — the decline tool requires `reason` at the schema level, so role prompts can call it without needing to remember conditional validation.
- **Five new HTTP endpoints** on the hub, all token-gated:
  - `POST /handoffs` — create (body cap 1 MiB to accommodate diffs in `context`).
  - `POST /handoffs/:id/accept` — recipient accepts.
  - `POST /handoffs/:id/decline` — recipient declines with a reason.
  - `POST /handoffs/:id/cancel` — sender (or the human) withdraws a pending handoff.
  - `GET /handoffs` — query by status / agent (read).
- **Five handoff statuses**: `pending` (transient), plus four terminal states `accepted`, `declined`, `expired`, `cancelled`.
- **New SSE event kinds** on `/stream`: `handoff.new` and `handoff.update`. Each snapshot carries a `version` field equal to the event seq that produced that state. UI reconciles by `handoff_id`, keeping the highest version seen.
- **New notification shape** pushed to `channel-bin` (via `/agent-stream`) for structured messages: `<channel kind="handoff.new" handoff_id="..." version="...">{...payload...}</channel>`. Agents reconcile by `(handoff_id, version)` exactly as the UI does.
- **Reconnect replay** for protocol state only — when an agent reconnects to `/agent-stream`, the hub pushes any `pending` handoffs where `to_agent = <them>` or `from_agent = <them>` as `handoff.new` notifications with `replay=true`. Chat log remains non-replayed.
- **Background expiry sweep** every 5 seconds (cheap indexed query): pending handoffs past their `expires_at` transition to `expired` with a `handoff.expired` event and a broadcast. Sweep is explicit, not computed on read.
- **UI cards** for handoffs: pending cards show task + context + expiry countdown; Accept/Decline buttons when the configured human is the recipient; Cancel button when the human is the sender (feature-complete on the backend, optional UI surface for v1 since human-originated handoffs are a separate future scope).
- **`hub-request-safety` modification**: auth requirement and body-size cap extended to the new `/handoffs` endpoints. `POST /handoffs` uses a 1 MiB cap; the other mutating handoff endpoints use the default 256 KiB cap.

**Explicit non-goals for this change:** multi-recipient handoffs ("first claimer wins"), handoff amendment after creation, structured messages originated *from* the human via the UI (accept/decline/cancel are already supported; creating a new handoff via UI is deferred), and all other structured-message kinds (`proposal`, `question`, `review_request`, `status`). The ledger is designed so those land without a top-level schema migration.

## Capabilities

### New Capabilities
- `protocol-ledger`: Durable, append-only event log plus derived current-state tables for typed protocol messages. Owns the event/state model, the expiry sweep, the reconnect-replay mechanism, the database lifecycle, and the version/ordering contract for broadcasts.
- `agent-handoffs`: The handoff-specific lifecycle (including cancel), validation rules, MCP tool surface, HTTP endpoints, and notification shapes. Sits on top of `protocol-ledger`.

### Modified Capabilities
- `hub-request-safety`: The new `POST /handoffs` (1 MiB cap), `POST /handoffs/:id/accept`, `POST /handoffs/:id/decline`, `POST /handoffs/:id/cancel`, and `GET /handoffs` endpoints are added to the auth-required set.

## Impact

- **Code**:
  - `src-tauri/src/lib.rs` — resolve ledger DB path, resolve human name from config, pass both to sidecar via `A2A_LEDGER_DB` and `A2A_HUMAN_NAME` env, expose `get_human_name` Tauri command.
  - `hub/hub.ts` — open `bun:sqlite` database, migrate schema, register the human identity in the roster at startup (never stale-cleaned), add `/handoffs` routes, add 5-second expiry sweep, extend `handleAgentStream` to push replay on connect, add new SSE event kinds with `version` field, extend `requireJsonBody` call sites to parameterize the cap.
  - `hub/channel.ts` — add four MCP tools (`send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff`), parse structured channel notifications, forward to the model via `notifications/claude/channel` preserving `kind`, `handoff_id`, `version`, and other attributes as channel `meta`.
  - `ui/index.html` — read human name from `get_human_name` Tauri command at bootstrap; use it as the UI's identity in Accept/Decline/Cancel requests; add handoff card renderer with version-based reconciliation; render cards for `handoff.new` / `handoff.update`.
- **APIs**: new HTTP endpoints, new SSE event kinds, new MCP tools, new Tauri command. Existing routes unchanged.
- **Filesystem**: new file `~/Library/Application Support/A2AChannel/ledger.db` (+ `-wal` / `-shm` WAL sidecars while running). Mode `0600`.
- **Dependencies**: none added. `bun:sqlite` is built into Bun.
- **Documentation**: `README.md` gains a "Protocol messages" section above "What it does". `CLAUDE.md` hard rules add the ledger file path, the atomicity rule (event + state update in one transaction), the version/ordering contract, and the token-identity caveat.
- **Known limitation, documented explicitly**: the bearer token in `hub.token` is shared across all `channel-bin` processes spawned against this hub. The `by` field on ack/decline/cancel endpoints is validated against the handoff's expected actor (recipient for ack/decline, sender or human for cancel), but the check is non-cryptographic — anyone with the token can claim any `by`. This inherits the trust model of `POST /post` (which already trusts `from` unchecked). Not a regression; worth naming so future hardening has a clear target.
- **Backwards compatibility**: agents that don't call the new tools see zero behavior change. Free-text chat unchanged. The ledger file not existing on first launch is normal — created + migrated on startup.
