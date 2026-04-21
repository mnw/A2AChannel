## MODIFIED Requirements

### Requirement: A2AChannel bundles tmux and orchestrates one session per agent

A static tmux binary for `aarch64-apple-darwin` SHALL be bundled under `src-tauri/resources/tmux` and packaged into `A2AChannel.app/Contents/Resources/`. The Rust shell SHALL invoke the bundled tmux binary against a shared socket at `~/Library/Application Support/A2AChannel/tmux.sock` to start a detached session via a single `new-session -d` invocation:

```
bundled-tmux -S <sock> new-session -d -s <agent> -x 80 -y 24 -c <cwd>
  '<SHELL> -ic "claude --mcp-config <path> --dangerously-load-development-channels server:chatbridge"'
```

The entire shell-wrapped command is passed as a SINGLE tmux argv element (with internal single-quote escaping) so `/bin/sh -c` doesn't re-tokenize it — see also the argv-packaging requirement below.

The `$SHELL -ic` wrapper is load-bearing: Anthropic's installer creates `claude` as a `.zshrc` alias, not a PATH binary. Interactive shells source `.zshrc` (login shells don't), so `-ic` is the only reliable way to resolve the alias. This also picks up user-PATH tools the project's MCP config depends on (docker, npm, uvx).

Session names SHALL match the agent name exactly (validated against the hub's `AGENT_NAME_RE`, both on the UI and defensively in Rust). The session is created in detached mode; the Rust shell does not attach as a controlling client at spawn time.

Sessions SHALL NOT be configured with `remain-on-exit on`. When claude exits for any reason, the pane exits, the tmux session dies, and the UI's `pty://exit/<agent>` listener removes the tab. On auto-attach to sessions that outlived an earlier A2AChannel process, the Rust shell SHALL defensively run `set-option -t <agent> remain-on-exit off` to clear the option from any legacy v0.7-alpha session that set it.

The tmux status bar SHALL be hidden (`set-option -t <agent> status off`) on both create and auto-attach paths — redundant with the A2AChannel tab label.

The bundled tmux binary SHALL be codesigned explicitly (ad-hoc sign) before the outer `.app` is assembled, not relying solely on `codesign --deep`. This avoids library-validation issues on macOS versions that enforce it for nested executables.

#### Scenario: New terminal session for an agent

- **GIVEN** no tmux session named `alice` exists
- **WHEN** the user clicks "Launch" on the `alice` tab in the terminal pane
- **THEN** A2AChannel invokes `bundled-tmux -S <sock> new-session -d -s alice -x 80 -y 24 -c <cwd> <shell-wrapped-claude>` targeting the shared socket
- **AND** immediately after, `set-option -t alice status off` is invoked to hide the status bar
- **AND** A2AChannel does NOT kill the session when the app exits

#### Scenario: claude alias in .zshrc resolves under `$SHELL -ic`

- **GIVEN** the user's `.zshrc` contains `alias claude=~/.claude/local/claude` (Anthropic installer default)
- **AND** A2AChannel is launched via the macOS GUI (not from a terminal — PATH is sparse)
- **WHEN** the user clicks Launch on an agent tab
- **THEN** the interactive shell started by `$SHELL -ic` sources `.zshrc`, resolves the alias, and starts claude
- **AND** claude starts in the tmux pane without a "command not found" error

#### Scenario: Claude exit terminates the tab

- **GIVEN** an `alice` session is running claude
- **WHEN** the user types `/exit` inside the xterm (or claude crashes)
- **THEN** claude exits cleanly, the pane exits, the tmux session is destroyed
- **AND** the PTY reader emits `pty://exit/alice`
- **AND** the UI removes the `alice` tab
- **AND** the user may relaunch via `+ New agent` with the same name (fresh session, fresh scrollback)

#### Scenario: Auto-attach clears legacy `remain-on-exit` on startup

- **GIVEN** an `alice` tmux session exists on the socket with `remain-on-exit` set to `on` (e.g. created by a v0.7-alpha build)
- **WHEN** A2AChannel starts and `pty_spawn` auto-attaches on reconcile
- **THEN** A2AChannel runs `set-option -t alice remain-on-exit off` before attaching the PTY
- **AND** a subsequent `/exit` from the user cleanly terminates the session (no held pane)

#### Scenario: Agent name invalid for session creation

- **WHEN** the user attempts to open a terminal for an agent whose name contains `/` or `:`
- **THEN** A2AChannel refuses with an error (UI-side validation)
- **AND** the error is re-enforced server-side in the Rust shell if the UI check is bypassed
- **AND** no tmux invocation occurs

### Requirement: The webview renders each agent's tmux session via a raw PTY bridge

The webview SHALL provide a vertically-tabbed right-side pane (`xterm.js`-backed) with one tab per known agent. Tabs are ordered by agent name. Opening a tab for an agent with an active tmux session SHALL attach to that session by spawning `bundled-tmux -S <sock> attach-session -t <agent>` inside a pseudo-terminal (PTY) allocated by the Rust shell via the `portable-pty` crate. The PTY master's raw byte stream SHALL be forwarded to the xterm instance verbatim via Tauri events; keystrokes produced by xterm.js SHALL be written to the PTY master as raw bytes via Tauri commands.

`tmux -C` control mode SHALL NOT be used. `send-keys` SHALL NOT be used for interactive input forwarding. All terminal I/O passes through the PTY as raw ANSI bytes.

The right pane SHALL be opt-in: a header toggle persists the choice in `localStorage` under `a2achannel_terminal_enabled`. Default state is off on first launch so existing users see no UI change on upgrade.

The Rust shell SHALL expose exactly the following Tauri surface for terminal I/O:

- Command `pty_spawn(agent: string, cwd: string)` — creates the tmux session (if missing), hides the status bar, defensively clears `remain-on-exit`, and allocates a PTY for xterm attach.
- Command `pty_write(agent: string, b64: string)` — writes base64-decoded bytes to the PTY master.
- Command `pty_resize(agent: string, cols: number, rows: number)` — propagates terminal dimensions via `TIOCSWINSZ`.
- Command `pty_kill(agent: string)` — issues `tmux kill-session -t <agent>`. Same outcome is reached when claude itself exits (session dies naturally).
- Command `pty_list()` — returns the current set of tmux sessions on the shared socket.
- Event `pty://output/<agent>` — emitted by the Rust shell carrying `{ agent, b64: string }` for each read from the PTY master. Payload bytes are standard-base64 encoded to avoid the JSON int-array expansion tax.
- Event `pty://exit/<agent>` — emitted when the attached `tmux` child exits.

Note: earlier drafts included `pty_restart` (for re-running claude inside a `remain-on-exit`-held pane). That feature was dropped when session-dies-on-exit became the chosen model — restart is expressed as "kill + `+ New agent`" and needs no dedicated command.

#### Scenario: User enables the terminal pane

- **WHEN** the user clicks the terminal toggle in the header
- **THEN** the right-side pane appears with one tab per known agent
- **AND** selecting a tab attaches to that agent's tmux session via a new PTY and begins streaming output
- **AND** `localStorage.a2achannel_terminal_enabled` is set to `"true"`

#### Scenario: Typing in the pane reaches the session

- **GIVEN** the user has selected the `alice` tab and the xterm has focus
- **WHEN** the user types `/model` + Enter
- **THEN** xterm.js's `onData` callback fires with the raw byte sequence
- **AND** the UI base64-encodes the bytes and invokes `pty_write(agent="alice", b64="...")`
- **AND** the bytes reach tmux via the PTY master
- **AND** claude's output echoes back through the PTY and renders in the xterm

#### Scenario: Interactive permission prompt

- **GIVEN** the agent pauses for a permission prompt (e.g. "run this command? y/N")
- **WHEN** the user types `y` + Enter in the xterm pane
- **THEN** the keystrokes are delivered via PTY and the agent resumes
- **AND** no control-mode framing or `send-keys` indirection occurs

#### Scenario: Resize propagates to the session

- **GIVEN** the user resizes the A2AChannel window
- **WHEN** the xterm container resizes
- **THEN** the fit-addon computes new `cols` / `rows`
- **AND** the UI invokes `pty_resize(agent, cols, rows)`
- **AND** the PTY master issues `TIOCSWINSZ`
- **AND** `stty size` inside the session reflects the new dimensions

#### Scenario: Output streams in near-real-time

- **GIVEN** claude is producing output at >1 KB/s
- **WHEN** bytes arrive at the PTY master
- **THEN** the Rust reader task emits them as `pty://output/<agent>` events within 50 ms of receipt
- **AND** xterm.js renders them in order without coalescing delays beyond its own frame budget

### Requirement: User can still `tmux attach` from their own terminal

The shared socket at `~/Library/Application Support/A2AChannel/tmux.sock` SHALL be documented in the README as a supported attachment point. A user running `bundled-tmux -S ~/Library/Application\ Support/A2AChannel/tmux.sock attach -t <agent>` in their own Terminal.app SHALL be able to interact with the same session concurrently with the A2AChannel webview pane.

Multi-client input behavior SHALL follow tmux's native semantics (both clients can type; documented caveat: interactive prompts should be answered from one client at a time).

#### Scenario: External attach works alongside webview attach

- **GIVEN** A2AChannel's pane is attached to the `alice` session
- **WHEN** the user runs `bundled-tmux -S ~/Library/Application\ Support/A2AChannel/tmux.sock attach -t alice` in Terminal.app
- **THEN** both clients see identical output
- **AND** keystrokes from either client reach the session's stdin

## ADDED Requirements

### Requirement: Agents enter the terminal pane via explicit or reactive creation

The UI SHALL support two entry paths for an agent to appear as a tab in the terminal pane:

1. **Explicit:** a `+ New agent` control in the tab strip opens a modal requesting an agent name (validated against `AGENT_NAME_RE`) and a working directory (native directory picker). On submit, A2AChannel generates the per-agent MCP config (per the MCP config requirement below), spawns the tmux session with `--mcp-config <path>`, allocates the PTY, and the tab renders claude's startup.
2. **Reactive:** when the hub's roster gains a new agent (because a `channel-bin` sidecar registered from a `claude` session the user started outside A2AChannel), the UI SHALL add a tab for that agent in an `external` state. The tab is display-only: no xterm is mounted and no PTY is owned by A2AChannel.

An agent MAY transition between states:

- `external` → `live` when the user explicitly launches a session inside A2AChannel for that agent name (this spawns a new tmux session; the user is responsible for quitting any previously-running external claude to avoid channel-bin collisions).
- `live` → tab-removed when the session is killed (via the tab × control, via external `tmux kill-session`, via claude `/exit`, or because claude crashes). There is no intermediate `dead` state; `pty://exit/<agent>` fires and the UI removes the tab. If the agent remains in the hub roster after, the next reconcile re-surfaces it as `external`.

#### Scenario: Explicit agent creation

- **GIVEN** the roster is empty (only the human)
- **WHEN** the user clicks `+ New agent`, enters name `alice`, picks cwd `/code/project-alice`
- **THEN** A2AChannel writes the per-agent MCP config at `~/Library/Application Support/A2AChannel/mcp-configs/alice.json`
- **AND** a tmux session named `alice` is created on the shared socket with claude as its first command
- **AND** a tab for `alice` appears in the pane in the `live` state with an xterm attached to the PTY
- **AND** within a few seconds `channel-bin` (spawned by claude via `.mcp.json`) registers `alice` with the hub and the legend pill turns online

#### Scenario: Reactive agent creation

- **GIVEN** the user has a pre-existing `.mcp.json` in `/code/project-bob` with `CHATBRIDGE_AGENT=bob` and runs `claude` from Terminal.app in that directory
- **WHEN** `channel-bin` registers `bob` with the hub
- **THEN** the hub broadcasts a roster update
- **AND** a tab for `bob` appears in the terminal pane in the `external` state
- **AND** the tab shows a status line indicating the agent is running outside A2AChannel
- **AND** no xterm is mounted for that tab and A2AChannel does NOT own a PTY for `bob`

### Requirement: A2AChannel generates a per-agent MCP config file and passes it via `--mcp-config`

On explicit spawn, A2AChannel SHALL write a per-agent MCP config file at `~/Library/Application Support/A2AChannel/mcp-configs/<agent>.json` (mode `0600`, directory mode `0700`) containing only the `chatbridge` server entry with `CHATBRIDGE_AGENT` set to the chosen agent name. The file SHALL be regenerated on every spawn (not merged) so stale paths or agent names self-heal.

The tmux-spawned claude command SHALL include `--mcp-config <absolute-path-to-generated-file>`. A2AChannel SHALL NOT modify, merge, or create any `.mcp.json` file in the user's filesystem. The user's existing project `.mcp.json` (if any) loads additively alongside our generated config — claude merges servers from both sources without `--strict-mcp-config`.

This requirement supersedes an earlier draft that had A2AChannel author the user's project `.mcp.json`. The `--mcp-config` path was adopted after the PoC proved it works and eliminates an entire class of merge/write/confirm UX.

#### Scenario: Fresh spawn writes config

- **GIVEN** no config exists for agent `alice` at `~/Library/Application Support/A2AChannel/mcp-configs/alice.json`
- **WHEN** the user launches `alice` via `+ New agent`
- **THEN** A2AChannel writes the config file (mode `0600`) containing a single `mcpServers.chatbridge` entry
- **AND** `CHATBRIDGE_AGENT` in the entry equals `"alice"`
- **AND** the tmux-spawned claude receives `--mcp-config /Users/.../mcp-configs/alice.json`
- **AND** the user's project `.mcp.json` (if any) is not touched

#### Scenario: Existing project `.mcp.json` is preserved

- **GIVEN** `/code/project-alice/.mcp.json` exists with entries for `sequentialthinking`, `context7`, `serena` (but no `chatbridge`)
- **WHEN** the user launches `alice` with cwd `/code/project-alice`
- **THEN** the project's `.mcp.json` is not modified
- **AND** claude spawns children for ALL of `sequentialthinking`, `context7`, `serena`, AND `chatbridge`
- **AND** `chatbridge` registers with the hub as `alice`

### Requirement: Terminal pane state reconciles with tmux's actual session set

The UI SHALL reconcile its tab strip against `pty_list()` on each of: pane toggle (off→on), every 5 seconds while the pane is visible, and after any `pty_kill` or `pty_spawn` completes. Tabs for sessions that no longer exist in tmux SHALL be removed; sessions present in tmux but absent from the UI SHALL appear as tabs.

The tab strip SHALL also merge the hub's `knownAgents` roster so agents whose tmux session has not been launched yet appear as tabs with a "Launch" affordance.

#### Scenario: External kill is reflected in the UI

- **GIVEN** the `alice` tab is visible
- **WHEN** the user runs `bundled-tmux -S <sock> kill-session -t alice` from Terminal.app
- **THEN** within 5 seconds the UI detects `alice` is gone from `pty_list()`
- **AND** the tab is removed (or transitions to the "Launch" state if `alice` is still in `knownAgents`)

#### Scenario: Roster member with no terminal session

- **GIVEN** the hub's roster contains `bob` but no tmux session exists for `bob`
- **WHEN** the user opens the terminal pane
- **THEN** a `bob` tab appears with a "Launch" button
- **AND** clicking "Launch" invokes `pty_spawn(agent="bob", cwd=<chosen>)` and the tab switches to the attached state
