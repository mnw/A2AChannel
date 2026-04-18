## 1. Rust shell — ledger path + human name

- [x] 1.1 Add `fn ledger_file() -> PathBuf` returning `<app_data_dir>/ledger.db`.
- [x] 1.2 Extend `AppConfig` with `human_name: Option<String>` (serde rename to `human_name`).
- [x] 1.3 Add `fn resolve_human_name() -> String`: prefer config override, default `"human"`, validate against reserved words (`you`, `all`, `system`) and agent-name regex; panic with clear error on invalid.
- [x] 1.4 Store resolved human name in `HubState` (new `human_name: Mutex<Option<String>>`).
- [x] 1.5 Add `#[tauri::command] fn get_human_name` returning the stored name.
- [x] 1.6 Register the new command in `generate_handler!`.
- [x] 1.7 Pass env vars to sidecar: `A2A_LEDGER_DB=<ledger path>` and `A2A_HUMAN_NAME=<human name>`.

## 2. Hub — database open + schema migration

- [x] 2.1 Import `bun:sqlite`; open `Database(process.env.A2A_LEDGER_DB, { create: true })`.
- [x] 2.2 Set `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON`.
- [x] 2.3 `chmod 0o600` on the DB file and on `-wal` / `-shm` sidecars once present.
- [x] 2.4 Migration runner: check `meta.schema_version`; apply `v1` if missing.
- [x] 2.5 Migration `v1`: create `events(seq INTEGER PK AUTOINCREMENT, handoff_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL, at_ms INTEGER NOT NULL)` plus index `(handoff_id, seq)` and `(actor, at_ms)`.
- [x] 2.6 Migration `v1` continued: create `handoffs(id TEXT PK, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, task TEXT NOT NULL, context_json TEXT, status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','cancelled','expired')), decline_reason TEXT, comment TEXT, cancel_reason TEXT, cancelled_by TEXT, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER)` plus indexes `(status, expires_at_ms)`, `(to_agent, status)`, `(from_agent, status)`, `(created_at_ms)`.
- [x] 2.7 Migration `v1` continued: create `meta(key TEXT PK, value TEXT NOT NULL)`; seed `schema_version=1`, `ledger_id=<random hex>`, `created_at_ms=<now>`.
- [x] 2.8 If `schema_version > 1` (future), log error and disable protocol routes; leave `/agents`, `/presence`, `/stream`, `/agent-stream` intact.

## 3. Hub — human registration in roster

- [x] 3.1 Read `A2A_HUMAN_NAME` at startup; fail loud if missing.
- [x] 3.2 Add a `permanentAgents: Set<string>` to hub state; populate with `HUMAN_NAME`.
- [x] 3.3 `ensureAgent(HUMAN_NAME)` at startup.
- [x] 3.4 Modify stale-cleanup logic to skip `permanentAgents` members.
- [x] 3.5 Verify existing queries/broadcasts/validations treat `HUMAN_NAME` identically to any other agent (sanity-check `handlePost`, `handleSend`, `handleAgentStream`, `validName`).

## 4. Hub — state machine helpers

- [x] 4.1 `mintHandoffId()` → `h_<16 hex chars>` via `crypto.getRandomValues`.
- [x] 4.2 `createHandoff({ from, to, task, context, ttl_seconds })`: in a transaction, insert `events(kind='handoff.created')`, insert `handoffs` row with `status='pending'`, capture event `seq` as `version`; return snapshot.
- [x] 4.3 `acceptHandoff(id, by, comment?)`: recipient-only check; idempotent-on-terminal; insert `events(kind='handoff.accepted')`, update row with `status='accepted', comment=...`; return snapshot with new version.
- [x] 4.4 `declineHandoff(id, by, reason)`: recipient-only check; idempotent-on-terminal; insert `events(kind='handoff.declined')`, update row with `status='declined', decline_reason=...`.
- [x] 4.5 `cancelHandoff(id, by, reason?)`: authorization = (by == from_agent) OR (by == HUMAN_NAME); idempotent-on-terminal; insert `events(kind='handoff.cancelled')`, update row with `status='cancelled', cancel_reason=..., cancelled_by=by`.
- [x] 4.6 `expireHandoff(id)` used by the sweep: `actor='system'`, `kind='handoff.expired'`, same transaction pattern.
- [x] 4.7 `listHandoffs({ status?, for?, limit })`: parameterized SELECT with the documented filter semantics.
- [x] 4.8 `snapshotHandoff(id)` helper: returns handoff row joined with its latest event seq as `version`.

## 5. Hub — HTTP routes

- [x] 5.1 `POST /handoffs` → auth + `requireJsonBody(req, 1 * 1024 * 1024)` (1 MiB cap); validate body (`from`, `to`, `task`, optional `context`, optional `ttl_seconds`); `createHandoff`; `broadcastHandoff('handoff.new', snapshot)`; respond `201 { id }`.
- [x] 5.2 `POST /handoffs/:id/accept` → auth + `requireJsonBody(req)` (default 256 KiB); parse/validate `id`; check `handoff_id` exists (404); call `acceptHandoff`; if not idempotent replay, broadcast `handoff.update`; respond `200 { snapshot }`.
- [x] 5.3 `POST /handoffs/:id/decline` → same structure; require `reason`; call `declineHandoff`.
- [x] 5.4 `POST /handoffs/:id/cancel` → same structure; `reason` optional; call `cancelHandoff`.
- [x] 5.5 `GET /handoffs` → auth only; parse `status`, `for`, `limit`; call `listHandoffs`; respond `200 [snapshot, ...]`.
- [x] 5.6 Register all five routes in the `fetch` switch using existing `requireAuth` and `requireJsonBody(req, max)` helpers.

## 6. Hub — broadcast helpers with version

- [x] 6.1 Add `broadcastHandoff(eventKind, snapshot)` where `eventKind ∈ {"handoff.new","handoff.update"}`. Writes one entry to `chatLog` with `kind`, `handoff_id`, `version` on top of the existing `from/to/text/ts/id` shape; pushes to all `uiSubscribers`; pushes a notification entry to affected agents' `agentQueues`.
- [x] 6.2 For `handoff.new`: push to recipient's agent queue. For `handoff.update`: push to both recipient's and originator's queues (each tolerates duplicate events via `version`).
- [x] 6.3 Entry shape on `agentQueues`: `{ kind, handoff_id, version, from, to, status, expires_at_ms, replay, text: JSON.stringify(snapshot) }` — the top-level fields let `channel.ts` forward them as `meta` without parsing body.
- [x] 6.4 Ensure `broadcastHandoff` entries get a monotonic `id` from `entrySeq` so existing SSE dedup on the UI keeps working; `version` is a separate field used for handoff-specific reconciliation.

## 7. Hub — expiry sweep at 5-second cadence

- [x] 7.1 `setInterval` at startup, fires every **5000 ms**, calls `runExpirySweep()`.
- [x] 7.2 `runExpirySweep()`: SELECT pending handoffs with `expires_at_ms < now`, iterate, call `expireHandoff(id)`, call `broadcastHandoff('handoff.update', ...)`.
- [x] 7.3 Clear the interval on process exit.

## 8. Hub — reconnect replay

- [x] 8.1 In `handleAgentStream` after `agentConnections.set(...)` and `broadcastPresence()`, call `replayPendingFor(agent, send)`.
- [x] 8.2 `replayPendingFor` queries `handoffs WHERE (to_agent=agent OR from_agent=agent) AND status='pending'`; for each, sends via `send(...)` with an entry shape matching the normal notification but with `replay=true`.
- [x] 8.3 Do NOT replay chat messages.

## 9. channel.ts — new MCP tools

- [x] 9.1 Extend `ListToolsRequestSchema` response with `send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff` tool descriptors per the specs.
- [x] 9.2 In `CallToolRequestSchema` handler, add `send_handoff` branch: validate args, POST `/handoffs` with `from=AGENT`, return text result containing the handoff_id.
- [x] 9.3 Add `accept_handoff` branch: POST `/handoffs/:id/accept` with `by=AGENT, comment?`.
- [x] 9.4 Add `decline_handoff` branch: POST `/handoffs/:id/decline` with `by=AGENT, reason`.
- [x] 9.5 Add `cancel_handoff` branch: POST `/handoffs/:id/cancel` with `by=AGENT, reason?`.
- [x] 9.6 All four retry once on 401 (existing token-rotation pattern).
- [x] 9.7 Update `tailHub` SSE frame parser: if an incoming agent-stream event has a `kind` starting with `handoff.`, forward via `notifications/claude/channel` with `kind`, `handoff_id`, `version`, `from`, `to`, `status`, `expires_at_ms`, `replay` as `meta` entries and the `text` field (already the JSON snapshot) as `content`.
- [x] 9.8 Update the `instructions` string so the agent knows: when to call `post` vs `send_handoff`, that decline must include a reason, that cancel reaches only own or human-originated handoffs.

## 10. UI — human name bootstrap

- [x] 10.1 In `bootstrap()`, after `invoke('get_hub_url')`, also `invoke('get_human_name')` and store in a new module-scope `HUMAN_NAME` variable.
- [x] 10.2 Update the legend pill for the human to render as `HUMAN_NAME` instead of `"you"`.
- [x] 10.3 Update `NAMES` seeding to map `HUMAN_NAME` → capitalized form.
- [x] 10.4 Keep `to: "you"` working in the `post` tool send path for backward compat (chat routing).

## 11. UI — handoff card renderer

- [x] 11.1 Extend SSE `handleEvent` dispatch: if `data.kind?.startsWith('handoff.')`, route to `renderHandoffCard(data)`; otherwise existing path.
- [x] 11.2 `renderHandoffCard(event)`: key by `handoff_id`; apply version reconciliation (`seenVersions: Map<string, number>`); ignore events with `version <= seenVersions[handoff_id]`.
- [x] 11.3 Card DOM: sender → recipient, task, context (collapsible `<details>` when non-empty), status badge, time-until-expiry for pending.
- [x] 11.4 Conditional action rendering:
  - Accept/Decline buttons when `status=pending` AND `to === HUMAN_NAME`.
  - Cancel button when `status=pending` AND `from === HUMAN_NAME`.
  - Otherwise no buttons.
- [x] 11.5 Accept click: `authedFetch('/handoffs/' + id + '/accept', POST, { by: HUMAN_NAME })`.
- [x] 11.6 Decline click: small prompt/modal for reason; on submit `authedFetch('/handoffs/' + id + '/decline', POST, { by: HUMAN_NAME, reason })`.
- [x] 11.7 Cancel click: optional reason prompt; `authedFetch('/handoffs/' + id + '/cancel', POST, { by: HUMAN_NAME, reason? })`.
- [x] 11.8 Card CSS: Catppuccin palette, distinct left-border per status — mauve=pending, green=accepted, red=declined, peach=cancelled, overlay0=expired.

## 12. UI — countdown ticker

- [x] 12.1 Single `setInterval` at 1 s updates all visible pending-card countdown labels.
- [x] 12.2 Label format: `3m 42s left` / `12s left` / `expired`.
- [x] 12.3 Exit early when no pending cards are visible.

## 13. Documentation

- [x] 13.1 README: new "Protocol messages" section above "What it does"; include a short transcript of a handoff end-to-end.
- [x] 13.2 README runtime-files table: add row for `ledger.db` (mode `0600`, persistent, user-deletable).
- [x] 13.3 README config.json description: document `human_name` field.
- [x] 13.4 CLAUDE.md hard rules additions:
  - Every handoff state change writes exactly one event + one derived-table update in one SQLite transaction.
  - Handoff broadcasts carry a `version` (= event `seq`); clients reconcile by max version.
  - Handoff endpoints operate on **trust-on-self-assertion**: `by` / `from` are validated against the expected actor for the route, but not cryptographically verified. Any token-holder can claim any identity. Hardening target is per-sidecar tokens.
- [x] 13.5 README: add a "Trust model" subsection under Protocol messages that states the trust-on-self-assertion caveat in user-facing language, names the hardening target, and notes that this matches the existing `/post` trust model.

## 14. Verification

- [x] 14.1 Build via `./scripts/install.sh`. Confirm `~/Library/Application Support/A2AChannel/ledger.db` created with mode `0600`.
- [x] 14.2 `sqlite3 ~/Library/Application\ Support/A2AChannel/ledger.db '.schema'` confirms `events`, `handoffs`, `meta` tables with the specified columns.
- [x] 14.3 Register two agents (`alice`, `bob`). From alice: `send_handoff({to:"bob", task:"test task"})`. Confirm `201 { id }`.
- [ ] 14.4 Confirm the UI renders a handoff card in the chat stream.
- [ ] 14.5 Confirm bob receives a `<channel kind="handoff.new" version=…>` notification with the snapshot.
- [ ] 14.6 From bob: `accept_handoff({handoff_id})`. Card updates to "Accepted"; alice receives `handoff.update`.
- [ ] 14.7 Create, decline without reason → tool validation fails client-side.
- [ ] 14.8 Create, decline with reason → card shows decline reason, originator notified.
- [ ] 14.9 Create, cancel from sender → card shows cancelled with `cancelled_by=<sender>`.
- [x] 14.10 Create as alice→bob; cancel via **curl** with `by=<human_name>` (no UI required in v1) → card updates to cancelled with `cancelled_by=<human_name>` and originator receives `handoff.update`. Command used:
  ```bash
  curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
       -d "{\"by\":\"$HUMAN\",\"reason\":\"override\"}" "$HUB/handoffs/h_xyz/cancel"
  ```
- [x] 14.11 Third-party cancel attempt (carol cancelling alice→bob handoff) → `403`.
- [x] 14.12a Terminal-state policy tests: accept-after-declined → 409; decline-after-accepted → 409; cancel-after-accepted → 409; cancel-after-cancelled → 200 idempotent.
- [ ] 14.12 Accept a handoff twice → second call idempotent (same snapshot returned, no duplicate event rows in DB).
- [x] 14.13 Handoff with `ttl_seconds=60`; wait 70s; confirm transition to `expired` within ~5s of deadline (sweep cadence).
- [ ] 14.14 Kill bob's Claude session before ack; restart session; confirm `handoff.new` replay notification with `replay=true` delivered.
- [ ] 14.15 Version race test: emit two quick updates (e.g. accept + immediate new handoff) — confirm UI card shows final version's state.
- [x] 14.16 `POST /handoffs` with 1.1 MiB body → `413`. With 900 KiB valid body → `201`.
- [x] 14.17 `GET /handoffs?for=<human_name>&status=pending` returns handoffs where human is to_agent or from_agent.
- [ ] 14.18 Config override: set `human_name="mnw"` in config.json, relaunch; confirm legend pill, @mention autocomplete, and handoff `to` targeting all use "mnw".
- [x] 14.19 Invalid human name (`human_name="all"`) in config → Rust shell fails to start with a clear error.
