## Context

`ui/main.js` (1652 lines) and `ui/terminal.js` (888 lines) are the last two large monoliths in the webview. Both grew organically as features landed (rooms in v0.9, copy buttons + room refocus in v0.9.9, banner scrape in v0.9.9, etc.). Eleven distinct responsibilities now share one file: HTTP, room filter, roster + presence, message rendering, composer, @mention autocomplete, emoji picker, attachments, nutshell strip, MCP modal, and the orchestrator.

Pre-v0.9.5 hub.ts had the same shape (2742 lines, mixed concerns) and got broken into `core/` primitives + `kinds/` state machines + standalone modules (`chat.ts`, `nutshell.ts`, etc.). The refactor stuck and the kind-runtime contract enabled cleaner subsequent work. CSS got the same treatment in v0.9.6 (`ui/styles/*.css` for foundations + `ui/kinds/*.css` for kind-specific chrome). This change applies the same discipline to webview JS.

Constraints (from CLAUDE.md and the repo's baseline):
- macOS ARM64 only.
- **No bundler for the UI.** Hard rule. Files load as classic `<script src=…>` tags. Shared lexical scope between modules — no `import`/`export`.
- No transpilation, no JSX, no React.
- `withGlobalTauri: true` so modules can call `window.__TAURI__.core.invoke(…)` directly.
- No automated UI tests exist; manual click-through is the QA gate.

## Goals / Non-Goals

**Goals:**
- Each module owns one clear responsibility, file size under ~250 lines.
- `ui/main.js` becomes the orchestrator only: bootstrap, SSE event dispatch, top-level loaders.
- `ui/terminal.js` keeps the terminal-pane orchestration but offloads PTY adapters, spawn modal, and byte-stream scanners to siblings.
- Load order in `index.html` is explicit, documented, and auditable.
- Behavior delta is **zero**. Manual click-through covers the regression risk envelope.

**Non-Goals:**
- Switching to a module system or bundler. Out of scope by hard rule.
- TypeScript for the webview. Possible future change; not this one.
- Reorganizing CSS or `ui/kinds/*.js` (already extracted in v0.9.6).
- Adding automated UI tests. Separate change.
- Changing the DOM structure (element IDs, classes, or hierarchy) — the DOM is the contract that lets modules find each other.

## Decisions

### 1. Classic scripts with shared lexical scope, not ES modules

**Decision:** Each new module is a classic `<script src=…>` loaded in `index.html`, sharing globals with all earlier-loaded modules. No `import`/`export`. No bundler.

**Rationale:**
- CLAUDE.md hard rule prohibits bundlers in the UI. The constraint is intentional: keeps the dev loop fast (no build step), keeps the dist path predictable (one HTML, plain JS), and keeps the tooling surface zero.
- The pattern already works in `ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js`, `ui/usage.js`, and `ui/terminal.js` — so extending it is mechanical.
- Tests of "does this load order produce a working page" are manual click-through, same as v0.9.6.

**Alternatives considered:**
- **ES modules (`<script type="module">`)** — rejected. Adds CORS friction with Tauri's webview, breaks the simple `withGlobalTauri` contract, and contradicts the bundler-free policy CLAUDE.md spells out.
- **A tiny bundler (esbuild, rolldown)** — rejected. Same hard-rule conflict; the existing UI builds cleanly without one and we want to keep that.

### 2. Per-file header comment block declares dependencies

**Decision:** Every extracted file opens with a comment block in the same shape `ui/kinds/handoff.js` uses today:

```js
// rooms.js — room switcher + menu + filter + pause/resume.
// Depends on (declared earlier): SELECTED_ROOM, ROOM_ALL, knownAgents (from
//   roster.js), authedFetch, addMessage, askReason, HUMAN_NAME.
// Exposes: applyRoomFilter, fireRoomInterrupt, renderRoomSwitcher, renderRoomMenu.
```

**Rationale:**
- Without ES module imports, dependencies are implicit. The header turns implicit into auditable.
- A regression "X is undefined" is fast to root-cause: read X's owner file's header, walk back through load order.
- Matches the existing convention in `ui/kinds/*.js`.

### 3. Single-IIFE-per-file is preserved where it already exists

**Decision:** `ui/usage.js` and `ui/terminal.js` are both wrapped in IIFEs that expose a small surface to `window.A2A_*`. Continue that pattern for any module that genuinely needs internal state isolation. For modules whose entire content already lives in the global lexical scope (chat-row rendering, escape helpers, room filter), don't wrap — that would just churn diff lines.

**Rationale:**
- The IIFE wrapper buys encapsulation. Most modules don't need it (they're already calling globals declared by main.js).
- Wrapping everything would require defining `window.A2A_*` shims for every helper, adding lines without value.

### 4. Three-tier load order

**Decision:** Scripts in `index.html` load in three tiers, separated by section comments:

```html
<!-- Tier 1: foundations (zero deps, pure or window-only) -->
<script src="state.js"></script>
<script src="text.js"></script>
<script src="http.js"></script>

<!-- Tier 2: feature modules (depend on tier 1) -->
<script src="messages.js"></script>
<script src="roster.js"></script>
<script src="rooms.js"></script>
<script src="nutshell.js"></script>
<script src="mentions.js"></script>
<script src="emoji.js"></script>
<script src="attachments.js"></script>
<script src="composer.js"></script>
<script src="mcp-modal.js"></script>

<!-- Tier 3: orchestrators + kinds + pill + terminal -->
<script src="main.js"></script>
<script src="usage.js"></script>
<script src="kinds/handoff.js"></script>
<script src="kinds/interrupt.js"></script>
<script src="kinds/permission.js"></script>
<script src="terminal/pty.js"></script>
<script src="terminal/banner-scan.js"></script>
<script src="terminal/spawn-modal.js"></script>
<script src="terminal.js"></script>
```

**Rationale:**
- Tiers communicate intent: "if this is a primitive, it goes in tier 1; if it depends on primitives, tier 2; if it orchestrates, tier 3."
- Within a tier, alphabetical or cohesion-based ordering is fine (no inter-tier-2 dependencies).
- main.js loads at the head of tier 3 so it can call into all earlier modules.

### 5. Element handles live in `state.js`

**Decision:** `messagesEl`, `legendEl`, `targetEl`, `nutshellEl`, etc. — DOM lookups via `document.getElementById('…')` — all move into `state.js` so any module can reference them by name.

**Rationale:**
- These handles are stable across the app's lifetime (DOM is built once at HTML parse).
- Today they're scattered through main.js based on where they happen to be first used; centralizing them removes the "is this declared yet?" guessing game.
- A future test harness or DOM-rebuild path would have one place to refresh these.

**Trade-off:** state.js becomes a "header file" of sorts. It's the largest of the foundation tier (~80 lines). Acceptable — it's still 20× smaller than today's main.js.

### 6. Handler wiring stays adjacent to the module that defines the handlers

**Decision:** `sendBtn.addEventListener('click', send)` lives in `composer.js` (where `send` is defined), not in `main.js`. Same for legend remove buttons (in roster.js), nutshell editor buttons (in nutshell.js), MCP modal buttons (in mcp-modal.js).

**Rationale:**
- Co-locating handler + wiring with the function that handles the event makes each module self-contained.
- main.js shrinks dramatically because it stops being the "everywhere we wire DOM" file.
- Today's main.js already mixes definition and wiring at the same point — this is just preserving the proximity while moving the pair to its module.

### 7. Order of extraction: leaves first, root last

**Decision:** Extract in the order proposed in §3 of tasks.md — pure helpers (text.js) first, then HTTP, then renderers, then orchestrator. main.js shrinks last.

**Rationale:**
- Each commit is independently verifiable and revertable.
- Bisect localizes any regression to a single moved chunk.
- Mirrors the v0.9.5 hub.ts extraction sequence (which worked).

**Alternatives considered:**
- **Big-bang split into all 12 files in one commit.** Rejected — un-bisectable; if the click-through reveals a regression, you have to inspect 1500+ moved lines.
- **Split by feature instead of responsibility.** Rejected — feature boundaries don't align with file size targets and would leave room/roster tangled.

### 8. terminal.js keeps its IIFE; sibling files extend it

**Decision:** `ui/terminal.js` already wraps everything in `(function terminalPane() { … })()`. The three extractions move OUT of that IIFE into sibling files, so they need to expose their surface via `window.__A2A_TERM__` (or similar). The IIFE in terminal.js then reads from that shared namespace.

**Rationale:**
- Today `terminal.js` is the only IIFE-wrapped UI file with substantial logic. Reaching across the IIFE boundary requires a window-level shim, same approach `ui/usage.js` uses (`window.A2A_USAGE.captureBanner`).
- Keeps terminal.js's existing encapsulation; doesn't break the working pattern.

## Risks / Trade-offs

**[Risk] Loading order is implicit and the wrong order silently breaks the app.**
**Mitigation:** Per-file header comment declares dependencies. Manual click-through catches any "X is undefined" at boot. The three-tier section structure in `index.html` makes accidental tier-violations stand out on PR review.

**[Risk] Move-only refactor over 1500+ lines without tests = surface area for accidental drops.**
**Mitigation:** Each commit is one extraction. Per-commit `git diff --stat` shows roughly equal `+` and `−` line counts (move, not rewrite). Hub-side tests still pass after every commit (54+ tests today). Manual click-through after each non-trivial commit.

**[Risk] Some helpers are called from many places; the module declaring it has to load before all callers.**
**Mitigation:** Tier 1 holds the most-shared helpers (text utilities, HTTP, state). Anything in tier 2 can freely use tier 1. Within tier 2, modules that depend on each other (composer → mentions, attachments) load in dependency order.

**[Risk] terminal.js's IIFE-wrapped state means extracted siblings can't reach across.**
**Mitigation:** `window.__A2A_TERM__` shim, same shape `window.A2A_USAGE` uses. Adds a few lines of glue per cross-call.

**[Trade-off] More files, more `<script>` tags. Larger HTTP cost on first load.**
**Rationale:** Tauri serves from local resources at near-zero latency. The cost is invisible. Long-term maintenance benefit dwarfs it.

**[Trade-off] Per-file header comments duplicate information that ES modules' import statements would carry.**
**Rationale:** Acceptable cost of the no-bundler constraint. The comments are short (3–5 lines) and only need updating when dependencies actually change.

## Migration Plan

**Implementation order** (each step is a commit):

1. **Extract `text.js`** — escHtml, escAttr, escRegex, linkify, highlightMentions, parseMentions. Pure functions, zero behavior risk. Click-through: send a message, see linkify and @mention rendering still work.
2. **Extract `state.js`** — globals + element handles + tiny helpers (`cap`, `shade`, `cssName`). Click-through: app boots without ReferenceError.
3. **Extract `http.js`** — authedFetch, parseErrorBody, withToken, imgUrl. Click-through: roster loads, /usage poll works, image attachments render.
4. **Extract `messages.js`** — addMessage, attachment HTML, image zoom, copy buttons, copy toast, trimMessages, getPermissionStack. Click-through: chat scrolls, copy buttons work, permission stack still pins to top.
5. **Extract `nutshell.js`** — applyNutshell, renderNutshell, editor open/close/submit, updateCountdownLabel. Click-through: nutshell strip + editor works; handoff card countdowns tick.
6. **Extract `mcp-modal.js`** — Tail of file, lowest coupling. Click-through: open MCP modal, copy snippet, close.
7. **Extract `roster.js`** — applyRoster, applyPresence, markAllOffline, renderLegend, renderTargetDropdown, renderTargetMenu. Click-through: roster pills + target menu reflect agents joining/leaving.
8. **Extract `rooms.js`** — room switcher, room menu, applyRoomFilter, fireRoomInterrupt, pause/resume. Click-through: switch rooms; legend filters; pause/resume buttons enabled per room.
9. **Extract `attachments.js` → `mentions.js` → `emoji.js` → `composer.js`** (composer family). Click-through: paste an image, drag-drop, @-autocomplete, emoji picker, send.
10. **Extract `terminal/pty.js`** — Tauri-invoke wrappers. Click-through: spawn an agent, write keystrokes, resize, kill.
11. **Extract `terminal/banner-scan.js`** — maybeFlagAttention, maybeAutoDismissDevChannels. Click-through: spawn an agent, see attention flag work, see dev-channels prompt auto-dismiss.
12. **Extract `terminal/spawn-modal.js`** — modal open/close, room picker, handle-launch. Click-through: spawn modal opens, room picker works, agent launches.
13. **Final cleanup commit** — collapse main.js to the bootstrap shell; verify all `<script>` tags in index.html match the module list; ship.

**Rollback:** per-commit. The first 12 commits are independent extractions; the cleanup commit can be reverted to roll back to "all old code still in main.js plus 12 new files of dead code." Not pretty but bisectable.

## Open Questions

1. **Should we adopt JSDoc `@ts-check` headers per module?** Would let `bun x tsc --noEmit` catch type drift even without a TS migration. **Leaning yes** for the foundation tier (text.js, http.js, state.js), **no** for renderers (the DOM-handle types would be noisy). Defer the decision; can layer in later without affecting this change.

2. **`window.__A2A_TERM__` vs. multiple smaller globals.** Either works; the namespace is cleaner. Going with `window.__A2A_TERM__ = { pty: {…}, scan: {…}, modal: {…} }` mirroring the file structure.

3. **Should `bootstrap()` move out of main.js?** It's the boot entry. Lives in main.js as the orchestrator's job. No move.

4. **Element handles in state.js — what if a future feature dynamically adds an element?** Add a `lookupEl(id)` helper that does a fresh `document.getElementById` and warns if missing; modules can use it for late-arriving elements. Out of scope for this change; just write a comment in state.js noting the convention.

5. **Should terminal.js's IIFE be kept or unwrapped?** **Kept.** Unwrapping would force every helper inside it to become a named global, polluting the page namespace. The shim approach (`window.__A2A_TERM__`) is cheaper.
