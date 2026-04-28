## Why

When a Claude Code agent shows a tool-use permission prompt, A2AChannel surfaces a sticky red card in the chat. Two resolution paths exist today:

- **Chat-first (clean)**: human clicks Allow/Deny in chat → hub broadcasts the verdict → channel-bin acks claude → claude's xterm dialog closes → chat card transitions to the verdict state.
- **Xterm-first (broken)**: human types `y`/`n` (or the numeric option) directly in the agent's xterm → claude's dialog closes locally → claude does NOT notify the channel → the chat card sits forever as a "ghost" with no resolution.

The xterm-first ghost requires the user to manually click the small `×` button on the card to dismiss it. That's a friction tax; users who don't notice the ghost build up a stack of stale cards that have to be cleaned up later.

Since the hub already has a high-fidelity sensor on the agent's PTY (the `pty://output/<agent>` Tauri event stream consumed by xterm.js, plus the `tmux capture-pane` snapshot used by Shift+Tab mode detection), we can detect when the dialog has vanished from the visible pane and auto-file a `dismissed` verdict — same outcome as a manual `×` click, but without the friction.

## What Changes

- **Per-permission scraper watcher** wired into the existing `permission.new` broadcast. When a permission card appears, the hub starts a state machine watching for the dialog to first appear in the agent's PTY (latch), then disappear (debounce), then auto-file `dismissed`.
- **Latch-and-confirm state machine** explicitly modelled: `PENDING → SEEN_DIALOG → GHOST_WATCH → AUTO_DISMISSED`. Transitions only ever advance forward; the machine fails closed (does NOT auto-dismiss) if it never reaches `SEEN_DIALOG`.
- **`PermissionResolver` interface** abstraction so the scraper is one implementation. When Anthropic ships a `notifications/claude/permission_resolved` MCP notification (or equivalent), a `ChannelResolver` implementation can replace the scraper without touching ledger / UI code.
- **Per-dismissal forensic snapshot** written to `~/Library/Application Support/A2AChannel/permission-snapshots/<id>.txt` (mode 0600) — the captured pane bytes the scraper used to make the decision. The ledger row gains a `snapshot_path` column and a `dismissed_by_scraper INTEGER` flag distinct from human-dismissed cards.
- **Config flag** `permission_scraper.enabled: false` defaulting OFF in `config.yml`. Power users opt in. Documented in the seeded config so it's discoverable.
- **Fail-closed marker recognition**. If the scraper boots and finds none of its expected dialog markers in any pane (suggesting a claude-version label drift), it logs a single warning and disables itself for the session — does not silently auto-dismiss everything.
- **Telemetry hook**: hub log line per state transition (`PENDING → SEEN_DIALOG`, etc.) including the permission id and the markers that triggered it. Hub log is already mode 0600.

## Capabilities

### New Capabilities

- `permission-scraper`: passive PTY scanner that resolves xterm-first permission dismissals without manual user action. Covers the resolver interface, the state machine, marker detection, snapshot storage, fail-closed behaviour, and the config opt-in.

### Modified Capabilities

- `kind-runtime`: only insofar as the `permissions` table gains two columns (`snapshot_path TEXT`, `dismissed_by_scraper INTEGER NOT NULL DEFAULT 0`). The kind module's broadcast surface is unchanged — `dismissed` is already an existing terminal status.

## Impact

**Code**
- `hub/core/scraper.ts` (new) — `PermissionResolver` interface + `ScraperResolver` implementation with the latch state machine.
- `hub/kinds/permission.ts` — wires `permission.new` into the resolver; on `onResolved` callback, calls existing terminal-state transition with `dismissed_by_scraper=1`.
- `hub/core/ledger.ts` — schema migration v9 adding the two columns.
- `src-tauri/src/lib.rs` — config knob `permission_scraper.enabled`, env var `A2A_PERMISSION_SCRAPER_ENABLED`, seed comment.
- `hub/hub.ts` — reads the env, instantiates `ScraperResolver` only when enabled.
- `CLAUDE.md` — new hard rule on fail-closed behaviour; new accepted-risk entry on snapshot files.

**Filesystem**
- New directory `~/Library/Application Support/A2AChannel/permission-snapshots/`, mode 0700.
- One file per auto-dismissal, mode 0600. Bounded retention: keep last 100 by mtime; older snapshots pruned on each write.

**APIs**
- `permission.dismissed` broadcast frame already exists; gains an optional `by: "scraper"` field so UI can render dismissals with a distinct affordance ("auto-dismissed — view snapshot").
- New `GET /permissions/:id/snapshot` route serving the snapshot file as plain text. Auth-gated like other reads.

**Risk**
- **Snapshots may contain secrets.** The visible pane could include token output, file contents, debug dumps. Mode 0600 file + 0700 dir is the only protection. Default-off opt-in is the boundary. Documented as accepted risk.
- **Marker drift across claude versions.** Mitigated by fail-closed (don't auto-dismiss if markers unrecognized), and by requiring multiple independent markers (tool name + selector pattern) to enter `SEEN_DIALOG`.
- **False positives during pane redraws.** Mitigated by the GHOST_WATCH debounce window (1500ms with N consecutive clean snapshots).
- **Race with human clicking ×.** Idempotent — whichever transition reaches the terminal-state-policy code first wins; the second is a same-status retry → 200 (per existing `kind-runtime` contract).

**Out of scope (Phase 2)**
- Auto-detecting which option the human selected (Allow/Deny). The scraper only ever fires `dismissed`. Real verdicts come only from the chat-first path or a future upstream MCP notification.
- Snapshot redaction (heuristic secret-masking).
- A snapshot viewer UI inside the app — Phase 1 ships only the file path; users `cat` or `less` it.
- The future `ChannelResolver` implementation — interface drafted now, implementation lands when Anthropic ships the upstream notification.
