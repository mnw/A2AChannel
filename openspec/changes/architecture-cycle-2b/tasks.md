## 0. Pre-grilling + smoke-checklist authoring

- [ ] 0.1 Confirm `architecture-cycle-2a` has been merged to main AND soaked for at least one week with the long-running test agents (Drupal/Copernicus/Django/EIFE) before starting this cycle. Re-grill 2b's `KindRenderer/KindCard` contract against THEN-CURRENT 2a code (not against 2a's design at split-time) — see design.md Risks "2a's structural completion is a substantive gate."
- [ ] 0.2 Walk the three current Kind modules (`ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js`) and write a strawman `KindRenderer` for each. **Renderer-shape decision points:**
  - **Single `mount(snapshot, container, dispatch)` vs 4-builder split:** verify whether `KindCard` needs to inject shared chrome BETWEEN sections. If not, single `mount` is sufficient (default per design.md Decision 1). If yes, escalate to `extractSnapshot + buildHeader + buildBody + buildActions + dispatch + placement`.
  - **Placement strings vs per-Kind callback for the rare mode that needs Kind-specific DOM:** verify that `KindCard` can implement all three placement modes (stack/pin/append) generically without per-Kind DOM. If permission's `getPermissionStack()` (or any other mode) genuinely requires Kind-specific DOM, promote that ONE mode to a per-renderer callback while keeping strings for the others.
  - **Dismiss matrix** per design.md Decision 1: `"append"` → keep + add terminal class; `"pin"` → move-to-inline; `"stack"` → remove. Verify each matches today's per-Kind behavior.
  - Record any refinement to design.md Decision 1.
- [ ] 0.3 Enumerate the `ctx` shape for renderer factories: grep today's classic `<script>` per-Kind files for the names referenced from main.js's lexical scope. Today's known set: `messagesEl`, `authedFetch`, `parseErrorBody`, `askReason`, `escHtml`, `HUMAN_NAME`, `addMessage`, `trimMessages`, `updateCountdownLabel`. Per-Kind state Maps (`handoffCards`, etc.) are renderer-LOCAL — not on `ctx`. Confirm the shape; record in design.md Open Questions if any Kind needs a field the others don't.
- [ ] 0.4 Author `tests/smoke/tab-lifecycle.md` with four scenarios — cold-start race, reconnect storm, theme-change refit, kill+respawn — each scenario row has columns: `expected` / `observed` / `pass-fail`. Cold-start scenario MUST cover claude's MCP init ~10s window where `notifications/claude/channel` is silently dropped. Reconnect-storm scenario MUST cover N close+reopen in <500ms with no orphan xterm instances. Theme-refit scenario MUST cover xterm column re-fit on dark/light toggle. Kill+respawn scenario MUST cover claude pid kill, Tab dismount, agent re-register on next spawn.
- [ ] 0.5 Branch `architecture-cycle-2b` off main; verify with `git branch --show-current`.

## 1. KindRenderer + KindCard + ES-module migration (kind-rendering capability)

- [ ] 1.1 Convert `ui/main.js` from classic `<script>` to ES module. Export `createCtx()` returning the helper bundle (`messagesEl`, `authedFetch`, `parseErrorBody`, `askReason`, `escHtml`, `humanName`, `addMessage`, `trimMessages`, `updateCountdownLabel`). Per-Kind card-state Maps (`handoffCards`, `interruptCards`, `permissionCards`) are REMOVED from main.js — they move into each renderer's closure.
- [ ] 1.2 Define `KindRenderer` interface (informal — pure JS, no .d.ts file in this cycle) in `ui/kinds/kind-renderer.js`: `{ extractSnapshot(entry): Snapshot, mount(snapshot, container, dispatch): void, dispatch(verb, payload): Promise<void>, placement: "stack" | "pin" | "append" }`. Snapshot shape: `{ id: string, version: number, status: string, [extra]: unknown }`.
- [ ] 1.3 Implement `KindCard` lifecycle owner in `ui/kinds/kind-card.js` — exports a registry (Map kind-prefix → factory + ctx) and a static `KindCard.dispatch(eventKind, entry)` that looks up the renderer by kind-prefix and applies the lifecycle: tracks `(id, version)` newer-wins; on first version calls `mount`; on newer version clears container and re-mounts; on terminal status applies the per-placement dismiss matrix from spec (append→keep+terminal-class; pin→move-inline; stack→remove). Sets `data-kind="<kind>"` on the card root so `kinds.css` rules apply.
- [ ] 1.4 Migrate `ui/kinds/handoff.js` to `<script type="module">` exporting `createHandoffRenderer(ctx): KindRenderer` with `placement: "append"`. Move `handoffCards` Map into the renderer closure. Remove the classic-`<script>` shared-lexical-scope dependency.
- [ ] 1.5 Migrate `ui/kinds/interrupt.js` similarly — `createInterruptRenderer(ctx): KindRenderer` with `placement: "pin"`. Move `interruptCards` Map into the renderer closure. Verify the pin→move-inline transition on terminal status.
- [ ] 1.6 Migrate `ui/kinds/permission.js` similarly — `createPermissionRenderer(ctx): KindRenderer` with `placement: "stack"`. Move `permissionCards` Map into the renderer closure. Verify the per-placement dismiss matrix removes the card on terminal status.
- [ ] 1.7 Update `ui/main.js` to construct `ctx = createCtx()`, register each renderer factory in `KindCard`'s registry passing `ctx`, and delegate per-Kind events to `KindCard.dispatch(eventKind, entry)`. Remove direct calls to per-Kind helpers.
- [ ] 1.8 Update `ui/index.html`: per-Kind script tags + main.js gain `type="module"`. Verify load order works with module load semantics (modules are deferred by default; classic scripts loading before them in <head> need explicit `defer` or move).
- [ ] 1.9 **Add `tests/unit/kind-renderer.test.ts`** — exercises each renderer's `extractSnapshot` + `dispatch` against a fake `ctx` with `authedFetch: jest.fn()` etc. No jsdom required; both methods are pure (no DOM). High-leverage because the renderer is the most-testable surface in the cycle. Assertions: `extractSnapshot` returns the canonical `{id, version, status, ...}` shape for each event kind; `dispatch("allow", id)` calls `ctx.authedFetch(...)` with the right URL + body for permission verdict.
- [ ] 1.10 **Add `tests/contract/no-classic-script-globals.test.ts`** — grep-style assertion that runs in CI: each `ui/kinds/<kind>.js` declares no top-level `var name = ...` / `function name() {}` (i.e., is a pure ES module with explicit imports/exports). Replaces the manual grep step with an actual test that drift-fails on regression.
- [ ] 1.11 Manual smoke-test all three Kinds: handoff round-trip with placement append + terminal-class on accept; interrupt round-trip with pin→move-inline transition; permission round-trip with two pending requests stacking + correct removal on terminal.
- [ ] 1.12 Smoke-test version-discard: simulate out-of-order version arrival (replay older version after newer), verify `KindCard` discards it without re-mounting.
- [ ] 1.13 Commit: `feat(ui): KindRenderer + KindCard + ES-module migration with ctx factory`

## 2. CSS consolidation

- [ ] 2.1 Create `ui/styles/kinds.css`. Schema: foundational rule for `[data-kind]` (the shared card skeleton from `ui/styles/card.css` — border, radius, padding, grid). Per-status rules keyed by `[data-kind][data-status="<status>"]`. Per-Kind rules keyed by `[data-kind="<kind>"]`.
- [ ] 2.2 Fold `ui/styles/card.css` (67 LOC) into `kinds.css`. The shared `.handoff-card / .interrupt-card / .permission-card` skeleton becomes the foundational `[data-kind]` rule. Delete `ui/styles/card.css` from `ui/index.html`'s `<link>` tags.
- [ ] 2.3 Pull rules from `ui/kinds/handoff.css` (112 LOC) into `kinds.css`. Convert `.handoff-card.X` selectors to `[data-kind="handoff"][data-X]` form (or `[data-kind="handoff"] .X` for descendants). Truly Kind-specific quirks may remain in `ui/kinds/handoff.css` but target ≥90% migrated. If file empties, delete it.
- [ ] 2.4 Same for `ui/kinds/interrupt.css` (86 LOC) and `ui/kinds/permission.css` (183 LOC).
- [ ] 2.5 Migrate `ui/features/rooms.js` lines 125-127 (runtime-injected room-filter CSS) from `.handoff-card[data-room]:not(...)` to `[data-kind][data-room]:not(...)`. The rule now applies to all current and future Kinds without per-Kind hardcoding.
- [ ] 2.6 Update `ui/index.html`: replace `<link rel="stylesheet" href="styles/card.css">` + per-Kind CSS `<link>`s with `<link rel="stylesheet" href="styles/kinds.css">` (single line replaces 4-5).
- [ ] 2.7 **Add `tests/contract/per-kind-class-isolation.test.ts`** — grep-style CI test: zero matches of `.handoff-card`, `.interrupt-card`, `.permission-card` outside `ui/styles/kinds.css`. Replaces the manual grep step.
- [ ] 2.8 Manual smoke-test all three Kinds visual rendering matches pre-consolidation. Verify dark/light theme toggle still applies. Verify room-filter still works.
- [ ] 2.9 Commit: `style(ui): consolidate per-Kind CSS (5 sources → 1) into ui/styles/kinds.css`

## 3. Tab / XtermBinder / PtyEvents split (tab-lifecycle capability) — GATED

- [ ] 3.1 GATE: confirm `tests/smoke/tab-lifecycle.md` exists with all four scenarios filled in (from task 0.4) and all `observed` rows pass under manual exercise. If any row fails, DEFER this section's commit to a future cycle and ship 2b without it.
- [ ] 3.2 Define module split (the existing `ui/terminal/` directory holds `pty.js` and `xterm-themes.js` today; new modules land alongside):
  - `ui/terminal/tab.js` — Tab lifecycle (cold-start, reconnect, dispose, dev-channels prompt auto-dismiss)
  - `ui/terminal/xterm-binder.js` — xterm.js binding (write, refit, theme); `mount(container, opts)` returns a Promise that resolves only after geometry-heal SIGWINCH propagates to the PTY master
  - `ui/terminal/pty-events.js` — PTY event subscription (output, exit, resize). Owns the dev-channels prompt output-scan + SIGWINCH dance (per design.md Open Question default).
- [ ] 3.3 Move xterm-binding code from `ui/terminal.js` (873 LOC) into `ui/terminal/xterm-binder.js`. Implement `mount(container, opts)` so its returned Promise resolves only after the post-fit SIGWINCH propagates to the PTY master (per tab-lifecycle/spec.md geometry-heal requirement).
- [ ] 3.4 Move PTY event subscription (output streaming, exit detection, resize-from-container) from `ui/terminal.js` into `ui/terminal/pty-events.js`. Include the dev-channels prompt output-scan + SIGWINCH cycle that triggers when the literal "I am using this for local development" string appears.
- [ ] 3.5 `ui/terminal/tab.js` becomes the orchestrator: awaits `XtermBinder.mount(...)` BEFORE any `write()` or `attachPty()`, constructs a `PtyEvents`, subscribes to its callbacks (output → binder.write; exit → tab.dispose), exposes `cold-start`, `reconnect`, `dispose` lifecycle hooks.
- [ ] 3.6 **Add `tests/contract/terminal-encapsulation.test.ts`** — grep-style CI test:
  - `ui/terminal/tab.js` imports both `xterm-binder.js` and `pty-events.js`
  - `ui/terminal/xterm-binder.js` does NOT import `pty-events.js`
  - `ui/terminal/pty-events.js` does NOT import `xterm-binder.js`
  - No call site outside `ui/terminal/*` references `XtermBinder` or `PtyEvents` directly (returns zero matches)
- [ ] 3.7 Re-execute the 4-scenario smoke-checklist after the split and verify all observed rows still pass.
- [ ] 3.8 Verify v0.9.8 regression guard `tests/integration/pty-plumbing.test.ts` still passes (no `%output`/`%begin`/`%end` control-mode framing on attach stream).
- [ ] 3.9 Commit: `feat(ui): split terminal.js into Tab + XtermBinder + PtyEvents (gated)`

## 4. CaptureTransaction (capture-transaction capability)

- [ ] 4.1 Define `CaptureTransaction` struct in `src-tauri/src/pty.rs` with cleanup state held as a single Vec<CleanupAction> (or enum-of-known-arms) — explicit ordering: `pipe-pane -o off` → `set-option window-size` revert → sentinel-file delete (best-effort).
- [ ] 4.2 Implement `Drop` for `CaptureTransaction` running cleanup arms in declared order. Each arm wrapped in its own try-block (or `std::panic::catch_unwind` for inner panic safety) so a panicking arm does NOT prevent subsequent arms from running.
- [ ] 4.3 Rewrite `pty_capture_turn(agent, input, timeout_ms)` to construct a `CaptureTransaction`, perform input-write + sentinel-wait + output-read, then drop the transaction (cleanup happens in `Drop`).
- [ ] 4.4 Verify by grep that `pty_capture_turn` no longer contains explicit `pipe-pane -o off` or geometry-revert calls outside `Drop::drop`.
- [ ] 4.5 Add test under `src-tauri/tests/capture_transaction_test.rs` for success path: pre-capture `CaptureState` is recorded, `pty_capture_turn` runs, post-capture `CaptureState` matches baseline (modulo new success-log file).
- [ ] 4.6 Add test for timeout path: fixture configured with no sentinel write, 100ms timeout, post-call `CaptureState` matches baseline (modulo new `.partial.log`).
- [ ] 4.7 Add test for panic path. **Setup is non-trivial** (per design.md Risks):
  - Wrap `pty_capture_turn` invocation in `std::panic::catch_unwind`.
  - Install a `std::panic::set_hook` that suppresses the test-runner's default panic message during this specific test (restore after).
  - Inject the panic via a flag the fixture-provided sentinel-watcher checks before yielding control.
  - Ensure the injected panic does NOT poison shared mutexes used by other tests (use a fixture-private mutex if needed).
  - Assert `CaptureState` matches baseline after `catch_unwind` returns `Err`.
  - **Budget half a day** for this test alone — it's the most operationally tricky part of the cycle.
- [ ] 4.8 `cargo check`, `cargo test --test capture_transaction_test`, `./scripts/install.sh`, manual smoke-test slash-command capture flow with at least one success and one timeout.
- [ ] 4.9 Commit: `feat(pty): CaptureTransaction with Drop cleanup; tests assert CaptureState`

## 5. Pre-merge cleanup

- [ ] 5.1 Strip any debug instrumentation introduced during smoke-testing this cycle (per saved feedback memory).
- [ ] 5.2 Final pass on each commit's diff.
- [ ] 5.3 **Edit (don't delete) CLAUDE.md hard rules — explicit anchor enumeration:**
  - **The "Terminal pane uses a raw PTY" rule:** path-references update `ui/terminal.js` → `ui/terminal/tab.js` for the regression-guard reference (`tests/integration/pty-plumbing.test.ts` baseline path stays).
  - **The dev-channels prompt auto-dismiss rule:** "terminal.js watches the PTY output stream for the literal string..." → "PtyEvents watches the PTY output stream for the literal string..." (the module name shifts; the behavior stays).
  - **The Tab cold-start regression-guard rule:** path-references drift; update.
  - **The `pty.rs` hard rule covering `pty_capture_turn`'s atomic three-layer geometry/pipe-pane/sentinel coordination:** the rule's "must have an integration test scenario covering the affected plumbing" clause now structurally enforced via `CaptureTransaction::Drop` + the panic-safe ordering. Update commentary to reflect this; the rule itself stays.
- [ ] 5.4 **Ship 2 ADRs as definite deliverables** (each REFERENCES design.md for full rationale and adds only post-implementation lessons — avoid duplicating design.md content):
  - **ADR-0007 — RAII over closure-defer in Rust for `CaptureTransaction`:** references design.md Decision 3. Adds: did the panic-test setup (catch_unwind + custom panic hook) uncover any Drop-ordering issues? Did any cleanup arm need to grow beyond the original three?
  - **ADR-0008 — `KindRenderer.placement` declarative string + per-placement dismiss matrix:** references design.md Decision 1. Adds: did the strawman renderers in pre-grill 0.2 confirm the strings shape was sufficient, or did one mode promote to a callback? Did a 4th placement mode appear during implementation? References ADR-0004 (orchestration shape) for context.
- [ ] 5.5 Verify ADRs 0001–0006 (from prior cycles) still describe current behavior; edit if drifted.
- [ ] 5.6 Run full smoke-test sweep: chat round-trip, all three Kind round-trips with proper KindCard placement + per-placement dismiss matrix, terminal cold-start, terminal reconnect, slash-command capture (success path), slash-command capture (timeout path), `tests/unit/kind-renderer.test.ts` passes, all three new contract tests pass.

## 6. Merge

- [ ] 6.1 `git log --oneline main..architecture-cycle-2b` shows the expected commits in dependency order.
- [ ] 6.2 Get explicit user greenlight to fast-forward main.
- [ ] 6.3 `git checkout main && git merge --ff-only architecture-cycle-2b`.
- [ ] 6.4 `git push origin main` (with explicit user permission).
- [ ] 6.5 `git branch -d architecture-cycle-2b`.
- [ ] 6.6 Run `/opsx:archive` to archive this OpenSpec change.
