## ADDED Requirements

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
