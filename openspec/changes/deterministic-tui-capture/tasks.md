## 1. Verification & Probe

- [ ] 1.1 Confirm the user's claude binary at the configured `claude_path` accepts `--settings <path>` (run `claude --help | grep -- --settings`). Document the version. If absent: pivot to fallback (user-side install) per design.md §D3.
- [ ] 1.2 Confirm BSD `date +%s` produces a valid epoch on the user's macOS — `date +%s` should output 10 digits. Confirm `stat -f %m <file>` produces sub-second mtime as a float (modern APFS).
- [ ] 1.3 Run the proposed Stop-hook command manually in a shell to verify file creation: `A2A_AGENT=test sh -c 'mkdir -p /tmp/a2a/$A2A_AGENT/signals && touch /tmp/a2a/$A2A_AGENT/signals/turn-$(date +%s).done'` then `ls -la /tmp/a2a/test/signals/`.

## 2. Per-agent settings file

- [ ] 2.1 Add `settings_dir()` helper to `src-tauri/src/pty.rs` returning `app_data_dir().join("settings")`. Mirror `mcp_configs_dir()`.
- [ ] 2.2 Add `write_settings_for(agent: &str) -> Result<PathBuf, String>` that materializes `~/Library/Application Support/A2AChannel/settings/<agent>.json` (mode 0600) with the exact JSON content from design.md §D3 — `Stop` hook with the BSD-compatible command. Atomic write via tmpfile + rename.
- [ ] 2.3 In `claude_command()` in `pty.rs`, append `--settings '<settings_path>'` after the existing `--mcp-config` argument (call `write_settings_for(agent)` to materialize the file before building the command string).
- [ ] 2.4 In the tmux `new-session` invocation, add `-e A2A_AGENT=<agent>` alongside the existing `-e TERM=...` etc. Use the same name validation (`valid_agent_name()`) before substitution.

## 3. Capture orchestrator (`pty_capture_turn`)

- [ ] 3.1 Add struct `CaptureResult { log_path: PathBuf, start_ms: u64, end_ms: u64, status: CaptureStatus }` (where `CaptureStatus = Success | Partial`) at the top of `pty.rs`.
- [ ] 3.2 Add `pty_capture_turn(state: State<PtyRegistry>, agent: String, input: String, timeout_ms: Option<u32>) -> Result<CaptureResult, String>` Tauri command. Use the timeout default of 60000ms.
- [ ] 3.3 Inside `pty_capture_turn`:
  - Validate agent name via existing `valid_agent_name()`.
  - Compute paths: capture_dir = `/tmp/a2a/<agent>/captures/`, signals_dir = `/tmp/a2a/<agent>/signals/`. `mkdir -p` both.
  - Compute `start_instant = SystemTime::now()` and the corresponding `start_ms`.
  - Compute `log_path = capture_dir/turn-<start_ms>.log` (touch the empty file).
- [ ] 3.4 Enable pipe-pane via `tmux_run(["pipe-pane", "-o", "-t", agent, &format!("cat >> {}", shell_escape(log_path))])`.
- [ ] 3.5 Force window size: `tmux_run(["set-option", "-t", agent, "window-size", "manual"])` then `tmux_run(["resize-window", "-t", agent, "-x", "240", "-y", "100"])`. Order matters — set-option first.
- [ ] 3.6 Inject input: call into the existing `pty_write` path with the agent + UTF-8 bytes of `input` (b64-encode in-process). The append of `\r` if absent is the caller's responsibility (slash-send already does this).
- [ ] 3.7 Poll for sentinel: every 50ms, list `signals_dir`, find the first file with `mtime > start_instant`. Bail out at `timeout_ms` (default 60000ms).
- [ ] 3.8 On sentinel found: sleep 75ms (final repaint absorption), then disable pipe-pane via `tmux_run(["pipe-pane", "-t", agent])` (no command arg disables).
- [ ] 3.9 Restore window-size: `tmux_run(["set-option", "-t", agent, "window-size", "automatic"])`.
- [ ] 3.10 On timeout: rename `log_path` to `<basename>.partial.log`, still disable pipe-pane and restore window-size. Return `CaptureResult { status: Partial, ... }` with the partial path.
- [ ] 3.11 On success: prune older successful captures — keep the 10 most recent `turn-*.log` files (not `.partial.log`); delete the rest. Single pass via `read_dir` + sort by mtime descending + drop tail.
- [ ] 3.12 Register the new command in the `invoke_handler!` macro in `lib.rs` alongside `pty::pty_write`, `pty::pty_resize`, etc.

## 4. UI integration

- [ ] 4.1 Add a JS wrapper in `ui/terminal/pty.js` exposing `ptyCaptureTurn(agent, input, timeoutMs?) → Promise<CaptureResult>` via `window.__A2A_TERM__.pty.ptyCaptureTurn`.
- [ ] 4.2 In `ui/features/slash-send.js`:
  - Replace the `captureSlashResponse` event-listener path with a call to `ptyCaptureTurn(agent, input, 60000)`.
  - On success: `await fetch('file://' + result.log_path)` is not available from the webview; instead, add a new Tauri command `pty_read_capture(log_path) → String` that reads + returns the file contents (with size cap, e.g. 256 KiB) so the JS layer can post-process.
  - Apply the existing CR-overwrite handler + ANSI strip + slice-to-divider to the file content. Post to chat as `[a2a-capture]\n\`\`\`\n<body>\n\`\`\``.
  - Remove the dead code: `captureSlashResponse`, `captureViaHeadless`, `snapshotResponse`, `stripAndSlice`, `sliceBetweenSlashAndPromptFrame`, `readBufferLines`, `captureBaseline`. (Keep `stripAnsi` — still needed for the file-content post-processing.)
- [ ] 4.3 Tighten the audit row text — now that the chat post is deterministic (no quiescence guess), the audit can include "captured to <log_path>" for forensics.

## 5. Hub-side briefing (no-op confirmation)

- [ ] 5.1 Confirm `hub/channel/tail.ts`'s briefing no longer instructs claude to mirror via `mcp__chatbridge__post` (this was already removed in main as of `f646827`). The capture path on the Tauri shell side handles mirror-to-chat; claude's mirror is redundant.

## 6. Tests

- [ ] 6.1 Unit-test the path computation + mtime filtering logic in isolation (Rust side, mocked filesystem). Cover: stale sentinels ignored, freshest matching wins, no-files-yet returns None.
- [ ] 6.2 Integration test in `tests/integration/pty-plumbing.test.ts` (extends the existing pattern): spawn a tmux session, write a known fixture program that prints content + a Stop-hook-equivalent file touch on completion, run `pty_capture_turn`, assert the captured file contains the expected bytes and the timing meets the budget.
- [ ] 6.3 Manual smoke against a live agent: `/context @<agent>` → chat shows the full panel without truncation, log file at `/tmp/a2a/<agent>/captures/turn-*.log` contains the byte stream.
- [ ] 6.4 Regression: verify existing tmux-attach + xterm rendering still works (the visible client should NOT show flicker outside of slash-send windows). Run a normal `claude` interaction with no slash sends.

## 7. Documentation

- [ ] 7.1 Update `docs/explorations.md`: add a "Resolution" section to the slash-from-chat conclusion noting that the deterministic-tui-capture change supersedes the earlier fragile capture iterations. Reference this change name.
- [ ] 7.2 Update `CLAUDE.md` (project) with a new hard rule documenting the per-agent settings file pattern: "A2AChannel materializes per-agent claude settings at `~/Library/Application Support/A2AChannel/settings/<agent>.json` and passes via `--settings <path>`. Do not write to user's `~/.claude/settings.json`. Mirror invariant of the `--mcp-config <path>` pattern."
- [ ] 7.3 Update `README.md` to document the new `pty_capture_turn` capability and the visible-flicker-during-capture trade-off (Phase 1 cost).

## 8. Release

- [ ] 8.1 Bump version (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) — propose `0.9.14` for Phase 1 of this change.
- [ ] 8.2 `./scripts/install.sh` — full rebuild + ad-hoc resign + install.
- [ ] 8.3 Manual verification: kill all running agents (existing settings files won't have the hook), respawn each, run `/context` and `/usage` from chat, confirm clean capture in chat.
- [ ] 8.4 Commit + tag + push tag + create GitHub release with bundled `.app.zip`.

## 9. Phase 2 placeholder (not in this change)

- [ ] 9.1 ~~Hidden second tmux client at 240×100 to eliminate visible-xterm flicker~~ — deferred. Track separately if user complaints land. Phase 1 is production-grade.
