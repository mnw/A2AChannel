## Why

Slash commands like `/context` and `/usage` render as TUI panels inside the agent's claude session. Their output is **not available via any structured API** — the only signal is ANSI-positioned bytes claude writes to its PTY. The current capture path (merged in v0.9.13 + capture iterations on the `commands` branch, now on main) extracts these bytes after a heuristic quiescence window and renders them through a headless xterm. It is structurally fragile:

- **Width-bound corruption**: claude renders for the agent's actual terminal dimensions (e.g. 86×71). At that width, two-column panels self-corrupt via in-place cursor-positioning overlays — content collisions like `(0.9%)⛶ ⛶ ⛶... ⛁ System prompt: 8.7k tokens` and `Avmcp__serena__safe_delete_symbolylbolseduthenticationion`. No client-side processing can recover what claude wrote already-corrupted.
- **Quiescence is unreliable**: API-paced renders (`/usage`'s "Scanning local sessions…" pause) trip the 12s silence window, closing capture before claude finishes painting the bottom of the panel.
- **No deterministic end-of-render signal**: we guess via byte silence; claude itself has no way to tell us "I'm done."

The architectural fix is to control all three layers of the contract — rendering geometry, capture stream, completion signal — instead of working around an output we don't control. Documented in `docs/explorations.md` as the path forward; this change implements it.

## What Changes

- **NEW Tauri command `pty_capture_turn(agent, input) → CaptureResult`** — a single-turn capture primitive. Resizes the agent's tmux window to a forced large geometry (240×100), tees PTY output to a per-capture file via `tmux pipe-pane`, injects `input` via the existing `pty_write`, waits for a deterministic completion sentinel, restores the window, returns the captured log path.
- **Per-agent claude settings injection** at spawn — A2AChannel writes `~/Library/Application Support/A2AChannel/settings/<agent>.json` with a `Stop` hook that `touch`es a sentinel file in `/tmp/a2a/<agent>/signals/` after every claude turn. Same pattern as the existing `--mcp-config <path>` injection (no user-file mutation, scoped via env).
- **`A2A_AGENT` env var** added to the tmux session env at spawn, scoping the hook's sentinel path per agent.
- **Slash-send refactor** — `slash-send.js`'s capture path replaced by a call to `pty_capture_turn`. The byte-stream-listener / quiescence-detector / headless-render / regex-slice pipeline goes away. Markdown wrap + chat post stay.
- **Per-agent file layout** under `/tmp/a2a/<agent>/`:
  - `captures/turn-<epoch>.log` — pipe-pane output (cleanly captured at 240×100 width)
  - `captures/turn-<epoch>.partial.log` — flagged on capture failure for forensics
  - `signals/turn-<epoch>.done` — sentinel file written by claude's Stop hook
- **Phase 1 ships with visible-xterm flicker during capture** (the resize is to the actual tmux window, so the visible client sees a viewport into the larger buffer). Phase 2 (hidden second client at 240×100) is out of scope; revisit only if user complaints land.

## Capabilities

### New Capabilities
- `pty-capture-turn`: deterministic single-turn capture of an agent's claude rendering — geometry control, pipe-pane teeing, hook-driven completion, per-agent-scoped filesystem layout.

### Modified Capabilities
- `terminal-projection`: documents the new generic capture path, the Stop-hook sentinel mechanism, and the temporary `window-size manual` resize during capture. Existing invariants (sessions survive app exit, tmux on shared socket, etc.) remain untouched.

## Impact

- **Tauri shell**: new `pty_capture_turn` Tauri command in `src-tauri/src/pty.rs`. New `--settings <path>` flag on the claude invocation in `claude_command()`. New `A2A_AGENT` env var on the tmux session at spawn. New `write_settings_for(agent)` helper that materializes the per-agent claude settings file with the `Stop` hook.
- **Hub**: no changes — captures happen client-side via the Tauri command, results post to chat via the existing `addMessage` path.
- **UI**: `ui/features/slash-send.js` simplified — removes `captureSlashResponse`, `captureViaHeadless`, `snapshotResponse`, `stripAnsi`, `stripAndSlice`, `sliceBetweenSlashAndPromptFrame`. Replaced with one Tauri call + ANSI-strip-with-CR-handling on the returned file content.
- **macOS-specific dependencies**: BSD `date +%s` (whole-second epoch — GNU `%3N` is unsupported), BSD `stat -f %m` for sub-second mtime, `touch`, `mkdir -p`, `sh -c`. All ship with macOS by default. **Do not introduce GNU-userland-only date format strings.**
- **Risks**:
  - Visible xterm flicker during capture (resize → claude SIGWINCH → repaint at 240×100; visible viewport sees top-left corner). Acceptable for v1.
  - Multiple `Stop` hook firings per turn (if claude's hook semantics evolve). Mitigated by mtime-based filtering: only sentinel files newer than the send timestamp count.
  - `--settings` flag verification: claude 2.1.x must support it. If absent, fallback is documented user-side install of the hook to `~/.claude/settings.json` once.
- **Testing**: hard to unit-test the full orchestrator (depends on a live tmux + claude). Integration test via the existing pty-plumbing test pattern (`tests/integration/pty-plumbing.test.ts`); per-helper coverage of the resize-pipe-restore sequence is the v1 acceptance gate.
