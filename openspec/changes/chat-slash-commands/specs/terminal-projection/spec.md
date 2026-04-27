## ADDED Requirements

### Requirement: Agent PTY accepts writes from the chat composer in slash mode

In addition to keystrokes typed inside the focused xterm tab, an agent's PTY master SHALL accept byte writes originating from the chat composer when the composer is in slash mode and addressing that agent. The mechanism is the existing `pty_write(agent: String, b64: String)` Tauri command at `src-tauri/src/pty.rs`. No new Tauri command is introduced.

The PTY does not distinguish input by origin: bytes written from the composer are indistinguishable from bytes typed in the xterm. tmux's normal multi-client semantics apply (concurrent input from multiple sources is supported).

#### Scenario: Composer slash send writes bytes that the xterm immediately echoes
- **GIVEN** the user has the `builder` xterm tab visible and the room composer focused
- **WHEN** the user sends `/clear @builder` from the composer
- **THEN** the `builder` xterm tab shows the typed `/clear` command being processed by claude
- **AND** the bytes were delivered via `pty_write(agent="builder", b64=base64("/clear\r"))`

#### Scenario: External-state agent rejects composer slash sends
- **GIVEN** an agent `bob` is in `external` state (A2AChannel does not own its PTY)
- **WHEN** the user attempts `/clear @bob` from the composer
- **THEN** the composer's `@`-popover did not list `bob` as a valid target
- **AND** no `pty_write` invocation for `bob` occurs
