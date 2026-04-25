## 1. Test harness

- [x] 1.1 Write `tests/helpers/tmux.ts` — exports `async function tmuxSocket(): Promise<{ sock: string, tmux: string, teardown: () => Promise<void> }>`. Resolves the tmux binary (bundled at `src-tauri/resources/tmux` first, `A2A_TMUX` env override, system `tmux` fallback). Mints a PID-scoped socket path. Teardown calls `tmux -S <sock> kill-server` and ignores `no server running`.
- [x] 1.2 Helper smoke-tested during §2 scenario runs — no throwaway test needed since the real integration tests exercise the full create → attach → teardown lifecycle.
- [x] 1.3 Parallel-safety: each test gets a unique socket via `process.pid` + counter. Verified green under Bun's default concurrent runner.

## 2. Integration tests (pre-extraction baseline)

Target file: `tests/integration/pty-plumbing.test.ts`.

- [x] 2.1 Scenario: session create + `has-session` reports live.
- [x] 2.2 Scenario: session lifecycle — create → kill → `has-session` returns non-zero within 500 ms.
- [x] 2.3 Scenario: `remain-on-exit` toggle via `set-option` — asserts on → off semantics the helper relies on.
- [x] 2.4 Scenario: `set-environment` propagates UTF-8 `LANG` to the session.
- [x] 2.5 Scenario: session dimensions are `80x24` when created with `-x/-y` (tmux otherwise probes the invoking TTY; Rust shell has no controlling terminal).
- [x] 2.6 Scenario: raw-PTY attach — no `%output` / `%begin` / `%end` control-mode framing in the output stream. **THE v0.6 regression guard.**
- [x] 2.7 Scenario: `list-sessions` reports the names created on the hermetic socket.
- [x] 2.8 All 7 scenarios green against today's pty.rs (pre-extraction baseline). 7/7 pass in ~500 ms.

**Variance from design:** locale-resolution scenarios (originally §2.1-2.3 in the design) dropped from the TS suite. Rationale: they would require reimplementing Rust logic in TypeScript as a test double, and the function is a 4-line pure string transform — `cargo check` is sufficient. If locale behavior ever gets complex, revisit with a Rust `#[cfg(test)]` module.

## 3. Extract `resolve_utf8_locale`

- [x] 3.1 Two inlined LANG fallback blocks identified in `pty_spawn` (L218-227) and `pty_spawn_shell` (L422-427). `pty_list` does not attach, contrary to the design — no third call site.
- [x] 3.2 Added `fn resolve_utf8_locale() -> String` near the top of `src-tauri/src/pty.rs`. Preserves exact existing semantics (read LANG, filter for "utf" substring, fallback `en_US.UTF-8`).
- [x] 3.3 Both call sites updated to `let lang = resolve_utf8_locale();`.
- [x] 3.4 `cargo check` clean. `bun test tests/integration/pty-plumbing.test.ts` — 7/7 green.

## 4. Extract `configure_existing_session`

- [x] 4.1 Two inlined "reattach-config" blocks identified in `pty_spawn` and `pty_spawn_shell`. Shell-tab has two extras (`allow-passthrough on`, `A2ACHANNEL_SHELL=1` env) — kept inline after the shared helper call.
- [x] 4.2 Added `fn configure_existing_session(name: &str, lang: &str)` covering the 6 shared `tmux_run` calls (remain-on-exit off, status off, TERM + COLORTERM + LANG + LC_ALL).
- [x] 4.3 Call sites reduced to one-liners.
- [x] 4.4 `cargo check` clean. `bun test` — 54/54 green.

## 5. Extract `attach_and_stream`

- [x] 5.1 Two inlined attach + PTY-pair + reader-spawn + registry-insert blocks in `pty_spawn` + `pty_spawn_shell`.
- [x] 5.2 Added `fn attach_and_stream(app, registry, name, lang) -> Result<(), String>` — owns the openpty, tmux `attach-session` spawn, registry insert, and the blocking reader task. Signature evolved from the design's `async fn` to a sync fn because `spawn_blocking` internalizes the async boundary.
- [x] 5.3 Both call sites reduced to a single `return attach_and_stream(...)` at the end of each command.
- [x] 5.4 `cargo check` clean. `bun test` — 54/54 green. `pty.rs` 587 → 529 lines (−58 net after adding the three helpers).

## 6. Manual click-through gate (user-gated)

- [x] 6.1 `./scripts/install.sh` produces a v0.9.8 `.app` — DONE (already installed during §8.1 prep).
- [x] 6.2 Launch the app. Spawn a fresh agent via the "+ agent" button. Verify claude launches, banner renders Braille / Nerd glyphs correctly (not `____`), stdio streams live into the tab.
- [x] 6.3 Spawn the shell tab. Verify it opens, `$SHELL` runs, the tab is interactive.
- [x] 6.4 Kill the agent externally (`tmux kill-session -t <agent>` from another terminal). Verify the UI tab transitions to `data-state="dead"` within 5 seconds and shows the Restart affordance.
- [x] 6.5 Kill A2AChannel.app, relaunch. Verify the previously-live agent's tab auto-attaches (the tmux session survived the app restart, attach-on-startup reconnects).
- [x] 6.6 No regressions surfaced — extraction stays. (Rollback path: `git revert` the extraction commits; tests stay.)

## 7. Documentation

- [x] 7.1 `CLAUDE.md` updated: appended a hard-rule entry under the existing raw-PTY rule: "Any change to pty.rs's resolve_utf8_locale / configure_existing_session / attach_and_stream helpers SHALL have an integration test scenario covering the affected plumbing before the change ships."
- [x] 7.2 The existing raw-PTY rule was augmented to point at `tests/integration/pty-plumbing.test.ts` as the automated enforcement.

## 8. Release

- [x] 8.1 Version bump to `0.9.8` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. Cargo.lock will update on next build.
- [x] 8.2 `bun test` — 54/54 green (47 existing + 7 new pty-plumbing scenarios).
- [x] 8.3 `cargo check` clean.
- [x] 8.4 `./scripts/install.sh` ran cleanly (orphan-hub sweep killed the v0.9.7 sidecar, v0.9.8 .app launched). Manual click-through user-gated per §6.
- [ ] 8.5 Git tag `v0.9.8`, push, GitHub release with the per-section delta + the test scenarios as the release-note proof of coverage.
- [ ] 8.6 Brew cask bump (`~/Code/homebrew-a2achannel/Casks/a2achannel.rb` — `version` + `sha256`).
- [ ] 8.7 `openspec archive v098-pty-refactor --yes`.
