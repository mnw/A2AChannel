## ADDED Requirements

### Requirement: Opt-In via Config Flag

The system SHALL run the permission scraper only when `permission_scraper.enabled` is `true` in `config.yml`. Default value SHALL be `false`. The flag SHALL be passed through `A2A_PERMISSION_SCRAPER_ENABLED` env var from the Tauri shell to the hub sidecar; the hub SHALL parse the env var as a boolean and instantiate `ScraperResolver` only when truthy.

#### Scenario: Default install — scraper inactive

- **WHEN** A2AChannel is launched without modifying `config.yml`
- **AND** an agent surfaces a permission prompt
- **THEN** the chat card appears as today
- **AND** no scraper watcher is started
- **AND** if the human resolves the dialog in xterm, the chat card stays as a ghost until manually dismissed via the `×` button

#### Scenario: User opts in

- **WHEN** the user sets `permission_scraper.enabled: true` in `config.yml`
- **AND** clicks Reload (or relaunches the app)
- **THEN** the hub starts with the scraper resolver active
- **AND** subsequent `permission.new` events register a watcher

### Requirement: `pty_await_pattern` Primitive — Positive Match

The system SHALL expose a Tauri command `pty_await_pattern(agent, pattern, timeout_ms?, poll_interval_ms?)` returning `{ matched: bool, elapsed_ms, last_snapshot, matched_text? }`. The command SHALL poll `tmux capture-pane -p -t <agent>` at `poll_interval_ms` (default 100) intervals, applying the supplied regex; SHALL resolve as soon as the pattern matches; SHALL return `matched=false` and the last snapshot on `timeout_ms` expiry. Regex compilation failure SHALL return an error result.

#### Scenario: Pattern matches before timeout

- **WHEN** the caller invokes `pty_await_pattern` for an agent whose pane content matches the pattern within the timeout
- **THEN** the result has `matched=true`, `matched_text` set to the regex's match span, and `elapsed_ms` reflecting the time to first match

#### Scenario: Timeout without match

- **WHEN** the timeout elapses without the pattern matching
- **THEN** the result has `matched=false`, `last_snapshot` set to the most recent capture, and `elapsed_ms` equal to the timeout

#### Scenario: Regex compile failure

- **WHEN** the caller supplies an invalid regex
- **THEN** the command returns an error result before any polling begins

### Requirement: `pty_await_pattern_absent` Primitive — Inverse Match

The system SHALL expose a Tauri command `pty_await_pattern_absent(agent, pattern, timeout_ms?, confirmations?, poll_interval_ms?)` with the same return shape. The command SHALL resolve `matched=true` when the pattern has been ABSENT for `confirmations` (default 4) consecutive snapshots. The absence counter SHALL reset to zero whenever the pattern reappears mid-watch.

#### Scenario: Confirmed absence resolves matched=true

- **WHEN** the pattern was visible at watch start, then disappears for 4 consecutive snapshots
- **THEN** the result has `matched=true` (= confirmed-absent) and `last_snapshot` is one of the absent snapshots

#### Scenario: Reappearance resets the counter

- **WHEN** the pattern disappears for 3 snapshots, then reappears in snapshot 4
- **AND** then disappears again for 4 more consecutive snapshots
- **THEN** the result fires after that second four-in-a-row absent run, NOT after the original three

#### Scenario: Outer timeout expires

- **WHEN** the timeout expires while the absence counter has not reached confirmations
- **THEN** the result has `matched=false`

### Requirement: PermissionResolver Interface

The system SHALL define a `PermissionResolver` interface with `watch(id, agent, room)`, `unwatch(id)`, and `onResolved(id, verdict, evidence)` callback. `ScraperResolver` SHALL be the only implementation in this change. A future `ChannelResolver` MAY be added without changing the interface or its consumers.

#### Scenario: Replacing scraper with channel resolver

- **WHEN** a future implementation listens for upstream `notifications/claude/permission_resolved`
- **THEN** that implementation registers as the system's `PermissionResolver`
- **AND** the hub wiring change is limited to which class is instantiated
- **AND** the `permissions` ledger schema, kind module, and UI code are unchanged

### Requirement: Latch-and-Confirm State Machine

The scraper SHALL implement a four-state machine per pending permission: `PENDING → SEEN_DIALOG → GHOST_WATCH → AUTO_DISMISSED`. Transitions SHALL be forward-only. The system SHALL NOT auto-dismiss any permission whose state never reaches `SEEN_DIALOG`.

#### Scenario: Happy path — dialog seen then dismissed

- **WHEN** a `permission.new` event registers a watcher for permission `p_abc`
- **AND** a snapshot of the agent's pane contains both the tool name from the event payload AND a recognized selector pattern (e.g., `Allow once`)
- **THEN** the state advances to `SEEN_DIALOG`
- **AND** subsequent snapshots without those markers transition the state to `GHOST_WATCH`
- **AND** after `CONFIRMATIONS_NEEDED` consecutive absent snapshots, the state advances to `AUTO_DISMISSED`
- **AND** the system files a `dismissed` verdict via the existing `permission` kind transition path

#### Scenario: Dialog never seen — fail closed

- **WHEN** a `permission.new` event registers a watcher for permission `p_def`
- **AND** the watcher's `LATCH_GRACE_MS` window elapses without ever observing both marker classes in the same snapshot
- **THEN** the watcher unregisters itself
- **AND** the permission card remains in `pending` status (no auto-dismissal)
- **AND** the human can still resolve the card via Allow/Deny in chat or the manual `×`

#### Scenario: Dialog briefly disappears then reappears

- **WHEN** the state is `GHOST_WATCH` and a snapshot lacks the markers
- **AND** a subsequent snapshot within `GHOST_WATCH_TIMEOUT_MS` contains the markers again
- **THEN** the state returns to `SEEN_DIALOG`
- **AND** the consecutive-absent-snapshot count resets to zero
- **AND** the watcher continues until either dismissal confirms or the outer timeout expires

#### Scenario: Outer timeout in GHOST_WATCH

- **WHEN** the state has been in `GHOST_WATCH` (or oscillating between `SEEN_DIALOG` and `GHOST_WATCH`) for `GHOST_WATCH_TIMEOUT_MS`
- **AND** no auto-dismissal has fired
- **THEN** the watcher unregisters itself
- **AND** the permission card remains pending; manual flow continues to work

### Requirement: Multi-Marker Dialog Detection

`SEEN_DIALOG` entry SHALL require BOTH the tool name from the `permission.new` event payload AND at least one selector pattern in the same snapshot. Selector patterns include (case-insensitive): `Allow once`, `Allow forever`, `Don't allow`, `Y/n`, the prompt-frame box-drawing characters `╭`/`┌` immediately preceding the tool name, and numbered options `1.`/`2.`/`3.` adjacent to the dialog region.

#### Scenario: Tool name alone is insufficient

- **WHEN** a snapshot contains the literal `Bash` (e.g., in scrollback from a prior tool call) but no selector pattern
- **THEN** the state does NOT advance to `SEEN_DIALOG`

#### Scenario: Selector alone is insufficient

- **WHEN** a snapshot contains `Allow once` but the tool name from the event is absent
- **THEN** the state does NOT advance to `SEEN_DIALOG`

#### Scenario: Both markers present in same snapshot

- **WHEN** a single snapshot contains both `Edit` (the event's tool_name) AND `Allow forever`
- **THEN** the state advances to `SEEN_DIALOG`
- **AND** the markers matched are recorded in the watcher's evidence buffer

### Requirement: Pane Snapshot Source

The scraper SHALL use `tmux capture-pane -p -t <agent>` (default visible region only) to obtain pane snapshots. The system SHALL NOT pull scrollback into the snapshot — historical dialog renders in scrollback would falsely keep the watcher latched after the dialog has actually closed.

#### Scenario: Scrollback exclusion

- **WHEN** a permission dialog appeared 30 seconds ago and is still in scrollback but no longer visible
- **AND** the scraper takes a snapshot of the current pane
- **THEN** the snapshot SHALL NOT contain the historical scrollback dialog
- **AND** the watcher SHALL transition to `GHOST_WATCH` based on current visible state

### Requirement: Snapshot Sidecar File on Auto-Dismissal

When the system fires an `AUTO_DISMISSED` verdict, it SHALL write the latest captured pane bytes (the snapshot that confirmed dialog absence) to `~/Library/Application Support/A2AChannel/permission-snapshots/<perm-id>.txt` with mode 0600. The directory SHALL be mode 0700, created if absent. The ledger row for that permission SHALL be updated with `snapshot_path` (absolute path) and `dismissed_by_scraper = 1`.

#### Scenario: Auto-dismissal writes sidecar file

- **WHEN** an `AUTO_DISMISSED` transition fires for permission `p_xyz`
- **THEN** the file `~/Library/Application Support/A2AChannel/permission-snapshots/p_xyz.txt` exists with mode 0600
- **AND** the file content is the most recent pane snapshot
- **AND** the `permissions` ledger row for `p_xyz` has `snapshot_path` set to the file's absolute path
- **AND** `dismissed_by_scraper = 1`
- **AND** `status = 'dismissed'`

#### Scenario: Snapshot retention pruning

- **WHEN** an `AUTO_DISMISSED` transition fires while 100+ snapshot files already exist
- **THEN** the system removes the oldest files (by mtime) until at most 100 remain
- **AND** the just-written file is preserved

#### Scenario: Manual dismissal does NOT write a sidecar

- **WHEN** the human clicks `×` on a card and the existing manual-dismiss flow fires
- **THEN** the ledger row's `dismissed_by_scraper` SHALL remain `0`
- **AND** no file is written under `permission-snapshots/`

### Requirement: GET /permissions/:id/snapshot Read Route

The hub SHALL expose `GET /permissions/:id/snapshot` returning the snapshot text file for an auto-dismissed permission. Authentication is read-auth (bearer header OR `?token=` query). If the permission has no `snapshot_path` (manual dismissal, current pending, etc.), the route SHALL return `404`. If the path is set but the file no longer exists (pruned), the route SHALL return `404` with a body indicating "snapshot pruned."

#### Scenario: Auto-dismissed permission with file present

- **WHEN** the user requests `GET /permissions/p_xyz/snapshot` for an auto-dismissed permission
- **AND** the file exists
- **THEN** the response is HTTP 200 with `Content-Type: text/plain; charset=utf-8`
- **AND** the body is the snapshot bytes

#### Scenario: Snapshot pruned

- **WHEN** the user requests a snapshot for an auto-dismissed permission whose file has been pruned
- **THEN** the response is HTTP 404
- **AND** the body indicates "snapshot pruned"

#### Scenario: Manually dismissed permission has no snapshot

- **WHEN** the user requests a snapshot for a permission that was dismissed via the manual `×` flow
- **THEN** the response is HTTP 404

### Requirement: Session-Scoped Circuit Breaker

If three consecutive watchers within the same hub-process lifetime fail to reach `SEEN_DIALOG` before their `LATCH_GRACE_MS` expires, the system SHALL disable the scraper for the remainder of the session. Subsequent `permission.new` events register no watcher. The system SHALL log a single warning naming the affected versions and instructing the user that the manual `×` flow continues to work.

#### Scenario: Three failed latches trigger circuit breaker

- **WHEN** three consecutive permission cards fail their latch grace within the same hub-process lifetime
- **THEN** the system logs `[scraper] disabled — 3 consecutive cards never reached SEEN_DIALOG`
- **AND** subsequent `permission.new` events do NOT register a scraper watcher
- **AND** the manual `×` flow remains functional
- **AND** restarting the hub re-enables the scraper

#### Scenario: Successful latch resets the failure counter

- **WHEN** two cards have failed their latch grace (counter at 2)
- **AND** the next card successfully reaches `SEEN_DIALOG`
- **THEN** the failure counter resets to 0
- **AND** the circuit remains active

### Requirement: Idempotency with Manual Resolution Paths

If a chat-first verdict (`POST /permissions/:id/verdict`) or a manual `×` dismissal arrives BEFORE the scraper fires `AUTO_DISMISSED`, the watcher SHALL `unwatch(id)` and NOT fire its own verdict. If the scraper fires `AUTO_DISMISSED` BEFORE a manual path resolves, the manual path SHALL receive same-status (200) for `dismissed` retries and `409 Conflict` for differing verdicts (per existing terminal-state policy).

#### Scenario: Human Allows in chat before scraper fires

- **WHEN** a watcher is in `GHOST_WATCH` and the human clicks Allow in chat
- **AND** the verdict route resolves the permission to `allowed`
- **THEN** the watcher receives the resolution (via the same broadcast or kind callback)
- **AND** `unwatch(id)` is called
- **AND** no `AUTO_DISMISSED` fires

#### Scenario: Scraper fires before human × click

- **WHEN** the scraper fires `AUTO_DISMISSED` and writes the verdict
- **AND** the human subsequently clicks the chat `×`
- **THEN** the manual path's same-status retry receives HTTP 200 (idempotent)
- **AND** no second broadcast or ledger row is created

### Requirement: SQLite Schema v9 — Permissions Columns

The system SHALL extend the `permissions` table via migration v9 to add:
- `snapshot_path TEXT` — nullable absolute path to the sidecar file.
- `dismissed_by_scraper INTEGER NOT NULL DEFAULT 0` — 0 = manual / chat-first, 1 = scraper auto-dismissal.

The migration SHALL be forward-only; existing rows remain valid (default 0, snapshot_path NULL).

#### Scenario: Fresh install creates v9 schema

- **WHEN** the hub starts against a `ledger.db` at schema v8 (post-transcript change)
- **THEN** migration v9 runs and adds the two columns
- **AND** `meta.schema_version` updates to `9`

#### Scenario: Existing v9 install — no-op

- **WHEN** the hub starts against a `ledger.db` already at v9
- **THEN** no migration runs

### Requirement: Broadcast `dismissed` Frame Includes `by` Field for Auto-Dismissals

The existing `permission.dismissed` broadcast frame SHALL include an optional `by: "scraper"` field when the dismissal originated from `ScraperResolver`. Manual `×` dismissals SHALL omit the `by` field (or set it to a value distinguishing manual from scraper). UI clients SHALL render scraper-dismissed cards with a distinct affordance (e.g., a "view snapshot" link) — UI work is in scope, not just protocol.

#### Scenario: Auto-dismissal broadcast carries `by: "scraper"`

- **WHEN** the scraper fires an `AUTO_DISMISSED` transition and the kind module broadcasts the `permission.dismissed` event
- **THEN** the broadcast frame includes `by: "scraper"`

#### Scenario: Manual dismissal broadcast omits `by`

- **WHEN** the human clicks `×` and the existing manual-dismissal path fires
- **THEN** the broadcast frame omits `by` (or sets it to a non-scraper value)

### Requirement: Telemetry — One Log Line Per State Transition

Every state-machine transition SHALL emit one line to `hub.log` containing the permission id and identifying information (e.g., markers matched, transition reason). No other log surface is added in this change.

#### Scenario: SEEN_DIALOG transition logged

- **WHEN** a watcher advances from `PENDING` to `SEEN_DIALOG`
- **THEN** a line of the form `[scraper] perm_id=<id> PENDING → SEEN_DIALOG (markers: <list>)` is appended to `hub.log`

#### Scenario: Latch grace expiry logged

- **WHEN** a watcher fails to reach `SEEN_DIALOG` before its grace window
- **THEN** a line of the form `[scraper] perm_id=<id> LATCH_GRACE_MS expired — gave up, no auto-dismiss` is logged

#### Scenario: Auto-dismissal logged with snapshot path

- **WHEN** an `AUTO_DISMISSED` transition fires
- **THEN** a line of the form `[scraper] perm_id=<id> GHOST_WATCH → AUTO_DISMISSED (snapshot: <path>)` is logged
