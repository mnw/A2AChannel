## 1. Ledger schema_version 5 → 6 migration

_(Note: v0.8 already shipped schema v5; bumping to v6 instead of v4 as the original task text assumed v3 starting point.)_

- [x] 1.1 Bump `LEDGER_SCHEMA_VERSION` to `6` in `hub/hub.ts`.
- [~] 1.2 ~~`ALTER TABLE agents`~~ — **N/A**, no `agents` table in ledger. Roster is in-memory only (CLAUDE.md invariant "In-memory roster"). Room lives on the `Agent` type in-memory; see 2.1.
- [x] 1.3 `ALTER TABLE events ADD COLUMN room TEXT`.
- [x] 1.4 `ALTER TABLE handoffs ADD COLUMN room TEXT NOT NULL DEFAULT 'default'`; index on `(room, status, created_at_ms DESC)`.
- [x] 1.5 `ALTER TABLE interrupts ADD COLUMN room TEXT NOT NULL DEFAULT 'default'`; index on `(room, status, created_at_ms DESC)`.
- [x] 1.5a **Added:** `ALTER TABLE permissions ADD COLUMN room TEXT NOT NULL DEFAULT 'default'`; index on `(room, status)`. (Original task list missed permissions — v0.8 shipped after this proposal was written.)
- [x] 1.6 `nutshell`: copy-drop-rename to `room TEXT PRIMARY KEY` schema; legacy `id=0` row migrates to `room='default'`.
- [ ] 1.7 Manual test: v0.9 ledger opened by v0.8 refuses via existing downgrade guard.
- [ ] 1.8 Manual test: re-running migration on v6 ledger is a no-op.

## 2. Hub — agent roster with room

- [x] 2.1 `Agent` type now includes `room: string | null`.
- [x] 2.2 `ensureAgent(name, room)` persists room on first registration, ignores on reconnect.
- [x] 2.3 Human registers at startup with `room = null` (super-user in every room).
- [x] 2.4 `A2A_DEFAULT_ROOM` env (default `"default"`) read at hub startup.
- [x] 2.5 `GET /room-default` (read-auth) returns `{ room }`.
- [x] 2.6 `/agent-stream?agent=X&room=Y` optional room param; recorded via `ensureAgent`.
- [x] 2.7 **Added:** `validRoomLabel()` + `resolveRoom()` helpers for input sanitization.

## 3. Hub — broadcast routing

- [x] 3.1 `broadcastUI(entry)` passes `entry.room` through unchanged (set by callers). UI gets everything; client-side filter handles presentation.
- [x] 3.2 `broadcastPermission` scopes to same-room agents only; handoff/interrupt fan-out goes to the named parties (cross-room already rejected at create-time).
- [x] 3.3 Explicit peer target (`to: "<name>"`) in `/post` bypasses the same-room filter by design.
- [x] 3.4 `/send` accepts `room` body field as the human's scope hint; `target: "all"` requires it; `/post` from an agent expands `to: "all"` to same-room peers + human.
- [x] 3.5 Every `<channel>` tag forwarded by channel-bin includes `room` meta attribute.

## 4. Hub — per-route room validation

- [ ] 4.1 `POST /post` / `POST /send`: no reject; broadcast scope automatically respects room rule via 3.x.
- [x] 4.2 `POST /handoffs`: 403 cross-room rule with human bypass.
- [x] 4.3 `POST /interrupts` single-shape: same cross-room rule.
- [x] 4.4 `POST /interrupts` bulk-shape `{from, rooms:[...], text}`; 403 when non-human.
- [x] 4.5 `POST /interrupts` bulk response `{ created: [{ room, interrupts: [...] }] }`.
- [ ] 4.6 `POST /permissions/:id/verdict`: validate `by` is in requester's room or is human.
- [x] 4.7 Nutshell cross-room edit rejected inside `acceptHandoff` (non-human sender) — patch dropped, handoff accept still succeeds.
- [ ] 4.8 Unit tests: cross-room reject cases.

## 5. Hub — nutshell per-room

- [x] 5.1 `readNutshell(room)` keys by room PK; returns empty sentinel when no row.
- [x] 5.2 `writeNutshellInTx(db, room, text, updatedBy)` upserts by room PK.
- [x] 5.3 `GET /nutshell?room=<label>` requires param; 400 otherwise.
- [x] 5.4 Accept-handoff nutshell path reads `context.room`; defaults to handoff's room; cross-room patches from non-human senders dropped silently inside the tx.
- [x] 5.5 `nutshell.updated` SSE entry includes `room` field.
- [x] 5.6 Briefing builder scoped to connecting agent's room: same-room peers only, that-room's nutshell only.

## 6. Hub — event + SSE wire format

- [x] 6.1 Every broadcast entry (chat, handoff, interrupt, nutshell, permission) carries `room` top-level.
- [x] 6.2 channel-bin forwards `room` as a `<channel>` meta attribute on every event.
- [x] 6.3 `Entry` type + all snapshot types include `room`.
- [ ] 6.4 Wire test — deferred to §15 smoke matrix.

## 7. channel-bin — room env + gate

- [x] 7.1 `CHATBRIDGE_ROOM` env read at startup; falls back to `"default"` when unset. `GET /room-default` runtime fetch deferred — spawn-modal agents always get an explicit env; external-spawn users edit their own MCP config.
- [x] 7.2 `&room=<label>` passed on `/agent-stream` URL.
- [x] 7.3 SSE handler gates inbound events by `evt.room`; mismatch → skip + stderr log with expected/actual pair.
- [x] 7.4 Every forwarded `<channel>` tag includes `room` meta attribute.
- [ ] 7.5 Smoke test — deferred to §15.
- [x] 7.6 Dynamic `instructions` bakes agent name + room + room-scope rules into claude's system prompt at construction. Peer list itself arrives via the briefing notification (sent on first connect) rather than the instructions string — instructions only change at server construction, so the peer list there would go stale on roster changes; the briefing refreshes live.

## 8. Rust shell — spawn modal & MCP config

- [x] 8.1 `pty_spawn(agent, cwd, session_mode, room)` accepts optional room with validation; falls back to git-root basename.
- [x] 8.2 `default_room_for_cwd()` walks up for `.git`, fallback to cwd basename.
- [x] 8.3 `write_mcp_config_for(agent, room)` includes `CHATBRIDGE_ROOM` in env block.
- [~] 8.4 Not needed — CHATBRIDGE_ROOM lives in the MCP config `env` block (Rust writes it per 8.3). claude's subprocess inherits it via the MCP server spawn env, so tmux `-e` is redundant. Skipped.

## 9. UI — room switcher & filtering

- [x] 9.1 `<select id="room-switcher">` + `#room-controls` cluster in header.
- [x] 9.2 Populated from `ROSTER` distinct rooms + "All rooms"; rebuilt via `renderRoomSwitcher()` inside `applyRoster()`.
- [x] 9.3 Persisted to `localStorage.a2achannel_selected_room`; falls back to "All".
- [x] 9.4 `.msg[data-room]` filter via injected `<style id="room-filter-style">` rule.
- [x] 9.5 `.handoff-card / .interrupt-card / .permission-card` data-room tagged, filter rule covers them.
- [x] 9.6 `.legend-item` data-room tagged; human lacks the attr → always visible.
- [x] 9.7 `.terminal-tab` data-room tagged at ensureTab + refreshed in reconcile.
- [ ] 9.8 Composer placeholder with room label + disable on "All" — deferred, cosmetic.
- [ ] 9.9 Nutshell strip per-room UI — deferred; hub already serves per-room, UI reads one room at a time and data.room filter handles the visual.

## 10. UI — pause / resume controls

- [x] 10.1 Pause + Resume icon buttons added next to the switcher.
- [x] 10.2 Click handlers POST `/interrupts` with `{from: HUMAN_NAME, rooms: [selected], text}`.
- [x] 10.3 Both disabled when "All rooms" is selected (via `updatePauseResumeState`).
- [ ] 10.4 Cooperative-semantics tooltip — basic title attrs present; extended copy deferred.
- [ ] 10.5 Toast with count — deferred, cosmetic.

## 11. UI — spawn modal room field

- [x] 11.1 `<input id="spawn-room-input">` added (after Working directory, before Session).
- [x] 11.2 cwd Pick handler pre-fills Room via `invoke('resolve_default_room', {cwd})`.
- [x] 11.3 `<datalist id="spawn-room-datalist">` populated from roster's distinct rooms.
- [x] 11.4 Submit validates against `NAME_RE`; blank → server-side default from cwd.
- [x] 11.5 `pty_spawn` now receives `room` param; Rust rejects invalid with error.

## 12. Rust — resolve_default_room Tauri command

- [x] 12.1 `resolve_default_room(cwd: String) -> String` in `pty.rs`.
- [x] 12.2 Wraps `default_room_for_cwd()`.
- [x] 12.3 Registered in `generate_handler!` list.

## 13. SSE client + ledger replay

- [x] 13.1 Hub's agent-stream reconnect replay filters pending handoffs/interrupts/permissions by the agent's room.
- [ ] 13.2 UI bootstrap pulls all pending items; client-side `data-room` filter hides cross-room cards. Server-side `?room=` param deferred — current load-and-filter path is fine for typical roster sizes.

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
