## Why

v0.6 shipped without the embedded terminal pane — it was the main tentpole feature and the one that failed in integration. The goal is single-window operation: the human launches agents, sends commands and slash-commands, and answers permission prompts without leaving A2AChannel. Stage-gate escape hatches (Terminal.app spawn) don't satisfy this goal. v0.7 commits to the embedded pane, but with a materially different architecture than the v0.6 attempt.

The v0.6 implementation used `tmux -C` control mode as the bridge between tmux and the webview. That stacked three fragile parsers (tmux's `%output` framing, a `send-keys` dispatch path, and xterm.js consumption) into one input loop, and one of them broke in a way that couldn't be diagnosed in the release budget. The v0.7 approach drops control mode entirely and runs tmux inside a raw PTY, feeding its ANSI stream directly into xterm.js — the same pattern every standalone terminal emulator uses.

## What Changes

- **BREAKING (relative to archived v0.6 terminal-projection spec):** The webview-to-tmux bridge is a raw PTY, not `tmux -C` control mode. `send-keys` is no longer part of the input path. The v0.6 `terminal-projection` capability's "control mode" requirement is replaced.
- New Rust dep: `portable-pty` (spawns and manages PTYs cross-platform).
- Bundled tmux binary under `src-tauri/resources/tmux` (revives the artifact from `scripts/build-tmux.sh`, now wired into the Tauri bundle).
- New Tauri commands: `pty_spawn(agent, cwd)`, `pty_write(agent, b64)`, `pty_resize(agent, cols, rows)`, `pty_restart(agent, cwd)`, `pty_kill(agent)`, `pty_list()`, `write_mcp_config(cwd, agent)`, `merge_mcp_config(cwd, agent)`. Input/output payloads are base64-encoded bytes rather than JSON int-arrays to avoid the 2.6x expansion tax on hot read paths.
- New Tauri events: `pty://output/<agent>` carrying `{ agent, b64 }`, `pty://exit/<agent>` (process exit).
- tmux sessions use `remain-on-exit on` + `respawn-pane` for claude restart semantics (instead of a `; exec $SHELL` fallback), so a `dead`-state tab explicitly shows claude exited rather than silently becoming a shell prompt.
- All tmux-spawned commands wrap through the user's login shell (`$SHELL -l -c "..."`) so `claude` resolves under the user's PATH — macOS GUI apps inherit launchd's sparse PATH, which almost never contains `claude`.
- xterm.js 5.x + `xterm-addon-fit` vendored under `ui/vendor/xterm/` — single-file ESM, no CDN, no bundler.
- UI: right-side vertical tab strip, one tab per agent. Launch / attach / kill controls per tab. Opt-in via header toggle, persisted in `localStorage`. Default off on first launch.
- Two entry paths for an agent to appear in the pane: **explicit** (`+ New agent` button prompts for name + cwd; A2AChannel writes or merges `.mcp.json` and spawns tmux+claude) and **reactive** (agent launched from the user's own terminal registers via `channel-bin`; appears as a display-only `external`-state tab).
- `.mcp.json` authoring: absent → write; matching chatbridge entry → skip; conflicting → prompt the user and merge while preserving other `mcpServers.*` entries.
- **PoC gate:** no code lands in `src-tauri/` or `ui/` until a standalone Tauri scratch project demonstrates a working xterm ↔ PTY ↔ bash loop including Ctrl-C, arrow keys, interactive prompts, resize, and UTF-8. The PoC explicitly un-blocks integration.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `terminal-projection`: the existing (archived-via-v06-roadmap) spec describes `tmux -C` control mode as the bridge. The delta replaces that with a PTY-based bridge, removes the `send-keys` input path, adds the PoC-gate requirement, and pins the specific Tauri event/command surface. Non-bridge requirements (bundled tmux, session naming, survive-restart, external `tmux attach` compatibility, explicit kill control, vendored xterm.js) remain in force.

## Impact

**Code:**
- `src-tauri/src/pty.rs` — new module wrapping `portable-pty::PtyPair` per agent, keyed in a `HashMap<String, PtyHandle>` on app state.
- `src-tauri/src/lib.rs` — register the five new `#[tauri::command]` handlers; add capability entries.
- `src-tauri/Cargo.toml` — `portable-pty = "0.8"` dep.
- `src-tauri/capabilities/default.json` — no new permissions needed (pty is Rust-internal, not shell-plugin).
- `src-tauri/resources/tmux` — bundled static binary from `scripts/build-tmux.sh`.
- `src-tauri/tauri.conf.json` — resource bundling entry for `resources/tmux`; CSP unchanged.
- `ui/vendor/xterm/xterm.js` + `ui/vendor/xterm/xterm.css` + `ui/vendor/xterm/xterm-addon-fit.js` — checked-in ESM bundles.
- `ui/index.html` — right-side tab strip DOM, xterm instance lifecycle, Tauri event plumbing, header toggle.
- `scripts/install.sh` — add `scripts/build-tmux.sh` invocation before `tauri build` (currently only runs `build-sidecars.sh`).

**APIs:**
- Five new Tauri commands listed above. No new HTTP routes on the hub — this feature is entirely shell-side.

**Dependencies:**
- `portable-pty ~0.8` (~150 KB crate, actively maintained, what WezTerm uses).
- `base64 = "0.22"` (stdlib-free base64 for the output encoder).
- Bundled tmux: +1.1 MB (static aarch64-apple-darwin binary).
- Bundled xterm.js: +230 KB (single-file ESM) + fit addon (~5 KB) + CSS.

**Bundle size:** ~+1.4 MB. App total stays under 135 MB.

**Out of scope (explicitly deferred to v0.8+):**
- Multi-pane per agent (tmux windows/panes). v0.7 is one tmux session = one xterm tab.
- Theming beyond a Catppuccin-matched default.
- Recording / replay of pty output.
- Windows / Linux / Intel Mac.
- macOS notarization for Gatekeeper-protected distribution (ad-hoc sign stays the norm).
- Cryptographic per-session identity for PTY access.
