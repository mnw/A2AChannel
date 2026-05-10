## Why

`architecture-cycle-2a` (Hub-only) lands first and soaks for a week before this cycle starts. Two layers of friction remain that 2a deliberately deferred to keep test-agent disruption bounded: the **Webview** has no Kind abstraction (each Kind reimplements card creation/update/teardown across `interrupt.js`, `handoff.js`, `permission.js` with per-Kind CSS scattered between three files) and **`src-tauri/src/pty.rs`'s `pty_capture_turn` uses closure-defer for cleanup** of the geometry/pipe-pane/sentinel triplet, which is fragile to early returns and panics. This cycle carves the Webview `KindRenderer` + `KindCard` lifecycle, consolidates per-Kind CSS into `ui/styles/kinds.css`, splits `terminal.js` into `Tab` + `XtermBinder` + `PtyEvents`, and rewrites `pty_capture_turn` around a `CaptureTransaction` with `Drop` cleanup.

## What Changes

- **Carve `KindRenderer` interface + `KindCard` lifecycle owner in the Webview.** Each Kind module exports a `KindRenderer` (mount, update-by-version, dismiss) instead of imperatively manipulating DOM nodes. `KindCard` owns the per-card lifecycle (create on first version, update by `(id, version)` with newer-wins, dismiss on terminal status). Placement (Permission stacks bottom-pinned, Interrupt pins-then-moves, Handoff appends inline) declared as `placement: "stack" | "pin" | "append"` strings on the renderer (decision lives in this cycle's design.md Decision 1; pre-grill 0.2 verifies it against the three current Kinds before code lands).
- **Consolidate per-Kind CSS into `ui/styles/kinds.css`.** Move `.handoff-card`, `.interrupt-card`, `.permission-card` rules out of `chat.css` (where they grew opportunistically) into a dedicated kinds stylesheet. `chat.css` shrinks to chat-pane concerns only.
- **Split `ui/terminal.js` into `Tab` + `XtermBinder` + `PtyEvents` (gated).** Today's `terminal.js` is ~700 LOC mixing Tab lifecycle (cold-start / reconnect / kill+respawn), xterm.js binding (write/refit/theme), and PTY event handling (output / exit / resize). Carve into three modules with clear seams. Gate by the smoke-checklist file `tests/smoke/tab-lifecycle.md` (cold-start race + reconnect storm + theme-change refit + kill+respawn) being completable with all observed-rows passing.
- **`CaptureTransaction` with `Drop` cleanup in `src-tauri/src/pty.rs`.** Today's `pty_capture_turn` uses three try-blocks + manual cleanup arms; replace with a `CaptureTransaction` struct holding the geometry/pipe-pane/sentinel state and using `Drop` for cleanup. Tests assert `CaptureState` is restored on success, timeout, and panic paths.

## Capabilities

### New Capabilities

- `kind-rendering`: Webview-side per-Kind `KindRenderer` interface owning mount/update/dismiss, with `placement` strategy declared as a string. `KindCard` is the lifecycle owner; chat-pane code never calls into per-Kind DOM directly.
- `tab-lifecycle`: `Tab` (cold-start / reconnect / dispose), `XtermBinder` (xterm.js write/refit/theme), and `PtyEvents` (output / exit / resize) with three clear seams. The cold-start race + reconnect storm + theme refit + kill+respawn invariants from `tests/smoke/tab-lifecycle.md` MUST hold.
- `capture-transaction`: `CaptureTransaction` struct in `pty.rs` owning geometry-set + pipe-pane-on + sentinel-watch state with `Drop` doing cleanup. `pty_capture_turn` becomes a thin wrapper that constructs the transaction and lets `Drop` handle teardown on every exit path.

### Modified Capabilities

- None. 2b is purely additive in terms of capability set; the Hub capabilities from 2a stay unchanged.

## Impact

- **Files affected (Webview):** `ui/index.html` (no framework — declarative module wiring); `ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js` (each becomes a `KindRenderer`; per-Kind `.css` files trimmed in favor of consolidated shared schema); new `ui/kinds/kind-card.js` (lifecycle owner); new `ui/kinds/kind-renderer.js` (interface + registry); `ui/main.js` (delegates per-Kind handling to `KindCard`); `ui/styles/chat.css` (per-Kind rules removed); new `ui/styles/kinds.css` (Kind-shared schema keyed by `data-kind`); `ui/terminal.js` split into `ui/terminal/tab.js`, `ui/terminal/xterm-binder.js`, `ui/terminal/pty-events.js` (gated by smoke-checklist; the existing `ui/terminal/` directory holds `pty.js` and `xterm-themes.js` today).
- **Files affected (Rust):** `src-tauri/src/pty.rs` (`pty_capture_turn` rewritten around `CaptureTransaction`); new tests under `src-tauri/tests/` asserting cleanup on success/timeout/panic.
- **Smoke-checklist artifact:** `tests/smoke/tab-lifecycle.md` ships as a tracked file in the repo (the gate for the Tab-split commit). Cycle pre-grill writes it; the Tab-split lands only after all observed-rows pass.
- **CLAUDE.md hard rules become structural facts:** "Tab cold-start" lock from cycle-1 stays referenced in CLAUDE.md but the commentary is updated to reflect the three-module shape. The "raw PTY, not tmux -C" rule stays as-is — `CaptureTransaction` does not change PTY mode.
- **No external API breakage.** No HTTP route changes, no SSE event-kind changes, no Tauri command renames. Hub remains untouched.
- **Schema unchanged.** No ledger migration.
- **Migration ordering is sequential, single branch.** The Webview Kind carve and Tab-split can in principle run in parallel branches, but the cost of a merge into `index.html` + module wiring is higher than the cost of running them sequentially. Single branch, per-candidate commits, smoke-test gate.
- **Depends on `architecture-cycle-2a` being merged + soaked.** The Webview `KindRenderer.placement` string mirrors the Hub-side Kind orchestration shape decided in 2a's pre-grill 1.1. If 2a's outcome is the fused `LedgerEntity`, the placement strategy still works (it's a Webview-only abstraction) — but the conceptual mirroring is what makes the seam coherent.
