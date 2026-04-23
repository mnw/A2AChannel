## 1. Ledger schema_version 3 → 4 migration

- [ ] 1.1 Bump `LEDGER_SCHEMA_VERSION` to `4` in `hub/hub.ts`.
- [ ] 1.2 Add migration step: `ALTER TABLE agents ADD COLUMN room TEXT`; populate existing rows with `'default'`; add index on `(room, name)`.
- [ ] 1.3 Add migration step: `ALTER TABLE events ADD COLUMN room TEXT`; populate existing rows with `'default'`.
- [ ] 1.4 Add migration step: `ALTER TABLE handoffs ADD COLUMN room TEXT NOT NULL DEFAULT 'default'`; index on `(room, status, created_at_ms DESC)`.
- [ ] 1.5 Add migration step: `ALTER TABLE interrupts ADD COLUMN room TEXT NOT NULL DEFAULT 'default'`; index on `(room, status, created_at_ms DESC)`.
- [ ] 1.6 Add migration step for `nutshell`: rename the existing row (`id=0`) into `room='default'`; drop the `id` column and its `CHECK(id=0)` constraint; make `room` the primary key.
- [ ] 1.7 Verify downgrade protection still fires: v0.9 ledger opened by v0.8 code refuses with the existing "schema version newer than code" error. Manual test.
- [ ] 1.8 Smoke-test idempotency: re-running the migration on an already-migrated v4 ledger is a no-op.

## 2. Hub — agent roster with room

- [ ] 2.1 Extend `Agent` type to include `room: string | null` (null = human/super-user).
- [ ] 2.2 Update `ensureAgent(name, room)` to accept and persist the room on first registration; ignore room on subsequent reconnects.
- [ ] 2.3 Register the human at startup with `room = null` (no env change; `A2A_HUMAN_NAME` unchanged).
- [ ] 2.4 Add `A2A_DEFAULT_ROOM` env (default `"default"`) read at hub startup; used as fallback when channel-bin lacks `CHATBRIDGE_ROOM`.
- [ ] 2.5 Add `GET /room-default` route (read-auth) returning `{ room }` based on `A2A_DEFAULT_ROOM`.
- [ ] 2.6 Update `/agent-stream?agent=<name>` to accept an optional `&room=<label>` query param; channel-bin will pass it. Hub records it via `ensureAgent`.

## 3. Hub — broadcast routing

- [ ] 3.1 Refactor `broadcastUI(entry)` to attach `entry.room = senderRoom`. UI SSE receives every event regardless of room (client-side filter handles presentation).
- [ ] 3.2 Refactor `broadcastAgents(entry, targetRooms?)` so only agents whose `agent.room === entry.room || agent.room === null` receive; the human (null) always receives.
- [ ] 3.3 Explicit peer targeting (`to: "<name>"`) bypasses the room rule when the target is a named roster member.
- [ ] 3.4 Update `resolveTargets()` so `target: "all"` from an agent expands to "same-room agents + human"; from the human, it expands to "all agents in the UI-selected room + human". Introduce `req.body.room` as the human's scope hint.
- [ ] 3.5 Add `room` attribute to every agent-stream notification's meta block.

## 4. Hub — per-route room validation

- [ ] 4.1 `POST /post` / `POST /send`: no reject; broadcast scope automatically respects room rule via 3.x.
- [ ] 4.2 `POST /handoffs`: reject with 403 `{"error": "cross-room handoff not permitted"}` when `agents[from].room != agents[to].room` AND `from != human_name`.
- [ ] 4.3 `POST /interrupts` single-shape: same cross-room rule as handoffs.
- [ ] 4.4 `POST /interrupts` bulk-shape: accept `{ from, rooms: [<label>...], text }`; reject 403 when `from != human_name`. For each listed room, fan out one interrupt per non-human agent.
- [ ] 4.5 `POST /interrupts` bulk response shape: `{ created: [{ room, interrupts: [<id>...] }] }`.
- [ ] 4.6 `POST /permissions/:id/verdict`: validate `by` is in the requesting agent's room or is the human.
- [ ] 4.7 `POST /handoffs/:id/accept` — in the nutshell-patch path, reject when `handoff.room != context.room` with 403 `{"error": "cross-room nutshell edit not permitted"}`.
- [ ] 4.8 Unit tests: cross-room reject cases for each route + human-bypass case.

## 5. Hub — nutshell per-room

- [ ] 5.1 Replace `loadNutshell()` with `loadNutshell(room)`; queries `nutshell WHERE room = ?`; returns empty sentinel `{ room, text: "", version: 0, ... }` when no row.
- [ ] 5.2 Replace `writeNutshell(text, updatedBy)` with `writeNutshell(room, text, updatedBy)`; upserts the row by room primary key.
- [ ] 5.3 `GET /nutshell` requires `room` query param; 400 without it.
- [ ] 5.4 Accept-handoff path for `[nutshell]` task: read `room` from `context.room`; default to sender's room; reject if sender's room ≠ `context.room` and sender is not human.
- [ ] 5.5 `nutshell.updated` SSE event includes the `room` field.
- [ ] 5.6 Update briefing builder: pass connecting agent's room; include only that room's nutshell.

## 6. Hub — event + SSE wire format

- [ ] 6.1 Every `/stream` payload (chat, handoff, interrupt, nutshell, permission) includes a top-level `"room"` field; null when the originator is the human or for global events.
- [ ] 6.2 Every `/agent-stream` payload includes `meta.room`.
- [ ] 6.3 Update TypeScript event-shape types in `hub/hub.ts` to include `room`.
- [ ] 6.4 Wire test: a multi-room fixture broadcasts a `post` from room A; verify only room-A agent queues receive; UI stream receives with `room` tag.

## 7. channel-bin — room env + gate

- [ ] 7.1 At channel-bin startup, read `CHATBRIDGE_ROOM` from env; if unset, fetch via `GET /room-default`; if that fails, use literal `"default"`.
- [ ] 7.2 Pass `&room=<label>` on the `/agent-stream` subscription URL.
- [ ] 7.3 In the SSE event handler, compare each event's `meta.room` against the configured room. On mismatch: log `[channel] dropped cross-room event: mine=<a> theirs=<b> kind=<k>` to stderr and do NOT forward to claude. This is the upstream "Gate inbound messages" pattern (https://code.claude.com/docs/en/channels-reference#gate-inbound-messages).
- [ ] 7.4 Forward matching events as today, adding `room="<label>"` to the `<channel>` meta attributes so claude can reason about the room in context.
- [ ] 7.5 Smoke test: inject a synthetic cross-room SSE event, verify it is dropped and logged.
- [ ] 7.6 **Dynamic `instructions` string** per agent at `Server` construction (see [channels-reference → Server options](https://code.claude.com/docs/en/channels-reference#server-options)). The current generic paragraph becomes a per-agent prompt injected at session start, containing: (a) the agent's room name, (b) the peer list for that room ("you share this room with `qa` and `human`"), (c) explicit rules — broadcasts are room-scoped, cross-room coordination requires `to: "<name>"`, the `room=` attribute on incoming `<channel>` tags is authoritative and can be trusted. Peer list is a best-effort snapshot at startup; does not auto-refresh. This primes claude's system prompt to respect the room protocol rather than relying on external enforcement alone.

## 8. Rust shell — spawn modal & MCP config

- [ ] 8.1 `pty_spawn(agent, cwd, session_mode, room)` — add the new `room` parameter; default to git-root basename when omitted.
- [ ] 8.2 Git-root resolver: walk up from cwd until `.git` is found or filesystem root reached. Helper function in `src-tauri/src/pty.rs`.
- [ ] 8.3 `write_mcp_config_for(agent, room)` — add `CHATBRIDGE_ROOM` to the generated env block.
- [ ] 8.4 Pass the room through tmux's `new-session -e CHATBRIDGE_ROOM=<label>` so the env reaches channel-bin even on respawn.

## 9. UI — room switcher & filtering

- [ ] 9.1 Add `<select id="room-switcher">` to `index.html` header, placed between the brand block and the status pill.
- [ ] 9.2 Populate the switcher from the current roster's distinct `room` values plus an "All" option; rebuild on roster changes.
- [ ] 9.3 Store selection in `localStorage` key `a2achannel_selected_room`; default to "All" on first launch.
- [ ] 9.4 Filter chat messages client-side: hide `.msg` elements whose `data-room` doesn't match the selection; "All" shows everything.
- [ ] 9.5 Filter handoff + interrupt cards with the same rule.
- [ ] 9.6 Filter roster pills (the legend strip).
- [ ] 9.7 `terminal.js` `reconcile()` hides tabs whose agent's room doesn't match the selection.
- [ ] 9.8 Composer placeholder reflects the current selection (`"Message #<room>…"`); disabled with tooltip when "All" is selected.
- [ ] 9.9 Nutshell strip displays per-room; in "All" view renders stacked with room headings.

## 10. UI — pause / resume controls

- [ ] 10.1 Add Pause (⏸) and Resume (▶) icon buttons next to the room switcher.
- [ ] 10.2 Click handlers: when a specific room is selected, POST `/interrupts` with `{ from: HUMAN_NAME, rooms: [<selected>], text: "<canned>" }`.
- [ ] 10.3 Disable both buttons when "All" is selected; tooltip explains why.
- [ ] 10.4 Pause tooltip: `"Agents finish their current tool call before pausing."` (communicates cooperative semantics).
- [ ] 10.5 Flash a brief confirmation toast after a successful pause/resume: `"Paused N agents in <room>"` / `"Resumed N agents in <room>"`.

## 11. UI — spawn modal room field

- [ ] 11.1 Add `<input id="spawn-room-input">` to the spawn modal between Agent and CWD fields.
- [ ] 11.2 On cwd selection, call Tauri `invoke('resolve_default_room', { cwd })` to pre-fill the Room input with the git-root basename (or cwd basename fallback).
- [ ] 11.3 Add a `<datalist>` of existing roster rooms for quick selection.
- [ ] 11.4 Validation: same rules as agent name (1..=64 chars, allowed charset). Inline error if invalid.
- [ ] 11.5 Submit passes `room` to `pty_spawn`; spawn fails cleanly if room validation rejected.

## 12. Rust — resolve_default_room Tauri command

- [ ] 12.1 `#[tauri::command] fn resolve_default_room(cwd: String) -> String` in `src-tauri/src/pty.rs` (or a new helper module).
- [ ] 12.2 Implementation: call the git-root resolver; return basename.
- [ ] 12.3 Register in the `invoke_handler!` list.

## 13. SSE client + ledger replay

- [ ] 13.1 On handoff/interrupt replay at first agent connect, filter so the replaying agent only sees items where they are the recipient or originator AND the item's room matches.
- [ ] 13.2 UI loadPendingHandoffs()/loadPendingInterrupts() pass `?room=<label>` to filter server-side (optional optimisation). Hub accepts a new `room` filter on the `GET /handoffs?` and `GET /interrupts?` routes.

## 14. Docs

- [ ] 14.1 `docs/PROTOCOL.md`: new "Rooms" section with identity, routing scope, per-room nutshell, and human super-user policy.
- [ ] 14.2 `README.md`: under "Three primitives", add a short "Rooms" paragraph. Under "Running agents", mention that the spawn modal's Room field defaults to the git-root basename.
- [ ] 14.3 `CLAUDE.md` (project instructions): add the new hard rules about cross-room route validation and the bulk-interrupt human-only restriction.

## 15. Migration smoke test

- [ ] 15.1 `scripts/release.sh`: pre-publish step that (a) installs v0.8, (b) creates handful of handoffs/interrupts/nutshell edits, (c) upgrades to v0.9, (d) asserts ledger opens, existing rows have `room='default'`, legacy nutshell preserved.
- [ ] 15.2 Document the smoke test's expected output in `scripts/README.md`.

## 16. Release

- [ ] 16.1 Bump version to `0.9.0` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `hub/channel.ts` server version string.
- [ ] 16.2 Update CaskaydiaMono inlining script if any build step changed.
- [ ] 16.3 Git tag `v0.9.0`, push, create GitHub release with the zipped .app and updated cask sha.
- [ ] 16.4 Update `docs/README.md` with v0.9 release notes.
