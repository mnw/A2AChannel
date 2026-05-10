## ADDED Requirements

### Requirement: `Composer` emits a `SendIntent` discriminated union

`ui/features/composer.js` SHALL expose a `Composer` Module that owns input state (textarea content, attachments tray, target room) and exposes `detectIntent(): SendIntent` returning one of three discriminated arms:

- `{ mode: "chat", target: string, text: string, attachments?: Attachment[] }` — chat post via Hub `/post` (or `/send`)
- `{ mode: "slash", agent: string, command: string, args: string[] }` — slash command via Tauri `pty_write` straight to the per-Agent tmux PTY
- `{ mode: "shift-tab", target: string }` — shift-tab via Tauri `pty_write` with the escape-code sequence

`detectIntent` MUST be a pure function of the current input state (textarea value + selected target + slash-mode flags). It MUST NOT mutate `sendBtn.disabled`, `input.value`, `SELECTED_ROOM`, or any other shared DOM state. The Send button's enabled/disabled state derives from the discriminator (single decision, single source).

#### Scenario: detectIntent returns chat mode for plain text

- **GIVEN** the textarea contains "hello world", target is "human", and slash-mode is off
- **WHEN** `Composer.detectIntent()` is called
- **THEN** the return value matches `{ mode: "chat", target: "human", text: "hello world" }`
- **AND** no shared DOM state has been mutated as a side effect

#### Scenario: detectIntent returns slash mode for /-prefixed input

- **GIVEN** the textarea contains "/clear", target is "@drupal", and slash-mode parsing recognizes the input
- **WHEN** `Composer.detectIntent()` is called
- **THEN** the return value matches `{ mode: "slash", agent: "drupal", command: "clear", args: [] }`

#### Scenario: detectIntent is invoked from per-keystroke handlers without side effects

- **GIVEN** the user is mid-keystroke (input event fires)
- **WHEN** the input handler calls `Composer.detectIntent()` to compute the Send button's disabled state
- **THEN** no other handler observes a state mutation as a side effect
- **AND** running `detectIntent()` twice in succession produces the same return value

### Requirement: Three per-mode adapters consume SendIntent

`Composer` SHALL provide three single-purpose dispatch adapters — `sendChat(intent: SendIntent & {mode: "chat"})`, `sendSlash(intent: SendIntent & {mode: "slash"})`, `sendShiftTab(intent: SendIntent & {mode: "shift-tab"})` — each owning its mode's validation + the actual send (Hub fetch or Tauri IPC). The Composer's send entry point dispatches on the `mode` discriminator: `dispatch(intent)` reads `intent.mode` and routes to the matching adapter.

Each adapter MUST be exercisable in isolation by passing a constructed intent shape — no DOM required.

#### Scenario: sendSlash is unit-testable in isolation

- **GIVEN** a `sendSlash` adapter and a constructed intent `{ mode: "slash", agent: "alice", command: "model", args: ["sonnet"] }`
- **WHEN** the adapter is invoked
- **THEN** it calls `pty_write` (or its Tauri-IPC equivalent) with the agent + command-text payload
- **AND** the test does NOT need to mount the DOM, set `input.value`, or trigger keystrokes

#### Scenario: A regression in slash detection does not break chat-send validation

- **GIVEN** `Composer.detectIntent` has a bug that misclassifies a chat input as slash
- **WHEN** the input handler calls `dispatch(detectIntent())`
- **THEN** the slash adapter fails validation (e.g. invalid agent) and surfaces an error
- **AND** the chat adapter is unaffected — its validation path is reachable for the next keystroke that produces a `mode: "chat"` intent

### Requirement: Adding a 4th send mode is a new arm + new adapter, not surgery

Adding a fourth send mode (e.g. file-drop send, paste-as-attachment send) SHALL require: (1) one new arm in the `SendIntent` discriminated union, (2) one new adapter function, (3) one branch in `dispatch`. It MUST NOT require editing `_refreshSlashState` (or whatever private detection helper detects the existing modes).

#### Scenario: Hypothetical file-drop mode is contained

- **WHEN** a developer adds a new `{ mode: "file-drop", target, files: File[] }` arm
- **THEN** they add a new `sendFileDrop` adapter and register it in `dispatch`
- **AND** they extend `detectIntent` to return the new arm when the input state matches (e.g. files in the attachments tray + empty textarea)
- **AND** the existing chat/slash/shift-tab paths are not modified
