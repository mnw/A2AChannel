## ADDED Requirements

### Requirement: A2AChannel SHALL provide a `pty_capture_turn` Tauri command for deterministic single-turn TUI capture

A new Tauri command `pty_capture_turn(agent: String, input: String, timeout_ms: Option<u32>) -> Result<CaptureResult, String>` SHALL be exposed by `src-tauri/src/pty.rs`. The command SHALL coordinate three layers of the capture contract — rendering geometry (tmux window size), output stream (tmux pipe-pane), and completion signal (filesystem sentinel written by claude's `Stop` hook) — to deliver a complete, untruncated capture of a single claude turn.

`CaptureResult` SHALL include at minimum: the absolute path to the captured log file, the start and end timestamps (epoch ms), and a status indicator (`success` | `partial`). The caller is responsible for reading the log file from disk and applying any post-processing (ANSI strip, etc.).

#### Scenario: Slash command capture against a live agent
- **GIVEN** an agent `foo` is running in a tmux session with the per-agent settings file installed (Stop hook present)
- **WHEN** the host calls `pty_capture_turn("foo", "/context\r", null)`
- **THEN** the command returns a `CaptureResult` whose `log_path` points to a file under `/tmp/a2a/foo/captures/turn-<epoch>.log`
- **AND** the file contains the full rendered `/context` panel including all MCP tools, custom agents, skills, and plugins
- **AND** no truncation occurs regardless of the visible xterm's actual width

#### Scenario: Cross-agent parallel capture
- **GIVEN** four agents `alice`, `bob`, `carol`, `dave` running in the same room
- **WHEN** four `pty_capture_turn` calls fire in parallel, one per agent
- **THEN** each call writes its own log file under `/tmp/a2a/<agent>/captures/`
- **AND** each call observes its own per-agent sentinel under `/tmp/a2a/<agent>/signals/`
- **AND** no path collision or sentinel cross-talk occurs

#### Scenario: Capture timeout when sentinel never arrives
- **GIVEN** an agent whose claude session has crashed or is stuck before the Stop hook can fire
- **WHEN** `pty_capture_turn` is called with default timeout (60s)
- **THEN** the call returns an error after 60s
- **AND** the captured log file is renamed to `turn-<epoch>.partial.log` for forensic inspection
- **AND** tmux state (window size, pipe-pane) is restored regardless of the timeout

### Requirement: The capture orchestrator SHALL force claude's render geometry to 240×100 during capture

Before injecting `input` into the agent's PTY, the orchestrator SHALL set the tmux window size to a forced 240 columns × 100 rows using:

```
tmux set-option -t <agent> window-size manual
tmux resize-window -t <agent> -x 240 -y 100
```

After the sentinel signal is received and the pipe-pane is closed, the orchestrator SHALL restore client-driven sizing:

```
tmux set-option -t <agent> window-size automatic
```

The fixed 240×100 dimensions are sufficient for every documented claude built-in slash command panel (`/context`, `/usage`, `/help`, `/cost`) plus reasonable headroom for custom commands.

#### Scenario: Window-size override prevents at-width corruption
- **GIVEN** an agent whose visible xterm is 86 columns × 71 rows
- **AND** claude's `/context` panel needs >86 columns to render its two-column layout without overlap
- **WHEN** `pty_capture_turn` runs `/context`
- **THEN** the tmux session is temporarily resized to 240×100
- **AND** claude renders for 240 columns, no two-column overlap, no garbled `Avmcp__serena__safe_delete_symbolylbolseduthenticationion`-style corruption

#### Scenario: Geometry is restored after capture
- **GIVEN** an agent whose tmux session was 86×71 before a capture
- **WHEN** `pty_capture_turn` completes (success OR error)
- **THEN** the agent's tmux window-size mode is restored to `automatic`
- **AND** subsequent SIGWINCH from the visible client adapts the window back to 86×71

### Requirement: The capture orchestrator SHALL tee the agent's PTY output to a per-capture file via `tmux pipe-pane`

Before injecting `input`, the orchestrator SHALL enable a per-capture pipe with:

```
tmux pipe-pane -o -t <agent> "cat >> /tmp/a2a/<agent>/captures/turn-<epoch>.log"
```

The `-o` flag toggles the pipe; subsequent `tmux pipe-pane -t <agent>` (no arg) disables it. The captured file contains the byte stream claude wrote during the turn, with full fidelity (no truncation from quiescence detection, no ANSI dropped at capture time).

#### Scenario: Pipe-pane captures bytes claude wrote during the turn
- **GIVEN** an agent receives `/usage\r` via `pty_write`
- **AND** claude renders the `/usage` panel including the API-paced "Scanning sessions…" interlude
- **WHEN** the orchestrator enables `pipe-pane` before the write and disables it after the sentinel
- **THEN** the captured file contains every byte claude wrote to the PTY between those two boundaries
- **AND** no bytes are lost to timing-window heuristics

#### Scenario: Pipe-pane is disabled even on capture failure
- **GIVEN** the sentinel never arrives (timeout or crash)
- **WHEN** the orchestrator hits its timeout
- **THEN** `tmux pipe-pane -t <agent>` is invoked to disable the pipe
- **AND** the agent's normal PTY output continues unaffected

### Requirement: The capture orchestrator SHALL detect turn completion via a filesystem sentinel written by claude's `Stop` hook

Each agent's claude session SHALL be launched with a per-agent settings file that registers a `Stop` hook. When claude completes a turn, the hook SHALL `touch` a sentinel file under `/tmp/a2a/<A2A_AGENT>/signals/turn-<epoch>.done`. The orchestrator SHALL poll the agent's signals directory at 50ms intervals after `pty_write` returns, and SHALL accept the FIRST sentinel file whose mtime is greater than the orchestrator's recorded `start_instant`.

The sentinel filename uses whole-second epoch (`date +%s`); the actual completion ordering is determined by APFS sub-second mtime via `stat -f %m`. **The hook command MUST use BSD-userland `date` syntax only** — `%3N` and `%N` are GNU-only and produce literal output on macOS.

#### Scenario: Sentinel arrives, capture completes
- **GIVEN** the per-agent Stop hook is installed
- **AND** the capture orchestrator records `start_instant` immediately before `pty_write`
- **WHEN** claude finishes the turn and the Stop hook fires
- **THEN** a file appears under `/tmp/a2a/<agent>/signals/` with mtime > start_instant
- **AND** the orchestrator detects this file within 50ms of its appearance
- **AND** proceeds to the stabilization-delay step

#### Scenario: Stale sentinels from previous turns are ignored
- **GIVEN** the agent has had previous turns whose sentinel files still exist in `/tmp/a2a/<agent>/signals/`
- **WHEN** a new capture starts at `start_instant`
- **THEN** only sentinel files with mtime > start_instant are eligible
- **AND** older sentinels are skipped during polling

### Requirement: A2AChannel SHALL inject the per-agent claude settings file at agent spawn

For each agent spawn, the Tauri shell SHALL materialize a per-agent settings file at `~/Library/Application Support/A2AChannel/settings/<agent>.json` containing the `Stop` hook command. The claude invocation SHALL include `--settings <path>` referencing this file (mirrors the existing `--mcp-config <path>` pattern). The agent's tmux session SHALL be spawned with `A2A_AGENT=<name>` in its env so the hook command can scope its sentinel writes per-agent.

#### Scenario: Settings file is materialized at every spawn
- **WHEN** `pty_spawn(agent, cwd, ...)` is invoked
- **THEN** the file `~/Library/Application Support/A2AChannel/settings/<agent>.json` is written (mode 0600)
- **AND** the file's `Stop` hook command references `$A2A_AGENT` for path scoping
- **AND** the claude invocation includes `--settings <that path>`

#### Scenario: Stale settings files self-heal
- **GIVEN** a settings file from a previous spawn exists at the expected path with outdated content
- **WHEN** the agent is respawned
- **THEN** the file is overwritten with current content (atomic write or write-and-rename)
- **AND** the new claude session uses the fresh hook

### Requirement: Captured log files SHALL be retained per-agent up to 10 successful captures, with failed captures retained until reboot

The orchestrator SHALL prune captures older than the 10 most recent successful ones for each agent on every successful capture. Failed captures (`.partial.log` suffix) SHALL NOT be pruned by the success path; they remain until OS-level `/tmp` cleanup (typically reboot) for forensic inspection.

#### Scenario: Successful captures rotate at 10-deep
- **GIVEN** the directory `/tmp/a2a/<agent>/captures/` contains 12 successful capture log files
- **WHEN** a new successful capture writes the 13th file
- **THEN** the orchestrator removes the 3 oldest successful captures
- **AND** exactly 10 successful captures remain (plus any `.partial.log` files unaffected)

#### Scenario: Failed captures persist for forensics
- **GIVEN** a capture times out and is renamed to `turn-<epoch>.partial.log`
- **WHEN** subsequent successful captures occur
- **THEN** the `.partial.log` file remains on disk
- **AND** is only removed by OS-level `/tmp` cleanup
