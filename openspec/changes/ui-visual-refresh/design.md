## Context

v0.7 shipped the terminal pane and the Activity-Ledger idea was implicit — handoff/interrupt cards rendered inline in the chat column, distinguishable only by border accents. Users reported scanning the chat stream to find "what needs my attention," which is the exact signal a typed-protocol system should make trivial. A mockup on the user's desktop (`~/Desktop/a2achannel-redesign.html`) proposes a three-column layout that separates typed coordination from prose and re-skins the app in warm dark neutrals with a typographic hierarchy.

Constraints this design must respect:
- **Vanilla HTML/CSS/JS UI.** No React/Vue/Svelte, no bundler. CLAUDE.md hard rule.
- **CSP is `script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:`.** No Google Fonts CDN, no eval, no inline `<style>` larger than ad-hoc rules.
- **All v0.6+ behaviour must survive unchanged.** SSE wiring, roster dynamics, handoff/interrupt/nutshell lifecycles, composer behaviour, terminal PTY bridge, localStorage keys. The refresh is the visual layer.
- **No new external dependencies** — no CSS frameworks, no icon libraries loaded at runtime (inline SVG is fine).

## Goals / Non-Goals

**Goals:**
- Match the mockup's information architecture (three-column layout, header composition, nutshell strip, composer shape).
- Pull typed-coordination rendering (handoff cards, interrupt cards) into a dedicated left rail so "what needs me" is legible without scrolling.
- Establish a single set of CSS custom properties for palette/typography so future visual tweaks touch one place.
- Keep the diff to HTML/CSS plus a small, surgical `main.js` edit for ledger-versus-inline rendering.

**Non-Goals:**
- Light theme. Single warm-dark palette for this release.
- Switching UI frameworks. Still vanilla.
- Restructuring `main.js` beyond the minimum needed to drop ledger cards into a new container.
- Changing protocol data shapes or persistence.
- Renaming any `ui/fonts/` file that already ships (CaskaydiaMono can stay as fallback).

## Decisions

### 1. Two-column layout (no Activity Ledger rail)

**Decision:** Keep the v0.7.0 two-column layout: `.app-body` is a flex row, chat column on the left (full width when terminal pane is hidden; shares space via `--split` when it's on), terminal column on the right (toggleable), splitter between them. No separate Activity Ledger column.

**History:** An earlier draft of this design added a 280-px left rail hosting pending handoffs + interrupts grouped into "Needs you" / "In flight". It was prototyped and **rejected** on first review: the ledger duplicated every pending card (once inline in chat, once in the rail), which was more visual noise than signal. Typed-coordination rendering stays inline in the chat stream exactly as v0.7.0 already does.

**What survives from the prototype:**
- Compact-card styling (`.handoff-card.compact`) was removed.
- No ledger containers, no `reconcileLedger`, no second-pass rendering — `main.js` renders each handoff/interrupt exactly once, in chat, as it always has.
- The `+ agent` roster button lives; it dispatches a `CustomEvent('a2a:open-spawn')` that `terminal.js` handles.

### 3. Palette + typography tokens as CSS custom properties

**Decision:** Define all colours and font stacks as `:root` CSS variables. Palette matches the mockup's `#1a1714` warm-dark family with orange accent. Typography: Inter (sans/body), Fraunces (serif — brand, nutshell, pane titles), JetBrains Mono (identity, protocol text, code).

**Alternatives considered:**
- Tailwind-style utility classes — rejected. Requires bundler, contradicts CLAUDE.md rule.
- Inline styles for the refresh — rejected. External stylesheet (v0.6.1 post-hardening) was the whole point of CSP-friendly layout.
- Keep Catppuccin Mocha — rejected. The mockup is a different palette entirely; splicing would fail on both.

**Details:**
- Replace every `--ctp-*` variable reference with the new `--bg`, `--bg-raised`, `--bg-elev`, `--bg-inset`, `--line`, `--line-soft`, `--text`, `--text-muted`, `--text-dim`, plus accent tokens (`--orange`, `--amber`, `--green`, `--red`, `--blue`, `--purple`, `--pink`, `--teal`).
- Keep `--mono`, `--serif`, `--sans` as font-family tokens so xterm and xterm-adjacent surfaces (terminal pane) can reference `--mono` cleanly.
- Retain a single `.msg-avatar.a-<hash>` pattern — hash-derived avatar colour stays, palette values are drawn from the new tokens.

### 4. Fonts are vendored locally

**Decision:** Download Inter, Fraunces, JetBrains Mono WOFF2 files into `ui/fonts/` and reference them via `@font-face` with `src: url("fonts/<file>.woff2")`. No `<link>` to Google Fonts at runtime.

**Alternatives considered:**
- Google Fonts CDN — rejected. CSP `font-src 'self' data:` blocks it; adding `fonts.googleapis.com` + `fonts.gstatic.com` widens the attack surface and requires the app to have network connectivity at launch.
- System fonts only — rejected. The mockup's visual identity relies on Fraunces (serif italic) and Inter; system fallback is visually divergent.
- Use only Inter + JetBrains Mono (skip Fraunces) — rejected for the same reason. Fraunces carries the brand mark and nutshell strip.

**Details:**
- Include only the weights actually used: Inter 400/500/600, Fraunces 400/500 (regular + italic), JetBrains Mono 400/500/600.
- Total footprint: ~250 KB combined WOFF2. Acceptable versus the 60 MB Bun sidecar.
- Add a license note (OFL) in `ui/fonts/README.md` next to the CaskaydiaMono existing README.
- `@font-face` uses `font-display: swap` so the UI isn't blocked on font load.

### 5. Composer reshape without behavioural change

**Decision:** The composer becomes a flex row: mention selector pill (existing `<select id="target">` re-styled to look like a pill, or a new wrapper around it), flexible text input, icon actions (existing emoji + attach buttons re-skinned), orange Send button. Keyboard hints move to a footer strip below the composer.

**Alternatives considered:**
- Replace `<select>` with a custom dropdown — rejected. Native `<select>` is the correct accessible primitive and the existing JS assumes its `value`. Re-style with `appearance: none` + chevron.
- Put the mention selector inside the input as a pill-on-focus — rejected. Increases complexity; the mockup shows it to the left of the input.

**Details:**
- Re-style `#target` to look like a mention pill with `.mention-select` wrapper (existing ID preserved).
- Send button gets `background: var(--orange); color: var(--bg);`.
- Emoji + attach icons become `.c-btn` (36×36 warm-dark).
- Hints footer is text-only; `<kbd>` elements styled with a subtle border.

### 6. Header recomposition with zero ID churn

**Decision:** Every element the JS currently reads by ID keeps its ID. Existing structure: `#legend`, `#settings-btn`, `#reload-btn`, `#reveal-btn`, `#terminal-toggle-btn`, `#status-text`, `.dot#dot`. New structure wraps these in a new `.header-row` / `.roster` / `.status-cluster` structure but preserves the IDs as children.

**Alternatives considered:**
- Rename IDs to match the mockup class names (e.g. `#status-pill`) — rejected. Every rename is a bug-source in `main.js`; the value is zero.

**Details:**
- `#dot` + `#status-text` become children of `.status-pill` styled as the green pulsing pill from the mockup. Hub-disconnected state styles the pill red (reusing existing `.dot.error` class).
- `#legend` becomes the `.roster` container; each child `.legend-item` is re-styled as the mockup's `.agent` pill. Role label pulled from optional `config.json.agent_roles[name]`.
- `+ agent` button (`#add-agent-btn` — new ID) triggers the existing `+ New agent` terminal-pane spawn modal from `terminal.js`. Single source of truth for agent creation.

### 7. Nutshell strip is full-width between header and main

**Decision:** Move the existing `#nutshell` element from inside the chat column to between `<header>` and `.main`. DOM move, not a rewrite. Styling updates (orange accent, italic serif body) use new CSS; the existing `#nutshell-body`, `#nutshell-meta`, `#nutshell-edit-btn`, `#nutshell-editor` IDs stay.

**Details:**
- Full-width background gradient (orange tinted on the left fading to transparent) per the mockup.
- Nutshell hidden state (`display: none` when empty) unchanged.
- Edit modal (`#nutshell-editor`) unchanged.

### 8. Terminal pane re-skin

**Decision:** Keep all IDs (`#terminal-col`, `#terminal-tabs`, `#terminal-body`, `#splitter`) and class names (`.terminal-tab`, `.terminal-tab-new`, etc.). Re-style to the mockup's darker-inset aesthetic with underline-active tabs. `terminal.js` reads zero presentation details, so no JS change needed.

## Risks / Trade-offs

- **[Risk] Font load failure leaves the UI in a fallback stack that looks wildly off-brand.** → Mitigation: `font-display: swap` + carefully chosen fallbacks (Inter → -apple-system, Fraunces → Georgia, JetBrainsMono → Menlo). Acceptable-if-plain rather than broken.
- **[Risk] Renaming class names the agents or docs reference.** → Mitigation: every existing ID preserved; `main.js` / `terminal.js` selector audit in §4 task verifies no dangling references before we declare visual complete.
- **[Risk] Scroll behaviour regressions.** The three-column layout with one shared header means each column needs `overflow-y: auto; min-height: 0;` correctly. → Mitigation: smoke-test all three columns' scroll state under content overflow. Task item.
- **[Trade-off]** Chasing the mockup pixel-perfectly is not the goal — matching the *structure* and *token system* is. Minor pixel deltas are acceptable to avoid yak-shaving.

## Migration Plan

- No data migration. All ledger data, SSE state, localStorage keys are untouched.
- Users on v0.7.0 see the refresh on first launch of v0.7.1 (or whatever version tags this); no config file edits required.
- Rollback path: downgrade the `.app`; no persistent state was restructured.
- The optional `agent_roles` config field is additive — absent → no role labels; present → role shown next to the agent name in the roster.

## Open Questions

All three resolved.

1. **Nutshell handoffs in the ledger** — resolved: no special-casing. `[nutshell]`-prefixed handoffs targeting the human flow through the generic "Needs you" rendering path. This is a UI refresh, not a functionality rebuild.
2. **Avatar glyph choice** — resolved: first-letter initial, uppercase, on the hash-derived colour circle. One-line change in `renderAvatar`.
3. **Terminal pane default state** — resolved: keep default-hidden. Existing `localStorage.a2achannel_terminal_enabled` behaviour unchanged.

## Decision 9 (late): brand mark uses the app icon

**Decision:** The header brand mark is an inline simplified SVG matching the app icon (`icon.svg` at repo root): a rounded-rect speech bubble outlined in orange with three small dots in the palette colours (orange `#d97757`, amber `#e8a857`, green `#7fb069`) and a tail on the bottom-left. At 26×26 header size, the full Anthropic-Claude glyph trio from the icon file is illegible; the simplified dot form preserves the visual identity.

The `icon.svg` file is also the source of truth for the app bundle's icons. Regenerate `src-tauri/icons/*` (including `icon.icns`) from `icon.svg` via `bun x tauri icon icon.svg -o src-tauri/icons`.

**Alternatives considered:**
- Embed the full `icon.svg` (all three Claude glyphs) in the header — rejected. At 26px the glyphs are unrecognisable mush.
- Reference `icon.svg` via `<img src="icon.svg">` — rejected. Double request + separate colour model; inline SVG is already what v0.7 uses.
- Link to the generated `icon.icns` — rejected. Not a web-loadable format.
