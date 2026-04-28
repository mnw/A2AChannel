## ADDED Requirements

### Requirement: Per-Room Opt-In Persistence Flag

The system SHALL persist a room's chat transcript ONLY when that room has explicitly opted in via the `room_settings.persist_transcript` flag. Default for any room without a row in `room_settings` is OFF (no persistence).

#### Scenario: Room with no settings row receives a chat entry

- **WHEN** a chat entry is appended for a room that has no row in `room_settings`
- **THEN** the entry is added to the in-memory `chatLog` as today
- **AND** no file is written under `~/Library/Application Support/A2AChannel/transcripts/`

#### Scenario: Opting a room in via settings route

- **WHEN** the human posts `PUT /rooms/<room>/settings` with `{ persist_transcript: true }` and a valid bearer token
- **THEN** the system inserts or updates the row in `room_settings` for that room
- **AND** subsequent chat entries for that room are appended to the active `<hash8>-<sanitized>.jsonl` file

#### Scenario: Opting a room out preserves history

- **WHEN** an opted-in room is opted out via `{ persist_transcript: false }`
- **THEN** new chat entries stop being persisted
- **AND** the existing `transcripts/<room>.jsonl` file is left intact on disk

### Requirement: JSONL Append-Only Write Path

The system SHALL persist each chat entry as one line of UTF-8 JSON terminated by `\n` to `~/Library/Application Support/A2AChannel/transcripts/<room>.jsonl`. Files SHALL be created with mode 0600 inside a directory created with mode 0700. Each line SHALL begin with the schema version field `"v": 1`.

#### Scenario: First chat entry creates the file

- **WHEN** the first chat entry is appended for an opted-in room with no existing transcript file
- **THEN** the system creates the directory `~/Library/Application Support/A2AChannel/transcripts/` (mode 0700) if absent
- **AND** creates `<room>.jsonl` (mode 0600)
- **AND** writes one JSON line ending in `\n` containing at minimum `{ "v": 1, "ts": <epoch_ms>, "from": ..., "to": ..., "text": ... }`

#### Scenario: Subsequent entries append to existing file

- **WHEN** an entry is appended for an opted-in room whose JSONL file already exists
- **THEN** the entry is appended as a single JSON line to the file
- **AND** existing lines are not modified

#### Scenario: Append is synchronous and durable

- **WHEN** an entry is appended for an opted-in room
- **THEN** the system uses `fs.appendFileSync` (or equivalent durability-equivalent call)
- **AND** does NOT buffer the write across multiple entries

### Requirement: Versioned Line Schema

The system SHALL include a numeric `v` field as the first key of every JSONL line. Readers SHALL tolerate lines whose `v` is greater than the highest version they understand by skipping them with a warning, and SHALL tolerate a final truncated line by skipping it silently.

#### Scenario: Reader encounters a future version

- **WHEN** a v=1 reader processes a JSONL file containing a line with `"v": 2`
- **THEN** the reader skips that line
- **AND** logs one warning per file (not per line) about the unsupported version

#### Scenario: Reader encounters a partial final line

- **WHEN** a reader processes a JSONL file whose final line is incomplete (no terminating `\n`, or fails `JSON.parse`)
- **THEN** the reader silently drops that line
- **AND** processes all preceding lines normally

#### Scenario: Reader encounters a corrupt mid-file line

- **WHEN** a reader processes a JSONL file with a parse error on any line OTHER than the last
- **THEN** the reader logs an error
- **AND** stops processing the file (does not return partial state)

### Requirement: Hub Restart Hydration Reads Active Chunk Only

On startup, for each room with `persist_transcript = true` in `room_settings`, the hub SHALL hydrate the in-memory `chatLog` from the **active** JSONL file only (`<hash8>-<sanitized>.jsonl`), NOT from rotated chunks. The hub SHALL merge the active chunk's entries with the last N kind events from SQLite by `ts` ascending. Hydration SHALL complete before the hub accepts SSE connections.

#### Scenario: Active chunk + 5 rotated chunks

- **WHEN** the hub starts up for a room with persistence on, where the active file has 7000 entries and there are 3 rotated chunks of 10000 entries each
- **THEN** the hub reads only the 7000 entries from the active file
- **AND** ignores the rotated chunks during hydration
- **AND** `chatLog` contains those 7000 entries merged with same-room SQLite events by `ts`

#### Scenario: No opted-in rooms

- **WHEN** the hub starts up with no rooms set to `persist_transcript: true`
- **THEN** `chatLog` starts empty
- **AND** behavior is identical to today's pre-change behavior

#### Scenario: Hydration tolerates a missing active file

- **WHEN** a `room_settings` row says `persist_transcript: true` but the active JSONL file does not exist
- **THEN** the hub treats it as an empty transcript
- **AND** logs one warning
- **AND** continues startup normally
- **AND** the next append creates the active file

### Requirement: `/clear` Removes Active File and Every Rotated Chunk

When `/clear` is run against a room whose `persist_transcript` is true, the system SHALL delete the active JSONL file AND every rotated chunk file for that room (matching `<hash8>-<sanitized>{,.\d+}.jsonl`). This SHALL run in the same hub-side critical section that filters the room's entries out of the in-memory `chatLog`. `/clear` is destructive and irreversible; rotation is non-destructive — they MUST stay distinct.

#### Scenario: `/clear` on opted-in room with active + 3 rotated chunks

- **WHEN** the human runs `/clear @planner` (or any equivalent room-clearing command) on a room with persistence on
- **AND** the room has the active file plus chunks `.000001.jsonl`, `.000002.jsonl`, `.000003.jsonl`
- **THEN** the system unlinks all four files
- **AND** removes that room's entries from `chatLog` in the same critical section
- **AND** the next append (after `/clear`) creates a fresh active file with no carry-over

#### Scenario: `/clear` confirmation surfaces full impact

- **WHEN** the user invokes `/clear` against a room with persistence on
- **THEN** the confirmation modal lists the count and total bytes of files about to be deleted (active + every rotated chunk)
- **AND** requires explicit confirmation before proceeding

#### Scenario: `/clear` on opted-out room

- **WHEN** `/clear` is run on a room with persistence off (or no `room_settings` row)
- **THEN** the in-memory `chatLog` is filtered as today
- **AND** no filesystem operations occur

#### Scenario: `/clear` is idempotent

- **WHEN** `/clear` is invoked twice in succession on the same opted-in room
- **THEN** the second invocation finds no transcript files to delete
- **AND** completes successfully without error

### Requirement: Active File Rotation at 10,000 Lines

The system SHALL rotate the active JSONL file when its line count reaches 10,000. Rotation MUST: (a) atomically rename the active file to `<hash8>-<sanitized>.<seq>.jsonl` where `<seq>` is a 6-digit zero-padded integer, one greater than the highest existing seq for this room (or `000001` if none), then (b) start a fresh active file at `<hash8>-<sanitized>.jsonl` for the next append. The system SHALL NOT delete or truncate any rotated chunk automatically.

#### Scenario: 10,000th append triggers rotation

- **WHEN** the active file currently has 9999 lines and a new entry is appended
- **THEN** the system writes the 10,000th line
- **AND** atomically renames the active file to `<hash8>-<sanitized>.000001.jsonl` (assuming no prior chunks exist)
- **AND** the next append creates a fresh active file with that one entry

#### Scenario: Rotation sequence increments

- **WHEN** rotation occurs in a room that already has chunks `.000001.jsonl` and `.000002.jsonl`
- **THEN** the new chunk is named `.000003.jsonl`

#### Scenario: Rotation under concurrent append

- **WHEN** two appends arrive concurrently and the second would push the file to 10,001 lines
- **THEN** the hub's mutex serializes them so exactly one of: (i) both land in the active file and rotation triggers on a subsequent append, or (ii) one lands and triggers rotation, the other lands in the fresh active file
- **AND** no entries are lost or duplicated

#### Scenario: Rotated chunks never auto-delete

- **WHEN** a room accumulates 100 rotated chunks over weeks of use
- **THEN** the system retains all 100 chunks indefinitely
- **AND** only `/clear` (or manual filesystem operations by the user) removes them

### Requirement: Rotated Chunk Naming Yields Chronological Sort

The system SHALL name rotated chunks such that lexicographic ordering of filenames yields chronological ordering of contents. The fixed format `<hash8>-<sanitized>.<6-digit-seq>.jsonl` satisfies this: zero-padding ensures `.000010.jsonl` sorts after `.000009.jsonl` and before `.000011.jsonl`.

#### Scenario: `ls` lists chunks in age order

- **WHEN** a user runs `ls -1 transcripts/<hash8>-<sanitized>.*.jsonl`
- **THEN** the output is in oldest-first order (lowest seq first)

#### Scenario: Hub recovery scans for highest seq

- **WHEN** the hub processes a rotation event and needs to compute the next seq
- **THEN** it scans the directory for filenames matching the room's hash-prefix pattern with a numeric suffix
- **AND** picks `max(existing) + 1`, formatted as 6-digit zero-padded

### Requirement: Trust-on-Self-Assertion for Settings Route

The `PUT /rooms/<room>/settings` route SHALL accept any caller bearing a valid hub bearer token. The route SHALL NOT verify that the caller's claimed identity matches a privileged role; identity claims are accepted as asserted, consistent with the existing trust model for mutating routes.

#### Scenario: Authenticated request

- **WHEN** a caller posts to `PUT /rooms/auth-rewrite/settings` with `Authorization: Bearer <valid-token>` and a JSON body
- **THEN** the system applies the settings change

#### Scenario: Missing or invalid token

- **WHEN** a caller posts to the same route with no `Authorization` header (or an invalid token)
- **THEN** the system rejects with HTTP 401
- **AND** does not modify any state

### Requirement: SQLite `room_settings` Table

The system SHALL maintain a `room_settings` table in `ledger.db` with the following columns:
- `room TEXT PRIMARY KEY`
- `persist_transcript INTEGER NOT NULL DEFAULT 0` (0 = off, 1 = on)
- `updated_at INTEGER NOT NULL`

The table SHALL be created via `CREATE TABLE IF NOT EXISTS` on hub startup. Forward-only; no destructive migration. Rotation size (10,000 lines) is a global constant in code, NOT a column in this table — Phase 2 may add per-room overrides if needed.

#### Scenario: Fresh install creates the table

- **WHEN** the hub starts up against a `ledger.db` that does not contain `room_settings`
- **THEN** the table is created with the schema above

#### Scenario: Existing install with the table present

- **WHEN** the hub starts up against a `ledger.db` that already has `room_settings`
- **THEN** no schema change occurs

### Requirement: Transcript Filename Sanitization

The system SHALL convert each room label to a safe filename component before constructing the JSONL path. Characters not in `[A-Za-z0-9_.-]` SHALL be replaced. To avoid collisions between rooms whose sanitized form would coincide, the filename SHALL be `<sha1prefix8>-<sanitized>.jsonl` where `sha1prefix8` is the first 8 hex chars of the SHA-1 of the original room label.

#### Scenario: Room label with spaces

- **WHEN** a room labeled `auth review` is opted in
- **THEN** the JSONL filename is `<hash8>-auth_review.jsonl`

#### Scenario: Two distinct labels with same sanitized form

- **WHEN** rooms `auth-review` and `auth review` are both opted in
- **THEN** they get different filenames because their sha1 prefixes differ

### Requirement: JSONL Owns Chat Only; SQLite Owns Kinds — No Overlap

The system SHALL NOT write any kind state (handoff, interrupt, permission, nutshell) into a JSONL transcript. Kinds remain exclusively in SQLite. Conversely, the system SHALL NOT write chat entries into the SQLite `events` table or any kind-derived table.

#### Scenario: Handoff lifecycle persists to SQLite, not JSONL

- **WHEN** a handoff is created in an opted-in room
- **THEN** the handoff event is written to `ledger.db` only
- **AND** a synthesized `system` chat entry describing the handoff is written to the JSONL (because it appears in `chatLog`)
- **AND** the JSONL line is not the source of truth for handoff state — `ledger.db` is

#### Scenario: Chat entry never lands in events table

- **WHEN** a `human → agent` chat message is sent
- **THEN** the entry is appended to JSONL (if room is opted in) and to `chatLog`
- **AND** no row is inserted into the SQLite `events` table for that message

### Requirement: Out-of-Scope Phase 2 Items

The change SHALL NOT include any of the following in its first implementation: markdown export (`/export` slash command), search index (FTS5 or otherwise), encryption at rest, time-based retention, secret auto-redaction, cross-machine sync. Each MAY be added in a subsequent change without altering the JSONL line schema.

#### Scenario: User invokes `/export`

- **WHEN** a user runs `/export` against an opted-in room in this change's first shipped version
- **THEN** the command is not recognized (handled by the existing slash-command picker / unknown-command path)
- **AND** the user's transcript file remains unchanged
