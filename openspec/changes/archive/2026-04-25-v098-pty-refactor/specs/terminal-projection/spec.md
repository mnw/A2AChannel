## ADDED Requirements

### Requirement: PTY plumbing primitives have integration test coverage

The Rust terminal-projection layer SHALL maintain integration test coverage over the three PTY plumbing primitives that `src-tauri/src/pty.rs` uses for agent and shell tab sessions:

1. **Locale resolution** — the function that resolves UTF-8 locale from the current process env, with fallback to `en_US.UTF-8` when the inherited locale is blank, `C`, or non-UTF-8. This is the primitive that prevents claude's capability probe from downgrading to ASCII output when macOS GUI apps inherit an empty locale from launchd.
2. **Existing-session reconfiguration** — the function that runs `tmux set-option remain-on-exit off` plus a SIGWINCH dimension resize cycle on an attach client, so claude samples correct 80×24 dimensions at startup.
3. **Attach-and-stream** — the function that pairs a PTY master with a Tauri output channel, spawns a reader task, and registers the session in the PtyRegistry. Used by spawn, shell-tab spawn, and attach-on-restart.

Tests MAY exercise these primitives via the `tmux` binary and the test harness directly — they are NOT required to drive pty.rs through a Tauri runtime. The tests cover the PTY / tmux contract that each primitive builds on.

The integration test suite MUST run on `bun test` and MUST NOT require a running Tauri shell.

#### Scenario: Locale resolution with UTF-8 environment

- **GIVEN** the process env has `LANG=en_US.UTF-8` and no `LC_ALL`
- **WHEN** the locale-resolution primitive is called
- **THEN** the return value is `"en_US.UTF-8"`

#### Scenario: Locale resolution with blank environment

- **GIVEN** the process env has empty `LANG` and empty `LC_ALL` (matching the macOS GUI app launchd inheritance case)
- **WHEN** the locale-resolution primitive is called
- **THEN** the return value is `"en_US.UTF-8"`
- **AND** the return value is used to set `LANG` / `LC_ALL` for the child tmux session

#### Scenario: Locale resolution rejects non-UTF-8 locale

- **GIVEN** the process env has `LANG=C`
- **WHEN** the locale-resolution primitive is called
- **THEN** the return value is `"en_US.UTF-8"` (NOT `"C"`)

#### Scenario: tmux session creates and accepts attach

- **GIVEN** a hermetic tmux socket at a PID-scoped path
- **WHEN** the test harness creates a detached tmux session with 80×24 dimensions
- **AND** attaches via `tmux attach-session` with `-e LANG=en_US.UTF-8`
- **THEN** the attach client is connected
- **AND** bytes written to the attach PTY appear in the session's output buffer
- **AND** bytes from the session are readable from the PTY master

#### Scenario: Existing-session reconfiguration clears remain-on-exit

- **GIVEN** an existing tmux session with `remain-on-exit on`
- **WHEN** the session-reconfiguration primitive is called with that session's name
- **THEN** `tmux show-option -g -t <session> remain-on-exit` reports `off`

#### Scenario: Session lifecycle — create, kill, confirm gone

- **GIVEN** a tmux session created by the test harness
- **WHEN** the harness sends `tmux kill-session -t <name>`
- **THEN** `tmux has-session -t <name>` returns a non-zero exit code within 500 ms
- **AND** the PtyRegistry entry (if one was registered) is reclaimable for the same name without collision

#### Scenario: Regression guard — tmux raw-PTY mode vs tmux -C

- **GIVEN** a tmux session attached via the attach-and-stream primitive
- **WHEN** a test writes interactive keystrokes (e.g., arrow keys, `\r`) to the PTY master
- **THEN** the bytes propagate as raw bytes, NOT as tmux control-mode commands
- **AND** no `%output`, `%begin`, `%end` tmux control-mode framing appears in the output stream

This scenario specifically guards against the v0.6 regression class where `tmux -C` was substituted for raw PTY and broke interactive input forwarding. The raw-PTY mode is documented as a hard rule in `CLAUDE.md` and reinforced here at spec level.
