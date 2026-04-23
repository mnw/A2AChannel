## ADDED Requirements

### Requirement: UI Pause and Resume buttons target a whole room

The webview header SHALL contain a Pause button and a Resume button adjacent to the room switcher. Clicking Pause while a specific room is selected SHALL POST a canned interrupt to every non-human agent in that room. Clicking Resume SHALL do the same with Resume text. When the "All" view is selected, both buttons SHALL be disabled (the pause scope must be an explicit room).

The canned texts SHALL be:
- Pause: `"Pause — stop current task, hold state, await resume."`
- Resume: `"Resume — continue previous task."`

Both texts SHALL be under 500 characters to comply with the interrupt `text` cap.

#### Scenario: Pause targets selected room

- **GIVEN** the human has selected room `neb-2026` in the switcher
- **AND** agents `backend` and `qa` are in that room
- **WHEN** the human clicks Pause
- **THEN** two `POST /interrupts` calls are issued, one to `backend` and one to `qa`
- **AND** each carries `from=<human_name>` and the canned Pause text

#### Scenario: Pause disabled in All view

- **GIVEN** the "All" room view is selected
- **WHEN** the Pause or Resume button is inspected
- **THEN** both buttons are disabled with a tooltip explaining that a specific room must be selected

### Requirement: Bulk interrupt POST accepts a `rooms` shape

`POST /interrupts` SHALL accept two alternative body shapes:

1. **Single-recipient (existing)**: `{ from, to, text }` — delivers one interrupt to the named recipient.
2. **Bulk-by-room (new)**: `{ from, rooms: [<label>...], text }` — for each listed room, the hub fans out one interrupt per non-human agent currently in that room. Each generated interrupt has its own ID, its own ledger row, and its own ack lifecycle. The response body SHALL list every generated interrupt ID.

The bulk shape is a convenience for UI-driven room-wide controls; it produces N independent interrupts, not one "broadcast interrupt" primitive. Existing retry, ack, and replay semantics apply unchanged to each.

If a listed room has no agents, the request SHALL succeed with an empty per-room list (no error); the audit event is still recorded.

#### Scenario: Bulk shape fans out per agent

- **GIVEN** room `neb-2026` has agents `backend`, `qa`
- **WHEN** the hub receives `POST /interrupts` with `{from: "human", rooms: ["neb-2026"], text: "Pause..."}`
- **THEN** the hub creates two interrupts, one addressed to `backend` and one to `qa`
- **AND** the response body is `{ created: [{ room: "neb-2026", interrupts: ["i_...", "i_..."] }] }`
- **AND** each interrupt is persisted with its own row in the `interrupts` table and its own `interrupt.new` event

#### Scenario: Bulk shape with empty room

- **WHEN** the hub receives `POST /interrupts` with `{from: "human", rooms: ["ghost"], text: "..."}` and no agents are in `ghost`
- **THEN** the response is 200 with `{ created: [{ room: "ghost", interrupts: [] }] }`

### Requirement: Pause and Resume are advisory, not preemptive

The Pause interrupt SHALL NOT interrupt an agent's in-flight LLM turn or in-flight tool call. Claude's cooperative-interrupt semantics apply: the agent finishes the current tool call, reads the interrupt card at the next context flush, and is expected to halt proactively. The hub imposes no behavioral guarantee on recipient agents beyond "the notification is delivered and the ack transitions the interrupt to `acknowledged`".

The UI SHALL communicate this cooperative semantics via tooltip on the Pause button, reading approximately `"Agents finish their current tool call before pausing."`.

#### Scenario: Agent completes in-flight call before pausing

- **GIVEN** agent `backend` is mid-way through a `Bash` tool call
- **WHEN** a Pause interrupt arrives
- **THEN** `backend` completes the Bash call
- **AND** on the next turn reads the interrupt card and chooses to pause
- **AND** the hub does not force-terminate any subprocess
