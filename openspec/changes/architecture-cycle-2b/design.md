## Context

`architecture-cycle-2a` (Hub-only) lands first — `LedgerEntity` (chosen via the pre-grill 1.1 hybrid shape), `HubFeature` dispatcher + 7 route-module carves, `Fanout`, `BriefingDispatcher`, `cap.ids.mint` deletion. After 2a fast-forward-merges to main and soaks for **at least one week** with the long-running test agents (Drupal/Copernicus/Django/EIFE), this cycle starts.

The split was made because 1.5–2 weeks of test-agent install.sh churn would compound disruption. The 2a/2b boundary is the Hub|Webview boundary, which has no shared files. The two cycles share only the orchestration-shape decision from 2a's pre-grill 1.1 (which the Webview's `KindRenderer.placement` mirrors); otherwise they touch disjoint files.

This cycle (architecture-cycle-2b) targets five layers of friction (three deferred from 2a; two added by post-2a code-audit):

1. **Webview has no Kind abstraction AND uses a classic-`<script>` shared-lexical-scope arrangement.** `ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js` each reimplement DOM mount/update/dismiss with `(id, version)` reconciliation. They share `ui/main.js`'s lexical scope via classic `<script>` load order — 12+ globals (`messagesEl`, `authedFetch`, `parseErrorBody`, `askReason`, `escHtml`, `HUMAN_NAME`, `addMessage`, `trimMessages`, `updateCountdownLabel`, `handoffCards`, `interruptCards`, `permissionCards`) — no module boundary, no exports.
2. **Per-Kind CSS spans 5 sources, 380+ LOC.** `ui/kinds/handoff.css` (112 LOC), `ui/kinds/interrupt.css` (86 LOC), `ui/kinds/permission.css` (183 LOC), the shared skeleton in `ui/styles/card.css` (67 LOC, holds `.handoff-card / .interrupt-card / .permission-card` grid+border+padding), and `ui/features/rooms.js` lines 125-127 (runtime-injected room-filter CSS that hard-codes the per-Kind class names). `ui/styles/chat.css` is already clean of Kind-specific rules — earlier audit framing of "rules grew opportunistically in chat.css" was incorrect.
3. **`ui/terminal.js` is 873 LOC** mixing Tab lifecycle, xterm binding, and PTY event handling — touched on every Tab feature change, every xterm bump, every PTY plumbing change.
4. **`pty_capture_turn` uses closure-defer for cleanup.** Three try-blocks + manual cleanup arms for geometry-set / pipe-pane / sentinel-watch. Fragile to early returns and panics. RAII via `Drop` is the idiomatic Rust shape.
5. **`Composer` send mode is implicit; three send paths coupled through DOM state.** `ui/features/composer.js` branches three modes (chat → Hub `/post`, slash → Tauri `pty_write`, shift-tab → escape codes) but the dispatch decision lives in `_refreshSlashState`'s mutation of `sendBtn.disabled` based on `input.value` + `SELECTED_ROOM`. Mid-keystroke state mutations can flip the active mode underneath the user. The Interface ("send a thing") is implicit; mode is a derived, fragile property of DOM state.
6. **`pty_spawn` is a 63-LOC orchestrator with a silent-failure path** (`let _ = tmux_run(...)` at line 369 swallows errors from `configure_existing_session`). Six concerns interleaved inline (validation, room resolution, registry idempotency, MCP-config materialization, locale resolution, session-existing-vs-new branching, tmux argv assembly, attach). Argv assembly bugs (the kind that broke v0.6 with quoted-path splitting) are buried inline rather than at a named seam. CLAUDE.md mandates per-helper test scenarios for `resolve_utf8_locale`, `configure_existing_session`, `attach_and_stream` — but the orchestrator that sequences them has no integration test (verified — `tests/integration/pty-plumbing.test.ts` never calls `pty_spawn` end-to-end).

Stakeholders: A2AChannel (single-developer codebase), the long-running test agents whose live sessions are the smoke-test surface — same as 2a.

## Goals / Non-Goals

**Goals:**

- Carve `KindRenderer` interface (`extractSnapshot` + `mount` + `dispatch` + `placement`; pre-grill 0.2 re-evaluates whether to split `mount` into `buildHeader/Body/Actions` — see Decision 1) and `KindCard` lifecycle owner in the Webview.
- Migrate `ui/main.js` + `ui/kinds/*.js` to ES modules with a `ctx` factory pattern that mirrors the Hub-side `cap` idiom. Replaces today's classic-`<script>` shared-lexical-scope arrangement.
- Consolidate per-Kind CSS from `ui/kinds/<kind>.css` (3 files, 381 LOC) + `ui/styles/card.css` (67 LOC shared skeleton) into `ui/styles/kinds.css` keyed by `[data-kind]`. Migrate `ui/features/rooms.js`'s runtime-injected room-filter CSS to use `[data-kind][data-room]` selectors instead of hardcoded `.handoff-card[data-room]` strings.
- Split `ui/terminal.js` (873 LOC) into `Tab` + `XtermBinder` + `PtyEvents` modules (gated by `tests/smoke/tab-lifecycle.md` checklist all-rows-pass).
- Rewrite `pty_capture_turn` around a `CaptureTransaction` struct with `Drop` cleanup. Tests assert `CaptureState` is restored on success / timeout / panic.
- Carve `Composer` Module emitting `SendIntent` discriminated union (`chat | slash | shift-tab`). Three single-purpose adapters consume the intent. Mode detection returns the discriminator instead of mutating `sendBtn.disabled` across modes.
- Extract `build_spawn_argv` + `ensure_session_configured` from `pty_spawn`. Replace the silent `let _ = tmux_run(...)` with a `Result<bool, String>` propagation. Add the missing orchestrator-level integration test scenario.
- Land each candidate as a discrete commit; smoke-test before the next starts.
- Strip any debug instrumentation introduced during the cycle before merge.

**Non-Goals:**

- **No Hub changes.** The Hub work is `architecture-cycle-2a`'s scope. 2b does not touch `hub/`.
- **No Channel sidecar changes.** `hub/channel/*` stays as-is.
- **No external API changes.** MCP tool names, HTTP route shapes, SSE event kinds, ledger schema, Tauri command shapes all preserved.
- **No new ledger migrations.** `LEDGER_SCHEMA_VERSION` stays at 12 (post-2a value).
- **No framework introduction in `ui/index.html`.** Vanilla HTML/CSS/JS by choice (CLAUDE.md hard rule). `KindRenderer` is plain object literals + module exports, not a framework component. The `<script>`-with-shared-lexical-scope arrangement is leaving — but that's a load-style change (classic `<script>` → ES module), not a framework introduction.
- **No PTY-mode changes.** Still raw PTY, not `tmux -C` (CLAUDE.md hard rule). `CaptureTransaction` only restructures cleanup; the geometry/pipe-pane/sentinel mechanics stay identical.

## Decisions

### Decision 1: `KindRenderer.placement` is a declarative string with per-placement dismiss policy; renderer shape settled at pre-grill

**Choice — placement strings:** `KindRenderer` exports `placement: "stack" | "pin" | "append"`. `KindCard` reads the string and applies the corresponding placement strategy.

**Choice — per-placement dismiss matrix:**

| Placement | Mount target | On terminal status |
|---|---|---|
| `"append"` | inline chat-message stream | leave card in place; renderer applies a terminal-status class for visual styling (matches today's handoff behavior — accepted/declined cards stay visible with a status badge) |
| `"pin"` | sticky pinned region at chat scroll bottom | move card from pinned region into inline message stream as a normal message (matches today's interrupt: `pending` is pinned, `acknowledged` migrates inline) |
| `"stack"` | dedicated stack region at chat-pane bottom | remove card from stack (matches today's permission: terminal-state permissions disappear from the stack; the audit trail lives in the events table) |

This matrix lives ON `KindCard`'s placement-strategy implementation, NOT on individual renderers. Renderers do NOT need a `dismiss` callback — the placement string + terminal-status detection is sufficient. If a future Kind needs custom dismiss behavior, promote to a per-renderer `onDismiss(card, snapshot): "remove" | "move-inline" | "keep-with-class"` hook.

**Choice — renderer methods (settled at pre-grill 0.2):** Default strawman is a single `mount(snapshot, container, dispatch): void` per renderer plus the `extractSnapshot` + `dispatch` + `placement` fields. The 4-builder split (`buildHeader` / `buildBody` / `buildActions`) is rejected unless pre-grill demonstrates `KindCard` needs to inject shared chrome BETWEEN sections (today it doesn't — header/body/actions are all painted by the Kind). The 4-builder shape would require every Kind to author 4 builders even when 3 do trivial DOM, which is over-decomposition.

**Snapshot shape (declared explicitly):** `Snapshot = { id: string; version: number; status: string; [key: string]: unknown }`. `KindCard` requires the first three fields for its lifecycle: `id` for the per-card map key, `version` for newer-wins reconciliation, `status` for terminal-status detection (per-placement dismiss matrix). Per-Kind extension fields ride on the index signature.

**Alternatives considered (placement strategy):**
- Vtable: each renderer exports `place(card, container)` and `dismiss(card)` callbacks. Rejected — every renderer's `place` would be one of three near-identical implementations (today's per-Kind code); the choice is baked into a value rather than declared. Future Kind authors would have to read three existing renderers to know which placement they wanted. **However:** this rejection is partial — if "stack" requires Kind-specific DOM (today's permission-stack uses `getPermissionStack()` to find-or-create a sticky element by id), the strings shape relies on `KindCard` knowing how to do "stack" generically. Pre-grill 0.2 must verify `KindCard` can implement all three placement modes from the string alone; if any mode genuinely needs per-Kind DOM, promote that one to a callback while keeping strings for the rest.
- Single placement strategy with conditional logic in `KindCard`: rejected because the conditionals would be type-tagged (`if (kind === "permission") { ... }`), defeating the point of the abstraction.

**Rationale:** Three placement modes, no fourth in sight. A string declaration is a literal taxonomy, not an extension point. If a 5th placement mode appears, then promote to a vtable; until then, strings are clearer at every call site.

### Decision 2: `Tab` / `XtermBinder` / `PtyEvents` split is gated by a literal smoke-checklist file

**Choice:** Before the Tab-split commit lands, `tests/smoke/tab-lifecycle.md` MUST exist with the four scenarios filled in (cold-start race, reconnect storm, theme-change refit, kill+respawn) and the "observed" rows MUST be all-passing under manual exercise. The file ships as a tracked artifact in the repo.

**Alternatives considered:**
- jsdom + fake xterm headless harness: real future leverage but real cost (multi-day to land); 2b doesn't earn it yet.
- No gate beyond manual smoke-test: rejected — terminal.js bugs surface at PTY/xterm/tmux interfaces and are hard to recover from once shipped (sessions get stuck, agents drop, cold-start race v0.6 was painful). A literal checklist file forces the test scenarios to be enumerated and reviewed before code lands.

**Rationale:** Per the saved feedback memory ("Architecture-skill cadence: per-candidate commits, manual smoke-test"), the cycle is gated by manual confidence anyway. Capturing that confidence as a checklist file makes it auditable and creates the seed for a future jsdom harness without committing to it now.

### Decision 3: `CaptureTransaction` uses `Drop` (RAII), not a `with_capture(|tx| {...})` closure helper

**Choice:** `CaptureTransaction` struct holds owned state for geometry-set + pipe-pane-on + sentinel-watch. `Drop` impl runs cleanup unconditionally. `pty_capture_turn` constructs the transaction and discards it on every exit path (success, timeout, panic). No closure-helper API.

**Alternatives considered:**
- `with_capture(opts, |tx| -> Result<T>) -> Result<T>` closure helper: explicit lexical scoping of cleanup. Rejected — the closure would have to return `Result` and the caller chain would be `with_capture(opts, |tx| { tx.write_input(input)?; tx.wait_for_sentinel(timeout)?; tx.read_output() })`. Cleanup-on-panic still requires a `Drop` impl on `tx` for safety; the closure adds nothing once `Drop` is in place.
- Manual cleanup blocks (today's shape): rejected — the entire point of the cycle is to fix this.

**Rationale:** RAII is idiomatic Rust. `Drop` runs on every exit including panic. The closure form would compose `Drop` with a closure for ergonomic clarity gain that doesn't materialize once `Drop` does the heavy lifting.

### Decision 4: ES-module migration with a `ctx` factory pattern (not free imports from `main.js`)

**Choice:** Today's `<script>`-with-shared-lexical-scope arrangement migrates to ES modules. Each Kind exports `createXRenderer(ctx): KindRenderer` — a factory taking a `ctx` object that carries the helpers the renderer needs. `main.js` constructs `ctx` once at startup and hands it to each renderer factory.

**Alternatives considered:**
- **Free imports from main.js:** `import { messagesEl, authedFetch, ... } from './main.js'` in each Kind module. Rejected because main.js becomes a giant export surface (12+ named exports), the per-Kind modules acquire a hardcoded import dependency on every helper they use, and unit-testing a renderer requires mocking those imports.
- **Globals on `window`:** Rejected — bypasses the module system, just a renamed `<script>` shared-scope.
- **`ctx` factory pattern (chosen):** mirrors the Hub-side `cap` idiom. `KindRenderer` factories receive a `ctx` object explicitly; tests construct a fake `ctx` and pass it in. Side benefit: the contract surface for "what does a renderer need from main.js" is one explicit object, not 12+ implicit globals.

**Rationale:** The `ctx` pattern is the project's idiom (Hub side uses `cap`; Webview should mirror it). Sub-millisecond unit tests of `extractSnapshot` / `dispatch` become possible without DOM (just a fake `ctx` with `authedFetch: jest.fn()`).

### Decision 5: Composer SendIntent is a discriminated union, not a mode flag

**Choice:** `Composer` Module exposes `detectIntent(inputState): SendIntent` returning one of three discriminated arms:
- `{ mode: "chat", target: string, text: string, attachments?: Attachment[] }`
- `{ mode: "slash", agent: string, command: string, args: string[] }`
- `{ mode: "shift-tab", target: string }`

A separate `dispatch(intent: SendIntent): Promise<void>` reads the discriminator and routes to one of three per-mode adapter functions (`sendChat`, `sendSlash`, `sendShiftTab`) that own validation + the actual send. `_refreshSlashState` collapses into a pure `detectIntent` call that returns the discriminator; the Send button's `disabled` state derives from the discriminator (single decision, single source).

**Alternatives considered:**
- **Mode flag (status quo):** `currentMode = "chat" | "slash" | "shift-tab"` set by `_refreshSlashState` mutating shared state. Rejected — the bug pattern (mid-keystroke flip from chat to slash) is exactly the failure mode that discriminated unions eliminate at the type level.
- **Three completely separate Composer instances:** rejected — they share input state (the `<textarea>`, attachments tray, target room). Forking into three Composers would duplicate input-handling code.
- **Single `send(input)` with internal branching:** rejected — internal branching is the status quo; the seam isn't where the orchestration lives.

**Rationale:** Discriminated unions make mode an explicit property of the value, not an emergent property of DOM state. The three adapters are independently testable: passing a constructed `{ mode: "slash", agent: "alice", ... }` to `sendSlash` exercises the path without DOM. Adding a fourth send mode (e.g. file-drop send) is a new arm + new adapter, not surgery on `_refreshSlashState`.

### Decision 6: Two extractions from `pty_spawn` + one new integration test

**Choice:** Extract two named seams from `pty_spawn`:
- `build_spawn_argv(agent: &str, cwd: &str, api_key: Option<&str>, lang: &str, spawn_cmd: &str, session_existed: bool) -> Vec<String>` — pure tmux argv assembly. Today's inline lines 375-394; argv-related bugs (v0.6's quoted-path splitting) live here.
- `ensure_session_configured(agent: &str, lang: &str) -> Result<bool, String>` — replaces the silent `let _ = tmux_run(...)` at line 369. Returns `Ok(true)` when an existing session was reconfigured (forced `remain-on-exit off`), `Ok(false)` when a new session must be created, `Err(msg)` when the tmux command itself failed.

After extraction, `pty_spawn` is ~20 LOC of clear sequencing: validate name → resolve room → registry check → materialize MCP config + settings → ensure-configured → build argv → spawn (or attach existing) → `attach_and_stream`.

Add one integration scenario to `tests/integration/pty-plumbing.test.ts`: "spawn → tmux session created with `remain-on-exit off` and `LANG` env set" (the missing orchestrator-level test that CLAUDE.md's per-helper rule was designed to prevent).

**Alternatives considered:**
- **Single `spawn_orchestration(...)` extraction:** rejected — would just rename the god function. The named-seam payoff comes from extracting the two atomic operations (argv build + ensure-configured) so each gets its own focused test.
- **Keep `let _ = tmux_run(...)`:** rejected — silent failure is exactly the bug class CLAUDE.md's pty.rs hard rule was written to prevent.
- **Rewrite `pty_spawn` from scratch:** rejected — over-scope. The shape is correct; only the inline-orchestration noise needs to leave.

**Rationale:** Two helpers + one orchestrator-level integration test closes the gap CLAUDE.md's per-helper rule was designed to prevent (every helper has a test, but the orchestrator that sequences them doesn't). Argv bugs become localized to a 20-LOC pure function that takes string arguments and returns a `Vec<String>` — sub-millisecond test surface, no tmux required.

### Decision 7: Sequential commits in dependency order; smoke-test gate between each

**Choice:** Land candidates as discrete commits in the order: `KindRenderer + KindCard (with ES-module migration)` → `kinds.css consolidation (incl. card.css fold + rooms.js migration)` → `Composer SendIntent` → `Tab/XtermBinder/PtyEvents split (gated)` → `pty_spawn extractions + orchestrator test` → `CaptureTransaction (Rust)`. Each commit must compile + pass `bun x tsc --noEmit` (for JS modules with type assertions or generated types) + `cargo check` (for Rust commits) + drive the running app through the relevant scenarios before the next commits.

**Alternatives considered:** Batch the Webview commits into one. Rejected because each carve is independently reviewable; CSS consolidation is mechanical; Composer SendIntent is independent of KindRenderer (different file); Tab-split has the highest risk and benefits from being the last Webview commit so the smoke-test surface is well-understood by then. The two Rust commits land in either order — `pty_spawn` extractions are independent of `CaptureTransaction` (different functions, different concerns).

**Rationale:** Per saved feedback memory ("Architecture-skill cadence: per-candidate commits, manual smoke-test"). Each commit has a clean revert path.

## Risks / Trade-offs

- **2a's structural completion is a substantive gate, not just temporal.** 2b's `KindRenderer` mirrors 2a's `LedgerEntity` orchestration shape via the `Decision`-discriminated union and the snapshot-versioning invariants. If 2a's shape changes during cleanup (e.g., post-2a corrections to the `KindModule extends HubFeature` literal-intersection, or the `Decision.create` arm semantics), 2b's `KindRenderer/KindCard` contract may need to follow. → **Mitigation:** Re-grill at the start of 2b's pre-grilling phase against the THEN-CURRENT 2a code, not against the 2a design at split-time.

- **Tab-split cold-start race regression risk.** v0.6 lost a week debugging `tmux -C` control mode; switching to raw PTY was the fix. The current `terminal.js` encodes hard-won knowledge about claude's MCP init timing (~10s window where `notifications/claude/channel` is silently dropped) and the dev-channels prompt auto-dismiss output-scan. → **Mitigation:** The smoke-checklist file (Decision 2) MUST include cold-start race scenarios. Tab-split commit gated on all observed-rows passing. If the checklist surfaces edge cases the split breaks, defer the Tab-split commit to a future cycle and ship cycle-2b with KindRenderer + CSS + CaptureTransaction only.

- **`CaptureTransaction` Drop ordering.** Cleanup arms today are: `pipe-pane -o off` → `set-option window-size` revert → sentinel-file delete (best-effort). Drop runs in declaration-order on struct fields. → **Mitigation:** Use a single field holding an enum or a Vec of cleanup actions executed in explicit order. Tests assert each cleanup arm runs on success / timeout / panic.

- **Panic-path test for `CaptureTransaction` is non-trivial.** Rust's default test runner aborts on panic. To assert that `Drop` runs on panic without crashing the test, the test must install a `std::panic::catch_unwind` boundary, optionally a `std::panic::set_hook` to suppress the test-runner's default panic message, and ensure the injected panic doesn't poison shared mutexes used by other tests. → **Mitigation:** Budget half a day for the panic test alone. Tasks 4.7 explicitly references the catch_unwind requirement.

- **Long-running test agents are the smoke-test surface.** Same as 2a: install.sh restarts disrupt the test agents' work. → **Mitigation:** Per CLAUDE.md's "tmux sessions survive A2AChannel restart" rule, the agents reconnect cleanly. Group smoke-test cadence by minimizing redundant restarts. The KindRenderer commit can be smoke-tested without restarting test agents (Webview-only changes); the Tab-split absolutely cannot.

- **`ui/index.html` still has zero framework + zero bundler.** `KindRenderer` exports must work as plain ES module imports. → **Mitigation:** Strict ES module exports, no JSX, no TypeScript on the `.js` files (TS lives only in `hub/`). The `ctx` factory pattern (Decision 4) keeps the surface explicit and TypeScript-friendly should we later introduce `.d.ts` files for the `.js` modules.

## Migration Plan

### Dependency DAG

```
   ┌──────────────────────────────┐
   │ 0. Pre-grilling +            │
   │    smoke-checklist authoring │
   └──────────┬───────────────────┘
              │
              ▼
   ┌─────────────────────────────────────┐
   │ 1. KindRenderer + KindCard +        │
   │    ES-module migration (ctx)        │
   └──────────┬──────────────────────────┘
              │
              ▼
   ┌─────────────────────────────────────┐
   │ 2. kinds.css consolidation          │
   │    (5 sources → 1; card.css fold;   │
   │     rooms.js [data-kind] migration) │
   └──────────┬──────────────────────────┘
              │
              ▼  (independent of 1+2; can run in parallel after 0)
   ┌──────────────────────────────┐
   │ 3. Composer SendIntent       │
   │    + per-mode adapters       │
   └──────────┬───────────────────┘
              │  (gated by smoke-checklist)
              ▼
   ┌──────────────────────────────┐
   │ 4. Tab / XtermBinder /       │
   │    PtyEvents split           │
   └──────────┬───────────────────┘
              │
              ▼  (Rust; independent of Webview commits)
   ┌──────────────────────────────────────┐
   │ 5. pty_spawn extractions + orch test │
   └──────────┬───────────────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 6. CaptureTransaction (Rust) │
   └──────────────────────────────┘
```

**Hard dependencies:**
- 1 (KindRenderer) requires the ES-module migration to land in the same commit — they're inseparable; the renderer factories can't run alongside classic-`<script>` shared-lexical-scope.
- 2 (CSS consolidation) depends on 1 — the Kind module structure is what tells us which CSS rules belong to which Kind.
- 3 (Composer SendIntent) is independent of 1/2 — different file, different concern. Can land in parallel after pre-grill 0.
- 4 (Tab-split) depends on the smoke-checklist artifact existing and being passable; technically independent of 1/2/3 but smoke-tested last in the Webview cluster because it's highest-risk.
- 5 (pty_spawn extractions) and 6 (CaptureTransaction) are both Rust, both in `pty.rs`, but touch different functions — they can land in either order. Independent of 1/2/3/4. The pty_spawn extraction lands first when the orchestrator test scaffolding (catch_unwind harness for #6's panic test) is still being figured out — extracting first defers the test-harness lift.

**Intermediate states the plan accepts:**
- After 1 lands but before 2: per-Kind CSS still in `ui/kinds/<kind>.css` + `card.css` + `rooms.js`. Renderer files set `data-kind` on cards but the existing per-Kind class names still work too. Fine; the consolidation commit is mechanical.
- After 2 lands but before 4: terminal.js untouched. Fine; it's an independent file.
- After 3 lands but before 4: Composer is mode-discriminated but terminal still monolithic. Fine; different files.
- After 5 lands but before 6: pty.rs is half-cleaned (spawn refactored, capture still inline). Fine; concerns are disjoint.
- After 6 lands but before 4: Rust capture transactional but Tab still monolithic. Fine; PTY layer changes don't touch Tab.

### Steps

1. **Branch:** `architecture-cycle-2b` off main, after 2a is fast-forward-merged + soaked for one week. Per saved feedback memory, branch is short-lived: created → commits land → ff-merge → delete.
2. **Pre-grill:**
   - Confirm `KindRenderer.placement` string set is sufficient for current 3 Kinds (write the strawman renderer for handoff, interrupt, permission and verify each lands at the right place; verify `KindCard` can implement all three placement modes from the string alone, OR identify modes that need per-Kind DOM and promote those to callbacks).
   - Confirm the `ctx` factory pattern: enumerate the actual `ctx` shape by grep'ing today's per-Kind `<script>`s for the names they reference from main.js's lexical scope.
   - Confirm whether `mount` should split into `buildHeader/Body/Actions` (only earned if `KindCard` injects shared chrome between sections; today it doesn't).
   - Author `tests/smoke/tab-lifecycle.md` with 4 scenarios: cold-start race (claude MCP init ~10s window where notifications/claude/channel is dropped), reconnect storm (close + reopen tab N times in <500ms), theme-change refit (toggle dark/light, verify xterm columns refit), kill+respawn (kill claude pid, verify tab cleans up + can respawn). Each scenario row has columns: `expected` / `observed` / `pass-fail`.
3. **Webview commits in order:**
   1. `feat(ui): KindRenderer + KindCard + ES-module migration with ctx factory`
   2. `style(ui): consolidate per-Kind CSS into ui/styles/kinds.css (incl. card.css fold + rooms.js [data-kind] migration)`
   3. `refactor(ui): Composer SendIntent discriminated union + per-mode adapters`
   4. `feat(ui): split terminal.js into Tab + XtermBinder + PtyEvents (gated)` — gate is the smoke-checklist all observed-rows passing
4. **Rust commits:**
   1. `refactor(pty): extract build_spawn_argv + ensure_session_configured from pty_spawn; surface tmux-run errors via Result; add orchestrator integration test`
   2. `feat(pty): CaptureTransaction with Drop cleanup; tests assert CaptureState`
5. **Each commit:** type-check (`bun x tsc --noEmit` if applicable) + Rust commits add `cargo check` + `./scripts/install.sh` + manual smoke-test of the affected flow + (for the KindRenderer commit) `tests/unit/kind-renderer.test.ts` passes. No commit lands without these green.
6. **Post-cycle:** Strip any debug instrumentation introduced during smoke-testing. Final pass on each commit's diff before merge.
7. **Ship 4 ADRs alongside the cycle:** ADR-0007 (RAII over closure-defer in Rust for `CaptureTransaction`), ADR-0008 (`KindRenderer.placement` declarative string vs vtable + the per-placement dismiss matrix), ADR-0009 (Composer SendIntent discriminated union vs mode flag), ADR-0010 (pty_spawn extractions + the missing orchestrator integration test that closes CLAUDE.md's per-helper-rule gap). ADRs reference design.md for the full rationale and add only post-implementation lessons.
8. **Merge:** Fast-forward `main` to `architecture-cycle-2b`. Delete the branch. **CLAUDE.md anchors to update (enumerated):** the dev-channels prompt auto-dismiss rule (`terminal.js watches the PTY output stream...` → `PtyEvents watches the PTY output stream...`); the Tab cold-start regression-guard rule's path; the "raw PTY, not tmux -C" rule's commentary if `attach_and_stream` shape shifts; the `pty.rs` hard rule covering `pty_capture_turn`'s atomic three-layer geometry/pipe-pane/sentinel coordination — now structurally enforced by `CaptureTransaction::Drop`.
9. **Rollback:** Each commit is independently revertable. Worst-case: revert from the most recent commit backward; prior commits stay landed. The CaptureTransaction commit is the most isolated (Rust-only); the Tab-split is the riskiest and is the gate point.

## Open Questions

- **Does `KindCard` need a `version` field on the DOM, or does the renderer track it internally?** Likely renderer-internal — the DOM doesn't need to surface version for any user-facing feature. Confirm during grilling 0.
- **Does `XtermBinder` own the resize-cycle SIGWINCH dance for dev-channels prompt auto-dismiss, or does that stay in `PtyEvents` (which sees the output stream)?** Argument for both ways; default to `PtyEvents` (output-scan triggers SIGWINCH; SIGWINCH is a PTY event, not an xterm event) unless smoke-testing reveals a cleaner shape.
- **Should the `tests/smoke/tab-lifecycle.md` checklist add a 5th scenario for `pty_capture_turn` interaction?** Capture is invoked from the chat composer's slash-command flow, not the Tab itself, so probably not — but verify during grilling that no Tab-lifecycle event interrupts an in-flight capture.
- **Is the `ctx` shape for renderer factories the same across all three Kinds, or do they need different ctx subsets?** Default is one shared `ctx` shape; pre-grill verifies via the strawman whether any Kind needs a field the others don't (in which case extra fields are fine — TypeScript-flavor structural typing handles "this Kind uses fewer fields").

## Closing — last planned architectural cycle

**2b is the planned terminus of the architecture-skill arc.** No `architecture-cycle-2c` is on the roadmap. The post-2a code audit surfaced six deepening opportunities; two (#1 Kind cards triplicated, #6 SSE event dispatch) were already covered by 2b's `kind-rendering` capability. Two (#4 Composer mode dispatch, #5 `pty_spawn` extractions) are folded into this cycle. The remaining two (#2 `paths.rs` carve, #3 `AppConfig` struct collapse) are explicitly **filed as known friction, not actioned** — catalogued in `docs/architecture/known-friction.md`.

**Rationale:** The architecture-skill cadence has high cost on this single-developer codebase. Cycle 2a took ~2 weeks of test-agent disruption to fix CLAUDE.md hard rules that had degraded into convention-enforced invariants. 2b's ~3 weeks (6 commits + 1-week soak + 1-week test-agent settle) close the remaining load-bearing items (Webview KindRenderer parity with the Hub-side LedgerEntity carve from 2a; Composer mode-discrimination bug class; the `pty_spawn` silent-failure correctness gap). Beyond 2b, every audit finding lands at the polish end of the curve — LOC reductions, test-surface improvements, organizational cleanups. None of them address bug classes or convention-enforced invariants. Continuing the architecture-skill loop would consume feature-delivery time on diminishing-return cleanups.

**Discipline rule for future audits (recorded for self-enforcement):** Audit findings get filed in `docs/architecture/known-friction.md`. A finding becomes a cycle only if it meets at least one of:
- Addresses a CLAUDE.md hard rule currently convention-enforced.
- Eliminates a real production bug class observed in the wild.
- Closes a structural gap in test coverage that the per-helper rule was explicitly designed to prevent (the gap #5 closes).

Audits that surface only LOC-reduction, test-surface, or organizational-locality improvements DO NOT trigger cycles — they accumulate in the friction log. If `lib.rs` or `pty.rs` is being touched for an unrelated feature reason, opportunistically address the relevant friction entries while you're already there. Don't open a refactor branch for them.
