# interrupt-messages Specification

## Purpose
TBD - created by archiving change v06-roadmap. Update Purpose after archive.
## Requirements
### Requirement: `interrupt` is a new typed message kind stored in the ledger

The ledger SHALL gain an `interrupts` table keyed by interrupt ID (`i_[0-9a-f]{16}`). Each row stores `{id, from_agent, to_agent, text, status, created_at_ms, acknowledged_at_ms, acknowledged_by}`. Status is one of `"pending"` or `"acknowledged"`; `"acknowledged"` is terminal.

Interrupts SHALL be written via the same event-log pattern as handoffs: one row in the `events` table plus one row/update in `interrupts`, wrapped in a single SQLite transaction.

#### Scenario: Create persists atomically

- **GIVEN** the ledger is enabled
- **WHEN** the hub accepts `POST /interrupts` with `{from: "alice", to: "bob", text: "stop, re-read the spec"}`
- **THEN** exactly one row is inserted into `events` with `kind="interrupt.new"`
- **AND** exactly one row is inserted into `interrupts` with `status="pending"`
- **AND** both writes are in the same transaction (rollback on either failure)

### Requirement: HTTP routes for interrupts mirror handoff conventions

`POST /interrupts` SHALL create a new interrupt (Bearer auth required, 256 KiB body cap). `POST /interrupts/:id/ack` SHALL transition it to `acknowledged` (Bearer auth; `by` must match `to_agent` or the human name). `GET /interrupts?status=&for=&limit=` SHALL list interrupts with the same filter shape as `/handoffs`.

The terminal-state policy matches handoffs: same-status retry → 200 idempotent, different-status retry → 409 conflict, not-recipient → 403, not-found → 404.

#### Scenario: Recipient acks a pending interrupt

- **GIVEN** interrupt `i_abc…` has `status="pending"` and `to_agent="bob"`
- **WHEN** `POST /interrupts/i_abc.../ack` arrives with `{by: "bob"}`
- **THEN** the response is 200 with `{snapshot: {..., status: "acknowledged", ...}}`
- **AND** a `events.kind="interrupt.ack"` row is written
- **AND** an SSE event `interrupt.ack` is broadcast to the UI

#### Scenario: Non-recipient cannot ack

- **GIVEN** interrupt `i_abc…` has `to_agent="bob"`
- **WHEN** `POST /interrupts/i_abc.../ack` arrives with `{by: "alice"}`
- **THEN** the response is 403 with `{error: "not the recipient"}`
- **AND** no events or status changes occur

#### Scenario: Ack of already-acknowledged interrupt is idempotent

- **GIVEN** interrupt `i_abc…` has `status="acknowledged"` and `acknowledged_by="bob"`
- **WHEN** `POST /interrupts/i_abc.../ack` arrives with `{by: "bob"}`
- **THEN** the response is 200 with `{snapshot: ..., idempotent: true}`
- **AND** no new events are written

### Requirement: Agents receive interrupts as channel notifications and expose `ack_interrupt`

The channel-mode sidecar SHALL forward `interrupt.new` events arriving via `/agent-stream` as `notifications/claude/channel` with `meta.kind="interrupt.new"`, `meta.interrupt_id`, `meta.from`, and `content` set to the interrupt text. The sidecar SHALL expose an MCP tool `ack_interrupt(interrupt_id)` that POSTs to `/interrupts/:id/ack`.

Agents SHALL also expose `send_interrupt(to, text)` to initiate interrupts toward peers or the human. Payload cap: 500 chars for `text`.

#### Scenario: Agent receives and acknowledges

- **GIVEN** agent `bob` is connected to `/agent-stream`
- **WHEN** `alice` sends an interrupt to `bob`
- **THEN** `bob`'s claude session receives `<channel kind="interrupt.new" interrupt_id="i_..." from="alice">...text...</channel>`
- **AND** `bob`'s session can call `ack_interrupt({interrupt_id: "i_..."})`
- **AND** the hub transitions the interrupt to `acknowledged`

### Requirement: UI renders interrupts as high-visibility cards

The webview SHALL render interrupts as cards distinct from handoff cards — larger, red-accented border, and sticky to the top of the message area until acknowledged. When the human is the recipient, the card SHALL display an "Acknowledge" button that calls `POST /interrupts/:id/ack` with `by=HUMAN_NAME`. The human MAY also compose interrupts via a header button or `@` command.

#### Scenario: Human acknowledges via UI

- **GIVEN** an interrupt targeting the human is displayed in the UI
- **WHEN** the human clicks "Acknowledge"
- **THEN** a POST to `/interrupts/:id/ack` is sent with `{by: HUMAN_NAME}`
- **AND** on success, the card transitions to a muted "acknowledged" state and un-sticks from the top

### Requirement: Interrupts are a coordination primitive, not a hard preemption

Interrupts SHALL NOT preempt or cancel an agent's in-flight LLM turn. The hub SHALL NOT assume any behavioral guarantee from recipient agents beyond "the notification is delivered." The coordination value derives from:

- The distinct channel notification kind (`interrupt.new`) that agents can be prompted to react to.
- The visible, persistent UI card that prevents the human from missing the signal.
- The acknowledgement protocol that lets senders track whether the message was seen.

The README and the onboarding briefing SHALL state this explicitly — interrupts depend on cooperative agents.

#### Scenario: Agent ignores interrupt

- **GIVEN** an interrupt is delivered to agent `bob`
- **WHEN** `bob`'s model does not call `ack_interrupt`
- **THEN** the interrupt stays `pending` until the sender's patience runs out
- **AND** the hub takes no action beyond delivery

