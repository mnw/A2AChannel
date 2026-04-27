## ADDED Requirements

### Requirement: The Tauri shell SHALL pass `--settings <path>` to claude alongside `--mcp-config <path>` at agent spawn

For each agent spawned via `pty_spawn`, the claude command line SHALL include `--settings <path>` where `<path>` is the absolute path to the per-agent settings file at `~/Library/Application Support/A2AChannel/settings/<agent>.json`. This mirrors the existing `--mcp-config <path>` pattern and follows the same "no user-file mutation" principle: A2AChannel materializes its own settings file under its own data dir; the user's `~/.claude/settings.json` remains untouched.

#### Scenario: Settings flag is included in claude invocation
- **WHEN** `pty_spawn(agent="alice", cwd="/work/proj", room="proj")` is called
- **THEN** the resulting tmux command spawns claude with arguments including `--mcp-config <mcp-path> --settings <settings-path>`
- **AND** `<settings-path>` is `~/Library/Application Support/A2AChannel/settings/alice.json`
- **AND** the user's `~/.claude/settings.json` is not modified

#### Scenario: Older claude versions without `--settings` support warn but do not block spawn
- **GIVEN** the user's claude binary does not recognize the `--settings` flag
- **WHEN** the Tauri shell detects this at spawn time (e.g. via `claude --help` parse)
- **THEN** the shell logs a warning recommending the user install the Stop hook to `~/.claude/settings.json` manually
- **AND** the agent still spawns successfully (without deterministic capture support)

### Requirement: The agent's tmux session SHALL include `A2A_AGENT=<name>` in its env at spawn

The `tmux new-session -e A2A_AGENT=<name>` flag SHALL be set so the Stop hook command can scope its sentinel-file writes per agent. This is in addition to the existing `CHATBRIDGE_AGENT` and `CHATBRIDGE_ROOM` env vars (which scope the channel-bin MCP sidecar). `A2A_AGENT` is independent — it is consumed by the Stop hook command in the per-agent settings file, not by chatbridge.

#### Scenario: A2A_AGENT env is set on the tmux session
- **WHEN** `pty_spawn(agent="bob", ...)` is called
- **THEN** the resulting `tmux new-session` invocation includes `-e A2A_AGENT=bob`
- **AND** any process spawned inside that session inherits `A2A_AGENT=bob` in its env
- **AND** the Stop hook command can resolve `$A2A_AGENT` to `"bob"` when it fires
