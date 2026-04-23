## MODIFIED Requirements

### Requirement: A per-room project nutshell is persisted in the SQLite ledger

The ledger's `nutshell` table SHALL key rows by `room TEXT PRIMARY KEY` instead of the single-row `CHECK(id = 0)` invariant. Columns: `room TEXT PRIMARY KEY`, `text TEXT NOT NULL DEFAULT ''`, `version INTEGER NOT NULL DEFAULT 0`, `updated_at_ms INTEGER NOT NULL`, `updated_by TEXT`.

On migration from schema_version 3 → 4, the existing single row (where `id = 0`) SHALL be moved into a new row with `room = 'default'`. The `id` column and its `CHECK` constraint SHALL be dropped.

On first open of a new ledger (fresh install), the `nutshell` table SHALL start empty. A row for a given room is created lazily on the first accepted nutshell edit for that room.

#### Scenario: Migration preserves legacy nutshell

- **GIVEN** a v0.8 ledger with `nutshell(id=0, text="hello", version=3, updated_at_ms=X, updated_by="alice")`
- **WHEN** v0.9 opens the ledger and runs the schema_version 3→4 migration
- **THEN** the `nutshell` table has exactly one row keyed by `room='default'` with the same `text`, `version`, `updated_at_ms`, `updated_by`
- **AND** no `id` column remains

#### Scenario: Fresh ledger has empty nutshell table

- **WHEN** a new v0.9 ledger is created
- **THEN** `SELECT count(*) FROM nutshell` returns `0`
- **AND** the first nutshell edit for any room creates a row for that room

### Requirement: Nutshell edits are proposed via the handoff primitive, scoped to the sender's room

Edits SHALL NOT be applied by a direct mutating route. Agents and the human propose edits by sending a handoff with `to = <human_name>`, `task` prefix `"[nutshell] …"`, and `context = { patch: "<full new text>" }`. The room of the edit is the SENDER's room (or, if the human is the sender, the `room` inferred from the current UI selection and passed in the handoff body as `context.room`).

When the handoff is accepted, the hub SHALL atomically:
1. Upsert `nutshell(<room>)` with `text = patch`, `version = old_version + 1`, `updated_at_ms = now`, `updated_by = <handoff.from>`.
2. Append an `events` row of kind `nutshell.update` with the `room` tagged.
3. Emit a `nutshell.updated` SSE event carrying `{ room, text, version, updated_at_ms, updated_by }`.

All three writes happen in one SQLite transaction.

Cross-room nutshell edits are disallowed: a handoff whose `context.room` does not equal the sender's room is rejected at accept time with HTTP 403.

#### Scenario: Accepted edit updates the sender's-room nutshell

- **GIVEN** agent `backend` in room `neb-2026` sends a handoff with `task="[nutshell] add v0.9 scope"` and `context={patch: "..."}`
- **WHEN** the human accepts the handoff
- **THEN** `nutshell('neb-2026').text` becomes the patch
- **AND** `nutshell('neb-2026').version` increments
- **AND** an SSE event `nutshell.updated` fires with `room: "neb-2026"`
- **AND** `nutshell('default')` is unchanged

#### Scenario: Cross-room edit rejected

- **GIVEN** agent `backend` is in room `neb-2026`
- **WHEN** `backend` sends a handoff with `task="[nutshell] ..."` and `context={patch: "...", room: "brand"}`
- **AND** the human accepts it
- **THEN** the accept returns 403 with `{"error": "cross-room nutshell edit not permitted"}`
- **AND** neither `nutshell('neb-2026')` nor `nutshell('brand')` is modified

### Requirement: Nutshell is exposed per-room via `GET /nutshell?room=<label>`

`GET /nutshell` SHALL require a `room` query parameter. Omitting it SHALL return HTTP 400 `{"error": "room parameter required"}`. Passing a `room` that has no row SHALL return `{ room: "<label>", text: "", version: 0, updated_at_ms: null, updated_by: null }` (empty sentinel), NOT 404.

The onboarding briefing (see `agent-onboarding`) SHALL include the nutshell for the CONNECTING AGENT's room only (not a global concatenation).

#### Scenario: Missing room parameter rejected

- **WHEN** a client issues `GET /nutshell`
- **THEN** the response is 400 `{"error": "room parameter required"}`

#### Scenario: Empty room returns empty sentinel

- **GIVEN** no row exists for room `brand`
- **WHEN** a client issues `GET /nutshell?room=brand`
- **THEN** the response is 200 with `{ room: "brand", text: "", version: 0, updated_at_ms: null, updated_by: null }`

#### Scenario: New agent sees its room's nutshell in briefing

- **GIVEN** `nutshell('neb-2026').text = "auth rework in progress"` and `nutshell('brand').text = "Q3 launch prep"`
- **WHEN** agent `marketing` in room `brand` connects for the first time
- **THEN** the briefing's `nutshell` field is `"Q3 launch prep"`
- **AND** `"auth rework in progress"` is not included

### Requirement: UI renders nutshells per room and scopes edits to the current selection

The webview's nutshell strip SHALL display the nutshell for the room currently selected in the room switcher. When "All" is selected, the strip SHALL display each room's nutshell stacked, with the room label as a heading.

The "Edit" affordance SHALL submit `POST /handoffs` with `context.room` set to the selected room. In "All" view, the Edit affordance SHALL be disabled (edit scope must be a single room).

The UI SHALL listen for `nutshell.updated` SSE events and update only the affected room's display.

#### Scenario: Single-room view shows only that nutshell

- **GIVEN** both `neb-2026` and `brand` rooms have nutshell content
- **WHEN** the human selects `neb-2026`
- **THEN** only `neb-2026`'s nutshell is visible in the strip
- **AND** its Edit button targets `room: "neb-2026"` when clicked

#### Scenario: All view shows all rooms' nutshells

- **WHEN** the human selects "All"
- **THEN** the nutshell strip lists each room with its text stacked vertically
- **AND** the Edit button is disabled
