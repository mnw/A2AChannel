## ADDED Requirements

### Requirement: `pty_spawn` is ~20 LOC of clear sequencing; argv assembly + session-configure are extracted helpers

`pty_spawn` in `src-tauri/src/pty.rs` SHALL be reduced to a thin orchestrator that sequences:
1. Validate agent name
2. Resolve room
3. Registry idempotency check (existing pid?)
4. Materialize per-agent MCP config + settings files
5. Call `ensure_session_configured(agent, lang) -> Result<bool, String>` to either reconfigure an existing tmux session (forced `remain-on-exit off`) OR signal that a fresh `new-session` must be created
6. Call `build_spawn_argv(agent, cwd, api_key, lang, spawn_cmd, session_existed) -> Vec<String>` to build the tmux argv (handles new-session vs send-keys-into-existing)
7. Spawn / attach
8. Hand off to `attach_and_stream`

The orchestrator body SHALL be ≤25 LOC of clear sequencing (no inline argv assembly, no inline tmux command construction, no silent error swallowing).

#### Scenario: pty_spawn body is short and named-seam-driven

- **WHEN** `pty_spawn`'s body is examined
- **THEN** it contains no inline `vec![...]` argv construction longer than 5 elements
- **AND** it contains no `let _ = tmux_run(...)` (silent error suppression)
- **AND** the function is ≤25 LOC excluding signature, opening/closing braces, comments

### Requirement: `build_spawn_argv` is a pure function with its own test

`build_spawn_argv(agent: &str, cwd: &str, api_key: Option<&str>, lang: &str, spawn_cmd: &str, session_existed: bool) -> Vec<String>` SHALL be a pure function — no I/O, no tmux invocation, no environment reads — that returns the tmux argv vector for either a `new-session -d -x 80 -y 24 -e ...` invocation (when `!session_existed`) or a `send-keys` invocation into the existing session. Quoting + escaping invariants (the failure mode that broke v0.6 with paths-with-spaces) live at this seam.

#### Scenario: Argv preserves single-token quoted paths

- **GIVEN** `cwd = "/Users/mnw/Workspace/A2AChannel/Some Path With Spaces"`, `agent = "alice"`, `spawn_cmd = "claude --mcp-config '/path/with spaces.json' --dangerously-load-development-channels server:chatbridge"`, `session_existed = false`
- **WHEN** `build_spawn_argv(...)` is called
- **THEN** the returned argv passes the entire `claude ...` invocation as a single tmux argv element (so /bin/sh's argv-join doesn't split the quoted `--mcp-config '/path/with spaces.json'` into multiple tokens — the v0.6 regression)
- **AND** the test runs without invoking tmux

#### Scenario: Argv differs between new-session and send-keys paths

- **GIVEN** the same inputs but `session_existed = true`
- **WHEN** `build_spawn_argv(...)` is called
- **THEN** the returned argv is a `send-keys` form (not `new-session`)
- **AND** the result still passes the spawn command as a single tmux argv element

### Requirement: `ensure_session_configured` returns `Result<bool, String>`; no silent failures

`ensure_session_configured(agent: &str, lang: &str) -> Result<bool, String>` SHALL replace the silent `let _ = tmux_run(...)` at `pty.rs:369` (today's behavior). Return semantics:
- `Ok(true)` — an existing tmux session was found, reconfigured (forced `remain-on-exit off`), and `LANG`/`LC_ALL` were re-set on it. Caller branches to send-keys.
- `Ok(false)` — no existing session for this agent. Caller must create one via `tmux new-session ...`.
- `Err(msg)` — a tmux command failed (e.g. socket unreachable, permission denied, tmux binary missing). Caller MUST surface this error to the Tauri command result; MUST NOT swallow it.

`pty_spawn` SHALL propagate `Err` returns from `ensure_session_configured` rather than continuing into the spawn path.

#### Scenario: tmux failure surfaces to the caller

- **GIVEN** a tmux invocation inside `ensure_session_configured` returns a non-zero exit
- **WHEN** the Tauri `pty_spawn` command is invoked
- **THEN** the Tauri response contains the error message from `tmux_run`
- **AND** the Webview UI surfaces "tmux: <reason>" instead of an opaque success-state

### Requirement: Orchestrator-level integration test closes the per-helper-rule gap

`tests/integration/pty-plumbing.test.ts` SHALL gain a new scenario asserting `pty_spawn` end-to-end invariants:
- A tmux session named `<agent>` exists on the configured `tmux.sock` after the spawn completes
- The session has `remain-on-exit off`
- The session's `-e LANG=...` env contains a UTF-8 locale (matches the resolution from `resolve_utf8_locale`)
- The PTY attach is live (no `%output`/`%begin`/`%end` control-mode framing — preserves the v0.9.8 raw-PTY regression guard)

The scenario MUST exercise `pty_spawn` end-to-end via the Tauri-IPC layer (or its test-double), not by directly calling individual helpers.

#### Scenario: Spawn end-to-end leaves tmux state in the expected shape

- **GIVEN** a fresh test environment (no prior session for the agent)
- **WHEN** `pty_spawn` is invoked
- **THEN** `tmux list-sessions` shows the agent's session
- **AND** `tmux show-options -t <agent> remain-on-exit` returns `off`
- **AND** `tmux show-environment -t <agent>` includes `LANG=en_US.UTF-8` (or the host's existing UTF-8 LANG)
