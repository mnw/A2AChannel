## Context

`src-tauri/src/pty.rs` (587 lines as of v0.9.7) handles everything tmux-adjacent: spawning new agent sessions, spawning the user's shell tab, attaching to sessions that survived an app restart, forwarding PTY output to the Tauri webview, and cleaning up on kill. Three Tauri commands (`pty_spawn`, `pty_spawn_shell`, and the attach sweep inside `pty_list`) share ~40 lines of setup code that was flagged as duplicated in the pre-v0.9.5 audit.

The audit's proposed extraction was deferred from v0.9.5 (kind-runtime refactor focused on hub.ts), from v0.9.6 (CSS + UI JS split), and from v0.9.7 (low-risk cleanup pass). Each time the deferral was the same: pty.rs has institutional scar tissue (v0.6 regression from swapping raw PTY for `tmux -C`), zero integration test coverage, and hard-to-reproduce failure modes (blank Braille glyphs in claude's banner, tabs stuck in `attaching` state, claude mis-rendering its logo as `____`). Every refactor without tests is a bet that we catch every regression class manually.

v0.9.8 breaks the deferral cycle by inverting the order: **tests first, extraction second**.

Current state of the three duplicated blocks (from my audit):

1. **UTF-8 locale resolution** (~10 lines, inlined 3×). Reads `LANG` / `LC_ALL` from env; falls back to `en_US.UTF-8` if the user's locale is blank or non-UTF8. Required because macOS GUI apps inherit a blank / `C` locale from launchd, which makes claude's capability probe downgrade to ASCII. Without this, Braille and box-drawing glyphs render as `____`.

2. **Existing-session reconfiguration** (~10 lines, inlined 2×). When attaching to a session that survived an app restart, the code runs `tmux set-option remain-on-exit off` (older session flavors had it on, which silently held panes after claude exits) and issues a SIGWINCH resize cycle so the attach client re-samples dimensions. The 80×24 default is load-bearing: tmux probes the invoking TTY otherwise, and the Rust shell has no controlling terminal.

3. **Attach-and-stream** (~20 lines, inlined 3×). Creates a PTY master, paired with a Tauri `Channel<PtyEvent>` for forwarding output bytes to the webview. Spawns a reader task that forwards bytes and signals exit. Registers the session in `PtyRegistry` so subsequent `pty_write` / `pty_resize` / `pty_kill` commands can find it.

Constraints (from CLAUDE.md + the repo's baseline):
- macOS ARM64 only.
- Bundled tmux at `src-tauri/resources/tmux` (static build; built on first install via `build-tmux.sh`).
- Tauri 2.x runtime.
- `bun test` for the TypeScript side; no Rust test suite exists today.
- No new dependencies.
- No bundler for the UI (tests run outside the webview).

## Goals / Non-Goals

**Goals:**
- Integration test coverage for the PTY plumbing — enough to catch the three regression classes documented above (blank glyphs, stuck tabs, silent hangs).
- Extract the three helpers with behavior-preserving semantics.
- Keep the tests runnable without a running Tauri shell (hermetic tmux socket + direct Bun tmux spawning).
- Net-zero behavior change. Visible only to `tsc` / `cargo` / clicks.

**Non-Goals:**
- Rewriting pty.rs at the architectural level. The tmux-based projection model stays.
- Xterm / glyph-rendering assertions. That's a visual regression concern, out of scope here.
- Rust-side unit tests beyond what the integration tests cover. Adding a `cargo test` harness is its own follow-up.
- Changing the Tauri event shape or the webview's expectations.
- Session persistence changes (e.g., checkpointing beyond the current "tmux session survives app restart" behavior).
- Swapping out bundled tmux for a system one.

## Decisions

### 1. Test tmux plumbing via Bun, not via Tauri

**Decision:** Integration tests shell out to `tmux` directly (using the bundled binary) and assert behavior on a hermetic socket. Tests do NOT drive pty.rs through a Tauri harness.

**Rationale:**
- Testing through Tauri requires a headless Tauri runtime — hours of setup, poor isolation.
- The three helpers are plumbing around tmux primitives. Testing tmux's contract (session creation, attach semantics, env-var propagation, dimension sampling) directly is enough to catch regressions: if pty.rs's helpers build on tmux correctly, the Tauri wiring (which is already covered by manual click-through) is decorative around them.
- Keeps tests fast (tmux session creation is ~50 ms each).

**Alternatives considered:**
- **Cargo test + mock PTY.** Rejected — Rust mocks of tmux's socket protocol would be fragile and wouldn't exercise the real binary's behavior.
- **Playwright against the installed app.** Rejected — enormous infrastructure lift, slow, and tests end-to-end including claude itself (too broad).

### 2. Hermetic tmux socket per test

**Decision:** Each test sets `tmux -S /tmp/a2achannel-test-<pid>-<counter>.sock …`. Teardown runs `tmux -S <sock> kill-server`. Tests never touch `~/Library/Application Support/A2AChannel/tmux.sock` (the production path).

**Rationale:**
- Isolation: no cross-test contamination, no interaction with a running app.
- Matches the repo's pattern for test hermeticity (cf. `tests/helpers/hub.ts` spawning isolated hub instances).

**Alternatives considered:**
- **Shared test socket.** Rejected — test order dependency, hard to parallelize, risk of colliding with a dev-mode app.

### 3. Extract helpers in pty.rs in the order they stabilize fastest

**Decision:** Extract the pure function first, then the idempotent setup function, then the async plumbing last.

Order:
1. `resolve_utf8_locale` — pure, no I/O, easiest to test.
2. `configure_existing_session` — single tmux command + a SIGWINCH, tmux-state setter.
3. `attach_and_stream` — async, ownership-sensitive (PTY master + reader task + registry handle).

Each extraction is a separate commit; intermediate states compile + pass tests.

### 4. Helper signatures

```rust
// Pure — reads current process env, returns the resolved locale string.
fn resolve_utf8_locale(env: &HashMap<String, String>) -> String;

// Runs tmux commands against the existing named session. Returns error with tmux's stderr on failure.
fn configure_existing_session(name: &str) -> Result<(), String>;

// Pairs a PTY master with an output channel, spawns the reader task, and registers the
// session handle. Returns the registered handle for the caller to stash in PtyRegistry.
// Caller owns the session lifecycle beyond this helper.
async fn attach_and_stream(
    name: &str,
    out_tx: tauri::ipc::Channel<PtyEvent>,
) -> Result<PtySessionHandle, String>;
```

`PtySessionHandle` already exists in pty.rs (internal struct for the registry).

### 5. Test scenarios

Six scenarios, each mapped to a regression class:

1. **Locale resolution happy path**: `LANG=en_US.UTF-8` passthrough. Asserts return value.
2. **Locale resolution blank env**: empty `LANG` + `LC_ALL`. Asserts `en_US.UTF-8` fallback (catches the macOS-GUI-launchd class of bugs).
3. **Locale resolution non-UTF8**: `LANG=C`. Asserts `en_US.UTF-8` fallback.
4. **tmux session create + attach**: spawn a detached tmux session on the test socket, attach via `tmux attach-session`, write bytes, read them back through the PTY. Baseline plumbing check.
5. **Existing-session reconfiguration**: create a session with `remain-on-exit on`, call the helper, assert the option is off.
6. **Session lifecycle**: create → kill → assert `has-session` returns not-found within 500 ms. Catches the "stuck tab" regression class.

Tests 1-3 exercise `resolve_utf8_locale` directly (pure). Tests 4-6 exercise tmux semantics the other helpers build on. No test drives pty.rs's Tauri commands directly — the assertion is "if these primitives work, the helpers work when wired correctly."

### 6. Test runner

**Decision:** `bun test tests/integration/pty-plumbing.test.ts`. Uses Bun's `spawn` / `Bun.spawn()` for tmux invocation; no Node.js `child_process` bundling.

**Rationale:**
- Matches the existing test infra (other integration tests at `tests/integration/*.test.ts` use the same runner).
- Bun spawn has an ergonomic streams API for PTY byte assertions.
- Bundled tmux path: `src-tauri/resources/tmux` when it exists, else system `tmux`. Fallback chosen in `tests/helpers/tmux.ts`.

## Risks / Trade-offs

**[Risk] Test suite doesn't catch a regression that the production runtime hits.** The test harness uses the bundled tmux directly, not through Tauri's IPC. An ownership or lifetime bug in `attach_and_stream` (Rust-side, async boundary) might compile, pass tests that only exercise tmux primitives, and still hang at runtime.
**Mitigation:** The manual click-through gate stays. Tests reduce the risk envelope, they don't eliminate it.

**[Risk] Bundled tmux is built on first install (`build-tmux.sh`). CI / fresh clone doesn't have it.**
**Mitigation:** `tests/helpers/tmux.ts` checks `src-tauri/resources/tmux` first, falls back to system tmux if absent. Document the requirement in the test file's header.

**[Risk] `SIGWINCH` + resize cycle in `configure_existing_session` is stateful — hard to assert cleanly.**
**Mitigation:** The test checks `tmux show-option -g remain-on-exit` post-invocation (which is the behavior that actually matters for the bug class). The SIGWINCH is verified indirectly via tmux reporting current window dimensions; if the helper runs, dimensions are 80×24.

**[Risk] Helper extraction order matters for bisect.** If `attach_and_stream` (async, hardest) lands last and a bug slips in, bisect needs to cross only that one commit.
**Mitigation:** Extract in the order defined in §3; commit per extraction.

**[Trade-off] Tests add ~150 lines of test code against ~40 lines of production extraction.** Net LOC delta is +110.
**Rationale:** Test-code line count is not a cost we optimize for here. The test suite protects the pty.rs surface against the next time someone proposes a refactor like v0.6's `tmux -C` swap.

## Migration Plan

**Implementation order:**

1. **Write `tests/helpers/tmux.ts`** — hermetic socket creation, bundled-vs-system tmux resolution, teardown.
2. **Write `tests/integration/pty-plumbing.test.ts`** — 6 scenarios per §5. Green against today's pty.rs (yes, they should pass BEFORE any extraction — that's the baseline).
3. **Extract `resolve_utf8_locale`** in pty.rs. Update 3 call sites. `cargo check` + tests green. Commit.
4. **Extract `configure_existing_session`** in pty.rs. Update 2 call sites. `cargo check` + tests green. Commit.
5. **Extract `attach_and_stream`** in pty.rs. Update 3 call sites. `cargo check` + tests green. Commit.
6. **`./scripts/install.sh`** + manual click-through gate (5 items per proposal).
7. Release as v0.9.8.

**Rollback:** per commit. The tests in step 2 stay regardless — they're an additive safety net.

## Open Questions

1. **Should `tests/helpers/tmux.ts` bundle its own test-only tmux config (`tmux.conf.test`) or share the shipped one?** Probably share. Any config divergence between test and prod is a correctness gap.

2. **Does `attach_and_stream` need to return the `PtySessionHandle` for the caller to stash, or should it register internally?** Returning is more flexible (caller composes registration with other state). Registering internally is one less parameter but hides a side effect. Leaning toward returning.

3. **Parallel test execution — safe?** Bun test runs tests in parallel by default. Each test uses a PID-scoped socket, so in principle yes. Verify: run the suite 10× with `--preload` and check for flakes.

4. **Should the test suite's tmux binary path be overridable via env (`A2A_TMUX=/usr/local/bin/tmux`)?** Yes, for developer flexibility. Default: `src-tauri/resources/tmux`, fallback system.

5. **Does this change need a CLAUDE.md update to reinforce the test-first rule for pty.rs?** Yes — add "any change to pty.rs's spawn/attach/stream helpers SHALL have integration test coverage before the change ships" to the hard rules section. Prevents the next audit from repeating the same deferral cycle.
