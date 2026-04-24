## Why

`ui/style.css` is 1916 lines across 22 chronologically-ordered sections with three near-identical implementations of the same pattern. Measured today against v0.9.1:

- **~437 lines of dropdown duplication.** The room switcher (L187, 66 lines), spawn-modal room combo (L253, 116 lines), and composer target dropdown (L1151, 255 lines) all implement "label + chevron + popover list + keyboard nav" from scratch. Tweaking hover/focus on one drifts the others.
- **~370 lines of card duplication.** `.handoff-*`, `.interrupt-*`, `.permission-*` each rebuild `-card`, `-header`, `-body`, `-meta`, `-actions`, `-status-badge`, `-replay-badge` instead of composing from a shared base.
- **Color tokens exist but leak.** 59-line token block at L19 defines the palette, yet `#4a3d34` appears 11 times (unpromoted shade), ~8 orange-adjacent hexes differ by perceptual noise, and `rgba(217, 119, 87, …)` appears 20+ times with 6+ alpha values that should be named.
- **Sections are chronological, not functional.** The "Custom room switcher" sits at L187; its structural sibling "Custom target dropdown" sits ~1000 lines away at L1151. Keyframes are split across L1581, L1692, and L1900.

None of these are correctness bugs — no `!important` abuse, no deep selector nesting, no visible regressions. But every CSS edit today risks drifting one of three copies of the same pattern, and finding "where's the dropdown styling" requires grep rather than file navigation. v0.9.5 already plans per-kind CSS co-location for the three cards; v0.9.6 captures the equivalent cleanup for the rest of the stylesheet and consolidates the duplicated patterns so future UI features compose instead of copy.

This is deliberately scoped **after** v0.9.5 kind-runtime ships. v0.9.5 is a JS/TS logic refactor gated by tests; v0.9.6 is a visual refactor gated by eyes. Bundling them means every review question becomes "is this a kind-runtime bug or a CSS bug?" Separating them keeps each reviewer's attention on one failure mode.

## What Changes

- **Split `ui/style.css` into a `ui/styles/` directory of semantic files** loaded via `<link>` from `ui/index.html`. Top-level `style.css` becomes a thin re-export (or is deleted entirely) — no bundler, no build step, just separate files served by the Tauri webview.
- **Consolidate the three dropdown implementations** into one `.dropdown` base class + variant data attributes. The room switcher, spawn-modal combo, and composer target dropdown all render through the same CSS contract; feature-specific overrides (width, anchor, empty-state text) become variant blocks, not rewrites.
- **Consolidate the card pattern** into a shared `.card` base + per-kind CSS files. Handoff, interrupt, and permission cards share `card`, `card-header`, `card-body`, `card-meta`, `card-actions`, `card-status-badge`, `card-replay-badge`. Kind-specific extensions (countdown, context-details, input-preview, dismiss button) live in `ui/kinds/<kind>.css` (already planned by v0.9.5).
- **Audit hardcoded colors and promote to tokens.** Target: <5 hardcoded hex values remain post-refactor, each justified by a comment. The orange-hover family, the `#4a3d34` soft-line shade, and the orange-with-alpha variants all gain token names.
- **Consolidate animation keyframes** into a single `animations.css`. No more hunting across three file regions.
- **UI JS per-kind module split** (inherited from v0.9.5 §10.1 + §10.4). `ui/main.js` switches to `<script type="module">`; per-kind `renderCard` / `buildDom` / `updateDom` / `handleAction` handlers move into `ui/kinds/<kind>.js` behind a four-export contract that mirrors the CSS per-kind files already in place. Event dispatcher in `ui/main.js` becomes a registry lookup (`KIND_MODULES[kind].renderCard(snapshot)`), matching the hub-side `KINDS` array. Adding a UI kind becomes one module + one line — the same "drop one file" ergonomic v0.9.5 landed server-side.
- **Design unchanged.** Visual output is byte-identical where possible; token consolidation may collapse 1–2 px perceptual differences that nobody was relying on. Only HTML change is the `<script type="module">` switch + the `<link>` list for the new CSS files.

## Capabilities

### New Capabilities

- `ui-styling`: the structural organization of `ui/styles/` (token file, shared primitives, per-surface files, animation file) and the shared primitives (`dropdown`, `card`, modal shell) that compose the A2AChannel UI. Governs how future UI surfaces are added without re-expanding the monolithic stylesheet.

### Modified Capabilities

None. User-visible behavior (pixels on screen, keyboard interactions, accessibility affordances) is unchanged. This is an implementation refactor; no spec-level requirements move.

## Impact

**Code:**
- `ui/style.css` — 1916 lines → ~50 (re-export shell) or deleted.
- `ui/styles/tokens.css` — new, consolidates design tokens + token-bound color helpers + `@font-face` declarations (~80 lines).
- `ui/styles/reset.css` — new, base reset + `.visually-hidden` utility (~20 lines).
- `ui/styles/layout.css` — new, app-body two-column layout, splitter (~60 lines).
- `ui/styles/header.css` — new, brand, nutshell strip, roster, usage pill (~200 lines).
- `ui/styles/composer.css` — new, message input, @mentions, attachment row (~120 lines).
- `ui/styles/chat.css` — new, messages column, msg bubbles, drop overlay, copy toast (~180 lines).
- `ui/styles/terminal.css` — new, terminal col, tab rail, kill confirm (~260 lines).
- `ui/styles/modals.css` — new, shared modal shell + spawn/reason/confirm variants (~180 lines).
- `ui/styles/dropdown.css` — new, consolidated dropdown primitive (~150 lines; replaces ~437 lines of triplicate).
- `ui/styles/card.css` — new, shared card primitive (~120 lines; pairs with v0.9.5 per-kind files).
- `ui/styles/animations.css` — new, all `@keyframes` (~40 lines).
- `ui/styles/scrollbars.css` — new (~20 lines).
- `ui/kinds/handoff.css`, `ui/kinds/interrupt.css`, `ui/kinds/permission.css` — pre-existing from v0.9.5; shrink to kind-specific extensions only (~40-90 lines each, down from 88-168 inline today).
- `ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js` — **new, inherited from v0.9.5 §10.1**. Each exports `renderCard`, `buildDom`, `updateDom`, `handleAction`. Pulls ~500–800 lines out of `ui/main.js` per kind; `main.js` shrinks + dispatches through a `KIND_MODULES` registry.
- `ui/main.js` — event dispatcher rewrite: switch/if-chain on `kind` replaced with registry lookup. Net line delta probably −200 to −400 after the per-kind extraction.
- `ui/index.html` — add `<link rel="stylesheet">` entries for each file in load order (tokens → reset → layout → primitives → feature files → kinds → animations). Change `<script src="main.js">` → `<script type="module" src="main.js">`.

**Estimated total:** 1916 lines → ~1400 (-27%). Dropdown dedup accounts for ~280 lines of the loss; card dedup ~120 lines; color token consolidation ~50 lines.

**APIs:** none affected. CSS only.

**Dependencies:** none new. Still no bundler, no preprocessor.

**Migration:** file split only; no runtime behavior change. Visual regression is the only failure mode. Rollback is a single-file revert of `ui/index.html`'s `<link>` list (files in `ui/styles/` stay in the repo harmlessly).

**Prerequisites:**
- v0.9.5 `v095-kind-runtime` complete and shipped. v0.9.5 introduces `ui/kinds/<kind>.css` — v0.9.6 assumes those files exist and shrinks them to kind-specific extensions only.

**Rollout:** single PR. Visual regression gate: before/after screenshots of the 12 UI states (idle chat, message with attachment, each of the three cards pending/resolved, spawn modal, kill confirm, reason modal, room switcher open, target dropdown open, terminal tab active, nutshell editing). Human-eye diff. No automated visual test infrastructure in v0.9.6 — that would be its own change.

**Out of scope (explicit):**
- Visual redesign of any kind. Same pixels, different file organization.
- Dropdown JS component extraction (`ui/components/dropdown.js`). Per-kind JS module split (cards) IS in scope via the v0.9.5 inheritance; dropdown/modal-level JS component extraction stays a follow-up.
- Screenshot-diff test infrastructure.
- Layout changes, accessibility improvements, keyboard shortcut changes.
- Rust-side or hub-side anything.
