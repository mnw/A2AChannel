# terminal-projection Specification

## Purpose
TBD - created by archiving change v06-roadmap. Update Purpose after archive.
## Requirements
### Requirement: A2AChannel bundles tmux and orchestrates one session per agent

A static tmux binary for `aarch64-apple-darwin` SHALL be bundled under `src-tauri/resources/tmux` and packaged into `A2AChannel.app/Contents/Resources/`. `a2a-bin` SHALL gain a new mode `A2A_MODE=pty` that, when spawned with `AGENT=<name>`, invokes the bundled tmux binary against a shared socket at `~/.config/A2AChannel/tmux.sock` to start a detached session named `<agent-name>` running `claude --dangerously-load-development-channels` in a user-chosen working directory.

Session names SHALL match the agent name exactly (validated against the hub's `AGENT_NAME_RE`). The session is created in detached mode; A2AChannel does not attach as a controlling client at spawn time.

#### Scenario: New terminal session for an agent

- **GIVEN** no tmux session named `alice` exists
- **WHEN** the user clicks "Open terminal" next to the `alice` pill in the legend
- **THEN** A2AChannel spawns the bundled tmux binary with `new-session -d -s alice` targeting the socket at `~/.config/A2AChannel/tmux.sock`
- **AND** tmux runs `claude --dangerously-load-development-channels` as the session's first command in the configured cwd
- **AND** A2AChannel does NOT kill the session when the app exits

#### Scenario: Agent name invalid for session creation

- **WHEN** the user attempts to open a terminal for an agent whose name contains `/` or `:`
- **THEN** A2AChannel refuses with an error
- **AND** no tmux invocation occurs

### Requirement: The webview renders each agent's tmux session in a right-side pane

The webview SHALL provide a vertically-tabbed right-side pane (`xterm.js`-backed) with one tab per active tmux session. Tabs are ordered by agent name. Opening a tab attaches to the session via `tmux -C attach-session -t <agent>` (control mode); the xterm renders output in real time, and keystrokes in the terminal pane are forwarded as `send-keys -t <agent> -l <input>` to the session.

The right pane SHALL be opt-in: a header toggle persists the choice in `localStorage`. Default state is off (chat-only) so existing users don't see a UI change on upgrade.

#### Scenario: User enables the terminal pane

- **WHEN** the user clicks the terminal toggle in the header
- **THEN** the right-side pane appears with one tab per active tmux session
- **AND** selecting a tab attaches to that session and begins streaming output
- **AND** localStorage stores `a2achannel_terminal_enabled=true`

#### Scenario: Typing in the pane sends to the session

- **GIVEN** the user has selected the `alice` tab
- **WHEN** the user types `/model` + Enter
- **THEN** `send-keys -t alice -l "/model" Enter` is issued against the tmux socket
- **AND** the session's output echoes the command and Claude's response streams back into the xterm

### Requirement: tmux sessions survive A2AChannel restart

tmux sessions are long-lived by design. A2AChannel SHALL NOT terminate sessions on app exit, crash, or SIGTERM. On next launch, the webview SHALL query `tmux list-sessions` against the shared socket and populate the tab bar from the result.

#### Scenario: App quit and relaunch preserves the session

- **GIVEN** a tmux session named `alice` is running claude
- **WHEN** the user quits A2AChannel and relaunches it
- **THEN** `alice` still exists in tmux
- **AND** enabling the terminal pane shows `alice` as an active tab
- **AND** attaching resumes the session's running claude process with its full scrollback intact

### Requirement: User can still `tmux attach` from their own terminal

The shared socket at `~/.config/A2AChannel/tmux.sock` SHALL be documented in the README as a supported attachment point. A user running `tmux -S ~/.config/A2AChannel/tmux.sock attach -t <agent>` in their own Terminal.app SHALL be able to interact with the same session concurrently with the A2AChannel webview pane.

Multi-client input behavior SHALL follow tmux's native semantics (both clients can type; documented caveat: interactive prompts should be answered from one client at a time).

#### Scenario: External attach works alongside webview attach

- **GIVEN** A2AChannel's pane is attached to the `alice` session
- **WHEN** the user runs `tmux -S ~/.config/A2AChannel/tmux.sock attach -t alice` in Terminal.app
- **THEN** both clients see identical output
- **AND** keystrokes from either client reach the session's stdin

### Requirement: Explicit kill control per session

Each tab in the right pane SHALL expose an `×` control that, on click, issues `tmux kill-session -t <agent>` and removes the tab. Confirmation is required (custom dialog, not browser `confirm()`).

#### Scenario: User kills a session

- **GIVEN** tab `alice` is visible
- **WHEN** the user clicks the `×` and confirms
- **THEN** `tmux kill-session -t alice` runs
- **AND** the tab disappears from the pane
- **AND** any external `tmux attach -t alice` is disconnected

### Requirement: xterm.js is bundled, not fetched

The `xterm.js` library (ESM single-file build) and its default CSS SHALL be checked into the repository under `ui/vendor/` and loaded by `ui/index.html` via relative paths. No CDN, no bundler. Version pinned and documented in `ui/vendor/README.md`.

#### Scenario: Terminal pane works offline

- **GIVEN** the machine has no network connectivity
- **WHEN** the user opens A2AChannel and enables the terminal pane
- **THEN** xterm loads from the local bundle
- **AND** the pane renders and functions identically to the online case

