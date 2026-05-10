## 0. Pre-grilling + smoke-checklist authoring

- [ ] 0.1 Confirm `architecture-cycle-2a` has been merged to main AND soaked for at least one week with the long-running test agents (Drupal/Copernicus/Django/EIFE) before starting this cycle. If 2a is still on its branch or has been on main <7 days, defer 2b.
- [ ] 0.2 Walk the three current Kind modules (`ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js`) and write a strawman `KindRenderer` for each (full contract: `extractSnapshot` + `buildHeader` + `buildBody` + `buildActions` + `dispatch` + `placement`). Verify each renderer's `placement` string lands the card at the correct visual location (Permission stack region, Interrupt pinned-then-moved, Handoff inline append). Record any refinement to design.md Decision 1.
- [ ] 0.3 Author `tests/smoke/tab-lifecycle.md` with four scenarios — cold-start race, reconnect storm, theme-change refit, kill+respawn — each scenario row has columns: `expected` / `observed` / `pass-fail`. Cold-start scenario MUST cover claude's MCP init ~10s window where `notifications/claude/channel` is silently dropped. Reconnect-storm scenario MUST cover N close+reopen in <500ms with no orphan xterm instances. Theme-refit scenario MUST cover xterm column re-fit on dark/light toggle. Kill+respawn scenario MUST cover claude pid kill, Tab dismount, agent re-register on next spawn.
- [ ] 0.4 Branch `architecture-cycle-2b` off main; verify with `git branch --show-current`.

## 1. KindRenderer + KindCard (kind-rendering capability)

- [ ] 1.1 Define `KindRenderer` interface in `ui/kinds/kind-renderer.js`: `{ extractSnapshot(entry), buildHeader(snapshot, container), buildBody(snapshot, container), buildActions(snapshot, container, dispatch), dispatch(verb, payload), placement: "stack" | "pin" | "append" }`
- [ ] 1.2 Implement `KindCard` lifecycle owner in `ui/kinds/kind-card.js` — tracks `(id, version)` per kind, on first version composes `buildHeader`+`buildBody`+`buildActions` against `extractSnapshot` output, on newer version re-runs the same builders to re-paint, on terminal status runs the placement-specific dismiss path; applies one of the three fixed placement strategies based on the renderer's declared string
- [ ] 1.3 Migrate `ui/kinds/handoff.js` to export a `KindRenderer` with `placement: "append"`; remove direct DOM manipulation from chat-pane consumers of handoff
- [ ] 1.4 Migrate `ui/kinds/interrupt.js` to export a `KindRenderer` with `placement: "pin"`; verify pin-then-move-to-inline behavior on terminal status
- [ ] 1.5 Migrate `ui/kinds/permission.js` to export a `KindRenderer` with `placement: "stack"`; verify multiple pending permissions stack correctly
- [ ] 1.6 Update `ui/main.js` to delegate per-Kind handling to `KindCard.dispatch(eventKind, entry)`; remove direct calls to per-Kind helpers from main.js
- [ ] 1.7 Verify by grep that `ui/main.js` no longer references handoff/interrupt/permission DOM helpers directly
- [ ] 1.8 Manual smoke-test all three Kinds: handoff round-trip, interrupt round-trip including pin→move-to-inline transition, permission round-trip with two pending requests stacking
- [ ] 1.9 Smoke-test version-discard: simulate out-of-order version arrival (replay older version after newer), verify `KindCard` discards it without calling `update`
- [ ] 1.10 Commit: `feat(ui): KindRenderer interface + KindCard lifecycle owner`

## 2. CSS consolidation

- [ ] 2.1 Create `ui/styles/kinds.css` with the shared schema keyed by `data-kind="<kind>"` selectors
- [ ] 2.2 Move per-Kind shared rules from `ui/styles/chat.css` (`.handoff-card`, `.interrupt-card`, `.permission-card` and shared status-badge/state classes) into `kinds.css`
- [ ] 2.3 Pull truly-shared visual rules from `ui/kinds/handoff.css`, `ui/kinds/interrupt.css`, `ui/kinds/permission.css` into `ui/styles/kinds.css`. Leave only Kind-specific quirks behind in the per-Kind files (target ≥90% of each per-Kind file's rules consolidated)
- [ ] 2.4 Update `KindCard` (from task 1.2) to set `data-kind="<kind>"` on each card root so the shared selectors apply
- [ ] 2.5 Add `<link rel="stylesheet" href="styles/kinds.css">` to `ui/index.html` (after chat.css, before per-Kind `.css` files)
- [ ] 2.6 Verify by grep that `ui/styles/chat.css` contains no `.handoff-card`, `.interrupt-card`, `.permission-card`, or other per-Kind class selectors
- [ ] 2.7 Verify the deletion-test scenario from kind-rendering/spec.md: an edit to "pending" status badge styling lands in exactly one file (`kinds.css`) and applies to all three Kinds
- [ ] 2.8 Manual smoke-test all three Kinds visual rendering matches pre-consolidation
- [ ] 2.9 Commit: `style(ui): consolidate per-Kind CSS into ui/styles/kinds.css`

## 3. Tab / XtermBinder / PtyEvents split (tab-lifecycle capability) — GATED

- [ ] 3.1 GATE: confirm `tests/smoke/tab-lifecycle.md` exists with all four scenarios filled in (from task 0.3) and all `observed` rows pass under manual exercise. If any row fails, DEFER this section's commit to a future cycle and ship 2b without it
- [ ] 3.2 Define module split (the existing `ui/terminal/` directory holds `pty.js` and `xterm-themes.js` today; new modules land alongside):
  - `ui/terminal/tab.js` — Tab lifecycle (cold-start, reconnect, dispose, dev-channels prompt auto-dismiss)
  - `ui/terminal/xterm-binder.js` — xterm.js binding (write, refit, theme); `mount(container, opts)` returns a Promise that resolves only after geometry-heal SIGWINCH propagates to the PTY master
  - `ui/terminal/pty-events.js` — PTY event subscription (output, exit, resize)
- [ ] 3.3 Move xterm-binding code (xterm instance creation, write-to-terminal, refit-on-resize, theme application) from `ui/terminal.js` into `ui/terminal/xterm-binder.js`. Implement `mount(container, opts)` so its returned Promise resolves only after the post-fit SIGWINCH propagates to the PTY master (per tab-lifecycle/spec.md geometry-heal requirement)
- [ ] 3.4 Move PTY event subscription (output streaming, exit detection, resize-from-container) from `ui/terminal.js` into `ui/terminal/pty-events.js`
- [ ] 3.5 `ui/terminal/tab.js` becomes the orchestrator: awaits `XtermBinder.mount(...)` BEFORE any `write()` or `attachPty()`, constructs a `PtyEvents`, subscribes to its callbacks (output → binder.write; exit → tab.dispose), exposes `cold-start`, `reconnect`, `dispose` lifecycle hooks
- [ ] 3.6 Verify by grep:
  - `ui/terminal/tab.js` imports both `xterm-binder.js` and `pty-events.js`
  - `ui/terminal/xterm-binder.js` does NOT import `pty-events.js`
  - `ui/terminal/pty-events.js` does NOT import `xterm-binder.js`
  - No call site outside `ui/terminal/*` references `XtermBinder` directly (returns zero matches)
- [ ] 3.7 Re-execute the 4-scenario smoke-checklist after the split and verify all observed rows still pass
- [ ] 3.8 Verify v0.9.8 regression guard `tests/integration/pty-plumbing.test.ts` still passes (no `%output`/`%begin`/`%end` control-mode framing on attach stream)
- [ ] 3.9 Commit: `feat(ui): split terminal.js into Tab + XtermBinder + PtyEvents (gated)`

## 4. CaptureTransaction (capture-transaction capability)

- [ ] 4.1 Define `CaptureTransaction` struct in `src-tauri/src/pty.rs` with three fields: `geometry_revert`, `pipe_pane_disable`, `sentinel_watch_release`. Each field is a closure or owned handle that runs cleanup
- [ ] 4.2 Implement `Drop` for `CaptureTransaction` running cleanup arms in declared order; each arm is panic-safe (a panicking arm does NOT prevent subsequent arms)
- [ ] 4.3 Rewrite `pty_capture_turn(agent, input, timeout_ms)` to construct a `CaptureTransaction`, perform input-write + sentinel-wait + output-read, then drop the transaction (cleanup happens in `Drop`)
- [ ] 4.4 Verify by grep that `pty_capture_turn` no longer contains explicit `pipe-pane -o off` or geometry-revert calls outside `Drop::drop`
- [ ] 4.5 Add test under `src-tauri/tests/capture_transaction_test.rs` for success path: pre-capture `CaptureState` is recorded, `pty_capture_turn` runs, post-capture `CaptureState` matches baseline (modulo new success-log file)
- [ ] 4.6 Add test for timeout path: fixture configured with no sentinel write, 100ms timeout, post-call `CaptureState` matches baseline (modulo new `.partial.log`)
- [ ] 4.7 Add test for panic path: fixture configured to inject a panic during sentinel-wait; assert `CaptureState` matches baseline after unwind
- [ ] 4.8 `cargo check`, `cargo test --test capture_transaction_test`, `./scripts/install.sh`, manual smoke-test slash-command capture flow with at least one success and one timeout
- [ ] 4.9 Commit: `feat(pty): CaptureTransaction with Drop cleanup; tests assert CaptureState`

## 5. Pre-merge cleanup

- [ ] 5.1 Strip any debug instrumentation introduced during smoke-testing this cycle (per saved feedback memory)
- [ ] 5.2 Final pass on each commit's diff
- [ ] 5.3 **Edit (don't delete) CLAUDE.md hard rules that drift:**
  - The "Terminal pane uses a raw PTY" rule's commentary references `terminal.js` for the regression guard; update path-references to the new `tab.js` / `pty-events.js` split (the rule itself stays)
  - The "Tab cold-start" lock from cycle-1 stays referenced; commentary updated to reflect the three-module shape
  - Any other path-references that drift during this cycle's carves
- [ ] 5.4 **Ship 2 ADRs as definite deliverables**:
  - **ADR-0007 — RAII over closure-defer in Rust for `CaptureTransaction`:** explains why `Drop` impl is the cleanup mechanism rather than a `with_capture(|tx| { ... })?` closure helper
  - **ADR-0008 — `KindRenderer.placement` declarative string vs vtable:** explains why placement is one of three fixed strings rather than a per-renderer callback. References the cycle-2a orchestration-shape ADR-0004 for context.
- [ ] 5.5 Verify ADRs 0001–0006 (from prior cycles) still describe current behavior; edit if drifted
- [ ] 5.6 Run full smoke-test sweep: chat round-trip, all three Kind round-trips with proper KindCard placement, terminal cold-start, terminal reconnect, slash-command capture (success path), slash-command capture (timeout path)

## 6. Merge

- [ ] 6.1 `git log --oneline main..architecture-cycle-2b` shows the expected commits in dependency order
- [ ] 6.2 Get explicit user greenlight to fast-forward main
- [ ] 6.3 `git checkout main && git merge --ff-only architecture-cycle-2b`
- [ ] 6.4 `git push origin main` (with explicit user permission)
- [ ] 6.5 `git branch -d architecture-cycle-2b`
- [ ] 6.6 Run `/opsx:archive` to archive this OpenSpec change
