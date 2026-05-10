## ADDED Requirements

### Requirement: UI per-kind modules own their slice end-to-end via `KindRenderer`

Every persistent state-machine kind with UI surface SHALL ship as a module at `ui/kinds/<kind>.js` exporting a `KindRenderer` object with the following contract:

- `extractSnapshot(entry): Snapshot` — projects an incoming SSE entry to the renderer's snapshot shape (`{ id, version, status, ...kind-specific }`)
- `buildHeader(snapshot, container): void` — paints the header region (title, status badge, by/from actor)
- `buildBody(snapshot, container): void` — paints the body region (per-Kind content: handoff context, interrupt text, permission tool/cwd/diff)
- `buildActions(snapshot, container, dispatch): void` — paints action buttons; each button's click invokes `dispatch(verb, payload)`
- `dispatch(verb, payload): Promise<void>` — sends the verb to the hub via the appropriate route; UI updates arrive via the next SSE event, not via local mutation
- `placement: "stack" | "pin" | "append"` — static property declaring the renderer's card placement strategy

`ui/main.js` SHALL delegate to a generic `KindCard` factory (defined below) when an SSE event arrives whose `kind` field matches a registered renderer's prefix. `KindCard` produces DOM by composing `buildHeader` + `buildBody` + `buildActions` against the renderer's `extractSnapshot` output, applies version reconciliation, and places the card per `placement`.

Layout, composer, header, and other non-kind UI concerns remain in `ui/main.js` and `ui/styles/chat.css`.

`ui/index.html` SHALL load per-Kind modules via `<script type="module">`. No inline event handlers (`onclick=`, etc.) are permitted; all interaction uses `addEventListener` (wired by `KindCard` from the renderer's `buildActions`).

#### Scenario: SSE event routes to the matching renderer via KindCard

- **GIVEN** the renderer registry exposes `handoffRenderer`, `interruptRenderer`, `permissionRenderer`
- **WHEN** an SSE event arrives with `kind: "permission.new"`
- **THEN** `KindCard(permissionRenderer, event)` is invoked to produce or update a card
- **AND** `handoffRenderer` is not invoked

#### Scenario: Adding a UI kind requires no edits to main.js or KindCard

- **WHEN** a developer adds `ui/kinds/foo.js` exporting a `fooRenderer: KindRenderer`, adds a `<script type="module">` entry in `index.html`, and registers the renderer in the UI kind registry
- **THEN** `ui/main.js` requires zero edits
- **AND** `ui/kinds/kind-card.js` requires zero edits
- **AND** Kind-shared CSS in `ui/styles/kinds.css` automatically applies via `data-kind="foo"` attribute

### Requirement: `KindCard` owns lifecycle by `(id, version)` newer-wins

`KindCard` SHALL track each Kind entry by `(id, version)` and discard any update with `version <= lastSeenVersion(id)`. On first version, `KindCard` mounts (calls `buildHeader` + `buildBody` + `buildActions`); on subsequent newer versions, it re-runs the same builders against the new snapshot to re-paint; on terminal status reached for the first time, it dismisses (removes the card or moves it to the inline message stream depending on `placement`). Dismissal MUST be idempotent (re-dismissing a dismissed card is a no-op).

#### Scenario: Out-of-order versions are discarded

- **GIVEN** `KindCard` has rendered version 5 of handoff `h-abc`
- **WHEN** an SSE event with version 3 of the same handoff arrives (e.g., from a slow replay)
- **THEN** `KindCard` discards the event without calling any builder

#### Scenario: Terminal status triggers exactly one dismiss

- **GIVEN** an interrupt transitions from `pending` to `acknowledged` (terminal)
- **WHEN** the `interrupt.update` event arrives
- **THEN** `KindCard` runs the placement-specific dismiss path exactly once (Interrupt: pin region → moves card into chat-message stream)
- **AND** subsequent same-status events do not re-run the dismiss path

### Requirement: Placement strategies map to fixed Webview behaviors

The three `placement` strings SHALL behave as follows:
- `"append"`: card appended inline to the chat-message stream (Handoff today)
- `"pin"`: card pinned at the chat scroll bottom; on terminal status, moved into the inline message stream as a normal message (Interrupt today)
- `"stack"`: card stacked at the chat-pane bottom in a dedicated stack region; multiple pending cards stack vertically (Permission today)

`KindCard` MUST honor the renderer's declared `placement` string deterministically; it MUST NOT consult any per-Kind logic to decide placement.

#### Scenario: Permission cards stack independently of chat scroll

- **GIVEN** two pending permission requests
- **WHEN** both renderers' `placement: "stack"` is consumed by `KindCard`
- **THEN** both cards appear in the dedicated stack region
- **AND** their position does NOT change when the user scrolls the chat pane

### Requirement: Per-Kind CSS consolidates into `ui/styles/kinds.css`

Per-Kind shared visual rules SHALL live in `ui/styles/kinds.css`, keyed by `data-kind="<kind>"` attributes set by `KindCard` on the card's root element. Per-Kind rules previously scattered across `ui/styles/chat.css` (`.handoff-card`, `.interrupt-card`, `.permission-card` and their state classes) MUST be moved into `kinds.css`. `ui/styles/chat.css` SHALL afterwards contain chat-pane concerns only — message bubbles, composer, scroll region, header bar — with no Kind-specific class rules.

A truly Kind-specific quirk that doesn't belong to the shared schema MAY remain in a per-Kind file (e.g., `ui/kinds/<kind>.css`) but the shared schema is canonical and SHOULD cover ≥90% of each Kind's visual rules.

#### Scenario: Restyling all Kind status badges touches one file

- **GIVEN** a developer wants to change the visual treatment of "pending" status badges across all three Kinds (handoff, interrupt, permission)
- **WHEN** they edit the rule
- **THEN** the edit lands in exactly one file: `ui/styles/kinds.css`
- **AND** the rule is keyed by `[data-kind][data-status="pending"] .badge` (or equivalent shared selector) so it applies to all three Kinds

#### Scenario: chat.css contains no Kind-specific rules

- **WHEN** `ui/styles/chat.css` is grepped for `.handoff-card`, `.interrupt-card`, `.permission-card`, or any other per-Kind class selector
- **THEN** zero matches are found
- **AND** all per-Kind selectors live in `ui/styles/kinds.css`
