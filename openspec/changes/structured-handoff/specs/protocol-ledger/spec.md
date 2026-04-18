## ADDED Requirements

### Requirement: Ledger database is opened at startup

The hub SHALL open a SQLite database at `~/Library/Application Support/A2AChannel/ledger.db` at startup. If the file does not exist, the hub SHALL create it. On open, the hub SHALL enable WAL mode (`PRAGMA journal_mode=WAL`) and synchronous-normal (`PRAGMA synchronous=NORMAL`). The database file SHALL be created with filesystem mode `0600`. The path MAY be overridden by the `A2A_LEDGER_DB` environment variable (set by the Rust shell when bundled).

#### Scenario: First launch creates the database

- **WHEN** the hub starts and no `ledger.db` exists in the app data directory
- **THEN** a new `ledger.db` is created at `~/Library/Application Support/A2AChannel/ledger.db` with mode `0600`
- **AND** WAL mode is enabled

#### Scenario: Subsequent launch opens existing database

- **GIVEN** a prior session left `ledger.db` with pending handoffs
- **WHEN** the hub starts
- **THEN** the existing database is opened, not replaced
- **AND** all pending handoffs remain queryable

### Requirement: Ledger schema is versioned and migrated on open

The ledger SHALL record a schema version in a `meta` table. On open, the hub SHALL compare the stored version against the version compiled into the binary. If the stored version is lower, migrations SHALL run in order, each wrapped in a transaction. If the stored version is higher (downgrade scenario), the hub SHALL refuse to operate on the DB and log a clear error.

#### Scenario: Fresh DB applies initial migration

- **WHEN** the hub opens a database with no `meta.schema_version` row
- **THEN** the hub runs the initial migration (creating `events`, `handoffs`, `meta` tables)
- **AND** sets `meta.schema_version = 1`

#### Scenario: Newer version refuses older DB gracefully

- **GIVEN** `meta.schema_version = 2` and the binary knows only versions 1
- **WHEN** the hub opens the DB
- **THEN** the hub logs the version mismatch and refuses to serve protocol routes
- **AND** read-only routes (/agents, /presence, /stream for chat) continue to work

### Requirement: Events are append-only and immutable

Every protocol state change SHALL be recorded as a row in the `events` table with a monotonically increasing `seq`, a `handoff_id`, a `kind` string (one of `handoff.created`, `handoff.accepted`, `handoff.declined`, `handoff.cancelled`, `handoff.expired`), an `actor`, a `payload_json` body, and a timestamp. No row in the `events` table SHALL be updated or deleted under normal operation. The hub SHALL wrap each state change (event insert + derived-table update) in a single transaction.

#### Scenario: Creating a handoff writes one event and one handoffs row

- **WHEN** an authenticated client calls `POST /handoffs` with valid payload
- **THEN** exactly one row is inserted into `events` with `kind='handoff.created'`
- **AND** exactly one row is inserted into `handoffs` with matching `id` and `status='pending'`
- **AND** both inserts occur inside a single transaction

#### Scenario: Accepting a handoff writes one event and updates the handoffs row

- **GIVEN** a handoff with `status='pending'`
- **WHEN** the recipient calls `POST /handoffs/:id/ack` with `status='accepted'`
- **THEN** exactly one row is inserted into `events` with `kind='handoff.accepted'`
- **AND** the matching `handoffs` row is updated to `status='accepted', resolved_at_ms=<now>`
- **AND** the previous `handoff.created` event remains unchanged in `events`

### Requirement: Derived state can be rebuilt from events

The `handoffs` table SHALL be a deterministic projection of the `events` table. If the `handoffs` table is dropped and rebuilt by replaying all events in `seq` order, the resulting state SHALL equal the state before the rebuild (modulo non-semantic fields like row order). The `handoffs` row's `status` column SHALL hold one of `pending`, `accepted`, `declined`, `cancelled`, `expired`.

#### Scenario: Rebuild produces identical current state

- **GIVEN** a ledger with any sequence of valid events
- **WHEN** `handoffs` is dropped and rebuilt by replaying events in `seq` order
- **THEN** every remaining `handoffs` row matches the pre-rebuild state for `id`, `from_agent`, `to_agent`, `task`, `status`, `decline_reason`, `comment`, `created_at_ms`, `expires_at_ms`, `resolved_at_ms`

### Requirement: Expiry sweep runs as a background task

The hub SHALL run a background task that fires every 5 seconds. On each fire, the task SHALL find all rows in `handoffs` where `status='pending' AND expires_at_ms < <now>`, and for each SHALL insert a `handoff.expired` event (with `actor='system'`), update the handoffs row to `status='expired', resolved_at_ms=<now>`, and broadcast the state change to UI subscribers and both the originating and target agents.

#### Scenario: Expired handoff transitions via sweep

- **GIVEN** a handoff with `status='pending'` and `expires_at_ms` 5 seconds in the past
- **WHEN** the next sweep fires
- **THEN** a `handoff.expired` event is inserted
- **AND** the handoffs row transitions to `status='expired'`
- **AND** a `handoff.update` SSE event is broadcast with the new snapshot
- **AND** the originating agent receives a channel notification with `kind='handoff.update'`

#### Scenario: Sweep does not affect resolved handoffs

- **GIVEN** a handoff with `status='accepted'` and `expires_at_ms` in the past
- **WHEN** the next sweep fires
- **THEN** no new event is inserted for that handoff
- **AND** the handoffs row is unchanged

### Requirement: Reconnect replay delivers pending items to agents

When an agent opens a new `/agent-stream?agent=X` connection, after the presence-increment step, the hub SHALL query `handoffs WHERE (to_agent = X OR from_agent = X) AND status = 'pending'` and push each row as a `handoff.new` channel notification with a `replay=true` attribute. The hub SHALL NOT replay chat messages.

#### Scenario: Agent reconnecting sees pending handoffs as recipient

- **GIVEN** a handoff with `to_agent='alice'` and `status='pending'`
- **AND** alice is not currently connected
- **WHEN** alice connects to `/agent-stream?agent=alice`
- **THEN** alice receives a `handoff.new` notification with `replay=true` containing the pending handoff's snapshot

#### Scenario: Agent reconnecting sees pending handoffs as originator

- **GIVEN** a handoff with `from_agent='alice'` and `status='pending'`
- **WHEN** alice reconnects
- **THEN** alice receives a `handoff.new` notification with `replay=true` for that handoff too

#### Scenario: Reconnect does not replay closed handoffs

- **GIVEN** a handoff with `status='accepted'` (resolved)
- **WHEN** the recipient reconnects
- **THEN** no replay notification is sent for that handoff

### Requirement: Broadcasts carry a version for client-side reconciliation

Every `handoff.new` and `handoff.update` broadcast (over `/stream` to UI subscribers and over `/agent-stream` to agents) SHALL include a `version` field equal to the `events.seq` of the event that produced the broadcast state. Clients SHALL reconcile by `handoff_id`, applying only snapshots whose `version` exceeds the highest `version` previously seen for that `handoff_id`. Snapshots with older versions SHALL be discarded.

#### Scenario: Higher version overwrites lower

- **GIVEN** a client has applied a snapshot for `h_abc` with `version=10`
- **WHEN** a new broadcast arrives for `h_abc` with `version=12`
- **THEN** the client updates its local state to match the new snapshot

#### Scenario: Lower version is discarded

- **GIVEN** a client has applied a snapshot for `h_abc` with `version=12`
- **WHEN** a delayed broadcast for `h_abc` arrives with `version=7`
- **THEN** the client keeps `version=12` state and discards the stale event

#### Scenario: Replay version interplay with live events

- **GIVEN** a reconnecting agent is sent a `handoff.new` replay with `version=5` for `h_abc`
- **AND** concurrently receives a live `handoff.update` with `version=9` for `h_abc`
- **WHEN** the events arrive in any order
- **THEN** the final state is the one with `version=9`
