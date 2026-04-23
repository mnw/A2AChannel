## MODIFIED Requirements

### Requirement: HTTP routes for interrupts mirror handoff conventions and enforce room scope

`POST /interrupts` SHALL create a new interrupt (Bearer auth required, 256 KiB body cap). Two body shapes are accepted:

1. **Single-recipient**: `{ from, to, text }` — the recipient MUST be in the sender's room, UNLESS the sender is the human (who is in every room). A cross-room attempt by a non-human sender returns HTTP 403 `{"error": "cross-room interrupt not permitted"}`. The human may address any agent in any room.
2. **Bulk-by-room**: `{ from, rooms: [<label>...], text }` — only accepted when `from` equals the human_name (only the human may bulk-address rooms). Each listed room generates one interrupt per non-human agent in that room. The response lists the generated interrupt IDs grouped by room.

`POST /interrupts/:id/ack` SHALL transition an interrupt to `acknowledged`. `by` must match `to_agent` or the human name. The acker does not need to be in the same room as the interrupt's originator (the human may ack anywhere; the recipient agent is by definition in the right room).

`GET /interrupts?status=&for=&room=&limit=` SHALL list interrupts; the new `room` filter narrows results to interrupts whose recipient agent was in the given room at ack time.

The terminal-state policy is unchanged: same-status retry → 200 idempotent, different-status retry → 409 conflict, not-recipient → 403, not-found → 404.

#### Scenario: Cross-room interrupt rejected for non-human sender

- **GIVEN** agent `backend` is in room `neb-2026` and agent `marketing` is in room `brand`
- **WHEN** `backend` POSTs `/interrupts` with `{from: "backend", to: "marketing", text: "..."}`
- **THEN** the response is 403 `{"error": "cross-room interrupt not permitted"}`
- **AND** no ledger row is written

#### Scenario: Human crosses rooms freely

- **WHEN** the human POSTs `/interrupts` with `{from: "<human_name>", to: "marketing", text: "..."}` regardless of marketing's room
- **THEN** the interrupt is created normally

#### Scenario: Bulk shape rejects non-human sender

- **WHEN** agent `backend` POSTs `/interrupts` with `{from: "backend", rooms: ["neb-2026"], text: "..."}`
- **THEN** the response is 403 `{"error": "bulk interrupt restricted to human"}`

#### Scenario: Bulk shape fans out per agent

- **GIVEN** room `neb-2026` contains agents `backend` and `qa`
- **WHEN** the human POSTs `/interrupts` with `{from: "<human_name>", rooms: ["neb-2026"], text: "Pause..."}`
- **THEN** two interrupts are created, one addressed to `backend`, one to `qa`
- **AND** each has its own ID, ledger row, and `interrupt.new` event

## ADDED Requirements

### Requirement: Interrupt SSE events carry the room attribute

Every `interrupt.new`, `interrupt.ack`, and `interrupt.*` event broadcast on `/stream` SHALL include a top-level `room` field equal to the recipient agent's room (for single-recipient interrupts) or the target room (for bulk shape). This allows the UI room switcher to filter interrupt cards without needing to cross-reference the roster.

Channel-bin forwarding interrupts to a claude session SHALL pass `room` as a `<channel>` meta attribute, enabling channel-bin's room-gate (see `rooms` capability) to reject cross-room leakage as defense-in-depth.

#### Scenario: Interrupt events tagged with room

- **WHEN** an interrupt is created for agent `qa` in room `neb-2026`
- **THEN** the `/stream` SSE payload includes `"room": "neb-2026"`
- **AND** the `/agent-stream` forwarding to `qa` includes the same `room` attribute
