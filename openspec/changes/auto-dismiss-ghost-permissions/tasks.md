## 1. Config + plumbing

- [ ] 1.1 Add `permission_scraper.enabled: bool` (default false) to `AppConfig` in `src-tauri/src/lib.rs`. Use a nested struct `PermissionScraperConfig { enabled: Option<bool> }` so future knobs (latch grace, sample interval) can land here without an outer rename.
- [ ] 1.2 Add `resolve_permission_scraper_enabled()` resolver returning `bool`. Default false on absence, on parse error, or on explicit `false`.
- [ ] 1.3 Pass `A2A_PERMISSION_SCRAPER_ENABLED=true|false` env var to the hub sidecar in both the boot and `reload_settings` code paths.
- [ ] 1.4 Update `render_seed_yaml()` to emit the `permission_scraper:` block with the documented opt-in comment from the proposal.

## 2. Ledger schema + helpers

- [ ] 2.1 Bump `LEDGER_SCHEMA_VERSION` to 9 in `hub/core/ledger.ts`.
- [ ] 2.2 Add migration v9: `ALTER TABLE permissions ADD COLUMN snapshot_path TEXT; ALTER TABLE permissions ADD COLUMN dismissed_by_scraper INTEGER NOT NULL DEFAULT 0;`. Single transaction.
- [ ] 2.3 Update `dismissPermission()` (or equivalent terminal-state helper in `hub/kinds/permission.ts`) to accept an optional `by_scraper: boolean` flag and an optional `snapshot_path: string`; persist both into the row.
- [ ] 2.4 Update `permissionSnapshot()` (or the row → broadcast payload mapper) to emit `by: "scraper"` when `dismissed_by_scraper = 1`.

## 3. Snapshot file storage

- [ ] 3.1 Create `hub/core/permission-snapshots.ts` exporting: `init()`, `snapshotsDir()`, `snapshotPath(id)`, `writeSnapshot(id, bytes)`, `readSnapshot(id)`, `listSnapshots()`, `prune(keep)`.
- [ ] 3.2 `init()` ensures `~/Library/Application Support/A2AChannel/permission-snapshots/` exists with mode 0700.
- [ ] 3.3 `writeSnapshot()` uses `fs.writeFileSync` with mode 0600. Calls `prune(100)` after each write.
- [ ] 3.4 `readSnapshot()` returns the file bytes or `null` if missing.
- [ ] 3.5 `prune(keep)` lists files by mtime descending, unlinks anything past index `keep`. Best-effort; errors logged not propagated.

## 4. PermissionResolver interface + ScraperResolver

- [ ] 4.1 Define `PermissionResolver`, `ResolveEvidence`, and constants in `hub/core/scraper.ts`.
- [ ] 4.2 Module-level constants: `LATCH_GRACE_MS = 30_000`, `CONFIRMATIONS_NEEDED = 4`, `SAMPLE_INTERVAL_MS = 400`, `GHOST_WATCH_TIMEOUT_MS = 60_000`, `CIRCUIT_BREAKER_THRESHOLD = 3`.
- [ ] 4.3 `ScraperResolver` class implements the interface:
  - Map `id → WatcherState` with fields `{ agent, room, toolName, state, seenAt, samplesAbsent, ghostWatchStart }`.
  - `watch()` registers a state record and starts an interval that snapshots the agent's pane via `tmux capture-pane -p -t <agent>`.
  - `unwatch()` clears the interval and removes the record.
  - State transitions implemented per the design's diagram.
- [ ] 4.4 Marker detection: `detectMarkers(snapshot, toolName) → { hasToolName, hasSelector, matched }`. Selector pattern is a disjunction over `Allow once`, `Allow forever`, `Don't allow`, `Y/n`, `\b1\.`/`\b2\.`/`\b3\.`, `╭`/`┌` adjacent to toolName. Case-insensitive on the literal text matches.
- [ ] 4.5 On `AUTO_DISMISSED`: write snapshot via `writeSnapshot()`, call `onResolved(id, "dismissed", evidence)`. The `evidence.snapshotBytes` carries the bytes for the kind to persist.
- [ ] 4.6 Circuit breaker: increment a session-scoped failure counter on each `LATCH_GRACE_MS` expiry. At threshold, set `disabled = true` and log the warning. `watch()` becomes a no-op when disabled.
- [ ] 4.7 `shutdown()` clears all intervals (called from hub shutdown handler).

## 5. Wire ScraperResolver into the hub + permission kind

- [ ] 5.1 In `hub/hub.ts`, on startup, if `A2A_PERMISSION_SCRAPER_ENABLED` is truthy, instantiate `ScraperResolver` and store it in module scope.
- [ ] 5.2 Hook `permission.new` broadcast: after broadcasting the new event, call `resolver.watch(id, agent, room)`.
- [ ] 5.3 Hook permission terminal-state transitions: `permission.allowed`, `permission.denied`, `permission.dismissed` all call `resolver.unwatch(id)` so the scraper stops watching whichever id was just resolved.
- [ ] 5.4 Set `resolver.onResolved = (id, verdict, evidence) => { /* file dismissal via existing kind helper */ }`. The kind helper persists `dismissed_by_scraper=1` and `snapshot_path=<path>` from the evidence.
- [ ] 5.5 Register `resolver.shutdown()` on the hub's shutdown handler (existing `dispose` chain).

## 6. Snapshot read route

- [ ] 6.1 Add `GET /permissions/:id/snapshot` handler in `hub/hub.ts` (read-auth, accepts header OR `?token=`).
- [ ] 6.2 Look up the permission row; if `snapshot_path` is null → 404 (no snapshot exists for this id).
- [ ] 6.3 If path is set but the file is missing → 404 with body `"snapshot pruned"`.
- [ ] 6.4 If file exists, return `Content-Type: text/plain; charset=utf-8` and the bytes.
- [ ] 6.5 Restrict served paths to be within the snapshots directory (defense-in-depth).

## 7. UI (minimal)

- [ ] 7.1 In `ui/kinds/permission.js` (or wherever the permission card renders), check `entry.by === "scraper"` on `dismissed` and render a small chevron / link "view snapshot".
- [ ] 7.2 Link click fetches `GET /permissions/:id/snapshot` and shows the body in a simple modal (reuse the existing modal infrastructure if any; otherwise a `<details>`).
- [ ] 7.3 Modal text includes a one-line caveat: "Captured pane bytes used by the scraper to confirm dialog absence. May contain secrets visible at the time of capture."

## 8. CLAUDE.md update

- [ ] 8.1 New hard rule: "Permission scraper auto-dismissals are FAIL-CLOSED. If `SEEN_DIALOG` never reaches across `LATCH_GRACE_MS` for any pending card, the watcher gives up on that id. After 3 consecutive failures within the session, the scraper disables itself and logs once. The manual `×` button is always the canonical fallback; the scraper is opportunistic, never load-bearing."
- [ ] 8.2 New accepted-risk entry: "Permission auto-dismissal snapshots may capture secrets. Files at `~/Library/Application Support/A2AChannel/permission-snapshots/<id>.txt` are mode 0600 in a 0700 dir; `permission_scraper.enabled: false` is the default. Users opting in accept the disk-persistence trade. Phase 2 redaction tracked separately."

## 9. Tests

- [ ] 9.1 Unit tests in `tests/unit/scraper-state.test.ts`: each state transition independently. Use a fake clock + fake snapshot provider so the state machine is deterministic without spinning a real hub.
- [ ] 9.2 Unit test: `detectMarkers()` returns the right shape across several known-good and known-bad snapshots (positive: tool name + selector; negative: tool name only, selector only, neither).
- [ ] 9.3 Unit tests for `permission-snapshots.ts`: write creates 0600 file in 0700 dir; prune keeps last N by mtime; readSnapshot returns null on missing.
- [ ] 9.4 Integration test in `tests/integration/scraper-dismissal.test.ts`: spawn the hub with `A2A_PERMISSION_SCRAPER_ENABLED=true`, post a fake `permission.new`, simulate xterm-side dismissal by manipulating the agent's tmux pane (write dialog text → wait → clear), assert the permission row transitions to `dismissed` with `dismissed_by_scraper=1` and a snapshot file appears.
- [ ] 9.5 Integration test: chat-first Allow before scraper fires → watcher is unwatched, no auto-dismissal occurs, no snapshot file written.
- [ ] 9.6 Integration test: scraper fires before manual `×` → `×` retry returns same-status 200, no double events.
- [ ] 9.7 Negative integration test: hub starts with `A2A_PERMISSION_SCRAPER_ENABLED=false`, all of the above scenarios proceed without scraper involvement.

## 10. Documentation

- [ ] 10.1 Update `README.md` with a "Auto-dismiss ghost permissions (opt-in)" section: how to enable, what it does, the safety model in plain language, the snapshot file location, the secrets-on-disk caveat.
- [ ] 10.2 Update `docs/PROTOCOL.md` with the new `GET /permissions/:id/snapshot` route + the `by: "scraper"` extension to `permission.dismissed` broadcast frames.
- [ ] 10.3 Document the `permission_scraper.enabled` config knob in the README config block.

## 11. Release

- [ ] 11.1 Bump version (package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json) — propose `0.11.0` since this introduces a new opt-in destructive-automation feature worth a minor bump.
- [ ] 11.2 Build via `./scripts/install.sh`. Smoke-test the opt-in flow end-to-end: enable, trigger a permission, dismiss in xterm, watch chat card auto-clear; click "view snapshot" link.
- [ ] 11.3 Tag, push tag, create GitHub release with bundled `.app.zip`.
- [ ] 11.4 Update brew cask sha256 + version, commit + push the tap repo.
