## 1. UI polish

- [x] 1.1 Add `.msg-avatar` circular element + per-agent background color, letter derived from `name[0].toUpperCase()`.
- [x] 1.2 Add `row-reverse` variant of `.msg` for rows where `from === HUMAN_NAME`, swap meta/avatar layout accordingly.
- [x] 1.3 Style `.msg-body` as a pill bubble with per-agent accent background (use `shade(COLORS[name], 0.8)`) and rounded corners.
- [x] 1.4 Update `linkify()` to wrap detected URLs in `<a class="msg-link" target="_blank" rel="noopener">` using `var(--ctp-sky)` for color.
- [x] 1.5 After each `.msg-link`, emit a sibling `<button class="msg-link-copy" data-href="..." aria-label="Copy link">` with a 📋 glyph.
- [x] 1.6 Delegated click handler on `messagesEl` for `.msg-link-copy`: `navigator.clipboard.writeText(href)`, swap glyph to ✓ for 1 s.
- [x] 1.7 Add CSS hover state + transition on the copy button so it's discoverable but unobtrusive.
- [x] 1.8 Screenshot-test: compare against `docs/demo.gif` target aesthetic; iterate spacing/padding until a non-technical user would call it "nice."

## 2. Agent attachment uploads (`post_file`)

- [x] 2.1 Register the `post_file` tool in `channel.ts` `ListToolsRequestSchema` handler with schema `{path (required), to?, caption?, room?}`.
- [x] 2.2 Implement the tool handler: read `path` from the agent's filesystem, build a FormData with the file bytes, POST to `<hub>/upload` with the bearer token, then POST to `/post` with `{from: AGENT, to, text: caption ?? "", image: url, room}`.
- [x] 2.3 Propagate hub's error body to the MCP tool error message (extension allowlist rejection, size cap, etc.) so agents can self-correct.
- [x] 2.4 Verify `/upload` route accepts the channel sidecar's bearer token without changes (it should — same auth surface as today).
- [x] 2.5 Update the onboarding briefing (see §5) to include `post_file` in the tool list. *(channel.ts instructions updated; hub-side briefing handled in §5)*
- [x] 2.6 README: document the symmetric upload path under "What's in the room" and in the MCP tools table.
- [ ] 2.7 Smoke test: agent calls `post_file` with a .md, card renders in UI with correct author, peer agents receive `[attachment: <abs path>]` in their channel notifications.

## 3. Terminal projection via tmux — DEFERRED TO v0.7

**Status:** removed from v0.6 scope. We attempted two shapes (Terminal.app spawn, then embedded xterm.js + PTY bridge). The embedded version's input loop was broken and couldn't be debugged in the time budget without further delaying the rest of the v0.6 release. All terminal-related code has been reverted from the v0.6.0 commit.

**Artifacts removed:**
- `src-tauri/resources/tmux` (bundled static tmux binary, ~1.1 MB)
- `ui/vendor/xterm/` (xterm.js 5.5.0 + addon-fit vendoring)
- `portable-pty` and `base64` crate dependencies in `Cargo.toml`
- All `tmux_*` and `tmux_pty_*` Tauri commands in `lib.rs`
- 🖥 Terminals header button, modal, right-pane layout, and xterm.js JS plumbing in `ui/index.html`
- `scripts/build-tmux.sh` kept on-disk for future reuse but no longer wired into `install.sh`.

**For v0.7:**
- Write a minimal standalone PoC first (portable-pty + xterm.js in a trivial Tauri window) and validate the full input/output loop end-to-end.
- Only after the PoC is green, integrate into A2AChannel.
- Budget devtools access from day 1 so we can see runtime errors instead of guessing at Tauri arg-naming conventions.

## 4. Interrupt messages

- [x] 4.1 Migrate the ledger: bump `LEDGER_SCHEMA_VERSION` to 2; add `interrupts` table with columns per the spec.
- [x] 4.2 Add state-machine helpers in `hub.ts`: `mintInterruptId()`, `createInterrupt()`, `ackInterrupt()`, `snapshotInterrupt()`, `loadInterrupt()`, `listInterrupts()`.
- [x] 4.3 Wrap each helper's two writes (events + interrupts) in `db.transaction`, matching the handoff pattern.
- [x] 4.4 Add HTTP routes: `POST /interrupts`, `POST /interrupts/:id/ack`, `GET /interrupts?status=&for=&limit=`.
- [x] 4.5 Implement `broadcastInterrupt(snapshot, "interrupt.new" | "interrupt.ack")` following `broadcastHandoff` — push to `uiSubscribers` and to the recipient's agent queue.
- [x] 4.6 In `channel.ts`, register MCP tools `send_interrupt({to, text})` and `ack_interrupt({interrupt_id})`.
- [x] 4.7 In `channel.ts` `tailHub()`, forward `interrupt.new` events as `notifications/claude/channel` with `meta.kind="interrupt.new"`, `meta.interrupt_id`, `meta.from`, content = text.
- [x] 4.8 UI: add `.interrupt-card` styles (red accent, larger, sticky to the top of the message container while pending).
- [x] 4.9 UI: render interrupts via a `renderInterruptCard(event)` function following `renderHandoffCard`'s pattern, with version-style reconciliation (latest seen wins).
- [x] 4.10 UI: "Acknowledge" button on cards targeting the human calls `POST /interrupts/:id/ack` with `{by: HUMAN_NAME}`.
- [x] 4.11 UI: add a "Send interrupt" entry in the send composer (dropdown option next to `@ mentions`).
- [x] 4.12 UI: fetch pending interrupts on bootstrap and on reload (`GET /interrupts?status=pending&for=<human>&limit=500`).
- [x] 4.13 README + `docs/PROTOCOL.md`: document the interrupt kind, lifecycle, tools, routes, SSE events, and the "coordination primitive, not hard preemption" caveat.

## 5. Onboarding briefing

- [x] 5.1 In `hub.ts`, add a `briefedAgents = new Set<string>()` module state and emit a `briefing` event to the agent's queue on their first `/agent-stream` connect during the process lifetime.
- [x] 5.2 Build the briefing payload: tool list (static array, keep in sync with channel.ts's `ListTools` handler), peers (walk `knownAgents`, include online flag from `presenceSnapshot`), `attachments_dir`, `human_name`, `nutshell.text` (from §6).
- [x] 5.3 In `channel.ts`, detect `type === "briefing"` events and forward them as `notifications/claude/channel` with `meta.kind="briefing"`; body = a readable prose summary rendered from the JSON.
- [x] 5.4 Ensure the briefing is delivered BEFORE any queued chat or handoff events (push it first on the stream).
- [ ] 5.5 Smoke test: a fresh agent connects, sees the briefing in its context, subsequent `post` calls behave normally.
- [x] 5.6 README: document the first-connect briefing under "What's in the room" → "Protocol messages" and the tools it advertises.

## 6. Project nutshell

- [x] 6.1 Migration: add a `nutshell` table with one-row invariant (`id INTEGER PRIMARY KEY CHECK(id = 0)`); insert the default empty row in the same transaction.
- [x] 6.2 In `hub.ts`, add helpers `readNutshell()`, `writeNutshell({text, updated_by})` — both use the ledger; write increments version + updated_at, emits `nutshell.updated` SSE event.
- [x] 6.3 Add route `GET /nutshell` (read-auth), returning the current row JSON.
- [x] 6.4 Wire nutshell edits through the handoff primitive: when a handoff with `task` starting with `"[nutshell]"` and `context.patch` is accepted AND `to_agent === HUMAN_NAME`, call `writeNutshell` atomically in the same transaction as the handoff's accept event.
- [x] 6.5 Guard: handoff-accept path checks the task prefix and context shape before writing the nutshell; invalid shape → regular handoff accept (no nutshell change).
- [x] 6.6 UI: add a collapsible pinned area above `#messages` that renders the current nutshell (text, version, updated_by); fetch via `GET /nutshell` on bootstrap + on reload.
- [x] 6.7 UI: listen for `nutshell.updated` SSE events and re-render with a brief highlight animation.
- [x] 6.8 UI: "Propose edit" button opens a textarea pre-filled with current text; submitting fires `POST /handoffs` with `task="[nutshell] edit"`, `to=HUMAN_NAME`, `context={patch: newText}`.
- [x] 6.9 Include the current nutshell text in the briefing payload from §5.
- [x] 6.10 README + `docs/PROTOCOL.md`: document the nutshell lifecycle, edit-via-handoff convention, and read/update routes.

## 7. Release prep

- [ ] 7.1 Bump version to `0.6.0` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `hub/channel.ts` (server name/version string).
- [ ] 7.2 Rebuild sidecar + Tauri bundle; install to `/Applications`.
- [ ] 7.3 Full smoke test: all six features end-to-end with at least two agents (alice + bob) + human.
- [ ] 7.4 Update `CLAUDE.md` hard rules with any new invariants (nutshell single-row, interrupts are advisory, etc.).
- [ ] 7.5 Git tag `v0.6.0`, push, create GitHub release with DMG + `.app.zip`.
- [ ] 7.6 Archive this change (`openspec archive v06-roadmap`).
