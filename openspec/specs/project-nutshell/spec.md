# project-nutshell Specification

## Purpose
TBD - created by archiving change v06-roadmap. Update Purpose after archive.
## Requirements
### Requirement: A single project nutshell is persisted in the SQLite ledger

The ledger SHALL gain a `nutshell` table with exactly one row (enforced by `CHECK(id = 0)` primary key). Columns: `id INTEGER PRIMARY KEY CHECK(id = 0)`, `text TEXT NOT NULL DEFAULT ''`, `version INTEGER NOT NULL DEFAULT 0`, `updated_at_ms INTEGER NOT NULL`, `updated_by TEXT`.

On first open of a new ledger, a row with `id=0, text="", version=0, updated_at_ms=<now>, updated_by=NULL` SHALL be inserted as part of the migration.

#### Scenario: Fresh ledger has an empty nutshell row

- **WHEN** a new ledger file is created on first launch
- **THEN** `SELECT * FROM nutshell WHERE id=0` returns exactly one row with `text=""` and `version=0`

### Requirement: Nutshell edits are proposed via the existing handoff primitive

Edits SHALL NOT be applied by a direct mutating route. Instead, agents and the human propose nutshell edits by calling `send_handoff` with `to=HUMAN_NAME` and a distinguished `task` prefix (e.g., `"[nutshell] <summary of change>"`) and `context = {patch: "<full new nutshell text>"}`.

When a handoff of this shape is accepted (by the human, who is the canonical arbiter in v0.6), the hub SHALL atomically:
1. Write the patch text to `nutshell.text`.
2. Increment `nutshell.version`.
3. Update `nutshell.updated_at_ms` to now and `updated_by` to the sender of the handoff.
4. Emit an SSE event `nutshell.updated` with the full new snapshot.

This wraps the three writes in a single transaction (consistent with the handoff state-machine invariant).

#### Scenario: Accepted edit updates the nutshell

- **GIVEN** `nutshell.text = "MVP of A2A coordination app"` and `version = 3`
- **WHEN** agent `alice` sends a handoff to `human` with `task="[nutshell] add v0.6 scope"` and `context={patch: "MVP of A2A coordination app. v0.6: terminal pane, interrupts, nutshell."}`
- **AND** the human accepts that handoff
- **THEN** `nutshell.text` becomes the patch
- **AND** `nutshell.version` becomes `4`
- **AND** `nutshell.updated_by` is `"alice"`
- **AND** an SSE event `nutshell.updated` is broadcast with the new snapshot

#### Scenario: Declined edit leaves nutshell unchanged

- **GIVEN** `nutshell.text = "X"` and `version = 3`
- **WHEN** an agent's nutshell-edit handoff is declined by the human
- **THEN** `nutshell.text` and `version` are unchanged

### Requirement: The current nutshell is exposed via `GET /nutshell` and in briefings

`GET /nutshell` SHALL return the current nutshell row as JSON, authenticated via the read-auth rule (header OR `?token=` query). The onboarding briefing (see `agent-onboarding`) SHALL include the current `nutshell.text` so newly-connected agents receive it as context on first connect.

#### Scenario: Read the nutshell

- **WHEN** the webview GETs `/nutshell?token=<t>`
- **THEN** the response is `{text: "...", version: N, updated_at_ms: ..., updated_by: ...}`

#### Scenario: New agent receives current nutshell in briefing

- **GIVEN** `nutshell.text = "building v0.6"` and agent `bob` has never connected to this hub process
- **WHEN** `bob` connects
- **THEN** the briefing's `nutshell` field is `"building v0.6"`

### Requirement: UI surfaces the nutshell and a propose-edit flow

The webview SHALL render the current nutshell in a collapsible pinned area above the chat messages, with the current `version` and `updated_by`. A "Propose edit" button SHALL open a textarea pre-filled with the current text; submitting the textarea fires `POST /handoffs` with `task="[nutshell] edit"` and `context={patch: <new text>}` targeting the human.

The UI SHALL listen for `nutshell.updated` SSE events and re-render the pinned area live, with a subtle highlight animation to call attention to the change.

#### Scenario: UI renders and refreshes

- **GIVEN** the webview is connected and the nutshell has text
- **WHEN** a `nutshell.updated` SSE event arrives
- **THEN** the pinned area updates to the new text
- **AND** `updated_by` and `version` refresh to the new values

