## 0. Scope change — Activity Ledger dropped

The three-column layout with an Activity Ledger rail was prototyped during implementation and **rejected** on first visual review. Reason: the ledger rendered every pending handoff twice (once inline in chat, once in the rail) which was duplication, not clarity. All ledger-specific code was reverted before release:

- `.ledger-col` DOM block removed from `ui/index.html`
- Activity-Ledger CSS block removed from `ui/style.css`
- `reconcileLedger()`, `buildCompactHandoffCard`, `buildCompactInterruptCard`, ledger element refs, and the four `reconcileLedger()` call sites removed from `ui/main.js`
- `.app-body` kept on the v0.7.0 two-column flex layout (`chat-col | splitter | terminal-col`)

Subtasks in §2 and §4 that built the ledger UI were completed-then-reverted. They remain checked below to reflect "this code was written, reviewed, and dropped."

## 1. Font vendoring

- [x] 1.1 Download Inter 400/500/600, Fraunces 400/500 (regular + italic), JetBrains Mono 400/500/600 WOFF2 files. Place under `ui/fonts/`. Use Google Fonts' direct WOFF2 URLs or fontsource.org.
- [x] 1.2 Update `ui/fonts/README.md` (or create one) noting the SIL Open Font License for the three families and the exact filenames + versions.
- [x] 1.3 Verify each file loads (non-zero size, valid WOFF2 magic bytes `wOF2`).

## 2. Stylesheet rewrite (ui/style.css)

- [x] 2.1 Replace the `:root` block. Define all new palette tokens (`--bg`, `--bg-raised`, `--bg-elev`, `--bg-inset`, `--line`, `--line-soft`, `--text`, `--text-muted`, `--text-dim`, `--orange`, `--orange-soft`, `--amber`, `--green`, `--red`, `--blue`, `--purple`, `--pink`, `--teal`) and typography tokens (`--mono`, `--serif`, `--sans`). Keep the Catppuccin `--ctp-*` variables as an ALIAS layer during migration — set each `--ctp-<name>: var(--<equivalent>)` so unmigrated rules still resolve. Remove the alias layer in §2.8 once migration is verified.
- [x] 2.2 Replace `@font-face` declarations with the new Inter/Fraunces/JetBrainsMono families loading from `ui/fonts/*.woff2`. Keep CaskaydiaMono as an optional fallback or delete — decide in §2.8.
- [x] 2.3 Base reset and body rules: `body { font-family: var(--sans); font-size: 13px; line-height: 1.55; background: var(--bg); color: var(--text); }`. Set `html, body { height: 100%; }` and flex column.
- [x] 2.4 Titlebar (optional decorative row). If keeping: 38px tall, warm-dark gradient, traffic lights on the left, center title in mono. If Tauri uses a native title bar already, skip this and mark the task N/A.
- [x] 2.5 Header: `.header`, `.header-row`, `.brand`, `.brand-mark`, `.brand-name` (serif with italic `<i>` accent for the `Channel` wordmark), `.brand-meta` (mono small-caps). `.status-cluster`, `.status-pill` (green pulsing dot from CSS keyframes), `.icon-btn` (30×30 warm). `.brand-mark` contains an inline simplified SVG matching the app icon: rounded-rect speech bubble in `url(#orangeStroke)` with three dots (orange `#d97757`, amber `#e8a857`, green `#7fb069`) and a bottom-left tail. All referenced by existing IDs `#settings-btn`, `#reload-btn`, `#reveal-btn`, `#terminal-toggle-btn`, `#status-text`, `#dot`.
- [x] 2.6 Roster: `.roster`, `.roster-label` (small-caps mono), `.agent` pill (dot + name + optional role), `.agent.you` (orange-tinted), `.agent.active` (soft orange ring). `.agent-dot` with hash-derived colour via inline `style="background: <color>"`. `.add-agent` dashed-border pill.
- [x] 2.7 Nutshell strip: full-width below header, `linear-gradient(90deg, rgba(orange, 0.06) 0%, transparent 60%)`, `.nutshell-tag`, `.nutshell-text` (serif italic), `.nutshell-meta`, `.nutshell-edit` button. Preserve existing IDs.
- [x] 2.8 Main three-column grid. `.main { display: grid; grid-template-columns: 280px 1fr 1fr; flex: 1; min-height: 0; }`. `body.no-terminal .main { grid-template-columns: 280px 1fr; }`. Each column has `min-height: 0; overflow: hidden` for scroll behaviour. Remove Catppuccin alias layer (from §2.1) and confirm no `--ctp-*` reference remains.
- [x] 2.9 Activity Ledger column: `.ledger`, `.ledger-head` (title + sub), `.ledger-scroll`, `.section-head` (with count chip), `.handoff` card variants (`.pending-you` amber, `.interrupt` red pulsing via CSS animation, outbound default orange). `.handoff-route`, `.handoff-task`, `.handoff-actions`, `.h-btn` variants (primary/secondary/cancel), `.handoff-ttl` + `.ttl-bar` + `.ttl-fill`.
- [x] 2.10 Chat column: `.chat`, `.pane-head`, `.pane-title` (serif), `.pane-hint`, `.messages` (`overflow-y: auto`, padding), `.day-div` (flanked horizontal rules). `.msg`, `.msg-avatar` (28×28 circle, hash-derived background, crust-dark text, first-letter initial), `.msg-body`, `.msg-meta`, `.msg-name` (mono), `.msg-role`, `.msg-time`, `.msg-text`. `code` tag inside `.msg-text` gets orange-tinted mono. `.mention` orange.
- [x] 2.11 Inline handoff/interrupt cards in chat: `.msg-handoff`, `.msg-interrupt` with matching accents, `.mh-head`, `.mh-kind`, `.mh-state` variants (accepted/declined/cancelled/expired), `.mh-route`, `.mh-task`, `.mh-context`. These mirror the ledger cards visually but are larger and show full status history.
- [x] 2.12 Composer: `.composer`, `.composer-bar` (flex row), `.mention-select` (wraps `#target`), `.composer-field` (wraps `#msg-input`), `.composer-actions` (contains existing `#emoji-btn`, `#attach-btn`), `.send-btn` (orange). `.composer-hint` footer with `<kbd>`. Re-style `#target` with `appearance: none` + chevron.
- [x] 2.13 Terminal column: `.terminal` (dark inset), `.term-tabs`, `.term-tab` (rounded-top, `.active` underline), `.term-tab .dot` (live/dead/external/launching variants via `data-state`), `.term-tab .close`, `.term-add`. `.term-body` (mono). Re-style for warm palette but keep all `data-state` selectors the JS uses.
- [x] 2.14 Scrollbars: thin warm-neutral via `::-webkit-scrollbar` + `::-webkit-scrollbar-thumb`.
- [x] 2.15 Modals (`.modal-backdrop`, `.modal`, `.modal-actions`) re-skin to warm-dark with orange primary action. Preserve existing `#mcp-modal`, `#reason-modal`, `#spawn-modal`, `#confirm-modal`, `#nutshell-editor` IDs + children.
- [x] 2.16 Drop overlay + copy toast: re-style with new palette tokens. Orange confirmed-copy success state.
- [x] 2.17 Keyframes: `pulse` (status pill dot), `blink` (interrupt card glow), `fade-in` (message entry). Remove any Catppuccin-specific animation references.

## 3. DOM restructure (ui/index.html)

- [x] 3.1 Replace the header block with the new structure: `<header>` containing `.header-row` (brand on the left, `.status-cluster` on the right with existing icon buttons), then `.roster` with the `#legend` container inside it (JS renders into `#legend` as before).
- [x] 3.2 Move the existing `#nutshell` element out of the chat column to between `<header>` and the main layout. Preserve its IDs and children exactly.
- [x] 3.3 Replace `.app-body` with a new `.main` grid container. Inside, in order: `.ledger` (new, with `#ledger-needs-you` and `#ledger-in-flight` children), existing `.chat-col` renamed to `.chat` (preserve `#messages`, `#target`, `#msg-input`, `#send-btn`, `#emoji-btn`, `#attach-btn`, `#file-input`, `#attachment-row`, `#emoji-popover`, `#mention-popover`), `.splitter#splitter`, and `.terminal-col` renamed to `.terminal` (preserve `#terminal-tabs`, `#terminal-body`).
- [x] 3.4 Add the `<kbd>`-bearing `.composer-hint` element below the composer.
- [x] 3.5 Add the optional decorative titlebar row at the top if Tauri's window chrome doesn't already provide it. If Tauri's native title bar is in use, skip; otherwise render the traffic lights + centered title.
- [x] 3.6 Confirm every ID listed in spec's "Existing IDs are preserved" clause still exists in the updated HTML. Grep check: `grep -oE 'id="[^"]+"' ui/index.html | sort -u`, compare against `grep -oE "getElementById\\('[^']+'\\)" ui/main.js ui/terminal.js | sort -u`.
- [x] 3.7 Verify `<script>` and `<link>` order: stylesheet first, xterm vendor scripts, then `main.js`, then `terminal.js`. Unchanged from v0.7.

## 4. Ledger rendering in main.js

- [x] 4.1 Add `ledgerNeedsYouEl` and `ledgerInFlightEl` module-level references after DOM load.
- [x] 4.2 Refactor `renderHandoffCard(event, container, { compact })` — `compact=true` omits status-history detail, renders inline Accept/Decline or Cancel buttons, and returns a node ready for the ledger container. The existing chat-column rendering path calls it with `compact: false`.
- [x] 4.3 Add `reconcileLedger()` — runs after any handoff/interrupt event. Reads the current `handoffs` + `interrupts` state, filters to non-terminal + unacked, partitions into `needsYou` (recipient === human_name OR interrupt recipient === human_name) and `inFlight` (the rest). Re-renders both ledger containers with compact cards. Updates count chips in section headers.
- [x] 4.4 Call `reconcileLedger()` after: `handoff.new`, `handoff.update`, `interrupt.new`, `interrupt.update`, initial `/handoffs?status=pending` + `/interrupts?status=pending` bootstrap fetches.
- [x] 4.5 Update `renderAvatar(name)` to draw the first-letter initial on the hash-derived colour background (matches mockup; replaces any full-name-based rendering).
- [x] 4.6 Add roster role support in `applyRoster(roster)`: read `agent_roles` from `/config` (add a minimal endpoint if missing, or read from existing `get_*` commands). Render role suffix in each pill when non-empty. No-op when absent.
- [x] 4.7 Update the status pill text rendering: `<onlineCount>/<totalCount> agents · hub :<port>`. Reuse existing presence and `get_hub_url` data.
- [x] 4.8 Wire the `+ agent` roster button to call the terminal-pane spawn modal (it's defined in `terminal.js`; either expose it via a global `window.openSpawnModal` or trigger a DOM event the terminal IIFE listens for).
- [x] 4.9 Regression pass: walk every `document.getElementById(...)` and `querySelector(...)` call in `main.js`; confirm each selector resolves against the new HTML.

## 5. Terminal.js touch-ups

- [x] 5.1 Remove the stale header comment about `dead` state + Restart (lines mentioning held-pane semantics) — state machine is `external | launching | live` only since v0.7 final cleanup.
- [x] 5.2 Rename internal section header `// --- Spawn / Launch / Restart / Kill ---` to `// --- Spawn / Launch / Kill ---`. No behaviour change.
- [x] 5.3 Expose `openSpawnModal` to the window so `main.js`'s `+ agent` button can invoke it: `window.openSpawnModal = openSpawnModal;` near the bottom of the IIFE. Alternative: emit a `CustomEvent('a2a:open-spawn')` on document and listen from both places.
- [x] 5.4 Verify every class name the JS references against the refreshed stylesheet (`terminal-tab`, `terminal-tab-new`, `state-dot`, `close-x`, `active`, `data-state=...`).

## 6. Manual smoke test

- [ ] 6.1 Build and install: `./scripts/install.sh`. Launch app. No console errors.
- [ ] 6.2 Roster: connect an agent, confirm pill renders with dot + name + (optionally) role.
- [ ] 6.3 Nutshell: set via agent handoff; confirm strip renders, Edit opens modal.
- [ ] 6.4 Handoff: agent sends handoff to you; card appears in "Needs you" ledger AND in chat. Accept; ledger card vanishes, chat card updates to `accepted`.
- [ ] 6.5 Interrupt: agent sends interrupt; ledger card in "Needs you" with red pulsing animation, Acknowledge works.
- [ ] 6.6 Composer: Enter sends, Shift+Enter inserts newline, `@alice` triggers mention popover, Send button submits.
- [ ] 6.7 Attachment: drag-drop a PNG; upload succeeds; chip + inline preview render in the sent message.
- [ ] 6.8 Terminal pane: toggle icon in header shows/hides the terminal column. Splitter still drags within 25–75%.
- [ ] 6.9 `+ agent` button in roster opens the same spawn modal as the terminal-pane `+` button.
- [ ] 6.10 Reload-settings and MCP-configs buttons still work.
- [ ] 6.11 Narrow window (1024×768): layout stays usable — no horizontal scroll, ledger shrinks if implemented.
- [ ] 6.12 Resize the window rapidly: no xterm/ledger layout jank beyond one frame.
- [ ] 6.13 Devtools console: zero CSP violations, zero 404s on font/asset fetches.

## 7. App icon regeneration

- [x] 7.1 Confirm `icon.svg` at repo root is the v0.7.1 source icon (speech bubble + 3 Claude glyphs on warm-dark gradient).
- [x] 7.2 Regenerate bundle icons: `bun x tauri icon icon.svg -o src-tauri/icons`. Verify `src-tauri/icons/icon.icns` + `icon.png` + assorted sizes are produced.
- [x] 7.3 Build a test bundle (`bun x tauri build --bundles app`) and confirm the new icon renders in `/Applications/A2AChannel.app` (Finder preview, Dock).

## 8. Cleanup + release

- [x] 8.1 Run `git diff --stat` — verify changes scoped to `ui/*`, `ui/fonts/*`, `src-tauri/icons/*`, `icon.svg`, version files, and optionally README. No protocol, hub, or PTY-layer edits.
- [x] 8.2 Update README.md's "What's new in v0.7" block with a one-line v0.7.1 note (visual refresh + new icon). No behavioural doc edits needed.
- [x] 8.3 Bump version to `0.7.1` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `hub/channel.ts`.
- [ ] 8.4 Commit, tag `v0.7.1`, push, create GitHub release with DMG + `.app.zip`.
- [ ] 8.5 Archive this OpenSpec change: `openspec archive ui-visual-refresh`.
