## ADDED Requirements

### Requirement: Every agent record carries a `room` identifier

The hub SHALL store a `room` field on every agent record. The field is a non-empty string, 1..=64 characters, matching the agent-name character class (`[A-Za-z0-9_.-]` plus internal spaces, non-space boundaries). The field is set once at first `/agent-stream` connect for that agent during the hub's lifetime and is immutable thereafter.

The human is stored with `room = null` (sentinel for "every room"). All broadcast logic SHALL treat `null` as equivalent to matching every room.

The ledger `agents` table SHALL gain a `room TEXT` column (NOT NULL except for the human). Existing rows migrate with `room = 'default'`.

#### Scenario: Agent registers with room from env

- **GIVEN** channel-bin has `CHATBRIDGE_AGENT=backend` and `CHATBRIDGE_ROOM=neb-2026` in its environment
- **WHEN** it connects to `/agent-stream?agent=backend`
- **THEN** the hub's `agents` record for `backend` has `room="neb-2026"`
- **AND** subsequent reconnects do not change the room

#### Scenario: Agent registers without room env falls back to default

- **GIVEN** channel-bin has `CHATBRIDGE_AGENT=legacy` and no `CHATBRIDGE_ROOM`
- **WHEN** it connects to `/agent-stream?agent=legacy`
- **THEN** the hub reads `A2A_DEFAULT_ROOM` env (default `"default"`)
- **AND** the agent is registered with that room

#### Scenario: Human is in every room

- **GIVEN** the human is registered at startup
- **WHEN** the human's agent record is inspected
- **THEN** its `room` field is `null`
- **AND** every broadcast targeting any room includes the human as a recipient

### Requirement: Broadcast scope is the sender's room plus explicit peer targets

For any event emitted by sender S in room R, the hub SHALL compute recipients as:

1. All agents in the roster whose `room == R` (or whose `room == null`, i.e. the human), PLUS
2. If the event has an explicit non-broadcast `to` field matching a roster member, that member regardless of room.

`target: "all"` is NOT a cross-room broadcast. It means "all agents in my room, plus the human." Cross-room delivery happens only through explicit peer-name targeting.

This rule applies uniformly to chat events (`/post`, `/send`), handoffs (`/handoffs`), interrupts (`/interrupts`), and permission relays (`/permissions`).

#### Scenario: Broadcast stays in-room

- **GIVEN** agents `backend` and `qa` are in room `neb-2026`, agent `marketing` is in room `brand`, and the human is a permanent member
- **WHEN** `backend` POSTs `/post` with `{text: "ready for review", target: "all"}`
- **THEN** the message is enqueued on `qa`'s agent stream and the human's UI stream
- **AND** the message is NOT enqueued on `marketing`'s agent stream

#### Scenario: Explicit peer target crosses rooms

- **WHEN** `backend` (room `neb-2026`) POSTs `/post` with `{to: "marketing", text: "check this out"}`
- **THEN** the message is enqueued on `marketing`'s stream even though `marketing` is in room `brand`
- **AND** the human receives it as always

#### Scenario: Human's broadcast reaches only selected room

- **GIVEN** the human's UI has selected room `neb-2026` in the switcher
- **WHEN** the human POSTs `/send` with `{target: "all", text: "hi team"}` and the request carries the selected room in its body
- **THEN** only room `neb-2026` agents receive the message

### Requirement: Every event carries its sender's room on SSE streams

Every event broadcast on `/stream` and `/agent-stream` SHALL include a top-level `room` field equal to the sender's room (or `null` if the sender is the human). This applies to chat entries, handoff events, interrupt events, nutshell events, and permission events.

Channel-bin forwarding events to claude SHALL include `room="<label>"` as a `<channel>` attribute.

#### Scenario: SSE chat entry carries room

- **WHEN** `backend` (room `neb-2026`) posts a message
- **THEN** the `/stream` SSE event for that message includes `"room": "neb-2026"`

#### Scenario: channel-bin forwards room attribute

- **WHEN** an agent `qa` in room `neb-2026` receives a channel notification
- **THEN** the `<channel>` tag in claude's context includes `room="neb-2026"`

### Requirement: channel-bin validates the `room` field on incoming events as defense-in-depth

channel-bin SHALL compare the `room` attribute on every inbound `/agent-stream` event against its own configured `CHATBRIDGE_ROOM`. If the attribute is present and does not match, the event SHALL be dropped before `notifications/claude/channel` would forward it to claude. Dropped events SHALL be logged to stderr with both room values for diagnostic purposes.

This is a redundant check on top of the hub's routing. A match succeeds silently; a mismatch drops the event and logs.

Events without a `room` attribute (e.g. broadcasts to the human's stream, which channel-bin does not read) are unaffected.

#### Scenario: Room mismatch dropped by channel-bin

- **GIVEN** channel-bin is configured with `CHATBRIDGE_ROOM=neb-2026`
- **WHEN** it receives an SSE event whose `room` field is `"brand"`
- **THEN** the event is not forwarded to claude's context
- **AND** a line `[channel] dropped cross-room event: mine=neb-2026 theirs=brand kind=<kind>` is written to stderr

#### Scenario: Matching room forwards normally

- **GIVEN** channel-bin is configured with `CHATBRIDGE_ROOM=neb-2026`
- **WHEN** it receives an SSE event whose `room` field is `"neb-2026"`
- **THEN** the event is forwarded to claude as usual

### Requirement: UI room switcher filters client view without changing protocol

The webview header SHALL contain a room selector dropdown listing every distinct room present in the current roster plus an "All" option. Selecting a specific room SHALL filter: chat messages, presence pills in the roster strip, terminal-pane tabs, handoff cards, interrupt cards, and the nutshell strip.

The filter is client-side only: the SSE stream continues to deliver every event to the human; the UI hides the ones outside the selected room.

Selecting "All" SHALL restore the full view (no filtering).

The human's composer SHALL indicate the currently-selected room in its placeholder (e.g. `"Message #neb-2026…"`). When "All" is selected, the composer SHALL be disabled with a tooltip instructing the human to select a room first.

#### Scenario: Switch rooms hides other-room messages

- **GIVEN** chat has messages from agents in `neb-2026` and `brand`
- **WHEN** the human selects `neb-2026` in the switcher
- **THEN** only messages tagged `room: "neb-2026"` are visible
- **AND** messages tagged `room: "brand"` are hidden

#### Scenario: All view shows everything

- **WHEN** the human selects "All"
- **THEN** every chat message, card, and tab is visible regardless of room
- **AND** the composer is disabled

#### Scenario: Terminal tabs filter by room

- **GIVEN** agents `backend@neb-2026`, `frontend@neb-2026`, `marketing@brand` are live in the terminal pane
- **WHEN** the human selects `neb-2026`
- **THEN** only the `backend` and `frontend` tabs are visible
