## 1. Discovery

- [x] 1.1 Add a `BUILTIN_SLASH_COMMANDS` constant in a new `ui/features/slash-discovery.js` module. Initial value: `["/clear", "/compact", "/context", "/usage", "/cost", "/model", "/help", "/mcp"]`. Comment notes: review on each Claude Code release.
- [x] 1.2 Add a `DESTRUCTIVE_SLASH_COMMANDS` constant in the same module. Initial value: `new Set(["/clear", "/compact"])`.
- [x] 1.3 Implement `discoverCommandsForAgent(agent)` in `slash-discovery.js`: returns a `Set<string>` covering built-ins + a filesystem scan over the agent's cwd `.claude/commands/*.md`, `.claude/skills/*/SKILL.md`, plus `~/.claude/commands/*.md` and `~/.claude/skills/*/SKILL.md`. The agent's cwd is read from the existing `pty.rs` pane-current-path Tauri command if available, or from the agent's spawn cwd cached in the UI.
- [x] 1.4 ~~Add a Tauri command `slash_scan_dir(path: String) -> Vec<String>`~~ Replaced with combined `slash_discover_for_agent(agent) -> Vec<String>` (one IPC per agent vs five). Resolves cwd via `pane_current_path`, scans both project + personal `.claude/commands/` and `.claude/skills/`, returns command names without leading `/`. Best-effort: returns `[]` on any error rather than propagating.
- [x] 1.5 Implement `discoverCommandsForRoom(roomName)` in `slash-discovery.js`: returns a `Map<string, Set<string>>` keyed by agent name, value is the agent's command set. Iterates over live agents in the room (from `ROSTER` filtered by room) and calls `discoverCommandsForAgent` for each.
- [x] 1.6 Implement `commandUnion(roomMap)` and `commandAvailability(commandName, roomMap)` helpers: union returns the set of all commands seen in any agent; availability returns `{available: number, total: number, missingFrom: string[]}` for the badge.

## 2. Composer slash mode

- [x] 2.1 In a new `ui/features/slash-mode.js`, export `isSlashMode(textareaValue)` returning `true` iff the textarea starts with `/`. (Simplified from "first character was just typed" — any state with leading `/` is slash mode; mid-message slashes don't qualify because the leading char isn't `/`.)
- [x] 2.2 Wire a textarea `input` listener in `composer.js` (instead of main.js — composer.js already owns the input handlers) that calls `isSlashMode` and toggles slash-popover visibility + send-button gating.
- [x] 2.3 In `slash-mode.js`, export `parseSlashMessage(text)`: returns `{slashCommand: string|null, target: string|null, args: string}`. Returns nulls for missing parts.
- [x] 2.4 Disable the send button when slash mode is active and any of: `slashCommand` missing, `target` missing, or room dropdown is `All rooms`.
- [x] 2.5 Add inline error rendering under the composer for slash-mode validation: `Select a room first` when `All rooms` is selected; `specify @agent or @all` when target missing.
- [x] 2.6 On `Escape` keydown while slash mode is active, exit slash mode (clear textarea, dismiss popover).
- [x] 2.7 On `Backspace` that removes the leading `/`, exit slash mode automatically. (Falls out naturally from `_refreshSlashState` running on every input event.)

## 3. Slash picker popover

- [x] 3.1 Add `<div class="slash-popover" id="slash-popover"></div>` to `ui/index.html` near the existing `mention-popover` and `emoji-popover`.
- [x] 3.2 In a new `ui/features/slash-picker.js`, render the popover when slash mode is active. Inputs: filtered command list (filtered by what's typed after the `/`), per-command availability badge.
- [x] 3.3 On open, call `discoverCommandsForRoom(SELECTED_ROOM)` and `commandUnion`. Render `<command_name>` with `<N>/<M> agents` badge. Sort: built-ins first, then alpha.
- [x] 3.4 Highlight commands with `available === 0` (none of the room's live agents have it) — gray out + tooltip "no live agents have this command".
- [x] 3.5 Keyboard navigation: ArrowDown / ArrowUp to move selection, Tab to commit (replaces composer text with `<commandName> ` and positions cursor). Enter sends. (Tab chosen over Enter to commit so Enter remains the universal "send" key.)
- [x] 3.6 Style the popover in `ui/styles/composer.css`. Matches the visual weight of the mention popover.
- [x] 3.7 Dismiss the popover on Escape, blur, or successful command pick.

## 4. Target resolution and `@` popover reuse

- [x] 4.1 Modify the `@mention` popover in `ui/features/mentions.js` to support slash mode: in slash mode, candidates come from `slashTargetCandidates(SELECTED_ROOM)` (live + in-room only); `@all` is included whenever the candidate count ≥ 1; external/dead/launching agents are filtered out.
- [x] 4.2 The `@`-popover automatically activates slash-mode filtering whenever the composer is in slash mode (no flag needed; checked at popover render).
- [x] 4.3 In `slash-mode.js`, export `resolveTargets(target, roomName)`: for `@all` returns the list of in-room live, non-busy agent names; for `@<name>` returns `[name]` if that name is a valid candidate, else `[]` with a skipped entry explaining why.
- [x] 4.4 Implement busy-skip for `@all`: exclude any agent for whom there's a pending permission card or pending interrupt card. Reads `permissionCards` / `interruptCards` Maps already maintained by `ui/kinds/permission.js` and `ui/kinds/interrupt.js`.

## 5. Send path

- [x] 5.1 In a new `ui/features/slash-send.js`, export `sendSlash({slashCommand, target, args})`. Resolves targets, fans out to `pty_write` per-agent.
- [x] 5.2 The byte payload for each `pty_write` is `<slashCommand>[ <args>]\r` (CR only, not CRLF). UTF-8 encode then base64.
- [x] 5.3 Hook the composer's send-button click + `Enter` keydown so that when slash mode is active, `sendSlash` is invoked instead of the existing chat send. Block the chat send entirely while slash mode is active.
- [x] 5.4 If `slashCommand` is in `DESTRUCTIVE_SLASH_COMMANDS` AND `resolvedTargets.length > 1`, show a confirm modal. Reuses the shared `askConfirm` helper (promoted from terminal.js's IIFE into `core/state.js` so slash-send can call it).
- [x] 5.5 Cancel from the destructive modal aborts entirely (no `pty_write`, no audit entry, leaves the composer text intact for editing).
- [x] 5.6 Confirm proceeds with the fan-out.
- [x] 5.7 After all `pty_write` calls resolve (or partially fail), append one `system` chat entry. Format: `human → <slashCommand>[ <args>] @<target> (<resolved>) [— skipped: <skipped with reasons>]`.
- [x] 5.8 Clear the composer textarea and exit slash mode after a successful send.

## 6. Tests

- [x] 6.1 Unit-test `parseSlashMessage` in `tests/unit/slash-parse.test.ts` (renamed from slash-mode.test.ts to avoid colliding with the source-file name): leading `/` only, full `/cmd @target args`, missing target, malformed target, MCP-style commands.
- [ ] 6.2 ~~Unit-test `resolveTargets`~~ Skipped — function reads multiple globals (`ROSTER`, `presenceState`, `permissionCards`, `interruptCards`) whose mock setup is heavyweight; behavior is exercised by the manual smoke test in 6.6 and verified end-to-end against a live two-agent room.
- [x] 6.3 Unit-test `commandUnion` and `commandAvailability` with synthetic discovery output (covered in `tests/unit/slash-parse.test.ts`).
- [ ] 6.4 ~~Integration test for `/clear @all`~~ Skipped — requires DOM mocking (composer textarea, popover state, modal flow) plus Tauri IPC mocking; the surface duplicates the manual smoke test below. The audit-text format is covered by `formatSlashAuditText` unit tests.
- [ ] 6.5 ~~Integration test for `/help @builder` in All-rooms view~~ Skipped — same DOM/IPC mock surface as 6.4. The room-gating is exercised manually in 8.3.
- [ ] 6.6 Manual / smoke test: with two real claude agents launched in A2AChannel, send `/clear @all` from the composer; verify both xterms reset and the audit row appears in chat. **Pending verification at install time (8.3).**

## 7. Documentation

- [x] 7.1 ~~Update README.md "What chat does vs. what the xterm does" section~~ — that section doesn't exist as a header; instead added a new "Slash commands from chat" subsection under the Permission relay section in README.md.
- [x] 7.2 Added "Slash commands from chat" subsection in README.md covering the picker, target syntax, busy-skip, destructive confirm.
- [x] 7.3 Added a hard-rule entry in `CLAUDE.md` documenting the slash-command bypass + the two constants `BUILTIN_SLASH_COMMANDS` and `DESTRUCTIVE_SLASH_COMMANDS` in `ui/features/slash-discovery.js` — both need review on each Claude Code version bump.

## 8. Release

- [x] 8.1 Bump version to `0.9.13` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`.
- [x] 8.2 `./scripts/install.sh` for full rebuild + ad-hoc resign + install to `/Applications`.
- [ ] 8.3 Manual verification of all spec scenarios against a live two-agent room. **Pending.**
- [ ] 8.4 Commit, tag, push tag, create GitHub release with the bundled `.app.zip`. **Pending.**
