## ADDED Requirements

### Requirement: `CaptureTransaction` owns capture-related state and cleans up on `Drop`

`pty_capture_turn` in `src-tauri/src/pty.rs` SHALL be implemented around a `CaptureTransaction` struct. The struct holds owned state for the three capture-related concerns:
- Geometry (`tmux set-option window-size manual` + `resize-window 240×100`) — restored on Drop
- Pipe-pane (`tmux pipe-pane -o`) — disabled on Drop
- Sentinel-watch (`/tmp/a2a/<agent>/signals/`) — observation cleaned up on Drop

`Drop` SHALL run unconditionally on every exit path: success, timeout, error, panic. Cleanup arms MUST execute in declared order; a panic in one arm MUST NOT prevent subsequent arms from running.

#### Scenario: Cleanup runs on success

- **GIVEN** `pty_capture_turn(agent, input, timeout_ms)` returns successfully
- **WHEN** the caller drops the result
- **THEN** geometry has been reverted to its pre-capture value
- **AND** pipe-pane is disabled
- **AND** sentinel-watch resources are released

#### Scenario: Cleanup runs on timeout

- **GIVEN** the sentinel does not appear within `timeout_ms`
- **WHEN** `pty_capture_turn` returns with a partial-log path
- **THEN** all three cleanup arms have executed
- **AND** the partial-log file is retained at `/tmp/a2a/<agent>/captures/turn-<epoch>.partial.log`

#### Scenario: Cleanup runs on panic

- **GIVEN** an internal panic occurs during capture (e.g., invariant violation in tmux output parsing)
- **WHEN** the panic unwinds through `pty_capture_turn`
- **THEN** `CaptureTransaction::Drop` runs
- **AND** all three cleanup arms execute (one panicking arm does not prevent the others)

### Requirement: `pty_capture_turn` is a thin wrapper around `CaptureTransaction`

`pty_capture_turn` SHALL contain only construction of the transaction, the input-write step, the sentinel-wait step, and the output-read step. It MUST NOT contain manual cleanup blocks; cleanup is delegated entirely to `Drop`.

#### Scenario: Function body has no manual cleanup

- **GIVEN** the implementation of `pty_capture_turn`
- **WHEN** statically inspected
- **THEN** there is no explicit call to `tmux pipe-pane -o off` outside `Drop::drop`
- **AND** there is no explicit call to revert geometry outside `Drop::drop`
- **AND** there is no explicit `if cleanup-needed { ... }` arm

### Requirement: Tests assert post-condition `CaptureState` on every exit path

A test under `src-tauri/tests/` SHALL exercise `pty_capture_turn` along three exit paths (success, timeout, panic) and assert in each case that `CaptureState` (the observable post-condition: tmux window-size, pipe-pane status, sentinel files) matches the pre-capture baseline.

#### Scenario: Success-path test reverts state

- **GIVEN** a test fixture with a known pre-capture `CaptureState`
- **WHEN** `pty_capture_turn` runs successfully against it
- **THEN** the post-call `CaptureState` matches the pre-call baseline byte-for-byte (modulo new partial-log absence and new success-log presence)

#### Scenario: Timeout-path test reverts state

- **GIVEN** a test fixture configured with no sentinel-write
- **WHEN** `pty_capture_turn` is invoked with a 100ms timeout
- **THEN** the call returns within ~timeout
- **AND** the post-call `CaptureState` matches the pre-call baseline (modulo a new `.partial.log` file)

#### Scenario: Panic-path test reverts state

- **GIVEN** a test fixture configured to inject a panic during sentinel-wait
- **WHEN** `pty_capture_turn` is invoked and the panic unwinds
- **THEN** the post-unwind `CaptureState` matches the pre-call baseline
