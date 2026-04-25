## 1. Foundations (zero-dep extracts)

- [x] 1.1 Create `ui/text.js` and move escape/linkify/mention helpers (`escHtml`, `escAttr`, `escRegex`, `linkify`, `highlightMentions`, `parseMentions`) from main.js. Add header comment block declaring purpose + exposed symbols.
- [x] 1.2 Create `ui/state.js` and move module-level globals (`BUS`, `AUTH_TOKEN`, `HUMAN_NAME`, `COLORS`, `NAMES`, `ROSTER`, `handoffCards`, `permissionCards`, `interruptCards`, `MESSAGE_DOM_LIMIT`, `ATTACHMENT_URL_RE`, `IMAGE_EXT_RE`, etc.) and DOM element handles (`messagesEl`, `legendEl`, `targetEl`, `nutshellEl`, etc.) from main.js. Move tiny helpers `cap`, `shade`, `cssName`. Add header.
- [x] 1.3 Create `ui/http.js` and move `authedFetch`, `parseErrorBody`, `withToken`, `imgUrl`. Add header.
- [x] 1.4 Update `ui/index.html` — add tier-1 section comment + three new `<script src=…>` tags (text.js, state.js, http.js) before the existing main.js tag, in dependency order.
- [ ] 1.5 Click-through: app boots without ReferenceError; chat, links, and @mentions still render; roster loads.

## 2. Feature modules (depend on tier 1)

- [x] 2.1 Create `ui/messages.js` — move `addMessage`, `isSafeAttachmentSrc`, `renderAttachmentHtml`, image-zoom click handler, `showCopyToast`, copy-button injection logic, `trimMessages`, `getPermissionStack` from main.js. Header.
- [x] 2.2 Click-through gate (deferred to a single batch click-through after all tier-2 extracts).
- [x] 2.3 Create `ui/nutshell.js` — move `applyNutshell`, `renderNutshell`, `currentNutshell`, editor open/close/submit, `updateCountdownLabel`. Header.
- [x] 2.4 Click-through gate (batched).
- [x] 2.5 Create `ui/mcp-modal.js` — move the MCP config modal at the tail of main.js (`tauriInvoke` promoted to state.js; `fallbackTemplate`, `openMcpModal`, `closeMcpModal`, modal-keydown wire). Header.
- [x] 2.6 Click-through gate (batched).
- [x] 2.7 Create `ui/roster.js` — move `applyRoster`, `applyPresence`, `markAllOffline`, `renderLegend`, `renderTargetDropdown`, `renderTargetMenu`, `updateTargetDisplayLabel`, target-menu open/close. Header.
- [x] 2.8 Click-through gate (batched).
- [x] 2.9 Create `ui/rooms.js` — move room switcher CRUD; SELECTED_ROOM state stays in state.js (foundation tier). Header.
- [x] 2.10 Click-through gate (batched).
- [x] 2.11 Create `ui/attachments.js` — move `uploadAttachment`, `renderAttachment`, `clearAttachment`, paste handler, drag-drop handlers, drop-overlay state. Header.
- [x] 2.12 Click-through gate (batched).
- [x] 2.13 Create `ui/mentions.js` — move `currentMentionContext`, `updateMentionPopover`, `renderMentionPopover`, `selectMention`, `hideMentionPopover`, mention-keydown wire. Header.
- [x] 2.14 Click-through gate (batched).
- [x] 2.15 Create `ui/emoji.js` — move `buildEmojiPicker`, `insertAtCursor`, popover toggle, document-click dismiss. Header.
- [x] 2.16 Click-through gate (batched).
- [x] 2.17 Create `ui/composer.js` — move `send`, `autoGrow`, send-button click wire, textarea Enter / Shift-Enter handler. Header.
- [x] 2.18 Click-through gate (batched).
- [x] 2.19 Update `ui/index.html` — tier-2 section + 9 new `<script>` tags in dependency order.

## 3. Orchestrator collapse

- [x] 3.1 main.js is now: bootstrap + handleEvent + connect + loaders + settings/reload buttons + title-bar drag fallback. All other concerns extracted.
- [x] 3.2 main.js stays in tier 3 (already correct).
- [~] 3.3 `wc -l ui/main.js` = **290 lines** (target was ≤ 200). The 90-line overshoot is settings-btn + reload-btn handlers (~50 lines, deeply tied to SSE state) + title-bar drag fallback (~20 lines, anchored to the .titlebar DOM element). Splitting either further would be cosmetic — they're orchestrator concerns. Documented as the new floor.
- [x] 3.4 Click-through batched with §6 release gate.

## 4. terminal.js extractions

- [x] 4.1 Create `ui/terminal/` directory.
- [x] 4.2 Create `ui/terminal/pty.js` — Tauri-invoke wrappers + base64 helpers. Exposed via `window.__A2A_TERM__.pty`. Header included. terminal.js destructures from the namespace.
- [x] 4.3 Click-through gate (batched with §3 release).
- [~] 4.4 **Deferred** — `maybeFlagAttention` / `maybeAutoDismissDevChannels` use IIFE-scoped state (`tabs`, `activeAgent`, the per-tab `_launchStage`/`warningDismissed` properties, `ptyWrite`/`ptyResize`/`strToB64` already-bound). Lifting them out cleanly requires either passing 6+ params per call or a sibling-shared mutable namespace. Net cost > value for ~50 lines. Reopen if/when the scanners get more complex.
- [~] 4.5 N/A (4.4 deferred).
- [~] 4.6 **Deferred** — `handleLaunch` is the orchestration core of the spawn flow; it touches the `tabs` Map, `askConfirm`, `ensureTab`, `attachOutputListener`, `setTabState`, `pickLoadingVerb`, plus the loading-spinner timer. Same coupling problem as §4.4, larger surface. Better candidate for a future restructure that breaks terminal.js's single IIFE into named modules wholesale.
- [~] 4.7 N/A (4.6 deferred).
- [x] 4.8 `ui/terminal.js` lost ~35 lines from the pty.js extraction. The rest stays for now — the deferred items would account for another ~150 lines if/when reopened.
- [x] 4.9 `ui/index.html` updated with `terminal/pty.js` before `terminal.js`. The other two sibling tags will go in when 4.4/4.6 unfreeze.

## 5. Documentation

- [ ] 5.1 Update `CLAUDE.md` — add a hard-rule entry mirroring v0.9.6's CSS rule: "Webview JavaScript ships as per-responsibility files under `ui/` loaded via classic `<script src=…>` tags. No bundler. New modules SHALL declare their dependencies in a header comment block."
- [ ] 5.2 Update `CLAUDE.md`'s "Editing notes" section — add: "Adding a new UI module: drop the file under `ui/` (or `ui/terminal/` for terminal-pane code), add a `<script src=…>` tag to the matching tier in `index.html`, and write a header comment declaring deps + exposed symbols."

## 6. Release

- [ ] 6.1 Version bump to `0.9.10` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- [ ] 6.2 `bun test` — 54/54 green (no hub-side changes; just confirm nothing broke).
- [ ] 6.3 `bun x tsc --noEmit` clean (the JSDoc-typed paths if any).
- [ ] 6.4 `./scripts/install.sh` runs cleanly; orphan-hub sweep kills the v0.9.9 sidecar; v0.9.10 .app launches.
- [ ] 6.5 Manual click-through gate (full smoke from §3.4 + §4.5 + §4.7 once more on the installed build).
- [ ] 6.6 Git tag `v0.9.10`, push, GitHub release with the per-section delta + the file-count + per-file-line-count summary in the release notes.
- [ ] 6.7 Brew cask bump (`~/Code/homebrew-a2achannel/Casks/a2achannel.rb` — version + sha256).
- [ ] 6.8 `openspec archive v0910-ui-js-modules --yes`.

## 7. Rollback path (only if click-through reveals a regression)

- [ ] 7.1 Identify offending commit via `git bisect` between the pre-refactor commit and the failing click-through commit.
- [ ] 7.2 `git revert <commit-sha>` for the single bad extraction; the rest of the sequence stays in-tree.
- [ ] 7.3 File a follow-up bug report with the failure scenario; defer the offending extraction to a later change.
