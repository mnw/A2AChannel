## ADDED Requirements

### Requirement: CSS is organized into semantic files under `ui/styles/`

The A2AChannel UI SHALL ship CSS as a set of semantic files under `ui/styles/`, each scoped to a single concern, loaded by `ui/index.html` via individual `<link rel="stylesheet">` tags in a deterministic order.

The file set includes at minimum:

- `tokens.css` — CSS custom properties (design tokens) and `@font-face` declarations.
- `reset.css` — base reset rules and the `.visually-hidden` utility.
- `animations.css` — all `@keyframes` declarations.
- `layout.css` — application shell layout (two-column, splitter).
- `scrollbars.css` — global scrollbar styling.
- `dropdown.css` — shared dropdown primitive.
- `card.css` — shared card primitive.
- `modals.css` — modal shell plus spawn / reason / confirm variants.
- `header.css` — brand, nutshell strip, roster, usage pill.
- `composer.css` — message input, @mention popover, attachment row.
- `chat.css` — messages column, message bubbles, drop overlay, copy toast.
- `terminal.css` — terminal column, tab rail, kill-confirm surfaces.

Per-kind files under `ui/kinds/` (introduced by v0.9.5) SHALL contain only kind-specific extensions on top of the shared `card` primitive, not full card implementations.

The legacy `ui/style.css` monolith SHALL NOT remain after this change (it may be deleted outright or replaced with an empty stub for one release cycle before removal).

#### Scenario: Semantic split is navigable

- **GIVEN** a developer looking for dropdown styling
- **WHEN** they open `ui/styles/dropdown.css`
- **THEN** they find every rule governing the dropdown primitive
- **AND** no dropdown rules exist in any other file under `ui/styles/`

#### Scenario: Load order is deterministic

- **GIVEN** `ui/index.html`
- **WHEN** the page loads
- **THEN** `<link>` tags appear in the order: tokens → reset → animations → layout → scrollbars → dropdown → card → modals → header → composer → chat → terminal → kinds
- **AND** any rule that references a token, keyframe, or shared primitive resolves correctly because its dependency loaded earlier

#### Scenario: Per-kind files contain only extensions

- **GIVEN** v0.9.6 has shipped
- **WHEN** reading `ui/kinds/permission.css`
- **THEN** it contains only permission-specific rules (e.g., `.card-input-preview`, `.card--permission .permission-dismiss`)
- **AND** it does NOT redefine `.card` base properties (border, padding, grid) — those live in `ui/styles/card.css`

### Requirement: A single shared dropdown primitive backs all three dropdowns

The `.dropdown` CSS class SHALL be the single source of truth for dropdown button structure, popover positioning, keyboard focus rings, `aria-expanded` state styling, and empty-state rendering. The three existing dropdown surfaces (header room switcher, composer target selector, spawn-modal room combo) SHALL render through this primitive, distinguished by `data-variant` attribute values on the dropdown root:

- `data-variant="target"` — composer target selector.
- `data-variant="room"` — header room switcher.
- `data-variant="spawn-room"` — spawn-modal room combo with text input.

Feature-specific overrides (width, anchor position, empty-state label, disabled state) SHALL be expressed as `[data-variant="..."]` selector blocks in `ui/styles/dropdown.css`. Feature files (`header.css`, `composer.css`, `modals.css`) SHALL NOT redefine dropdown structural rules.

Pre-refactor state: three parallel implementations totalling ~437 lines. Post-refactor target: one primitive plus variant overrides, ~220 lines total.

#### Scenario: Tweaking the shared dropdown affects all three surfaces

- **GIVEN** v0.9.6 has shipped
- **WHEN** a developer adjusts `.dropdown button:focus-visible` in `ui/styles/dropdown.css`
- **THEN** the focus style updates on the room switcher, the target selector, and the spawn-modal room combo simultaneously
- **AND** no feature-specific CSS file needs a matching edit

#### Scenario: Variant differences are contained

- **GIVEN** the target dropdown is wider than the room switcher
- **WHEN** reading `ui/styles/dropdown.css`
- **THEN** the width override sits under `.dropdown[data-variant="target"]`
- **AND** the override block is <40 lines, not a full re-implementation

### Requirement: A single shared card primitive backs all kind cards

The `.card` CSS class SHALL be the single source of truth for card frame, border, padding, grid layout, header/body/meta/actions structure, and shared status/replay badge styling. Per-kind cards SHALL render as `<div class="card card--<kind>">` with the kind's own extensions provided in `ui/kinds/<kind>.css`.

Shared elements SHALL include:
- `.card` (root frame)
- `.card-header`, `.card-body`, `.card-meta`, `.card-actions`
- `.card-status-badge`, `.card-replay-badge`
- State modifiers: `.card--pending`, `.card--resolved`, `.card--terminal`

Kind-specific extensions SHALL live only in `ui/kinds/<kind>.css` and SHALL NOT duplicate base rules from `ui/styles/card.css`.

Legacy class names (`.handoff-card`, `.interrupt-card`, `.permission-card` and their `-header`, `-body`, etc. variants) SHALL be replaced across `ui/main.js` DOM builders and any CSS consumers in the same PR that ships this refactor. No alias classes are retained.

#### Scenario: Adding a kind card requires no touches to `card.css`

- **GIVEN** a developer adds a new kind (e.g., signoff) under the v0.9.5 kind-runtime contract
- **WHEN** writing `ui/kinds/signoff.css`
- **THEN** they declare only signoff-specific extensions
- **AND** they inherit the card frame, header, body, and status badge from `ui/styles/card.css` automatically via the `.card.card--signoff` class composition

#### Scenario: No redundant card frame rules across kinds

- **GIVEN** `ui/kinds/handoff.css`, `ui/kinds/interrupt.css`, `ui/kinds/permission.css` post-refactor
- **WHEN** comparing them
- **THEN** none redeclare `.card { background; border; border-radius; padding; display: grid }`
- **AND** each contains only extensions specific to its kind (countdown for handoff, input-preview for permission, etc.)

### Requirement: Hardcoded color values are consolidated into tokens

All recurring color values in the CSS tree SHALL be expressed as CSS custom properties under `ui/styles/tokens.css`, not inline hex or rgba literals. Hardcoded values that appear two or more times SHALL be promoted to a named token. One-off affordances MAY remain hardcoded if accompanied by an explanatory comment on the same line or the line above.

The token set SHALL cover:
- The brand palette (`--orange`, `--green`, `--red`, and their hover/pressed variants).
- Alpha variants of the brand orange (used extensively for backgrounds, borders, shadows) via named tokens or `color-mix()` calls against the base token.
- The text hierarchy (`--text`, `--text-dim`, and any interstitial shades currently hardcoded).
- The surface hierarchy (`--bg`, `--bg-inset`, `--line`, and any line/divider shades currently hardcoded).

Target: fewer than 5 hardcoded hex literals remain in the entire `ui/styles/` + `ui/kinds/` tree post-refactor, each accompanied by a comment justifying why it's not a token.

#### Scenario: Token audit completeness

- **GIVEN** v0.9.6 has shipped
- **WHEN** running `grep -oE '#[0-9a-fA-F]{3,8}\b' ui/styles/ ui/kinds/ | sort -u`
- **THEN** fewer than 5 unique hex values appear
- **AND** each has an accompanying `/* one-off: ... */` comment explaining its presence

#### Scenario: Orange alpha variants are token-reachable

- **GIVEN** a designer wants to adjust the "brand orange with 8% alpha" tone used on card backgrounds
- **WHEN** reading `ui/styles/tokens.css`
- **THEN** they find either a named token (e.g., `--orange-bg-soft`) or a `color-mix` pattern they can adjust in one place
- **AND** the change propagates to every consumer automatically

### Requirement: Animation keyframes are centralized

All `@keyframes` declarations SHALL live in `ui/styles/animations.css`. Feature files SHALL reference animations by name but SHALL NOT declare their own `@keyframes` blocks.

#### Scenario: Keyframes are discoverable

- **GIVEN** a developer wants to modify the `blink-border` animation
- **WHEN** they search for the `@keyframes` declaration
- **THEN** they find it in `ui/styles/animations.css`
- **AND** no other file in `ui/styles/` or `ui/kinds/` contains a `@keyframes` block

### Requirement: No user-visible behavior changes

The v0.9.6 refactor SHALL preserve user-visible behavior byte-identically in the common case:

- Pixel output on all 12 documented UI states (idle chat, message with attachment, each kind card pending/resolved, spawn modal, kill confirm, reason modal, room switcher open, target dropdown open, terminal tab active, nutshell editing) is identical before and after, within a tolerance of 2 deltaE perceptual difference for any token-consolidated color.
- Keyboard interactions (tab order, Enter-to-submit, Escape-to-close, arrow-key navigation in dropdowns) are unchanged.
- `aria-expanded`, `aria-label`, `role` attributes on interactive elements are unchanged.
- Animation timings, easings, and durations are unchanged.

The refactor introduces no new HTML element types, no new event listeners, and no new JS code paths beyond what class-name alignment (decision 3) requires.

#### Scenario: Visual regression gate

- **WHEN** the v0.9.6 PR is opened
- **THEN** the description includes before/after screenshots for all 12 documented UI states
- **AND** reviewers can reject the PR if any pixel difference is visible and unjustified

#### Scenario: No new JS behavior

- **GIVEN** v0.9.6 has shipped
- **WHEN** running the app
- **THEN** clicking each dropdown, card, and modal produces the same console output, same network requests, and same SSE events as the v0.9.5 baseline
- **AND** the only diff in `ui/main.js` is class-name alignment in DOM-builder functions
