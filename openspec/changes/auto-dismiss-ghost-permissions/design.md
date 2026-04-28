## Context

A2AChannel's `permission` kind already has a clean lifecycle: `pending → allowed | denied | dismissed`. The chat-first path (Allow/Deny clicked in chat) flows through `POST /permissions/:id/verdict` and Claude Code's MCP integration closes the local dialog automatically. The xterm-first path leaves the chat card stranded because Claude Code doesn't notify the channel when its local dialog wins — there's no `permission.resolved` notification kind in the development-channels protocol today.

The hub already runs two PTY-scraping mechanisms:
- **`pty_capture_turn`** (deterministic-tui-capture): geometry-forced, marker-driven slash command capture.
- **`pty_tap_read`** (Shift+Tab mode read-back): brief `tmux capture-pane -p` snapshot, parsed for prompt-frame footer text.

Both work by reading the visible pane via tmux. The Shift+Tab implementation has shipped and demonstrably works, with the caveat that its marker strings have drifted twice across the claude versions tested in development (`auto-accept edits on` → `accept edits on` → `auto mode on`).

This change adds a third scraper for permission-dialog presence/absence detection, with a stricter failure model than the others because mis-firing can dismiss state the human is actively waiting on.

## Goals / Non-Goals

**Goals:**
- Auto-dismiss the chat ghost card when the human resolves the dialog in xterm.
- Survive false-positive scraping conditions (partial redraws, scroll, off-screen rendering) without ever wrongly clearing a card.
- Survive claude-version marker drift gracefully (fail closed, log, don't auto-dismiss anything).
- Provide forensic evidence — if a user thinks an auto-dismissal was wrong, they can inspect the captured pane bytes that drove the decision.
- Default off, opt-in via config — the existing manual `×` flow stays as the canonical UX until the scraper is proven in real use.
- Abstract the resolver interface so a future upstream MCP notification (`permission_resolved`) can drop in cleanly.

**Non-Goals:**
- Inferring which option the human selected (Allow/Deny). The scraper records `dismissed`. Period.
- Real-time secret redaction in snapshots.
- A snapshot viewer UI inside the app.
- Cross-process coordination — single hub process owns the watcher.
- Active probing of the agent (e.g. injecting bytes to test). Read-only sensor.

## Decisions

### D1. PermissionResolver interface as the abstraction boundary

A single TypeScript interface separates "did the dialog get resolved outside chat?" from "how did we detect that?":

```typescript
interface PermissionResolver {
  watch(id: string, agent: string, room: string): void;
  unwatch(id: string): void;
  onResolved: (id: string, verdict: "dismissed", evidence: ResolveEvidence) => void;
  shutdown(): void;
}

interface ResolveEvidence {
  snapshotBytes?: Uint8Array;     // for ScraperResolver — the pane bytes
  upstreamPayload?: unknown;       // for future ChannelResolver
  markersMatched?: string[];       // which markers triggered SEEN_DIALOG
}
```

`ScraperResolver` is the only implementation in this change. A future `ChannelResolver` can listen for `notifications/claude/permission_resolved` and emit through the same callback without touching the kind/ledger/UI code.

**Why:** Migration cost when Anthropic ships a real MCP notification is one new file + a wiring change in `hub/hub.ts`, not a refactor through every layer.

**Alternative considered:** No abstraction; inline the scraper directly in `permission.ts`. Rejected because it couples the upstream-event story to a specific implementation that should be replaceable.

### D2. Latch-and-confirm state machine, fail-closed

```
                    ┌──────────────────┐
                    │     PENDING      │
                    │  (card created)  │
                    └────────┬─────────┘
                             │  marker set seen in pane
                             ▼
                    ┌──────────────────┐
                    │   SEEN_DIALOG    │  ◄─── LATCH
                    │  (was visible)   │       once true, stays true
                    └────────┬─────────┘       for the session
                             │  marker set absent in latest snapshot
                             ▼
                    ┌──────────────────┐
                    │   GHOST_WATCH    │
                    │  (debounce N     │  ◄─── repeats CONFIRMATIONS_NEEDED
                    │   consecutive    │       times before next transition
                    │   absences)      │
                    └────────┬─────────┘
                             │  N consecutive absent samples confirmed
                             ▼
                    ┌──────────────────┐
                    │  AUTO_DISMISSED  │
                    │  (file verdict)  │
                    └──────────────────┘

                    Terminal state: AUTO_DISMISSED.
                    All other transitions are forward-only;
                    a chat-first verdict resolves the card
                    via the existing path and `unwatch(id)` halts the watcher.
```

**Why fail-closed:** If the watcher boots and never reaches `SEEN_DIALOG` for ANY pending card across the session (suggesting marker drift after a claude update), it logs once and disables itself. The chat-first manual `×` flow continues to work; the scraper is opportunistic, never load-bearing.

**Constants** (tunable via config later if needed):
- `LATCH_GRACE_MS = 30_000` — if a card has been pending for 30s without entering `SEEN_DIALOG`, the watcher gives up on that card. Fails closed for that id only.
- `CONFIRMATIONS_NEEDED = 4` — number of consecutive absent snapshots before transition to `AUTO_DISMISSED`.
- `SAMPLE_INTERVAL_MS = 400` — how often the watcher snapshots the pane in `GHOST_WATCH`. With N=4, total debounce window is ~1.6s.
- `GHOST_WATCH_TIMEOUT_MS = 60_000` — outer cap on `GHOST_WATCH`. If the dialog disappears once but reappears (re-render, queued prompt), the state can return to `SEEN_DIALOG`. After 60s of churn, give up on this id and log.

### D3. Multi-marker dialog detection

`SEEN_DIALOG` requires BOTH:
1. The tool name from the `permission.new` event payload appearing literally in the captured pane bytes (e.g., `Bash`, `Edit`, `Write`).
2. At least one selector pattern: any of `Y/n`, `Allow once`, `Allow forever`, `Don't allow`, `1.`, `2.`, `3.`, the boxed prompt frame `╭` or `┌` glyph adjacent to the tool name.

Both must coincide in the same snapshot.

**Why two markers:** Single-string matching breaks on label drift (we proved this twice with Shift+Tab). Tool name comes from the broadcast event payload itself, not the pane — so it's effectively schema-stable. The selector pattern is a disjunction of likely shapes; any one suffices. Drift in claude's selector glyphs would have to remove EVERY shape in our set to fail, which is a much higher bar than renaming a single string.

**Alternative considered:** Regex on the box-drawing frame. Rejected as primary because claude could change box characters without changing semantics; box-frame matching is one of the disjunction options, not the only signal.

### D4. Snapshot file outside the ledger row

When `AUTO_DISMISSED` fires, write the latest captured pane bytes to:

```
~/Library/Application Support/A2AChannel/permission-snapshots/<perm-id>.txt
```

mode 0600, parent dir mode 0700. The ledger row gets `snapshot_path TEXT` (the absolute path) and `dismissed_by_scraper INTEGER NOT NULL DEFAULT 0`.

**Why a sidecar file, not base64-in-ledger:**

- **SQL stays cheap.** The ledger row is small + queryable. Pulling 5–10 KB of base64 per row inflates indexes and hurts replay perf.
- **Filesystem affordance.** `cat <path>` works. A user investigating a wrongly-dismissed card opens the file. Base64-in-SQL would need a tool to decode + view.
- **Independent retention.** Users can `rm` snapshot files without touching the ledger. The ledger row's `snapshot_path` going dangling is fine — readers tolerate missing files (return "snapshot pruned").
- **Mirrors existing patterns.** Attachments and transcripts both already use sidecar files referenced from in-memory or relational state. Consistency.

**Retention:** keep the 100 most recent snapshot files by mtime; older snapshots pruned on each write. Bounds disk growth without a daemon. The ledger row's `snapshot_path` outlives the file; the GET endpoint returns 404 with a "snapshot pruned" message if the file is gone.

### D5. Config opt-in, default off

`config.yml`:

```yaml
# Scraper-based auto-dismissal of "ghost" permission cards left behind when
# the human resolves a dialog directly in the agent's xterm. Default OFF —
# opt in only after you've used the manual × button enough to want
# automation. See docs/PROTOCOL.md for the safety model (latch-and-confirm,
# fail-closed) and the secrets-on-disk caveat for snapshot files.
permission_scraper:
  enabled: false
```

Wired through `A2A_PERMISSION_SCRAPER_ENABLED` env var to the hub sidecar; hub instantiates the resolver only when truthy.

**Why default-off:** This is a destructive automation (clears blocking state). Same opt-in posture as room transcripts. Better to ship dark and let users opt in than to ship on and create a "card disappeared, did claude just run that command?" support thread.

### D6. Fail-closed marker discovery on boot

On hub start (when scraper is enabled), nothing happens until the FIRST `permission.new` arrives. There's no boot-time discovery probe — the scraper is event-driven.

What can fail-close: an individual `LATCH_GRACE_MS` window expiring without `SEEN_DIALOG`. If three consecutive cards in a session fail-close, the resolver disables itself for the rest of that session and logs:

```
[scraper] disabled — 3 consecutive cards never reached SEEN_DIALOG.
[scraper] markers may have drifted with the current claude version.
[scraper] manual × button still works; restart hub to re-enable.
```

**Why a session-scoped circuit breaker:** Catches systemic marker drift quickly without requiring per-card forensic work by the user. The bar (3 consecutive fails) is tight enough to not trigger on transient issues but loose enough to recover if one user happens to ignore a card past the latch window.

### D7. Telemetry: hub log only, not new infrastructure

Each state transition emits a single log line:

```
[scraper] perm_id=p_abc123 PENDING → SEEN_DIALOG (markers: Bash, Allow once)
[scraper] perm_id=p_abc123 SEEN_DIALOG → GHOST_WATCH
[scraper] perm_id=p_abc123 GHOST_WATCH → AUTO_DISMISSED (snapshot: /path)
[scraper] perm_id=p_abc123 GHOST_WATCH timeout — gave up, no auto-dismiss
[scraper] perm_id=p_def456 LATCH_GRACE_MS expired — gave up, no auto-dismiss
```

`hub.log` is already mode 0600 and rotates at 10 MB. No new log file, no new dashboard.

**Why not richer telemetry:** Personal tool, single user, single host. The forensic surface is the snapshot file plus the log line. Anything beyond is over-engineered.

## Risks / Trade-offs

- **Snapshot capture leaks secrets** → file mode 0600 + dir 0700, opt-in only. Documented as accepted risk in CLAUDE.md alongside the existing transcript-secrets entry.
- **Marker drift after a claude update silently breaks the scraper** → fail-closed circuit breaker (D6) plus the manual `×` button as the always-available fallback. Worst case: nothing auto-dismisses; user falls back to clicking `×` like before.
- **Race between scraper firing `dismissed` and human clicking `×`** → idempotent. Per existing `kind-runtime` terminal-state policy (`status='dismissed'` is terminal), the second writer gets a same-status 200 response. No double events broadcast.
- **Race between scraper firing `dismissed` and chat-first verdict arriving** → same-status retry returns 200; different-status (e.g. scraper says dismissed but chat says allowed) returns 409 Conflict. The verdict that wins is whichever lands at the hub first.
- **Snapshot disk growth unbounded** → 100-file mtime-based retention cap on every write. Worst case: ~100 files × ~10 KB = ~1 MB.
- **Per-card watcher overhead** → small. One `tmux capture-pane -p` per agent per `SAMPLE_INTERVAL_MS` while in `GHOST_WATCH`. Most cards never reach `GHOST_WATCH`; those that do exit within ~2s.
- **The `permission_scraper.enabled` flag becomes a footgun if the user enables it before the manual flow has stabilized for them** → seeded config comment explicitly recommends "opt in only after you've used × enough to want automation."

## Migration Plan

1. **Forward migration:** ledger schema v9 adds two columns to `permissions` (`snapshot_path`, `dismissed_by_scraper`). Forward-only; both columns are nullable / default-zero, so existing rows stay valid.
2. **Rollback:** flip `permission_scraper.enabled: false`. Existing manual flow continues unaffected. Snapshot directory + files become orphaned (harmless).
3. **Forward migration of upstream-event resolver:** new `ChannelResolver` implements the same interface; one-line wiring change in `hub/hub.ts` swaps which resolver is registered. No schema or UI change needed at swap time.

## Open Questions

- **Should auto-dismissals get a distinct UI affordance** (e.g., a "view snapshot" link on the dismissed card)? Lean: yes — small chevron next to the dismissed status that fetches `GET /permissions/:id/snapshot` into a modal. But spec'd as Phase 2 since it's polish.
- **Should the snapshot include `tmux capture-pane -e`** (with ANSI escape codes preserved) for full visual fidelity, or plain text? Lean: plain text for grep-friendliness. ANSI bytes can be added later if forensic detail matters.
- **Pruning policy** for snapshot files when their ledger row is removed (e.g., a future "vacuum old permissions" job)? Lean: out of scope for this change — vacuum is its own future capability.
