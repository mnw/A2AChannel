## Context

`architecture-cycle-2a` (Hub-only) lands first — KindBase/KindStore (or fused `LedgerEntity`), HubFeature dispatcher + route module carve, Fanout, BriefingDispatcher, `cap.ids.mint` deletion. After 2a fast-forward-merges to main and soaks for **at least one week** with the long-running test agents (Drupal/Copernicus/Django/EIFE), this cycle starts.

The split was made because 1.5–2 weeks of test-agent install.sh churn would compound disruption. The 2a/2b boundary is the Hub|Webview boundary, which has no shared files. The two cycles share only the orchestration-shape decision from 2a's pre-grill 1.1 (which the Webview's `KindRenderer.placement` mirrors); otherwise they touch disjoint files.

This cycle (architecture-cycle-2b) targets two layers of friction 2a deliberately deferred:

1. **Webview has no Kind abstraction.** `ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js` each reimplement DOM mount/update/dismiss with `(id, version)` reconciliation. CSS is split between `ui/kinds/<kind>.css` per-Kind files and `ui/styles/chat.css` opportunistic rules. Adding a 4th Kind today means duplicating ~150 LOC of card lifecycle + spreading CSS across multiple files.
2. **`ui/terminal.js` is ~700 LOC** mixing Tab lifecycle, xterm binding, and PTY event handling — touched on every Tab feature change, every xterm bump, every PTY plumbing change.
3. **`pty_capture_turn` uses closure-defer for cleanup.** Three try-blocks + manual cleanup arms for geometry-set / pipe-pane / sentinel-watch. Fragile to early returns and panics. RAII via `Drop` is the idiomatic Rust shape.

Stakeholders: A2AChannel (single-developer codebase), the long-running test agents whose live sessions are the smoke-test surface — same as 2a.

## Goals / Non-Goals

**Goals:**

- Carve `KindRenderer` interface (`extractSnapshot` + `buildHeader` + `buildBody` + `buildActions` + `dispatch` + `placement`) and `KindCard` lifecycle owner in the Webview. Each `ui/kinds/<kind>.js` exports a renderer; `ui/main.js` delegates to `KindCard` instead of per-Kind direct DOM calls.
- Consolidate per-Kind CSS into `ui/styles/kinds.css` keyed by `data-kind`. `chat.css` shrinks to chat-pane concerns only; per-Kind `.css` files at `ui/kinds/<kind>.css` shrink substantially (truly Kind-specific quirks may remain).
- Split `ui/terminal.js` into `Tab` + `XtermBinder` + `PtyEvents` modules (gated by `tests/smoke/tab-lifecycle.md` checklist all-rows-pass).
- Rewrite `pty_capture_turn` around a `CaptureTransaction` struct with `Drop` cleanup. Tests assert `CaptureState` is restored on success / timeout / panic.
- Land each candidate as a discrete commit; smoke-test before the next starts.
- Strip any debug instrumentation introduced during the cycle before merge.

**Non-Goals:**

- **No Hub changes.** The Hub work is `architecture-cycle-2a`'s scope. 2b does not touch `hub/`.
- **No Channel sidecar changes.** `hub/channel/*` stays as-is.
- **No external API changes.** MCP tool names, HTTP route shapes, SSE event kinds, ledger schema, Tauri command shapes all preserved.
- **No new ledger migrations.** `LEDGER_SCHEMA_VERSION` stays at 11.
- **No framework introduction in `ui/index.html`.** Vanilla HTML/CSS/JS by choice (CLAUDE.md hard rule). `KindRenderer` is plain object literals + module exports, not a framework component.
- **No PTY-mode changes.** Still raw PTY, not `tmux -C` (CLAUDE.md hard rule). `CaptureTransaction` only restructures cleanup; the geometry/pipe-pane/sentinel mechanics stay identical.

## Decisions

### Decision 1: `KindRenderer.placement` is a declarative string, not a vtable

**Choice:** `KindRenderer` exports `placement: "stack" | "pin" | "append"`. `KindCard` reads the string and applies the corresponding placement strategy (Permission stacks bottom-pinned; Interrupt pins-then-moves to chat on ack; Handoff appends inline). No vtable of `placeAt(card, container)` callbacks per renderer.

**Alternatives considered:**
- Vtable: each renderer exports `place(card, container)` and `dismiss(card)` callbacks. Rejected — every renderer's `place` would be one of three near-identical implementations, with the choice baked into code rather than declared. Future Kind authors would have to read three existing renderers to know which placement they wanted.
- Single placement strategy with conditional logic in `KindCard`: rejected because the conditionals would be type-tagged (`if (kind === "permission") { ... }`), defeating the point of the abstraction.

**Rationale:** Three placement modes, ≤4 likely future Kinds. A string declaration is a literal taxonomy, not an extension point. If a 5th placement mode appears, then promote to a vtable; until then, strings are clearer at every call site.

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

### Decision 4: Sequential commits in dependency order; smoke-test gate between each

**Choice:** Land candidates as discrete commits in the order: `KindRenderer + KindCard` → `kinds.css consolidation` → `Tab/XtermBinder/PtyEvents split (gated)` → `CaptureTransaction (Rust)`. Each commit must compile + pass `bun x tsc --noEmit` (for JS modules with type assertions or generated types) + `cargo check` (for Rust commits) + drive the running app through the relevant scenarios before the next commits.

**Alternatives considered:** Batch the Webview commits into one. Rejected because `KindRenderer` lands first and is independently reviewable; CSS consolidation is mechanical; Tab-split has the highest risk and benefits from being the last Webview commit so the smoke-test surface is well-understood by then.

**Rationale:** Per saved feedback memory ("Architecture-skill cadence: per-candidate commits, manual smoke-test"). Each commit has a clean revert path.

## Risks / Trade-offs

- **Tab-split cold-start race regression risk.** v0.6 lost a week debugging `tmux -C` control mode; switching to raw PTY was the fix. The current `terminal.js` encodes hard-won knowledge about claude's MCP init timing (~10s window where `notifications/claude/channel` is silently dropped) and the dev-channels prompt auto-dismiss output-scan. → **Mitigation:** The smoke-checklist file (Decision 2) MUST include cold-start race scenarios. Tab-split commit gated on all observed-rows passing. If the checklist surfaces edge cases the split breaks, defer the Tab-split commit to a future cycle and ship cycle-2b with KindRenderer + CSS + CaptureTransaction only.

- **`CaptureTransaction` Drop ordering.** Cleanup arms today are: `pipe-pane -o off` → `set-option window-size` revert → sentinel-file delete (best-effort). Drop runs in declaration-order on struct fields. → **Mitigation:** Use a single field holding an enum or a Vec of cleanup actions executed in explicit order. Tests assert each cleanup arm runs on success / timeout / panic.

- **Long-running test agents are the smoke-test surface.** Same as 2a: install.sh restarts disrupt the test agents' work. → **Mitigation:** Per CLAUDE.md's "tmux sessions survive A2AChannel restart" rule, the agents reconnect cleanly. Group smoke-test cadence by minimizing redundant restarts. The KindRenderer commit can be smoke-tested without restarting test agents (Webview-only changes); the Tab-split absolutely cannot.

- **`ui/index.html` still has zero framework + zero bundler.** `KindRenderer` exports must work as plain ES module imports. → **Mitigation:** Strict ES module exports, no JSX, no TypeScript on the `.js` files (TS lives only in `hub/`).

## Migration Plan

### Dependency DAG

```
   ┌──────────────────────────────┐
   │ 0. Pre-grilling +            │
   │    smoke-checklist authoring │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 1. KindRenderer + KindCard   │
   └──────────┬───────────────────┘
              │
              ▼
   ┌──────────────────────────────┐
   │ 2. kinds.css consolidation   │
   └──────────┬───────────────────┘
              │
              ▼  (gated by smoke-checklist)
   ┌──────────────────────────────┐
   │ 3. Tab / XtermBinder /       │
   │    PtyEvents split           │
   └──────────┬───────────────────┘
              │  (independent, can run in parallel after 0)
              ▼
   ┌──────────────────────────────┐
   │ 4. CaptureTransaction (Rust) │
   └──────────────────────────────┘
```

**Hard dependencies:**
- 2 (CSS consolidation) depends on 1 (KindRenderer) — the Kind module structure is what tells us which CSS rules belong to which Kind.
- 3 (Tab-split) depends on the smoke-checklist artifact existing and being passable; technically independent of 1 + 2 but smoke-tested last because it's highest-risk.
- 4 (CaptureTransaction) is independent of 1/2/3 — Rust only, no Webview crossover. Can land first if the Webview gate (smoke-checklist) needs more time.

**Intermediate states the plan accepts:**
- After 1 lands but before 2: per-Kind CSS still in `chat.css`. Renderer files import classes that exist in chat.css. Fine; the consolidation commit is mechanical.
- After 2 lands but before 3: terminal.js untouched. Fine; it's an independent file.
- After 4 lands but before 3: Rust capture transactional but Tab still monolithic. Fine; PTY layer changes don't touch Tab.

### Steps

1. **Branch:** `architecture-cycle-2b` off main, after 2a is fast-forward-merged + soaked for one week. Per saved feedback memory, branch is short-lived: created → commits land → ff-merge → delete.
2. **Pre-grill:**
   - Confirm `KindRenderer.placement` string set is sufficient for current 3 Kinds (write the strawman renderer for handoff, interrupt, permission and verify each lands at the right place); record outcome in design.md if grilling produces a refinement.
   - Author `tests/smoke/tab-lifecycle.md` with 4 scenarios: cold-start race (claude MCP init ~10s window where notifications/claude/channel is dropped), reconnect storm (close + reopen tab N times in <500ms), theme-change refit (toggle dark/light, verify xterm columns refit), kill+respawn (kill claude pid, verify tab cleans up + can respawn). Each scenario row has columns: `expected` / `observed` / `pass-fail`.
3. **Webview commits in order:**
   1. `feat(ui): KindRenderer interface + KindCard lifecycle owner`
   2. `style(ui): consolidate per-Kind CSS into ui/styles/kinds.css`
   3. `feat(ui): split terminal.js into Tab + XtermBinder + PtyEvents (gated)` — gate is the smoke-checklist all observed-rows passing
4. **Rust commit:**
   1. `feat(pty): CaptureTransaction with Drop cleanup; tests assert CaptureState`
5. **Each commit:** type-check (`bun x tsc --noEmit` if applicable) + Rust commits add `cargo check` + `./scripts/install.sh` + manual smoke-test of the affected flow. No commit lands without these green.
6. **Post-cycle:** Strip any debug instrumentation introduced during smoke-testing. Final pass on each commit's diff before merge.
7. **Ship 2 ADRs alongside the cycle:** ADR-0007 (RAII over closure-defer in Rust for `CaptureTransaction`), ADR-0008 (`KindRenderer.placement` declarative string vs vtable). These are definite deliverables.
8. **Merge:** Fast-forward `main` to `architecture-cycle-2b`. Delete the branch. CLAUDE.md updates: edit (don't delete) the "Terminal pane uses a raw PTY" rule's commentary to reflect the new Tab/XtermBinder/PtyEvents shape; the rule itself stays. Edit any path-references that drift (`ui/terminal.js` → `ui/terminal/tab.js` etc.).
9. **Rollback:** Each commit is independently revertable. Worst-case: revert from the most recent commit backward; prior commits stay landed. The CaptureTransaction commit is the most isolated (Rust-only); the Tab-split is the riskiest and is the gate point.

## Open Questions

- **Does `KindCard` need a `version` field on the DOM, or does the renderer track it internally?** Likely renderer-internal — the DOM doesn't need to surface version for any user-facing feature. Confirm during grilling 0.
- **Does `XtermBinder` own the resize-cycle SIGWINCH dance for dev-channels prompt auto-dismiss, or does that stay in `PtyEvents` (which sees the output stream)?** Argument for both ways; default to `PtyEvents` (output-scan triggers SIGWINCH; SIGWINCH is a PTY event, not an xterm event) unless smoke-testing reveals a cleaner shape.
- **Should the `tests/smoke/tab-lifecycle.md` checklist add a 5th scenario for `pty_capture_turn` interaction?** Capture is invoked from the chat composer's slash-command flow, not the Tab itself, so probably not — but verify during grilling that no Tab-lifecycle event interrupts an in-flight capture.
