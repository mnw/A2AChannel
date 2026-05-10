## ADDED Requirements

### Requirement: `Tab` / `XtermBinder` / `PtyEvents` are three distinct modules

`ui/terminal.js` SHALL be split into three modules under `ui/terminal/` (which today already contains `pty.js` and `xterm-themes.js`):
- `ui/terminal/tab.js` — owns Tab lifecycle (cold-start sequence, reconnect on reload, dispose on close, dev-channels prompt auto-dismiss)
- `ui/terminal/xterm-binder.js` — owns xterm.js bindings (write to terminal, refit on container resize, theme application)
- `ui/terminal/pty-events.js` — owns PTY event subscription (output streaming, exit detection, resize signals from container)

Each module MUST have a clear seam: `Tab` consumes `XtermBinder` and `PtyEvents` via constructor injection. `XtermBinder` and `PtyEvents` MUST NOT call into `Tab` directly; they expose callbacks the Tab subscribes to.

#### Scenario: Tab module is the only one importing the others

- **GIVEN** the three module files
- **WHEN** static-analyzed for imports
- **THEN** `tab.js` imports both `xterm-binder.js` and `pty-events.js`
- **AND** `xterm-binder.js` does NOT import `pty-events.js`
- **AND** `pty-events.js` does NOT import `xterm-binder.js`

#### Scenario: Internals are not referenced outside ui/terminal/

- **WHEN** the codebase is grepped for `XtermBinder` or `PtyEvents` outside `ui/terminal/*`
- **THEN** zero matches are returned
- **AND** all consumers go through the `Tab` orchestrator only

#### Scenario: Disposing a Tab releases all PTY listeners

- **GIVEN** a Tab with an attached `PtyEvents` subscription
- **WHEN** the Tab is disposed (user closes pane, or kill+respawn lifecycle event fires)
- **THEN** all PTY event listeners registered by that Tab are released
- **AND** a subsequent respawn attaches exactly one listener (no listener-leak)

### Requirement: `XtermBinder.mount()` resolves only after geometry-heal completes

`XtermBinder` SHALL expose `mount(container, opts): Promise<void>` whose resolution semantics ARE: the returned promise resolves only after (a) the xterm.js instance is attached to `container`, (b) the initial fit (column/row count derived from container dimensions) has been computed and applied, AND (c) the corresponding SIGWINCH has propagated to the PTY master (geometry-heal). Callers (i.e. `Tab`) MUST await `mount()` before any `write()` or `attachPty()` call.

This is the structural enforcement of the cold-start race fix: claude probes its terminal capabilities during MCP init and downgrades output (Braille/box-drawing → ASCII underscores) if it observes a stub geometry. Mount-then-await ensures the PTY sees the real geometry before claude reads `$LINES`/`$COLUMNS`.

#### Scenario: write() after mount() sees post-heal geometry

- **GIVEN** a fresh Tab cold-starts and calls `await binder.mount(div)`
- **WHEN** the `mount()` promise resolves
- **THEN** the PTY master has received a SIGWINCH carrying the post-fit geometry
- **AND** any subsequent `binder.write()` call lands at the correct column count

#### Scenario: theme change during a live session triggers refit

- **GIVEN** a live Tab with attached xterm + PTY
- **WHEN** the user toggles dark/light theme (which changes line-height in the xterm DOM)
- **THEN** `XtermBinder` re-fits the xterm grid against the new line-height
- **AND** a SIGWINCH carrying the new geometry propagates to the PTY master

### Requirement: Cold-start invariant from cycle-1 is preserved

`Tab` cold-start (first PTY spawn for a fresh agent) MUST NOT lose the dev-channels confirmation auto-dismiss output-scan behavior, MUST NOT race with claude's MCP init window (~10s after spawn during which `notifications/claude/channel` is silently dropped), and MUST NOT re-introduce `tmux -C` control mode.

#### Scenario: Dev-channels prompt is auto-dismissed by output-scan

- **GIVEN** a fresh Tab is cold-starting a claude session with `--dangerously-load-development-channels`
- **WHEN** the literal string "I am using this for local development" appears in the PTY output stream
- **THEN** `Tab` (via `PtyEvents` callback) sends `\r` plus a SIGWINCH resize-cycle to the PTY
- **AND** no time-based `setTimeout` is used to dismiss the prompt

#### Scenario: Reconnect storm collapses cleanly

- **GIVEN** the user closes and reopens a Tab N times in <500ms
- **WHEN** the close+reopen sequence completes
- **THEN** the final reopen attaches to the surviving tmux session
- **AND** no orphan xterm instances remain
- **AND** PTY event subscriptions match exactly one binding

### Requirement: Smoke-checklist file `tests/smoke/tab-lifecycle.md` is a tracked artifact

`tests/smoke/tab-lifecycle.md` SHALL exist as a tracked file in the repo with four scenarios — cold-start race, reconnect storm, theme-change refit, kill+respawn — each row containing `expected` / `observed` / `pass-fail` columns. The file is the auditable record of the manual smoke-test that gates the Tab-split commit per design.md Decision 2.

(The "Tab-split commit gated on all observed-rows passing" rule is operational policy, not a runtime invariant — see design.md Decision 2 for the gating logic. This requirement covers ONLY the existence + shape of the artifact, which IS auditable post-merge via `git ls-files`.)

#### Scenario: Checklist file exists and is shape-conformant

- **WHEN** the post-cycle codebase is examined
- **THEN** `tests/smoke/tab-lifecycle.md` is a tracked file
- **AND** it contains four scenario sections (cold-start race, reconnect storm, theme-change refit, kill+respawn)
- **AND** each section has `expected` / `observed` / `pass-fail` columns or equivalent fields
