## ADDED Requirements

### Requirement: `Snapshot` shape is declared explicitly

Every Kind's snapshot type SHALL conform to the base shape `Snapshot = { id: string; version: number; status: string; [key: string]: unknown }`. `KindCard` consumes the first three fields for its lifecycle (id for the per-card map key; version for newer-wins reconciliation; status for terminal-status detection driving the per-placement dismiss matrix). Per-Kind extension fields (e.g. handoff's `from_agent` / `task` / `expires_at_ms`) ride on the `unknown` index signature.

#### Scenario: extractSnapshot returns the canonical shape

- **GIVEN** an SSE event of `kind: "handoff.update"` with `text: JSON.stringify({...})` and `snapshot: {...}`
- **WHEN** `handoffRenderer.extractSnapshot(event)` is invoked
- **THEN** the returned object has at minimum `{id: string, version: number, status: string}`
- **AND** any additional Kind-specific fields are included

### Requirement: UI per-Kind modules own their slice end-to-end via `KindRenderer`

Every persistent state-machine kind with UI surface SHALL ship as a module at `ui/kinds/<kind>.js` exporting a factory `createXRenderer(ctx): KindRenderer`. The factory takes a `ctx` object carrying the helpers the renderer needs from `ui/main.js` (mirrors the Hub-side `cap` idiom). `KindRenderer` has the following contract:

- `extractSnapshot(entry): Snapshot` — projects an incoming SSE entry to the renderer's snapshot shape (`{ id, version, status, ...kind-specific }`). Pure; no DOM, no `ctx`.
- `mount(snapshot, container, dispatch): void` — paints the card's full content (header, body, actions) into `container`. Action-element click handlers wire to `dispatch(verb, payload)`.
- `dispatch(verb, payload): Promise<void>` — sends the verb to the hub via the appropriate route via `ctx.authedFetch`; UI updates arrive via the next SSE event, not via local mutation.
- `placement: "stack" | "pin" | "append"` — static property declaring the renderer's card placement strategy.

(The 4-builder split — `buildHeader` / `buildBody` / `buildActions` separate from `mount` — is rejected unless pre-grilling demonstrates `KindCard` needs to inject shared chrome BETWEEN sections. Today's three Kinds paint header/body/actions atomically; the single `mount` is sufficient.)

`ui/main.js` SHALL construct one shared `ctx` at startup and hand it to each `createXRenderer(ctx)` factory. `ui/main.js` SHALL delegate dispatch-on-event to a registry static `KindCard.dispatch(eventKind, entry)` that looks up the renderer by kind-prefix and applies the lifecycle (mount on first version, re-mount on newer version, dismiss on terminal status per placement matrix).

`ui/index.html` SHALL load `ui/main.js` and per-Kind modules via `<script type="module">`. No inline event handlers (`onclick=`, etc.) are permitted.

#### Scenario: SSE event routes to the matching renderer via KindCard.dispatch

- **GIVEN** the renderer registry has registered handoffRenderer, interruptRenderer, permissionRenderer (each constructed via `createXRenderer(ctx)`)
- **WHEN** an SSE event arrives with `kind: "permission.new"`
- **THEN** `KindCard.dispatch("permission.new", event)` is invoked from main.js
- **AND** the registry routes to permissionRenderer based on the `permission` prefix
- **AND** handoffRenderer / interruptRenderer are not invoked

#### Scenario: Adding a UI kind requires no edits to main.js

- **WHEN** a developer adds `ui/kinds/foo.js` exporting `createFooRenderer(ctx): KindRenderer`, adds a `<script type="module">` entry in `index.html`, and registers the factory in the UI kind registry
- **THEN** `ui/main.js` requires zero edits
- **AND** `ui/kinds/kind-card.js` requires zero edits
- **AND** Kind-shared CSS in `ui/styles/kinds.css` automatically applies via the `data-kind="foo"` attribute KindCard sets on the card root

### Requirement: ES-module migration replaces classic-`<script>` shared-lexical-scope

`ui/main.js` and the three per-Kind modules SHALL convert from classic `<script>` load-order shared-lexical-scope to ES modules. The `ctx` factory pattern (Decision 4 in design.md) replaces the implicit shared globals — today's 12+ globals (`messagesEl`, `authedFetch`, `parseErrorBody`, `askReason`, `escHtml`, `HUMAN_NAME`, `addMessage`, `trimMessages`, `updateCountdownLabel`, `handoffCards`, `interruptCards`, `permissionCards`) become explicit fields on `ctx`. Per-Kind state Maps (`handoffCards`, etc.) move INSIDE the renderer's closure (not on `ctx`) — they're renderer-local, not main-shared.

#### Scenario: Per-Kind module is a pure ES module

- **GIVEN** `ui/kinds/handoff.js`
- **WHEN** the file is loaded as `<script type="module">`
- **THEN** it declares no globals (`var name = ...` at top level)
- **AND** it exports `createHandoffRenderer(ctx): KindRenderer` as the single named export
- **AND** all dependencies on main.js helpers are received via the `ctx` parameter, never via implicit lexical-scope reference

### Requirement: `KindCard` owns lifecycle by `(id, version)` newer-wins; per-placement dismiss matrix

`KindCard` SHALL track each Kind entry by `(id, version)` and discard any update with `version <= lastSeenVersion(id)`. On first version, `KindCard` calls `renderer.mount(snapshot, container, renderer.dispatch)`; on subsequent newer versions, it re-mounts (clearing `container.innerHTML` and calling `mount` again with the new snapshot — atomic re-paint). On terminal status reached for the first time, the dismiss policy depends on the renderer's `placement`:

| Placement | Dismiss policy |
|---|---|
| `"append"` | Leave card in place; KindCard adds a CSS class `kind-card--terminal` for visual styling. Today's handoff behavior. |
| `"pin"` | Move card from sticky pinned region into the inline message stream (DOM detach + re-insert). Today's interrupt behavior. |
| `"stack"` | Remove card from the stack region (DOM detach). Today's permission behavior. |

`KindCard` MUST honor the dismiss policy deterministically based on the renderer's declared `placement`; renderers do NOT need to author a per-Kind `dismiss` callback. (If a future Kind needs custom dismiss behavior, an optional `onDismiss(card, snapshot): "remove" | "move-inline" | "keep-with-class"` hook is added.)

#### Scenario: Out-of-order versions are discarded

- **GIVEN** `KindCard` has rendered version 5 of handoff `h-abc`
- **WHEN** an SSE event with version 3 of the same handoff arrives (e.g., from a slow replay)
- **THEN** `KindCard` discards the event without calling `mount`

#### Scenario: Terminal-status dismiss for "append" placement keeps the card

- **GIVEN** a handoff (placement: "append") in `pending` state, mounted in the inline message stream
- **WHEN** an SSE `handoff.update` event arrives with `status: "accepted"` (terminal)
- **THEN** `KindCard` re-mounts with the new snapshot
- **AND** adds `kind-card--terminal` class to the card root
- **AND** does NOT remove the card from the DOM

#### Scenario: Terminal-status dismiss for "pin" placement moves the card inline

- **GIVEN** an interrupt (placement: "pin") in `pending` state, mounted in the pinned region
- **WHEN** an SSE `interrupt.update` event arrives with `status: "acknowledged"` (terminal)
- **THEN** `KindCard` re-mounts with the new snapshot
- **AND** moves the card root from the pinned region into the inline message stream
- **AND** does NOT remove the card from the DOM

#### Scenario: Terminal-status dismiss for "stack" placement removes the card

- **GIVEN** a permission (placement: "stack") in `pending` state, mounted in the stack region
- **WHEN** an SSE event arrives with `status: "allowed"` (terminal)
- **THEN** `KindCard` removes the card root from the stack region (DOM detach)

### Requirement: Placement strategies map to fixed Webview behaviors

The three `placement` strings SHALL behave as follows on MOUNT:
- `"append"`: card appended inline to the chat-message stream (Handoff today)
- `"pin"`: card pinned at the chat scroll bottom in a sticky region; multiple pinned cards stack vertically; the card transitions to inline on terminal status (per dismiss matrix)
- `"stack"`: card stacked at the chat-pane bottom in a dedicated stack region; multiple pending cards stack vertically (Permission today)

`KindCard` MUST implement all three placement modes generically — without per-Kind DOM. (Pre-grill 0.2 verifies this assumption: if a placement mode requires per-Kind DOM, that mode promotes from a string to a callback while the others keep strings.)

#### Scenario: Permission cards stack independently of chat scroll

- **GIVEN** two pending permission requests
- **WHEN** both renderers' `placement: "stack"` is consumed by `KindCard`
- **THEN** both cards appear in the dedicated stack region
- **AND** their position does NOT change when the user scrolls the chat pane

### Requirement: Per-Kind CSS consolidates into `ui/styles/kinds.css`; `ui/styles/card.css` folded in

Per-Kind shared visual rules SHALL live in `ui/styles/kinds.css`, keyed by `[data-kind="<kind>"]` attributes set by `KindCard` on the card's root element. The migration consolidates from FIVE current sources:

1. `ui/kinds/handoff.css` (112 LOC) → moved into `kinds.css`
2. `ui/kinds/interrupt.css` (86 LOC) → moved into `kinds.css`
3. `ui/kinds/permission.css` (183 LOC) → moved into `kinds.css`
4. `ui/styles/card.css` (67 LOC, the shared `.handoff-card / .interrupt-card / .permission-card` skeleton) → folded into `kinds.css` as the foundational `[data-kind]` rule (it's literally a Kinds-shared schema)
5. `ui/features/rooms.js` lines 125-127 (runtime-injected room-filter CSS hardcoding `.handoff-card[data-room]`) → migrated to `[data-kind][data-room]` selectors so the rule applies to all current and future Kinds without per-Kind hardcoding

`ui/styles/chat.css` is already clean of Kind-specific rules and stays clean.

A truly Kind-specific quirk that doesn't belong to the shared schema MAY remain in a per-Kind file (e.g., `ui/kinds/<kind>.css`) but the shared schema SHOULD cover ≥90% of each Kind's visual rules. After consolidation the per-Kind `.css` files SHOULD shrink substantially or be deleted entirely.

#### Scenario: Restyling all Kind status badges touches one file

- **GIVEN** a developer wants to change the visual treatment of "pending" status badges across all three Kinds
- **WHEN** they edit the rule
- **THEN** the edit lands in exactly one file: `ui/styles/kinds.css`
- **AND** the rule is keyed by `[data-kind][data-status="pending"] .badge` (or equivalent shared selector) so it applies to all three Kinds

#### Scenario: No per-Kind class selectors remain outside kinds.css

- **WHEN** the codebase is grepped for `.handoff-card`, `.interrupt-card`, `.permission-card` outside `ui/styles/kinds.css`
- **THEN** zero matches are found
- **AND** `ui/styles/chat.css`, `ui/styles/card.css`, `ui/kinds/<kind>.css`, AND `ui/features/rooms.js` all return zero matches
