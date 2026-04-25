## Why

`src-tauri/src/pty.rs` has ~40 lines of duplicated setup code across three Tauri command paths (`pty_spawn`, `pty_spawn_shell`, and the attach-on-startup sweep inside `pty_list`): UTF-8 locale resolution, existing-session reconfiguration, and PTY-master + output-channel pairing. The pre-v0.9.5 audit flagged this but we deferred because pty.rs has **zero integration test coverage** and is tightly coupled to tmux semantics, macOS locale quirks, and xterm rendering. A refactor without tests risks re-introducing the kind of regression v0.6 shipped when `tmux -C` was swapped in for raw PTY — hours of debug time, scar tissue in CLAUDE.md.

v0.9.8 fixes the order: land integration tests for the PTY plumbing first, extract the helpers under test cover second, manual click-through last. The refactor itself is the same one §7 of v0.9.7 carried but didn't execute.

## What Changes

- **Add `tests/integration/pty-plumbing.test.ts`** covering the PTY↔tmux plumbing that pty.rs commands depend on. Bounded scope: bytes flow both ways through an attach-session PTY, session lifecycle (spawn / attach / kill) behaves correctly, locale env resolution produces UTF-8. NOT in scope: claude's internal rendering, xterm glyph correctness, Tauri event dispatch.
- **Extract three helper functions** in `pty.rs` once tests are green:
  - `fn resolve_utf8_locale(env: &HashMap<String, String>) -> String` — consolidates the LANG / LC_ALL fallback logic currently inlined three times. Returns `en_US.UTF-8` for the known macOS-GUI-launchd blank-locale case.
  - `fn configure_existing_session(name: &str) -> Result<(), String>` — runs `tmux set-option remain-on-exit off` + a SIGWINCH resize cycle on the attach client, so claude's dimension probe sees correct values at startup.
  - `async fn attach_and_stream(name: &str, out_tx: Sender<PtyEvent>) -> Result<(), String>` — pairs a PTY master with the Tauri output-event channel, spawns the reader task, registers the session handle in the PtyRegistry.
- **Update `pty_spawn`, `pty_spawn_shell`, and the `pty_list` attach-on-startup branch** to call the helpers instead of inlining the duplicated blocks.
- **Manual click-through gate** before shipping: spawn a fresh agent, confirm Braille / Nerd glyphs render in claude's banner, confirm tab state transitions live → dead on external kill, confirm the shell tab (which has no `remain-on-exit off` concern but shares the locale + attach plumbing) still opens cleanly.

**Rollback plan if the click-through reveals a regression the tests missed:** `git revert` the extraction commit; tests stay (they're additive and don't depend on the extraction).

## Capabilities

### New Capabilities

None. The PTY-pairing behavior already ships and is covered by the existing `terminal-projection` capability.

### Modified Capabilities

- `terminal-projection`: adds a **test-coverage requirement** on the PTY plumbing primitives. The runtime behavior is unchanged; the requirement formalizes that `pty.rs`'s three duplicated setup blocks — locale resolution, session configuration, attach-stream pairing — have named helpers with integration test coverage. Catches the class of regression v0.6 had (tmux `-C` swap) before it ships.

## Impact

**Code:**
- `tests/integration/pty-plumbing.test.ts` — new, ~150 lines across 6-8 scenarios.
- `tests/helpers/tmux.ts` — new, hermetic tmux-socket helper (isolated socket path per test, `tmux kill-server` teardown).
- `src-tauri/src/pty.rs` — three extracted helpers (~40 lines new), three call-site simplifications (~40 lines removed). Net ~0 lines, improved cohesion + discoverability.
- No webview changes. No hub changes.

**APIs:** none affected. Tauri command signatures unchanged.

**Dependencies:** none new. Tests use Bun + the existing `tmux` binary bundled under `src-tauri/resources/tmux`.

**Test infrastructure:**
- Tests need the bundled tmux binary or a system tmux on PATH. Prefer bundled — matches shipped behavior.
- Tests run in a hermetic temp dir with a test-scoped socket (`/tmp/a2achannel-test-<pid>.sock`). `kill-server` on teardown.
- Bun test runs the TypeScript side; it shells out to tmux directly rather than driving pty.rs via the Tauri runtime (that would need a headless Tauri harness — out of scope).

**Risk assessment:**
- **[High]** without tests, pty.rs changes have historically broken terminal rendering in non-obvious ways (blank Braille glyphs, stuck tabs, claude banner as `____`). Tests-first is the single biggest risk reducer.
- **[Medium]** the helpers touch async boundaries (`attach_and_stream`'s reader task). A lifetime or ownership mistake here compiles clean but hangs at runtime. Tests mitigate via explicit session-lifecycle assertions.
- **[Low]** locale resolution is a pure function; near-zero risk once extracted.

**Rollout:** single PR, single-file revert rollback path.

**Out of scope (explicit):**
- Rewriting pty.rs at architectural level (e.g., switching off tmux, adding session persistence beyond the current restart-resume flow).
- Adding xterm / glyph-rendering assertions to the test suite — that belongs in a visual-regression framework, not here.
- Changing the Tauri event channel shape or the webview → Rust IPC contract.
- Any change to the shell-tab vs agent-tab state model. The `data-state="dead"` / `"live"` / `"external"` transitions stay exactly as they are.
