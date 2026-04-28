## 1. Config + plumbing

- [x] 1.1 Add `permission_scraper.enabled: bool` (default false) to `AppConfig` in `src-tauri/src/lib.rs`. Use a nested struct `PermissionScraperConfig { enabled: Option<bool> }` so future knobs (latch grace, sample interval) can land here without an outer rename.
- [x] 1.2 Add `resolve_permission_scraper_enabled()` resolver returning `bool`. Default false on absence, on parse error, or on explicit `false`.
- [x] 1.3 Pass `A2A_PERMISSION_SCRAPER_ENABLED=true|false` env var to the hub sidecar in both the boot and `reload_settings` code paths.
- [x] 1.4 Update `render_seed_yaml()` to emit the `permission_scraper:` block with the documented opt-in comment from the proposal.

## 2. Ledger schema + helpers

- [x] 2.1 Bump `LEDGER_SCHEMA_VERSION` to 9 in `hub/core/ledger.ts`.
- [x] 2.2 Add migration v9: `ALTER TABLE permissions ADD COLUMN snapshot_path TEXT; ALTER TABLE permissions ADD COLUMN dismissed_by_scraper INTEGER NOT NULL DEFAULT 0;`. Single transaction.
- [x] 2.3 Update `dismissPermission()` (or equivalent terminal-state helper in `hub/kinds/permission.ts`) to accept an optional `by_scraper: boolean` flag and an optional `snapshot_path: string`; persist both into the row.
- [x] 2.4 Update `permissionSnapshot()` (or the row → broadcast payload mapper) to emit `by: "scraper"` when `dismissed_by_scraper = 1`.

## 3. Snapshot file storage

- [x] 3.1 Create `hub/core/permission-snapshots.ts` exporting: `init()`, `snapshotsDir()`, `snapshotPath(id)`, `writeSnapshot(id, bytes)`, `readSnapshot(id)`, `listSnapshots()`, `prune(keep)`.
- [x] 3.2 `init()` ensures `~/Library/Application Support/A2AChannel/permission-snapshots/` exists with mode 0700.
- [x] 3.3 `writeSnapshot()` uses `fs.writeFileSync` with mode 0600. Calls `prune(100)` after each write.
- [x] 3.4 `readSnapshot()` returns the file bytes or `null` if missing.
- [x] 3.5 `prune(keep)` lists files by mtime descending, unlinks anything past index `keep`. Best-effort; errors logged not propagated.

## 4. Rust-side `pty_await_pattern` primitive

- [x] 4.1 Add `regex = "1"` to `src-tauri/Cargo.toml` dependencies.
- [x] 4.2 In `src-tauri/src/pty.rs`, add `AwaitResult` Serialize struct: `{ matched: bool, elapsed_ms: u64, last_snapshot: String, matched_text: Option<String> }`.
- [x] 4.3 Add Tauri command `pty_await_pattern(agent, pattern, timeout_ms?, poll_interval_ms?) -> Result<AwaitResult, String>`. Defaults: timeout 60000, poll 100. Compiles regex once; on each poll, calls `tmux capture-pane -p -t <agent>`, runs `Regex::find` against the result; resolves on first match. Returns `matched=false` and the last snapshot on timeout.
- [x] 4.4 Add Tauri command `pty_await_pattern_absent(agent, pattern, timeout_ms?, confirmations?, poll_interval_ms?) -> Result<AwaitResult, String>`. Same shape as positive form; resolves when the regex has been ABSENT for `confirmations` (default 4) consecutive snapshots. Counter resets if the pattern reappears mid-watch.
- [x] 4.5 Register both commands in `src-tauri/src/lib.rs::invoke_handler!`.
- [x] 4.6 JS wrappers `ptyAwaitPattern` and `ptyAwaitPatternAbsent` in `ui/terminal/pty.js`, exposed via `window.__A2A_TERM__.pty.{ptyAwaitPattern, ptyAwaitPatternAbsent}`.

## 5. PermissionResolver interface + ScraperResolver

> **Architectural note:** moved from `hub/core/scraper.ts` to `ui/features/permission-scraper.js`. The hub is a separate Bun process and cannot call Tauri commands; the webview can. Substance unchanged.

- [x] 5.1 Define `PermissionResolver`, `ResolveEvidence` in `ui/features/permission-scraper.js`.
- [x] 5.2 Module constants: `LATCH_GRACE_MS = 30_000`, `CONFIRMATIONS_NEEDED = 4`, `SAMPLE_INTERVAL_MS = 100`, `GHOST_WATCH_TIMEOUT_MS = 60_000`, `CIRCUIT_BREAKER_THRESHOLD = 3`.
- [x] 5.3 `buildSelectorRegex(toolName) → RegExp`. Single regex that matches BOTH the tool name AND any of the selector patterns (`Allow once`, `Allow forever`, `Don't allow`, `Y/n`, numbered options, box-drawing chars adjacent to tool). Case-insensitive on literal text.
- [x] 5.4 `ScraperResolver` class implements the interface. State per id: `{ agent, room, toolName, state, registeredAt }`.
- [x] 5.5 `watch(id, agent, room, toolName)` is async-fire-and-forget. Steps:
   1. Build selector regex from tool name.
   2. Call `pty_await_pattern(agent, regex, LATCH_GRACE_MS)`. On `matched=true` → `SEEN_DIALOG`. On `matched=false` → fail-closed; increment circuit-breaker counter.
   3. Call `pty_await_pattern_absent(agent, regex, GHOST_WATCH_TIMEOUT_MS, CONFIRMATIONS_NEEDED)`. On `matched=true` (= absent for N ticks) → `AUTO_DISMISSED`. On `matched=false` → outer timeout; give up on this id.
   4. On AUTO_DISMISSED, call `onResolved(id, "dismissed", { snapshotBytes: result.last_snapshot, markersMatched: [...] })`.
- [x] 5.6 `unwatch(id)` cancels the in-flight await sequence (AbortController on the tauri invoke).
- [x] 5.7 Circuit breaker: counter resets on a successful latch; at `CIRCUIT_BREAKER_THRESHOLD` consecutive fails, log once and set a session-scoped `disabled` flag that makes `watch()` a no-op.
- [x] 5.8 `shutdown()` aborts every in-flight watcher.

## 6. Wire ScraperResolver into the webview + permission kind

> Wiring happens in the webview (where the scraper lives) and the hub-side route. Section was originally drafted around hub-side wiring; updated post-relocation.

- [x] 6.1 In the webview, fetch `get_permission_scraper_enabled` Tauri command lazily; gate `permissionScraperWatch()` on the result.
- [x] 6.2 Hook `permission.new` rendering in `ui/kinds/permission.js`: after creating a pending card, call `permissionScraperWatch(id, agent, room, toolName)`.
- [x] 6.3 Hook permission terminal-state transitions: when a card moves out of `pending`, call `permissionScraperUnwatch(id)`.
- [x] 6.4 Hub side: new `POST /permissions/:id/dismiss-by-scraper` route in `hub/kinds/permission.ts` that writes the snapshot file via `permission-snapshots.writeSnapshot()` and dismisses the row with `dismissed_by_scraper=1`.
- [x] 6.5 Implicit shutdown — the webview-side scraper dies with the page lifecycle; no separate hook needed.

## 7. Snapshot read route

- [x] 7.1 Add `GET /permissions/:id/snapshot` handler in `hub/hub.ts` (read-auth, accepts header OR `?token=`).
- [x] 7.2 Look up the permission row; if `snapshot_path` is null → 404 (no snapshot exists for this id).
- [x] 7.3 If path is set but the file is missing → 404 with body `"snapshot pruned"`.
- [x] 7.4 If file exists, return `Content-Type: text/plain; charset=utf-8` and the bytes.
- [x] 7.5 Restrict served paths to be within the snapshots directory (defense-in-depth).

## 8. UI (minimal)

- [x] 8.1 In `ui/kinds/permission.js`, check `entry.by === "scraper"` on `dismissed` and render a small "view snapshot" link.
- [x] 8.2 Link click fetches `GET /permissions/:id/snapshot` and shows the body in a simple modal.
- [x] 8.3 Modal text includes a one-line caveat: "Captured pane bytes used by the scraper to confirm dialog absence. May contain secrets visible at the time of capture."

## 9. CLAUDE.md update

- [x] 9.1 New hard rule on fail-closed posture (see design D6).
- [x] 9.2 New accepted-risk entry: snapshots may capture secrets; opt-in only; mode 0600.

## 10. Tests

- [ ] 10.1 Unit tests for `pty_await_pattern` and `pty_await_pattern_absent` in `src-tauri/src/pty.rs::await_tests` (cargo): immediate match, timeout, regex compile failure, absence-confirmation counter reset on reappearance.
- [ ] 10.2 Unit tests in `tests/unit/scraper.test.ts` for `buildSelectorRegex(toolName)`: matches positive cases (tool + selector), rejects negatives (tool only / selector only).
- [x] 10.3 Unit tests in `tests/unit/permission-snapshots.test.ts`: write creates 0600 file in 0700 dir; prune keeps last N by mtime; readSnapshot returns null on missing.
- [ ] 10.4 Integration test in `tests/integration/scraper-dismissal.test.ts`: spawn hub with scraper enabled, simulate dialog appear/disappear in tmux pane, assert auto-dismissal + snapshot file.
- [ ] 10.5 Integration test: chat-first Allow before scraper fires → watcher unwatched, no auto-dismissal, no snapshot file.
- [ ] 10.6 Integration test: scraper fires before manual `×` → `×` retry returns same-status 200, no double events.
- [ ] 10.7 Negative test: hub with scraper disabled processes everything without watcher involvement.

## 11. Documentation

- [ ] 11.1 Update `README.md` with an "Auto-dismiss ghost permissions (opt-in)" section.
- [ ] 11.2 Update `docs/PROTOCOL.md` with the new route + `by: "scraper"` field on `permission.dismissed` broadcasts.
- [ ] 11.3 Document the `permission_scraper.enabled` config knob in the README config block.

## 12. Release

- [ ] 12.1 Bump version to `0.11.0` across the four manifests.
- [ ] 12.2 Build via `./scripts/install.sh`; smoke-test the opt-in flow.
- [ ] 12.3 Tag, push, create GitHub release with `.app.zip`.
- [ ] 12.4 Update brew cask sha256 + version; commit + push the tap.
