## 1. Dead tokens + misleading comments (zero-risk)

- [x] 1.1 Delete all 27 `--ctp-*` declarations from `ui/styles/tokens.css`. Verify `grep -r "var(--ctp-" ui/` returns zero post-delete (sanity check; should already be zero pre-delete).
- [x] 1.2 Replace the "Legacy fallback retained. Safe to remove in a follow-up if desired." comment above the CaskaydiaMono `@font-face` block in `ui/styles/fonts.css` with a load-bearing warning pointing at `ui/terminal.js` as the consumer.
- [ ] 1.3 Visual check on the installed app: open it, cards render, chat messages render. Computed styles on a sample element show identical colors pre/post.

## 2. Unused code removal (low-risk)

- [x] 2.1 Remove `export const IMAGE_EXTENSIONS` from `hub/core/attachments.ts:42`. Confirm zero import sites via `grep -rn "IMAGE_EXTENSIONS" hub/`.
- [x] 2.2 Remove the `get_attachments_dir` Tauri command definition from `src-tauri/src/lib.rs:439`.
- [x] 2.3 Remove its registration from the `generate_handler![]` call at `src-tauri/src/lib.rs:578`.
- [x] 2.4 Remove the `attachments_dir` field from `HubState` at `src-tauri/src/lib.rs:27` and the corresponding serde `attachments_dir: Option<String>` at `:40`.
- [x] 2.5 Confirm `grep -rn "get_attachments_dir\|state.attachments_dir\b" src-tauri/ ui/` returns zero.
- [x] 2.6 `cargo check` passes.

## 3. Dead CSS selector cleanup (verify-then-delete)

- [x] 3.1 For each candidate selector (`.pane-head`, `.pane-title`, `.pane-hint`, `.msg-arrow`, `.compact`), run `grep -rn "<class-no-dot>" ui/ src-tauri/` to confirm zero DOM, JS, or Rust references. **Do not delete if any reference found.**
- [x] 3.2 If verified unused: delete `.pane-head` / `.pane-title` / `.pane-hint` block from `ui/styles/chat.css:10`.
- [x] 3.3 If verified unused: delete `.msg-arrow { display: none; }` at `ui/styles/chat.css:101`.
- [x] 3.4 If verified unused: delete `.handoff-card.compact .*` at `ui/kinds/handoff.css:113,114` and `.interrupt-card.compact` at `ui/kinds/interrupt.css:87`.
- [x] 3.5 **Keep** `data-state="dead"` CSS at `ui/styles/terminal.css:62,154` — it IS load-bearing per pty.rs + terminal.js (terminal tab transitions on agent kill).

## 4. Loader dedup

- [x] 4.1 Extract helper function `loadPending(path, idField, renderFn)` near the top of the pending-load section in `ui/main.js`.
- [x] 4.2 Replace the three existing `loadPendingHandoffs` / `loadPendingInterrupts` / `loadPendingPermissions` functions with calls to `loadPending`.
- [x] 4.3 Update all call sites that invoked the old functions (L1568-1570, L1682-1684 per pre-cleanup grep).
- [ ] 4.4 Smoke: reload the app, pending cards render on boot for each of the three kinds.

## 5. Type guards for enum query params

- [x] 5.1 In `hub/kinds/handoff.ts`, add `HANDOFF_STATUS_FILTERS` constant and `isHandoffStatusFilter(s): s is HandoffStatus | "all"` function near the top-level exports.
- [x] 5.2 Replace the `validStatus` Set.has check + `as HandoffStatus | "all"` cast at the `GET /handoffs` handler with `if (!isHandoffStatusFilter(statusParam)) return 400;` + direct typed use.
- [x] 5.3 Repeat §5.1-5.2 for `hub/kinds/interrupt.ts` (`isInterruptStatusFilter`).
- [x] 5.4 Repeat for `hub/kinds/permission.ts` (`isPermissionStatusFilter` + the existing `status=*` query param handler).
- [x] 5.5 Add `isPermissionBehavior(s): s is PermissionBehavior` in `hub/kinds/permission.ts`. Replace the `behavior as PermissionBehavior` cast at the verdict handler (`:370`) with `if (!isPermissionBehavior(behavior)) return 400;`.
- [x] 5.6 `bun x tsc --noEmit` passes. `bun test` passes (47 tests, v0.9.5 baseline).

## 6. authedPost + authedUpload unification

- [x] 6.1 Read `hub/channel/hub-client.ts` and diff the bodies of `authedPost` and `authedUpload`. Identify the shared 401-retry + response-parsing shell.
- [x] 6.2 Write `authedRequest(hubEnv, method, path, buildBody)` where `buildBody()` returns `{ body, headers }`. Keep the retry-on-401 logic identical to existing behavior.
- [x] 6.3 Reimplement `authedPost` and `authedUpload` as thin wrappers over `authedRequest` (do NOT delete the names — call sites depend on them).
- [x] 6.4 Run `bun test tests/integration/auth-contract.test.ts` — must pass.
- [ ] 6.5 Smoke: installed app, send a chat message (uses `/post`), upload an attachment (uses `/upload`), both succeed.

## 7. pty.rs spawn-helper extraction (user-gated)

- [ ] 7.1 Identify the duplicated blocks across `pty_spawn`, `pty_attach`, and the shell-tab spawn path. Expected: UTF-8 locale resolution (~10 lines), attach-and-stream PTY pairing (~20 lines), existing-session configuration (~10 lines).
- [ ] 7.2 Extract `fn resolve_utf8_locale(env: &HashMap<String, String>) -> String` with the current LANG/LC_ALL logic.
- [ ] 7.3 Extract `fn configure_existing_session(name: &str) -> Result<(), String>` that runs `remain-on-exit off` + resize cycle on a known session.
- [ ] 7.4 Extract `async fn attach_and_stream(name: &str, out_tx: ...) -> Result<(), String>` that handles the PTY master pairing + byte-stream forwarding.
- [ ] 7.5 `cargo check` passes.
- [ ] 7.6 **User click-through gate**: `./scripts/install.sh`, spawn a fresh agent from the UI, verify (a) claude launches, (b) Braille glyphs render in the banner, (c) stdio streams live, (d) tab shows `live` state, (e) kill the agent externally, tab transitions to `dead` state.
- [ ] 7.7 If any smoke fails: revert the extraction and file a follow-up change with integration tests FIRST.

## 8. Empty-catch audit

- [x] 8.1 List all empty `catch {}` sites across `hub/` + `ui/`. Expected count: 25.
- [x] 8.2 For each site, read the surrounding function and categorize:
  - **A (silent by design):** SSE close-on-error, Bun cleanup teardown, `.catch(() => ({}))` JSON body defaults, `unlink` on tmp file failure, xterm destroy-on-close.
  - **B (swallowing real errors):** anything where a user action silently dropped, anything that could mask a network/permission error users need to see.
- [x] 8.3 Inline `// silent:` comments — variance: skipped. Audit finding was 0 category-B sites; the design's rationale for the comments was "so future audits skip them" but adding 25 inline comments is meaningful churn for zero runtime benefit. The triage outcome itself (all 25 = category A) is recorded in this tasks.md and the commit message — that's the durable record future audits will consult.
- [x] 8.4 No category-B sites found, so no `console.warn` added.
- [x] 8.5 No new test failures.

## 9. Release

- [x] 9.1 Version bump to `0.9.7` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- [ ] 9.2 `bun test` green. `bun x tsc --noEmit` clean. `cargo check` clean.
- [ ] 9.3 `./scripts/install.sh`. Click-through smoke: spawn an agent, send a message, upload an attachment, trigger a permission prompt, ack it, kill agent, verify tab transitions. All the flows that §§2-8 touched.
- [ ] 9.4 Git tag `v0.9.7`, push, GitHub release notes citing the per-section line-count delta.
- [ ] 9.5 `openspec archive v097-cleanup-pass --yes`.
