## Context

The current slash-from-chat capture path (on `main` post-PR-#2) tries to recover claude's rendered TUI panel from the PTY byte stream after a quiescence-based heuristic. It fails on two orthogonal axes:

1. **Width-bound rendering**: claude calls `TIOCGWINSZ` on its own terminal, computes layout for the reported size (e.g. 86×71 in the user's setup), and writes bytes that ENCODE that layout. At narrow widths, claude's two-column `/context` panel self-corrupts via cursor-positioning overlays. The bytes themselves are corrupted; no post-hoc client-side processing can recover.

2. **Non-deterministic completion**: the quiescence detector (12s of silence) trips during API-paced renders (e.g. `/usage`'s session-data fetch). The capture closes mid-stream; the bottom of the panel is missing.

Documented in `docs/explorations.md`. This change addresses both.

The architectural insight (credit: external review): we control three layers and only need to align them.

| Layer | Mechanism | Currently |
|---|---|---|
| Rendering geometry | `tmux resize-window` + `set-option window-size manual` | client-driven (whatever the webview xterm reports) |
| Capture stream | `tmux pipe-pane -o → file` | Tauri `pty://output/<agent>` event listener (timing-coupled) |
| Completion signal | claude's `Stop` hook → filesystem sentinel | quiescence heuristic (timing-coupled) |

All three are cleanly available via the bundled tmux + claude's documented hook system. The fix is plumbing, not invention.

## Goals / Non-Goals

**Goals:**

- Deterministic capture of any single claude turn (slash command, free-form prompt, future use cases) without timing heuristics.
- Width-corruption-free output: claude renders into a forced 240×100 buffer where two-column panels and long item names fit.
- Zero user-side setup: the hook installs via `--settings <path>` at spawn, mirroring the existing `--mcp-config <path>` pattern.
- Reusable primitive: the orchestrator is a Tauri command callable for slash sends today, conversational mirroring or auto-polling tomorrow.
- macOS ARM64 only — no cross-platform shims.

**Non-Goals:**

- Structured JSON representation of `/context` data. Claude does not expose it; parsing rendered text into JSON is per-command-fragile and out of scope.
- Token-by-token streaming into chat. Slash commands are commands, not conversation; a 200–500ms delayed snapshot is fine.
- Hidden second tmux client to eliminate visible-xterm flicker (Phase 2 — revisit if users complain).
- Capturing the agent's BACKGROUND state (multiple turns, async tool-use chains). Single-turn primitive only.

## Decisions

### D1. Three-layer contract: geometry + stream + signal

The capture orchestrator coordinates three tmux/claude levers in a fixed sequence:

```
prepare paths     → /tmp/a2a/<agent>/{captures,signals}/
record start_ms   → for sentinel mtime filtering
pipe-pane on      → tmux pipe-pane -o -t <agent> "cat >> <log_file>"
window-size manual → tmux set-option -t <agent> window-size manual
resize-window     → tmux resize-window -t <agent> -x 240 -y 100
inject input      → pty_write(agent, input)
wait sentinel     → poll /tmp/a2a/<agent>/signals/turn-*.done with mtime > start_ms
stabilize         → 75ms sleep (final repaint absorption)
pipe-pane off     → tmux pipe-pane -t <agent>
window-size auto  → tmux set-option -t <agent> window-size automatic
return log path   → caller reads + parses the file
```

Each step is a single tmux subcommand or filesystem op. No event-loop coordination, no background timers, no race-prone state.

**Alternatives considered:**

- *Hidden second tmux client at 240×100 (Phase 2)* — eliminates visible flicker. Rejected for v1 because it adds a second `attach-session` invocation, a second portable-pty allocation, and lifecycle management of the phantom client (when does it detach? what if the user kills the agent during capture?). The size-resize approach is one tmux command per phase boundary. Ship Phase 1 first; revisit if flicker is a real complaint.
- *Quiescence + larger window* — would solve corruption but not the non-deterministic completion. Two layers fixed, one still heuristic.
- *Parse `/context` panel structure regex-by-regex* — fragile to claude releases and per-command. Doesn't help for `/usage`, `/cost`, or future commands.

### D2. Completion via claude's `Stop` hook + filesystem sentinel

Claude Code's hook system fires user-defined commands on lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, etc.). The `Stop` hook fires **once per turn-completion** — exactly the signal we need.

Hook command (macOS-compatible):

```sh
sh -c 'mkdir -p /tmp/a2a/$A2A_AGENT/signals && touch /tmp/a2a/$A2A_AGENT/signals/turn-$(date +%s).done'
```

- `$A2A_AGENT` injected at tmux session spawn via `new-session -e A2A_AGENT=<name>` (existing pattern, mirrors `CHATBRIDGE_AGENT`/`CHATBRIDGE_ROOM`).
- `touch` creates the file; filesystem mtime carries sub-second precision (APFS).
- Polling logic on hub-bin side: `stat -f %m <file>` to read mtime as a float; first file with `mtime > start_instant` wins.

**Why filesystem, not stdout/event/IPC?**

- The hook runs in claude's child shell, not in our process tree. The cleanest cross-process signal is a filesystem write — POSIX-standard, observable from any process.
- We already use `/tmp` for ephemerality (no cleanup logic needed; reboot wipes).
- Polling at 50ms intervals is cheap (`stat` syscall, no read).

**Alternatives considered:**

- *Watching the byte stream for claude's prompt indicator (`❯ ` after a divider)* — works for some commands, fails when claude redraws the prompt mid-render or when the prompt indicator scrolls past viewport. Brittle.
- *Sentinel via injected shell command* (`send-keys "echo __END__\n"` after the slash) — claude treats the `echo` as user input to its prompt, not as a shell pipe. Wrong abstraction layer.
- *Hub-side handshake* (claude posts a chatbridge channel notification on completion) — requires coupling to the channel, doesn't help for non-channel-aware turns, and the briefing instruction approach we tried earlier proved unreliable (claude forgets to post).

### D3. Per-agent settings via `--settings <path>`, not user-file mutation

Mirrors the existing `--mcp-config <path>` decision in `pty.rs::write_mcp_config_for()`. A2AChannel materializes a per-agent settings JSON in its own data dir and passes the path to claude:

```
~/Library/Application Support/A2AChannel/settings/<agent>.json
```

Contents:

```json
{
  "hooks": {
    "Stop": [
      {
        "command": "sh -c 'mkdir -p /tmp/a2a/$A2A_AGENT/signals && touch /tmp/a2a/$A2A_AGENT/signals/turn-$(date +%s).done'"
      }
    ]
  }
}
```

The claude invocation gains `--settings <path>` alongside `--mcp-config <path>`.

**Verification step**: confirm `claude --help` on claude 2.1.x exposes `--settings`. If absent (older claude versions), fall back to documenting the hook install in `~/.claude/settings.json` and warn at spawn time.

**Why not user-file install?** Same rationale as `.mcp.json`: writing into the user's config tree without explicit consent is the wrong default. The MCP-config pattern proved this works at scale; reuse it.

### D4. macOS BSD userland — no GNU date format strings

The hook command **must use BSD-only tools** because that's what ships with macOS:

- `date +%s` ✅ (whole-second epoch, BSD-supported)
- `date +%s%3N` ❌ (GNU-only millisecond format; on BSD it produces literal `%3N`)
- `date +%s%N` ❌ (GNU nanoseconds; on BSD it produces literal `%N`)
- `touch <file>` ✅
- `mkdir -p <dir>` ✅
- `stat -f %m <file>` ✅ (BSD mtime in seconds-since-epoch as float; APFS provides sub-second precision)
- `sh -c '...'` ✅

The hook uses whole-second epoch for the FILENAME (uniqueness within a turn) and relies on the FILESYSTEM mtime for sub-second ordering. This sidesteps date-format portability minefields entirely.

**Polling approach** on hub-bin side:

```rust
loop {
  let entries = fs::read_dir(format!("/tmp/a2a/{agent}/signals/"))?;
  for entry in entries {
    let mtime = entry.metadata()?.modified()?;
    if mtime > start_instant { return Ok(entry.path()); }
  }
  sleep(Duration::from_millis(50));
  if elapsed > TIMEOUT { return Err(Timeout); }
}
```

50ms poll is fine. A `kqueue`/`fsevents` watcher would be marginally faster but adds dependency surface; not needed for v1.

### D5. Scope: single-turn primitive, multiple callers

`pty_capture_turn(agent, input)` is the only Tauri command introduced. Slash-send is **one** caller; future callers include conversational mirroring (capture claude's reply to a chat message), auto-polling (background `/usage` for the header banner), agent introspection (one-shot queries for diagnostics).

The primitive is intentionally generic: `input` is the bytes injected into the agent's PTY (slash command, prompt text, anything that triggers a turn). The orchestrator doesn't care what `input` is.

**Alternatives considered:**

- *Slash-specific primitive with `slashCommand` argument* — locks the abstraction to one use case. Refactoring later costs more than building generic now.
- *Hub-side primitive* (a new HTTP endpoint) — wrong layer; tmux orchestration lives in the Tauri shell, not in hub-bin.

### D6. Concurrency model

- **Per-agent: serialized.** Claude itself is single-threaded per session — only one turn in flight. The slash-send queue in `slash-send.js` already enforces this.
- **Cross-agent: parallel.** `/usage @all` to a 4-agent room fires 4 `pty_capture_turn` calls in parallel. Per-agent paths (`/tmp/a2a/<agent>/...`) prevent collision.

The orchestrator is a pure function of (agent, input, timestamps). No shared state across agents. No locks needed.

### D7. Log retention: ephemeral with 10-deep forensic buffer

Captured logs land in `/tmp/a2a/<agent>/captures/turn-<epoch>.log`. Default `/tmp` cleanup on reboot handles persistence. On top:

- After each successful capture, **prune captures older than the 10 most recent for that agent**. Cheap (≤10 stat calls).
- Failed/partial captures retained as `turn-<epoch>.partial.log` — not pruned by the success-path cleanup; only reboot wipes them.
- Hub-bin doesn't read logs after the capture call returns. They're forensic only — for "the chat mirror was wrong" debugging.

No durable persistence. No configurable location. No archival.

## Risks / Trade-offs

- **Visible xterm flicker during capture** → claude SIGWINCH-redraws at 240×100; the visible client sees the top-left 86×71 of the new buffer. Cursor jumps. **Mitigation**: temporarily `set-option status off` during capture (suppresses tmux status line); accept the rest as v1 cost. Phase 2 (hidden client) eliminates flicker if it becomes a real complaint.

- **Multiple `Stop` hook firings per turn** → claude's hook semantics could evolve to fire on tool-use completion mid-turn. **Mitigation**: mtime-based filtering. We only accept the FIRST sentinel file with `mtime > start_instant`. If multiple fire, we use the first; subsequent ones during the same capture are ignored. Cleanup at end of capture removes stale signals.

- **`--settings` flag absence on older claude versions** → spawn fails or claude ignores the flag. **Mitigation**: verify at spawn time via `claude --help | grep -- --settings`. If absent, log a warning and fall back to documenting the hook install in user's `~/.claude/settings.json`. Capture works in either case once the hook is installed somewhere claude reads.

- **Hook-fires-but-no-output** → claude completes a turn that produced no PTY output (e.g., a tool-use that was rejected). Sentinel fires; pipe-pane log is empty. **Mitigation**: capture orchestrator returns successfully with empty body; caller (slash-send) detects empty and skips chat post.

- **User typing during capture** → keystrokes go to the agent's PTY between resize and restore. Could conflict with the claude prompt re-render. **Mitigation**: document as expected. Pragmatically, captures are short (200–500ms) and the user is reading chat, not the xterm.

- **`/tmp/a2a/` directory pileup across reboots** → if user has uptime in days/weeks, captures accumulate. **Mitigation**: 10-deep prune per agent on success-path. Failed captures (.partial) accumulate until reboot — acceptable.

- **claude version drift** → hook semantics, `--settings` flag, slash command output formats can all change between releases. **Mitigation**: integration tests exercising the full capture flow against a live agent are the regression guard. Documented in tasks.md §6.

## Migration Plan

This is purely additive on `main` post-PR-#2:

1. Phase 1 ships as a new Tauri command alongside the existing capture path. Slash-send is updated to call the new command; the old `captureViaHeadless` / `stripAndSlice` / etc. become unreachable but stay in the file for one release as a fallback safety net.
2. After validation against the spec scenarios in production use (one release cycle), the dead capture code is deleted.
3. Phase 2 (hidden second client) is a separate change, gated on user feedback about flicker.

No breaking changes to any external contract (channel protocol, kind state machines, hub HTTP routes). Existing tmux agents don't need to be respawned to benefit — but they DO need the per-agent settings file (which is materialized at next spawn). For currently-running agents to use the new capture, they must be killed and respawned. Document in tasks.md.

## Open Questions

- **`--settings` flag verification on the user's claude binary** — confirm at implementation time. If absent on claude 2.1.x, the fallback path needs a small UI nudge (one-time toast?) to install the hook in `~/.claude/settings.json`.
- **Should `pty_capture_turn` accept a `timeout_ms` parameter?** Slash sends are short; conversational captures might be long. Default 60s; allow override per call.
- **Should the captured log be returned inline (as a string) or as a path the caller reads?** Path is simpler for large captures; inline is one less FS roundtrip. v1: return the path; caller reads. Revisit if the read latency matters.
- **Phase 2 second-client mechanism**: `tmux attach-session` vs `tmux refresh-client -C` on a phantom client. Defer until Phase 2 is greenlit.
