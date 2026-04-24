## Context

`ui/style.css` at 1916 lines is not the worst CSS imaginable — no `!important` abuse outside one legitimate `.visually-hidden` utility, no deep selector nesting, tokens exist. But three structural issues compound against future UI work:

1. **Three implementations of the same dropdown pattern** (~437 lines) diverge on every hover/focus tweak.
2. **Three card variants** share template structure but not code (~370 lines of parallel rules).
3. **Sections are chronological, not functional** — related rules for one pattern sit hundreds of lines apart.

Measured against v0.9.1:

```
1916 lines, 22 sections chronologically ordered

Dropdown triplication:
  L187   Custom room switcher         (66 lines)   ──┐
  L253   Spawn-modal room combo       (116 lines)  ──┼── same pattern
  L1151  Custom target dropdown       (255 lines)  ──┘

Card triplication:
  L752   Handoff cards                (115 lines)  ──┐
  L867   Interrupt cards              (88 lines)   ──┼── same structure
  L955   Permission cards             (168 lines)  ──┘

Token leakage:
  #4a3d34 × 11      (unpromoted shade)
  ~8 orange hexes   (perceptually similar)
  rgba(217,119,87,..) × 20+ with 6+ alpha values
```

v0.9.5 kind-runtime already plans per-kind CSS co-location (`ui/kinds/handoff.css`, etc.). v0.9.6 is the complementary piece: the non-kind portion of the stylesheet gets the same treatment, and the three duplication cases are consolidated.

Current constraints:
- macOS ARM64 only; Tauri webview (WKWebView).
- No UI bundler, no preprocessor. CSS is loaded via `<link>` tags in `ui/index.html`.
- `withGlobalTauri: true` — no build step exists or will be added.
- Vanilla HTML/CSS/JS is a hard rule (`CLAUDE.md`).
- v0.9.5 has shipped, so `ui/kinds/*.css` exists.

## Goals / Non-Goals

**Goals:**
- **Find-by-navigation, not grep.** A developer asking "where's the dropdown styling" opens `ui/styles/dropdown.css`. Same for cards, modals, header, terminal.
- **One truth per pattern.** The dropdown is defined once, not three times. Same for cards (with kind-specific extensions lifting off a shared base).
- **Token discipline.** Hardcoded color values <5 post-refactor, each justified. All orange variants name-reachable through tokens.
- **Zero visual regression.** Pixels unchanged, interactions unchanged. If a reviewer can spot a difference, the refactor failed.
- **Byte-identical DOM behavior.** No HTML class renames except where a consolidated primitive demands it; when it does, `ui/main.js` DOM construction updates in the same PR.

**Non-Goals:**
- Visual redesign. Same look, different file organization.
- JS component extraction (shared dropdown component in JS). CSS-only dedup here.
- Screenshot-diff test automation. Manual review is the gate.
- Accessibility improvements, keyboard shortcut changes, animation timing changes.
- Layout changes beyond the splits already implied by file extraction.
- Touching anything outside `ui/`.
- Changing how the dropdowns behave semantically (room picker still picks rooms, target dropdown still picks targets — the CSS primitive supports both via variant selectors, it doesn't merge their behaviors).

## Decisions

### 1. Semantic file split, not one-giant-file

**Decision:** Replace `ui/style.css` with `ui/styles/*.css` loaded individually via `<link>` tags in `ui/index.html`. Load order determines cascade resolution:

```
1. tokens.css         (CSS custom properties, @font-face)
2. reset.css          (base, .visually-hidden utility)
3. animations.css     (@keyframes — loaded early so any rule can reference)
4. layout.css         (app-body, two-column, splitter)
5. scrollbars.css     (global scrollbar styling)
6. dropdown.css       (shared primitive)
7. card.css           (shared primitive)
8. modals.css         (shared shell + variants)
9. header.css         (brand, nutshell, roster, usage pill — consumes dropdown for room switcher)
10. composer.css      (input, mentions, attachments — consumes dropdown for target)
11. chat.css          (messages, bubbles, drop overlay, toast)
12. terminal.css      (terminal col, tabs, kill modal)
13. kinds/handoff.css, interrupt.css, permission.css  (consume card)
```

**Anchor invariant:** "Shared primitives load before consumers. Kinds load last."

**Alternatives considered:**
- **Single `@import` file.** Rejected — `@import` in plain CSS serializes network fetches (minor; local in webview) and hides load order. `<link>` tags in `index.html` make the order reviewable.
- **Post-extraction bundler.** Rejected — violates CLAUDE.md "no bundler for UI." Also adds a build step that doesn't exist today and the project deliberately doesn't want.
- **Keep `style.css` as a concatenation.** Rejected — defeats the "find by navigation" goal. The single file is the problem.

### 2. Dropdown consolidation — one primitive, three variants via attributes

**Decision:** Define one `.dropdown` component in `dropdown.css` covering:
- Button / label / chevron structure.
- Popover list positioning, scrim, animation.
- Keyboard focus ring, `aria-expanded` state styling.
- Empty-state and disabled-state rules.

Feature-specific differences become variants via `data-variant` attribute on the root element:

```
.dropdown                      (base)
.dropdown[data-variant="target"]      (composer — full-width, empty="@ mentions")
.dropdown[data-variant="room"]        (header — compact, current-room indicator)
.dropdown[data-variant="spawn-room"]  (spawn modal — text input + picker, datalist-like)
```

Each variant block adds ~20–40 lines of overrides, not 60–250 lines of rebuilds.

**Total expected reduction:** 437 → ~220 lines (-50%).

**Why data attributes, not modifier classes (`.dropdown--target`)?** Both work. Data attributes pair naturally with how `ui/main.js` already sets these (the `target-dropdown` id is on the root element; the JS flips `aria-expanded` etc.). Using `data-variant` keeps the CSS/JS boundary clean: structural state in attributes, presentational state in classes.

**Constraint on this decision:** the three existing dropdowns must accept the new shared CSS without HTML rewrites, OR the HTML rewrites are bounded to `ui/main.js` and land in the same PR. An inspection pass on the DOM emitted by each dropdown's JS code is step 1 of the refactor.

### 3. Card consolidation — base + kind extensions

**Decision:** `card.css` defines the shared card skeleton:
- `.card` — frame, border, padding, grid.
- `.card-header`, `.card-body`, `.card-meta`, `.card-actions` — shared layout.
- `.card-status-badge`, `.card-replay-badge` — shared presentation.
- State modifiers: `.card--pending`, `.card--resolved`, `.card--terminal`.

Each kind's `ui/kinds/<kind>.css` file (already introduced in v0.9.5) declares only the extensions:
- **handoff.css**: `.card-countdown`, `.card-context` (collapsible details), decline-reason rendering.
- **interrupt.css**: text-weight emphasis, action-button shape.
- **permission.css**: `.card-input-preview` (monospace details block), dismiss-× button, sticky-at-top pending.

**Naming migration:** rules like `.handoff-card`, `.handoff-header` become `.card.card--handoff`, `.card-header` (inside an `.card--handoff` scope). This is the one place where HTML class attribute changes — `ui/main.js` card-DOM builders update in the same PR.

**Total expected reduction:** 371 → ~250 lines (-32%). Less dramatic than dropdowns because the three cards genuinely diverge more.

### 4. Token consolidation — promote, don't hardcode

**Decision:** Audit every hardcoded color against the token block. For each recurring value:
- If it's a brand color with alpha variants → add `--orange-bg`, `--orange-bg-soft`, `--orange-bg-hover` tokens (or use `color-mix(in oklab, var(--orange) N%, transparent)` where Safari WebView supports it — verify first).
- If it's a perceptually-identical-but-different hex → consolidate to one canonical value.
- If it's a one-off (theme accent for an isolated element) → leave it hardcoded with a `/* one-off: justification */` comment.

Target: <5 hardcoded hex values remain in the entire tree. Current count is ~25 distinct hexes.

**Alternatives considered:**
- **`color-mix()` everywhere.** Supported in Safari 16.2+; Tauri webview meets this. Preferred where alpha-on-brand is needed. Fall back to pre-computed `rgba()` as tokens if `color-mix` proves flaky in the local webview (verify in step 0 of implementation).
- **CSS custom properties for every color.** Slight readability cost at call sites (`var(--orange-hover)` vs `#e07a63`) but enormous consistency win. Token cost is one declaration per hue-tier; payoff is theming becomes possible later (if ever desired) without touching consumers.

### 5. Animations — one file, load early

**Decision:** All `@keyframes` declarations move to `animations.css`, loaded as the third `<link>` (after tokens and reset). Any feature file that references an animation by name relies on animations.css being loaded first.

Current state: keyframes at L1581, L1692, L1900 in style.css.

**Why load third:** tokens and reset are unconditional base layer. Animations frequently reference token values (e.g., `blink-border` references `--red`). Everything feature-specific loads after.

### 6. No HTML changes except where dropped by primitive consolidation

**Decision:** The only `ui/index.html` changes are:
- Adding `<link rel="stylesheet" href="styles/*.css">` entries in load order.
- Removing the existing `<link rel="stylesheet" href="style.css">` line (or keeping it pointing at a thin re-export stub during transition, then deleting in a follow-up).

The only `ui/main.js` changes are:
- Class-name updates in card-DOM builders (`.handoff-card` → `.card.card--handoff`) as part of decision 3.
- If any dropdown's emitted DOM doesn't match the new `.dropdown[data-variant=…]` contract, the minimum rewrite to conform. Not a rewrite of the dropdown behavior — just class/attribute alignment.

Nothing else in `ui/main.js` is touched. No hub changes, no channel changes, no Rust changes.

### 7. Rollout and rollback

**Decision:** Single PR. No feature flag — CSS refactors don't benefit from flags, they benefit from eyes on the diff.

**Gate:** human visual review of the 12 states enumerated in the proposal. The reviewer's job is to spot any pixel-level difference and either accept it (with justification) or reject the PR. A review checklist lives in the PR description.

**Rollback:** revert the PR. The new `ui/styles/` files can stay in the tree harmlessly (they're not `<link>`ed after revert); follow-up cleanup if desired. The `style.css` monolith reappears as it was.

### 8. Screenshot-diff infrastructure — explicitly deferred

**Decision:** Do not introduce visual regression testing as part of v0.9.6. It is its own concern with its own failure modes (golden-image staleness, flaky in CI, etc.) and bundling it would recreate the "two failure modes in one PR" trap v0.9.6 was split from v0.9.5 specifically to avoid.

A future change could introduce Playwright or similar against the built `.app`'s webview. Out of scope here.

## Risks / Trade-offs

**[Risk] Dropdown consolidation breaks a subtle ARIA interaction.** The three dropdowns have slightly different keyboard behaviors today (tab order, escape handling, click-outside). Merging them without testing means the room switcher might lose a keystroke the target dropdown didn't care about.
**Mitigation:** Step 1 of the implementation is a DOM+interaction audit of all three dropdowns side-by-side, documented as a table of behaviors. The consolidated primitive supports the union; per-variant behaviors are documented as intentional and kept.

**[Risk] `color-mix()` inconsistent in the Tauri webview.** Safari 16.2+ supports it, but quirks exist.
**Mitigation:** Step 0 of implementation: probe `color-mix` in the actual Tauri webview on a dev build. If it flakes, fall back to precomputed `rgba()` tokens. No functional difference; just two extra tokens per alpha variant.

**[Risk] Load order in `<link>` tags vs runtime cascade surprises.** CSS from later `<link>` tags overrides earlier ones at equal specificity. If two files unintentionally define the same selector, the last-loaded wins.
**Mitigation:** Linting step during implementation — after each file extract, diff computed styles on a key element (e.g., `.handoff-card`) before and after. Discrepancies fail the step.

**[Risk] Token audit breaks something that depended on a hardcoded value.** A `box-shadow` using a specific hex might get consolidated to a token, and the resulting color is subtly different.
**Mitigation:** Visual review gate catches it. The promotion criterion is "perceptually identical within 2 deltaE" — differences smaller than the human eye threshold.

**[Risk] HTML class renames in `ui/main.js` break something subtle.** E.g., a CSS selector for `.handoff-card` somewhere we missed.
**Mitigation:** Grep-based audit — find every reference to `.handoff-card`, `.interrupt-card`, `.permission-card` across `ui/`, `hub/`, and `src-tauri/`. Should be small (<10). Update all or revert the rename.

**[Trade-off] File count increases.** `ui/style.css` → ~13 files in `ui/styles/` + 3 in `ui/kinds/`. More files to navigate. Mitigated by the semantic split meaning you go directly to the one you want.

**[Trade-off] Variant-as-data-attribute vs modifier-class.** Style goes either way. Picked data-variant for JS/CSS boundary cleanliness; happy to revisit if consensus disagrees.

## Migration Plan

**Implementation order:**
1. **Probe step.** Verify `color-mix(in oklab, ...)` works in the Tauri webview. Run a one-off test build. If yes, use it; if no, precomputed rgba tokens.
2. **Create `ui/styles/` directory structure empty.** Add one `<link>` per file to `ui/index.html`, before the existing `style.css` link, so both load. CSS is additive; adding empty files changes nothing.
3. **Extract by section, bottom-up.** Move sections from `style.css` into their new homes one at a time. After each move, visually verify the app looks identical. Commit per file.
4. **Extract keyframes** into `animations.css`. Verify animations still fire (card blink, tab attention, sparkle-spin).
5. **Dropdown audit.** DOM + interaction table for room switcher, spawn-combo, target dropdown. Document behavior union.
6. **Consolidate dropdown.** Write `dropdown.css`. Update `ui/main.js` DOM builders to emit the `[data-variant]` contract. Delete the three old dropdown sections. Visual + interaction review.
7. **Consolidate card.** Write `card.css`. Update `ui/main.js` card builders (`.handoff-card` → `.card.card--handoff`). Shrink `ui/kinds/*.css` to extensions only. Visual review.
8. **Token audit.** Grep hardcoded hexes + rgba patterns. Promote frequent ones to tokens. Replace call sites. Verify computed colors match pre-refactor within tolerance.
9. **Delete `ui/style.css`** (or leave a stub re-export for a cycle). Remove its `<link>` from `ui/index.html`.
10. **Full visual review** of the 12 states. PR description includes before/after screenshots.
11. **Ship.**

**No hub changes, no sidecar rebuild needed.** CSS-only. `./scripts/install.sh` for a webview cache bust during dev; the installed app picks up changes on next open.

**Rollback:** single PR revert. Files in `ui/styles/` stay as orphans; remove in a follow-up cleanup.

## Open Questions

1. **Does `color-mix()` work reliably in the Tauri webview?** **Resolved 2026-04-24:** use `color-mix(in oklab, ...)`. The Tauri shell targets macOS ARM64 only (per `CLAUDE.md`); that surface is WKWebView on macOS 13+, which ships Safari 16.2+, which supports `color-mix()` reliably. No empirical flake observed across 10+ dev builds today. Fallback to pre-computed rgba tokens only if a future macOS regression surfaces.
2. **Class rename: `.handoff-card` → `.card.card--handoff`, or keep `.handoff-card` as an alias?** The alias means zero HTML/JS change but loses the conceptual consolidation. Recommend full rename; alias-for-transition is a hedge we don't need given the PR is atomic.
3. **Should `ui/main.js` dropdown builders also consolidate at the JS level?** Out of scope. v0.9.6 is CSS-only. A follow-up could introduce a shared dropdown JS helper; CSS dedup gets ~60% of the wins regardless.
4. **Do we ship screenshot-diff infrastructure now or later?** Later — explicitly out of scope. The manual review gate is enough for this one refactor.
5. **Tokens for spacing and radii, not just colors?** Current style.css hardcodes `padding: 11px 12px` and `border-radius: 6px` in many places. Tempting to tokenize. Recommend deferring — a style system redesign is its own project. v0.9.6 stays focused on what's duplicated today.
