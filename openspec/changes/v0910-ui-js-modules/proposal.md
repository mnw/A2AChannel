## Why

`ui/main.js` is **1652 lines** and `ui/terminal.js` is **888 lines** — combined ~2,540 lines of webview JavaScript with eleven distinct, mostly self-contained responsibilities tangled together (HTTP, room filter, roster, message rendering, composer, mentions, emoji, attachments, nutshell, MCP modal, and the orchestrator itself, all in one file). The hub-side equivalent (`hub.ts`) was the same shape pre-v0.9.5 and got broken into `core/` + `kinds/` + standalone modules — that refactor stuck. CSS got the same treatment in v0.9.6 (`ui/styles/*.css` + `ui/kinds/*.css`). UI JS is the last large monolith.

Pain points the size produces today:
- Adding a new chat-row affordance (e.g. the hover copy buttons) means scrolling past 700 lines of room/roster/composer code that has nothing to do with messages.
- The same `trimMessages` helper is called from four places (`addMessage`, `renderHandoffCard`, `renderInterruptCard`, `renderPermissionCard`); finding it requires a grep, not navigation.
- Composer concerns (send, autoGrow, mentions, emoji, attachments, paste, drag-drop) are scattered across three different sections of the file.
- Onboarding cost: anyone reading the file has to thread eleven concerns simultaneously.

v0.9.5 (hub.ts → core/+kinds/) and v0.9.6 (CSS hygiene) proved the extraction pattern. v0.9.10 closes the loop on the UI JS side.

## What Changes

- **`ui/main.js` 1652 → ~150 lines.** Reduced to: bootstrap, SSE `connect`, `handleEvent` dispatch, top-level keydown listener, and the pre-extraction loaders (`loadRoster`, `loadPending`, `loadNutshell`).
- **`ui/terminal.js` 888 → ~500 lines.** Three extractions (PTY adapter, spawn modal, banner-scan helpers) move into siblings; the file stays the orchestrator for the terminal pane.
- **12 new modules** under `ui/`, each owning one responsibility:
  - `state.js` — module-level globals + element handles + tiny helpers (`cap`, `shade`, `cssName`).
  - `text.js` — pure escaping / linkify / mention parsing utilities.
  - `http.js` — `authedFetch` (token-rotation retry), `parseErrorBody`, `withToken`, `imgUrl`.
  - `messages.js` — `addMessage`, attachment HTML, image zoom, copy buttons + toast, `trimMessages`, `getPermissionStack`.
  - `roster.js` — `applyRoster`, `applyPresence`, `markAllOffline`, legend + target dropdown rendering.
  - `rooms.js` — room switcher, room menu, `applyRoomFilter`, `fireRoomInterrupt`, pause/resume.
  - `composer.js` — `send`, `autoGrow`, send button + textarea wiring.
  - `mentions.js` — `@`-autocomplete popover.
  - `emoji.js` — emoji picker.
  - `attachments.js` — upload, render, paste, drag-drop.
  - `nutshell.js` — nutshell strip + editor + countdown helper for handoff cards.
  - `mcp-modal.js` — MCP config "How do I plug an external claude in?" modal.
- **`ui/terminal/` directory** for the three extracted terminal-pane modules:
  - `terminal/pty.js` — `ptySpawn` / `ptyWrite` / `ptyResize` / `ptyKill` / `ptyList` Tauri-invoke wrappers + base64 helpers.
  - `terminal/spawn-modal.js` — spawn-modal open/close, room picker, handle-launch flow.
  - `terminal/banner-scan.js` — `maybeFlagAttention`, `maybeAutoDismissDevChannels` (PTY-byte tail scanners).
- **Loading order documented in `index.html`** with a section comment block. Foundations → primitives → feature surfaces → orchestrator → kinds → terminal. Same convention `ui/kinds/*.js` already uses (header comment declares dependencies).
- **No bundler.** Continues using classic-script `<script src=…>` tags with shared lexical scope. Per CLAUDE.md hard rule.
- **No behavior change.** Pure structural refactor. Manual click-through gate before shipping (same as v0.9.8 pty.rs extraction).

## Capabilities

### New Capabilities

None. The behavior already ships under existing capabilities (`agent-onboarding`, `terminal-projection`, `interrupt-messages`, `project-nutshell`, etc.).

### Modified Capabilities

- **`ui-styling`** — extends with a "**module organization**" requirement: webview JavaScript SHALL be split into per-responsibility files of <500 lines each, declared explicitly in `ui/index.html` with a documented load order. Closes the same gap v0.9.6 closed for CSS (which is already in `ui-styling`'s scope).

## Impact

**Code:**
- `ui/main.js` shrinks 1652 → ~150 lines (-91%).
- `ui/terminal.js` shrinks 888 → ~500 lines (-44%).
- 15 new files (12 top-level + 3 under `ui/terminal/`), each under 250 lines.
- `ui/index.html` adds 14 `<script>` tags with a header comment block documenting load order.
- Net delta near zero — moves, not adds.

**APIs:** none. The refactor is internal to the webview; no Tauri command surface changes, no hub HTTP surface changes.

**Dependencies:** none new. No bundler, no transpiler, no test framework — same constraint as v0.9.5 and v0.9.6.

**Test infrastructure:**
- No automated UI tests exist (matches the constraint we accepted in v0.9.5/v0.9.6).
- **Manual click-through gate** before shipping: send a message in two rooms, run /usage in an embedded pane, fire a handoff (accept + decline + cancel + expire), trip a permission card, edit nutshell, reload settings, toggle terminal pane, kill an agent externally. Same scope as v0.9.8 §6.

**Risk assessment:**
- **[Medium]** Loading order is implicit — single typo in `index.html` and a global is undefined at load time. **Mitigation**: per-file header comment declaring dependencies (the convention `ui/kinds/handoff.js` already follows); manual click-through covers it; `bun x tsc --noEmit` catches some via JSDoc-typed `@ts-check` paths if we opt in (out of scope).
- **[Low]** Each extraction commits cleanly because main.js's responsibilities are weakly coupled — the eleven concerns share `BUS`/`AUTH_TOKEN`/`HUMAN_NAME`/`messagesEl`/etc. but otherwise call into each other through small surfaces.
- **[Low]** Symmetric to v0.9.5 (hub.ts) and v0.9.6 (CSS) — the pattern is proven; the extraction discipline transfers.

**Rollout:** single PR's worth of work, but landed as 12+ commits (one per extraction) so bisect locates any regression to a single moved chunk. Per-commit revert path stays open until the cleanup commit (header comment, removed dead globals).

**Out of scope (explicit):**
- Switching to ES modules / a bundler. Hard CLAUDE.md rule.
- Switching to TypeScript for the webview. Out of scope; possible future change.
- Refactoring `ui/usage.js`, `ui/kinds/*.js`, or styles — those are already extracted.
- Adding automated UI tests. Separate change; the manual gate stays the same.
- Changing element IDs, classes, or DOM structure. The DOM is the contract between modules; touching it would break the move-only discipline.
- Reorganizing CSS (already done in v0.9.6).
