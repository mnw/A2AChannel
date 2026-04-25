# ui-styling Specification

## Purpose
TBD - created by archiving change v096-css-hygiene. Update Purpose after archive.
## Requirements
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

### Requirement: Webview JavaScript is organized into per-responsibility files

The A2AChannel UI SHALL ship JavaScript as a set of per-responsibility files under `ui/`, each scoped to a single concern, loaded by `ui/index.html` via individual classic `<script src=…>` tags in a documented load order.

Folder structure:

- `ui/index.html`, `ui/main.js`, `ui/terminal.js` — entry + two orchestrators at root.
- `ui/core/` — tier-1 foundations.
- `ui/features/` — tier-2 feature modules (and the usage pill).
- `ui/kinds/` — per-kind card renderers (handoff, interrupt, permission).
- `ui/terminal/` — terminal-pane sub-modules.
- `ui/styles/` — CSS modules.

The JS file set includes at minimum:

- `core/state.js` — module-level globals (BUS, AUTH_TOKEN, HUMAN_NAME, COLORS, NAMES, ROSTER, card maps, message-DOM constants), DOM element handles (`messagesEl`, `legendEl`, `nutshellEl`, etc.), `tauriInvoke`, and small pure helpers (`cap`, `shade`, `cssName`).
- `core/text.js` — pure escaping / linkify / mention parsing (`escHtml`, `escAttr`, `escRegex`, `linkify`, `highlightMentions`, `parseMentions`).
- `core/http.js` — `authedFetch` (with token-rotation retry), `parseErrorBody`, `withToken`, `imgUrl`.
- `features/messages.js` — chat-row rendering: `addMessage`, attachment HTML, image zoom, copy buttons + toast, `trimMessages`.
- `features/roster.js` — roster + presence: `applyRoster`, `applyPresence`, `markAllOffline`, `renderLegend`, `renderTargetDropdown`, `renderTargetMenu`.
- `features/rooms.js` — room switcher + menu, `applyRoomFilter`, `fireRoomInterrupt`, pause/resume.
- `features/composer.js` — `send`, `autoGrow`, send-button + textarea wiring.
- `features/mentions.js` — `@`-autocomplete popover (`currentMentionContext`, `updateMentionPopover`, `selectMention`).
- `features/emoji.js` — emoji picker.
- `features/attachments.js` — upload, render, paste, drag-drop.
- `features/nutshell.js` — nutshell strip + editor + `updateCountdownLabel` for handoff cards.
- `features/mcp-modal.js` — MCP config snippet modal.
- `features/usage.js` — usage pill: banner scrape + transcript USD fallback (already shipped in v0.9.9).
- `main.js` — orchestrator: bootstrap, SSE `connect`, `handleEvent` dispatch, settings + reload buttons, title-bar drag fallback.
- `kinds/{handoff,interrupt,permission}.js` (already extracted in v0.9.5) — per-kind card renderers.
- `terminal.js` — terminal pane orchestrator (IIFE-wrapped).
- `terminal/pty.js` — `ptySpawn`, `ptyWrite`, `ptyResize`, `ptyKill`, `ptyList` Tauri-invoke wrappers + base64 helpers, exposed via `window.__A2A_TERM__.pty`.

No file SHALL exceed 500 lines after this change.

The legacy 1652-line `ui/main.js` and 888-line `ui/terminal.js` SHALL be reduced to orchestrator shells (target ~150 lines and ~500 lines respectively, post-extraction).

#### Scenario: Module count and size targets are honored

- **WHEN** the change ships
- **THEN** `ui/main.js` is no more than 200 lines
- **AND** `ui/terminal.js` is no more than 550 lines
- **AND** every file in `ui/` (excluding `ui/vendor/`) is under 500 lines
- **AND** `ui/index.html` references each module via a `<script src=…>` tag

#### Scenario: Each module declares its dependencies in a header comment

- **WHEN** a developer opens any extracted module
- **THEN** the file opens with a comment block stating the file's purpose, its declared-earlier dependencies (other modules' globals it uses), and the symbols it exposes
- **AND** the header convention matches `ui/kinds/handoff.js` (which shipped this convention in v0.9.5)

### Requirement: `ui/index.html` documents script load order in tiers

`ui/index.html` SHALL group its `<script>` tags into three commented tiers, in load order: foundations (no deps), feature modules (depend on foundations), and orchestrators / kinds / terminal (depend on feature modules).

Each tier SHALL be introduced by an HTML comment block declaring its purpose and constraints.

#### Scenario: Tier comments are present and informative

- **WHEN** a developer reads `ui/index.html`
- **THEN** the script-tag block is preceded by a comment explaining the three-tier load convention
- **AND** each tier is separated from the next by a blank line and a comment naming the tier

#### Scenario: Adding a new UI module is mechanical

- **WHEN** a developer adds a new feature module under `ui/`
- **THEN** they edit `ui/index.html` to insert a new `<script>` tag in the correct tier
- **AND** they add a header comment to the new file declaring its dependencies and exposed symbols
- **AND** no other module needs to be modified to "register" the new file (no central registry, no module manifest)

### Requirement: Webview JavaScript SHALL NOT introduce a bundler or module system

The webview SHALL continue to load JavaScript via classic `<script src=…>` tags. No `<script type="module">`, no bundler (esbuild, rolldown, vite, etc.), no transpiler (TypeScript, Babel, etc.), no JSX, and no framework runtime (React, Vue, Svelte, etc.).

This requirement encodes the existing CLAUDE.md hard rule into the spec.

#### Scenario: A bundler PR is rejected

- **WHEN** a contributor opens a PR introducing a webview bundler
- **THEN** the PR is rejected with a pointer to this requirement and to CLAUDE.md's "Never introduce a framework to ui/index.html" hard rule
- **AND** the PR is not merged absent a separate openspec change deprecating this requirement

### Requirement: Behavior is preserved across the JS module split

The structural refactor SHALL NOT change observable behavior of the UI. Every interaction available in the pre-extraction monolith MUST continue to work identically post-extraction: SSE event handling, message rendering with attachments and copy buttons, room switching with legend filter, agent legend pills, target dropdown + menu, @mention autocomplete, emoji picker, attachment upload via paste / drag-drop / button, nutshell editor, handoff / interrupt / permission card lifecycles, usage pill, terminal pane spawn / kill / external-attach flow, and the MCP config modal.

#### Scenario: Manual click-through gate before shipping

- **WHEN** the extraction commits are complete and the app is installed
- **THEN** a manual click-through covers: send a message in two rooms; run /usage in an embedded pane and confirm the pill updates; fire a handoff (accept + decline + cancel + expire); trip a permission card (allow + deny + dismiss); send + ack an interrupt; edit and accept a nutshell proposal; click "Reload settings"; toggle the terminal pane; spawn an agent; kill an agent externally and observe the dead-state UI; restart A2AChannel and confirm tabs auto-reattach
- **AND** every step behaves identically to the pre-extraction baseline
- **AND** no regression surfaces during the click-through

### Requirement: Per-commit revertability for the extraction sequence

Each module extraction SHALL be a separate commit. Each commit SHALL be independently revertable without breaking the build or requiring concurrent revert of other commits.

#### Scenario: Bisect locates a regression to a single extracted module

- **WHEN** a regression is observed during click-through
- **THEN** `git bisect` between the pre-refactor commit and the click-through-failing commit narrows to a single extraction commit
- **AND** the offending commit can be reverted in isolation
- **AND** the rest of the extraction sequence remains in-tree

