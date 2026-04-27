## ADDED Requirements

### Requirement: Composer enters slash mode on a leading `/`

The chat composer SHALL enter **slash mode** when the user types `/` as the first character of an otherwise empty composer input. While in slash mode, the composer renders a **slash picker popover** above the input. Backspacing the leading `/` SHALL exit slash mode and dismiss the picker. Pressing `Escape` while the picker is open SHALL also exit slash mode.

#### Scenario: Typing `/` opens the slash picker
- **GIVEN** the chat composer is empty and focused
- **WHEN** the user types `/`
- **THEN** the slash picker popover is shown above the composer
- **AND** the composer's send button is disabled until a valid `slashCommand + @target` is entered

#### Scenario: Typing `/` mid-message does not trigger slash mode
- **GIVEN** the composer already contains the text `look at`
- **WHEN** the user types ` /etc/hosts`
- **THEN** the slash picker popover does NOT appear
- **AND** the composer remains in normal chat mode

#### Scenario: Backspacing the leading `/` exits slash mode
- **GIVEN** the composer is in slash mode with content `/cl`
- **WHEN** the user backspaces until only `cl` remains
- **THEN** the slash picker popover is dismissed
- **AND** the composer returns to chat mode

### Requirement: Slash mode is blocked when no concrete room is selected

When the room dropdown is on `All rooms`, the slash picker SHALL refuse to open and SHALL display a hint instructing the user to select a concrete room. Sending a `/`-prefixed message in this state SHALL be rejected client-side without invoking `pty_write`.

#### Scenario: Slash picker refuses in All-rooms view
- **GIVEN** the room dropdown is set to `All rooms`
- **WHEN** the user types `/` in the composer
- **THEN** the picker shows the message `Select a room first`
- **AND** the composer's send button stays disabled regardless of further input

### Requirement: Slash picker shows the union of commands across the room's live agents with per-agent badges

The slash picker SHALL list every slash command discoverable for at least one live agent in the currently-selected room. Each list entry SHALL include a badge of the form `N/M agents` where `N` is the count of live agents in the room that have the command available and `M` is the total count of live agents in the room. Discovery SHALL include claude built-ins, MCP-registered prompts, custom commands under `<agent-cwd>/.claude/commands/`, custom skills under `<agent-cwd>/.claude/skills/`, and personal versions under `~/.claude/commands/` and `~/.claude/skills/`. Discovery SHALL be re-run each time the picker opens.

#### Scenario: Picker shows partial-availability commands with a badge
- **GIVEN** the selected room contains live agents `planner`, `builder`, `reviewer`, `docs`
- **AND** only `builder` defines `/refactor` in its `.claude/commands/`
- **WHEN** the user opens the slash picker
- **THEN** `/refactor` is listed with a `1/4 agents` badge
- **AND** built-in commands like `/clear` show `4/4 agents`

### Requirement: Every slash send requires explicit `@agent` or `@all` targeting

A slash send SHALL include exactly one `@target` token following the slash command. Valid targets are: an exact live-agent name in the selected room, or the literal `all`. Sending `/cmd` with no target SHALL be rejected client-side with the inline error `specify @agent or @all`. The `@target` token SHALL trigger the existing `@mention` popover for autocomplete.

#### Scenario: `/cmd` with no target is refused
- **GIVEN** the composer contains `/clear` (no `@`)
- **WHEN** the user presses Enter or clicks send
- **THEN** the composer displays the inline error `specify @agent or @all`
- **AND** no `pty_write` invocation occurs

#### Scenario: `@all` resolves only to live, non-busy agents in the selected room
- **GIVEN** the selected room contains agents `planner` (live), `builder` (live, permission pending), `nebula` (external), `docs` (live)
- **WHEN** the user sends `/clear @all`
- **THEN** `pty_write` is invoked for `planner` and `docs` only
- **AND** `builder` is excluded with reason `permission pending`
- **AND** `nebula` is excluded with reason `external state — not owned by A2AChannel`

#### Scenario: `@all` to a single-agent room behaves like targeting that one agent
- **GIVEN** the selected room contains exactly one live agent `solo`
- **WHEN** the user sends `/help @all`
- **THEN** `pty_write` is invoked once for `solo`

### Requirement: Slash sends invoke `pty_write` with the literal command bytes

For each resolved target agent, the composer SHALL invoke the existing `pty_write(agent, b64)` Tauri command with the bytes of `<slashCommand>[ <args>]\r` (CR, not CRLF) base64-encoded. The bytes SHALL NOT pass through the hub channel and SHALL NOT be delivered as MCP notifications.

#### Scenario: Slash send writes raw bytes to PTY and bypasses the hub
- **GIVEN** the composer contains `/compact @builder`
- **WHEN** the user sends
- **THEN** `pty_write` is invoked with `agent="builder"` and `b64=base64("/compact\r")`
- **AND** no `POST /post` request to the hub occurs for this send
- **AND** the agent's xterm tab shows the typed `/compact` command being processed by claude

### Requirement: Each successful slash send produces one synthetic system audit entry in chat

After `pty_write` resolves for the resolved target list, the webview SHALL append exactly one entry of type `system` to the chat log. The entry text SHALL include the full slash command + args, the targeting expression as the user wrote it (e.g. `@all` or `@builder`), the resolved target list, any skipped agents with reason, and the local timestamp. The entry SHALL be in-memory only; the hub SHALL NOT be informed.

#### Scenario: Audit entry includes resolved and skipped targets
- **GIVEN** the user sends `/clear @all` to a room of `planner`, `builder` (permission pending), `reviewer`, `docs`
- **WHEN** `pty_write` completes
- **THEN** one chat row of type `system` is appended with text:
  `human → /clear @all (planner, reviewer, docs) — skipped: builder (permission pending)`
- **AND** no `POST /post` was sent to the hub for the audit entry

### Requirement: Destructive slash commands targeting more than one agent require confirmation

When the slash command is a member of the destructive set `{ /clear, /compact }` AND the resolved target list contains more than one agent, the composer SHALL display a confirm modal naming the command and the resolved targets before invoking any `pty_write`. Single-agent destructive sends and any non-destructive send (regardless of target count) SHALL proceed without a confirm modal.

#### Scenario: `/clear @all` to a multi-agent room triggers confirm
- **GIVEN** the user is about to send `/clear @all` resolving to 4 agents
- **WHEN** the user clicks send
- **THEN** a modal appears with text mentioning `/clear` and the 4 target names
- **AND** `pty_write` is not invoked until the user clicks `Confirm`
- **AND** clicking `Cancel` aborts the send entirely (no audit entry)

#### Scenario: `/clear @builder` (single target) does not trigger confirm
- **GIVEN** the user sends `/clear @builder`
- **WHEN** the user clicks send
- **THEN** no confirm modal appears
- **AND** `pty_write` is invoked immediately for `builder`

#### Scenario: `/help @all` (non-destructive) does not trigger confirm
- **GIVEN** the user sends `/help @all` resolving to 4 agents
- **WHEN** the user clicks send
- **THEN** no confirm modal appears
- **AND** `pty_write` is invoked for each of the 4 agents

### Requirement: External-state agents and the shell tab are never slash targets

Agents whose `data-state` is `external` (running outside A2AChannel; A2AChannel does not own their PTY) SHALL be excluded from `@all` expansion and SHALL NOT be selectable from the `@mention` popover when the composer is in slash mode. The shell tab SHALL never be presented as a slash target.

#### Scenario: External-state agent is filtered out of slash @-popover
- **GIVEN** the selected room contains a live agent `alice` and an external agent `bob`
- **WHEN** the user types `/clear @` in the composer
- **THEN** the @-popover lists `alice` and `all`
- **AND** `bob` is not listed

#### Scenario: Shell tab is not a slash target
- **GIVEN** any room is selected and the shell tab exists in the terminal pane
- **WHEN** the user types `/clear @` in the composer
- **THEN** the @-popover does not list the shell tab as a target
