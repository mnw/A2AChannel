## Why

The current v0.7 UI is functional but visually unremarkable — a single Catppuccin-Mocha-tinted chat column with inline handoff/interrupt cards, a terminal pane bolted on the right. A design mockup (`~/Desktop/a2achannel-redesign.html`) proposes a warm-neutral palette, typographic hierarchy (serif for branding/nutshell, mono for identity + protocol text, sans for body), and integrated roster/nutshell/status in the header. The goal is a visual refresh that changes the look without touching behaviour.

## What Changes

- **Two-column main layout preserved from v0.7.0.** Chat column on the left, optional terminal pane on the right, existing splitter behaviour unchanged. The mockup's three-column Activity Ledger rail was prototyped during implementation and **rejected** — it duplicated every pending handoff card (inline chat view + ledger view), which was more noise than value. Handoff and interrupt cards continue to render inline in the chat stream exactly as v0.7.0 did.
- **New palette.** Warm dark neutrals (`#1a1714` base, `#221d19` raised, `#2a231e` elevated) + orange accent (`#d97757`). Replaces Catppuccin Mocha variables wholesale.
- **New typography.** Inter (body sans), Fraunces (serif — brand, nutshell, pane titles), JetBrains Mono (identity, protocol, code). Fonts **vendored locally** under `ui/fonts/` — no Google Fonts CDN (CSP-bound, no bundler).
- **Header redesign.** Brand mark + wordmark + version/ledger-id meta, status pill ("N/M agents · hub :port"), icon-button cluster (MCP configs, settings, terminal toggle). Roster strip below, flex-wrapped, agent pills with coloured dot + name + role label. `+ agent` button inline.
- **Nutshell strip** full-width between header and main, orange-accent left gradient, italic serif body, "Edit" affordance on the right.
- **Chat column** gets day dividers, avatar circles with hash-derived colour + initial, message meta row (name · role · time), inline handoff/interrupt cards retained (styled to match ledger cards).
- **Composer** redesign: mention selector pill on the left, flexible input, icon actions, orange Send button. Keyboard hints footer.
- **Terminal pane** re-skinned but structurally unchanged — tab strip on top, active-tab underline, dot-state indicators, `×` close, `+` new.
- **Scrollbars restyled** (thin, warm-neutral).
- **Behaviour preserved**: SSE wiring, agent registration, roster dynamics, handoff/interrupt/nutshell lifecycles, composer keyboard behaviour (Enter/Shift+Enter/@mention popover), emoji picker, attachment flow, drop overlay, settings/reload modals, PTY IPC, xterm integration, localStorage keys. No HTML IDs removed without a same-purpose replacement.

## Capabilities

### New Capabilities
- `webview-chrome`: Layout, palette, typography, and visual affordances of the A2AChannel webview. Defines the three-column structure, header composition, nutshell strip, composer shape, and how typed-coordination primitives (handoffs, interrupts) render in the Activity Ledger versus inline in chat.

### Modified Capabilities
<!-- None. All protocol/behaviour specs (handoff, interrupt, nutshell, terminal-projection, attachment-upload, agent-onboarding, hub-*) stay unchanged — this change is visual-only. -->

## Impact

**Code:**
- `ui/index.html` — restructured DOM: header row (brand + status cluster + roster), nutshell strip between header and main, two-column `.app-body` (`.chat-col | .splitter | .terminal-col`). All IDs consumed by `main.js` / `terminal.js` preserved.
- `ui/style.css` — wholesale rewrite around new CSS custom properties (`--bg`, `--bg-raised`, `--bg-elev`, `--bg-inset`, `--line`, `--text`, `--text-muted`, `--text-dim`, `--orange`, `--amber`, `--green`, `--red`, `--blue`, `--purple`, `--pink`, `--teal`, `--mono`, `--serif`, `--sans`). Existing class names kept where semantically equivalent.
- `ui/main.js` — small edits only: fix a handful of inline `var(--ctp-*)` references to use the new tokens, update the status-pill text to `<N>/<M> agents · hub :<port>`, wire the new `+ agent` button (dispatches a `CustomEvent('a2a:open-spawn')` that `terminal.js` listens for). Everything else — SSE handlers, handoff/interrupt/nutshell lifecycle, composer logic, reconnection state — untouched.
- `ui/fonts/` — add `Inter-*.woff2`, `Fraunces-*.woff2`, `JetBrainsMono-*.woff2` (self-hosted; licenses: OFL). Existing CaskaydiaMono files can stay as a fallback or be removed in a follow-up.
- `ui/terminal.js` — only if class names change around `terminal-col` / `terminal-tabs` / `terminal-body`. If kept identical, no diff required.

**CSP:** No CSP change. Fonts are `'self'`; the refresh introduces no new external resources.

**Config:** Optional `agent_roles` field in `config.json` (object `{ "<agent-name>": "<short-label>" }`) for roster role hints. Absent → no role label shown. Non-breaking.

**Testing:** Manual — verify legend/handoff/interrupt lifecycles, nutshell edit flow, composer behaviour, terminal pane toggle + tab flow, dark-mode colour contrast, font fallback if fonts fail to load.

**Out of scope:**
- Light-mode theme switcher (palette is single-theme for v0.7.x).
- Restructuring `main.js`'s internals beyond the minimum needed to split inline-card rendering into ledger + chat.
- Changing the underlying chat log / SSE / ledger APIs.
- `docs/PROTOCOL.md` edits (protocol is unchanged).
