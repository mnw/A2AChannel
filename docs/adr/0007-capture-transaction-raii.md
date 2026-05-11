# `pty_capture_turn` cleanup uses `CaptureTransaction` RAII (Drop), not closure-defer

`src-tauri/src/pty.rs`'s `pty_capture_turn` previously open-coded cleanup at every error-exit branch (~7 sites), calling two closures (`cleanup_geometry` + `cleanup_pipe`) manually before each early return. Closure-defer is fragile to early returns and panics: any error-path that forgets to invoke both closures leaves the tmux session stranded with `window-size=manual` + pipe-pane still piping to a stale file. The post-2a code audit (finding flagged in cycle 2b's design.md Decision 3) called for replacing the closure-defer pattern with RAII via `Drop`.

This decision implements `architecture-cycle-2b` §6 and was committed in the same patch as this ADR.

## Considered Options

- **`with_capture(opts, |tx| -> Result<T>) -> Result<T>` closure helper:** explicit lexical scoping of cleanup. Rejected — the closure would have to return `Result` and the caller chain would be `with_capture(opts, |tx| { tx.write_input(input)?; tx.wait_for_sentinel(timeout)?; tx.read_output() })`. Cleanup-on-panic still requires a `Drop` impl on `tx` for safety; the closure adds nothing once `Drop` does the heavy lifting. Net: more indentation, same correctness as bare RAII.
- **Manual cleanup blocks at each return site (status quo):** rejected — exactly the fragility the cycle is fixing.
- **A separate `TmuxRunner` trait with `RealTmux` + `FakeTmux` adapters:** ACCEPTED as part of the implementation. The trait isn't strictly required for RAII — `Drop` could call `tmux_run` directly — but the trait enables panic-path testing without real tmux. The cost (~30 LOC of trait + RealTmux + the `&dyn TmuxRunner` field on `CaptureTransaction`) buys sub-millisecond unit tests covering the load-bearing invariant (cleanup runs on panic-unwind).

## Consequences

- **`CaptureTransaction<'a>` struct** owns three pieces of state:
  - `agent: &'a str` — the tmux session name
  - `runner: &'a dyn TmuxRunner` — production uses `RealTmux`, tests use `FakeTmux`
  - `pipe_on: bool` + `geometry_set: bool` — flags marking which cleanup arms to run in `Drop`
- **`set_geometry(cols, rows)` + `enable_pipe(log_path)`** are the two state-mutating methods. Each runs its tmux operation via the runner and marks its corresponding bool true.
- **`Drop` impl** runs cleanup in canonical order — **pipe-pane DISABLE first, then geometry restore**. Disabling pipe first stops the capture file from receiving the redraw bytes that the geometry-restore triggers; the `.log` ends at the last in-stream byte rather than carrying trailing resize noise.
- **Each Drop arm is panic-safe.** Cleanup arms use `if let Err(e) = ... { eprintln!(...); }` rather than `?` propagation. A single tmux failure in one arm does NOT prevent the remaining arms from running. (Verified by `drop_continues_when_one_cleanup_arm_fails` test that injects a synthetic Err on call #5; the remaining cleanup arms still run.)
- **`pty_capture_turn` body collapses** from ~150 LOC with 7 cleanup branches to ~95 LOC of straight-line `?` propagation. Every `?` now triggers `Drop` automatically; every panic unwind triggers `Drop` automatically; explicit `drop(tx)` before `Ok(result)` makes the cleanup-before-return ordering visible to readers.
- **`TmuxRunner` trait** is a real seam now — two adapters (RealTmux production + FakeTmux tests). Tests exercise the Drop logic against a fake that records every tmux call in a `Mutex<Vec<Vec<String>>>`. Per LANGUAGE.md's "two adapters means a real seam" rule, this seam earns its keep.
- **7 unit tests cover the load-bearing invariants** (`cargo test --lib capture_transaction` passes in ~10ms):
  - `set_geometry_records_window_size_manual_and_resize`
  - `drop_restores_geometry_when_set` (the cleanup arms run, in canonical order)
  - `drop_disables_pipe_when_enabled`
  - `drop_runs_cleanup_in_pipe_then_geometry_order` (pipe disable BEFORE geometry restore)
  - `drop_skips_cleanup_when_state_was_never_set` (no spurious tmux calls if no state mutated)
  - `drop_runs_on_panic_unwind` (the panic-path test — uses `catch_unwind` + `AssertUnwindSafe`)
  - `drop_continues_when_one_cleanup_arm_fails` (panic-safe cleanup; a failing arm doesn't strand the session)

## Post-implementation lessons

- **The panic-test was easier than the design.md budgeted half-day suggested.** `catch_unwind` + `AssertUnwindSafe` is the entire harness. No `std::panic::set_hook` was needed — the panic is absorbed by `catch_unwind` before the test runner sees it; the test runner's stderr stays clean. No fixture-private mutex was needed — `Mutex` is naturally `!UnwindSafe`, which is exactly why `AssertUnwindSafe` exists; we're asserting that the unwind doesn't cause logical inconsistency, which is true because we read the Mutex AFTER the unwind completes. The full test is ~25 LOC including comments. Design.md's risk paragraph over-estimated the cost.
- **The `TmuxRunner` trait paid for itself immediately.** Without it, the panic-test would need real tmux running on the test machine — flaky in CI, slow locally, hard to assert on internal state. With the trait, the panic-test runs in sub-millisecond and asserts exactly which tmux commands ran in what order.
- **Cleanup ordering matters for capture file correctness.** Pipe disable BEFORE geometry restore — got this right by reading the prior `cleanup_pipe()` + `cleanup_geometry()` call order in the old manual code. The Drop impl's "declared field order" semantic is NOT load-bearing here because the Drop impl is hand-written; the explicit order in the impl body is what matters.
- **`drop(tx)` before `Ok(result)`** makes the cleanup-before-return ordering explicit at the call site. Without it, readers would have to know that Drop runs at end-of-scope which is AFTER the `Ok(result)` value is constructed but BEFORE the function returns. The explicit `drop(tx);` line eliminates the question.
- **Two failing-arm cases were considered for the panic-safe test.** First version checked "if call #3 fails, calls #4-7 still happen." That tested the wrong thing because call #3 was the pipe-pane enable (inside the closure body, not Drop). Final version fails call #5 (mid-Drop) and asserts calls #6, #7, #8 still happen. Catches the actual fragility: a tmux Err inside one Drop arm must not short-circuit the rest of Drop.

## Recorded by

`architecture-cycle-2b` §6 (CaptureTransaction RAII). Commit lands the implementation; this ADR documents the load-bearing rationale and the post-implementation lessons.
