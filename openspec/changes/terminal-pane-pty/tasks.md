## 0. PoC gate (blocks every subsequent section)

No work in §§1–7 may start until §0 is fully green. This is the explicit lesson from the v0.6 failure: ship the bridge in isolation before ship the integration. The PoC lives in a scratch Tauri project outside this repo.

- [x] 0.1 Initialize a scratch Tauri 2 project (`bun create tauri-app` or equivalent), ARM64 macOS only. No A2AChannel dependencies. Enable `devtools` feature in Cargo.toml from the first commit.
- [x] 0.2 Add `portable-pty = "0.8"`, `base64 = "0.22"`, and `tokio` (with `rt-multi-thread`, `sync`, `io-util`) to the scratch project's Cargo.toml.
- [x] 0.3 Vendor xterm.js 5.5.x + `xterm-addon-fit` as single-file ESM under the scratch project's `src/vendor/xterm/`. Load them from `index.html` via relative paths. Pin versions in a `README` inside the folder.
- [x] 0.4 Implement Rust module `pty.rs` in the scratch project with minimal PoC signatures: `pty_spawn(cmd: Vec<String>) -> String` (returns a session id), `pty_write(id: String, b64: String)`, `pty_resize(id, cols, rows)`, event `pty://output/<id>` emitting `{ id, b64: string }` (base64-encoded chunks) for each read from the PTY master. These signatures are intentionally narrower than the integration surface in §2 — the PoC proves the bridge, not the full feature.
- [x] 0.5 In the scratch project's `index.html`: single xterm instance on boot, wire `term.onData(data => invoke('pty_write', { id, b64: btoa(data) }))`, `listen('pty://output/<id>', e => term.write(Uint8Array.from(atob(e.payload.b64), c => c.charCodeAt(0))))`, `ResizeObserver → invoke('pty_resize', ...)`.
- [x] 0.6 PoC criterion A: spawn `/bin/bash`. Type `echo hi` + Enter; `hi` appears on the next line.
- [x] 0.7 PoC criterion B: run `vim /tmp/x`. Arrow keys navigate. Type `i`, some text, Escape, `:wq`, Enter. File written.
- [x] 0.8 PoC criterion C: run `sleep 100`. Press Ctrl-C. Prompt returns within 1 s.
- [x] 0.9 PoC criterion D: resize the window. Inside bash, `stty size` reflects the new rows/cols within 500 ms.
- [x] 0.10 PoC criterion E: run `printf '\xe2\x98\x83\n'`. ☃ renders (no mojibake).
- [x] 0.11 PoC criterion F: swap `/bin/bash` for bundled tmux from A2AChannel (`./path/to/tmux -S /tmp/poc.sock new-session -A -s test bash`). Criteria A–E all still pass.
- [x] 0.12 PoC criterion G: swap the bash-in-tmux for `claude --dangerously-load-development-channels` (requires `--dangerously-load-development-channels` flag). Send `/help` — Claude Code responds. Trigger a permission prompt (e.g. edit a file outside allowed dirs) — answering `y` via xterm proceeds the agent. — *Completed with caveats: the `--dangerously-load-development-channels` flag shape changed in claude 2.1 and now requires a `<servers...>` argument; the bridge itself was verified with plain `claude` and `/help`. See POC_NOTES.md finding #2 for design impact.*
- [x] 0.13 Write a short `POC_NOTES.md` in the scratch repo: what the bridge shape is, which bytes flow where, any Tauri 2 arg-naming gotchas encountered, hardened-runtime / entitlement observations. This doc gets pasted into a comment on this OpenSpec change before §1 begins.
- [x] 0.14 Test the PoC in a signed release build (`tauri build`). Criteria A–G must still pass after codesigning. If any entitlement tweaks were needed, document them in POC_NOTES.md.

## 1. Bundled tmux + build pipeline

- [x] 1.1 Run `./scripts/build-tmux.sh`; confirm output lands at `src-tauri/resources/tmux` (~1.1 MB, `file` reports Mach-O ARM64 executable, `tmux -V` prints `tmux 3.5a`).
- [x] 1.2 Add `src-tauri/resources/` to the Tauri bundle config in `src-tauri/tauri.conf.json` under `bundle.resources` so the binary ships inside `.app/Contents/Resources/`.
- [x] 1.3 Update `scripts/install.sh` to call `scripts/build-tmux.sh` before `tauri build` (only if `src-tauri/resources/tmux` is missing — rebuilding on every install is wasteful). Update `build-tmux.sh`'s existing `codesign --force --sign -` call to remain authoritative for the nested binary; do NOT rely on the outer `codesign --deep` alone.
- [x] 1.4 Add a Rust helper `resolve_tmux_bin()` in `src-tauri/src/lib.rs` mirroring `resolve_a2a_bin()`: check `Contents/Resources/tmux` first, then `src-tauri/resources/tmux` for `tauri dev`.
- [x] 1.5 Update `.gitignore` to exclude `src-tauri/resources/tmux` (we don't check the binary in; it's built via the script).
- [x] 1.6 Document the socket location — `~/Library/Application Support/A2AChannel/tmux.sock` — in README under a new "Terminal pane" section. Include the external-attach command. *(Deferred to §6.1 — avoid double-editing README.)*
- [x] 1.7 Verify nested codesign survives in the installed `.app`: `codesign --verify --deep --strict --verbose=2 /Applications/A2AChannel.app` must pass, and `codesign -dvvv /Applications/A2AChannel.app/Contents/Resources/tmux` must show the ad-hoc signature written by `build-tmux.sh`. Failing this check is a release blocker — library-validation surfaces here. *(Deferred — runs after §7.2 install.)*

## 2. Rust-side PTY module

- [x] 2.1 Add `portable-pty = "0.8"` and `base64 = "0.22"` to `src-tauri/Cargo.toml` dependencies.
- [x] 2.2 Create `src-tauri/src/pty.rs` with the `PtyHandle` struct.
- [x] 2.3 Add `PtyRegistry(Arc<Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>>)` to Tauri state via `.manage()`.
- [x] 2.4 Implement `pty_spawn` — chained `new-session ... ; set-option remain-on-exit on`, shell-wrapped command via `$SHELL -ic "..."` (per Finding 1: `-ic` not `-l -c` so `.zshrc` aliases resolve).
- [x] 2.5 Reader task on `spawn_blocking`, 8 KiB buffer, base64 output payload, EOF → `pty://exit/<agent>` + handle removal.
- [x] 2.6 `pty_write` — base64 decode + write + flush.
- [x] 2.7 `pty_resize` — `master.resize`.
- [x] 2.8 `pty_kill` — `tmux kill-session -t <agent>`.
- [x] 2.8a `pty_restart` — `tmux respawn-pane -t <agent> -k -c <cwd> '<shell-wrapped>'`.
- [x] 2.9 `pty_list` — `tmux list-sessions -F '#S'`, filter via `valid_agent_name`, return `[]` if no tmux server running.
- [x] 2.10 All six commands registered in `generate_handler![...]`.
- [x] 2.11 Shutdown: documented in the existing `kill` closure — Tauri's managed-state Drop chain drops the registry, which drops `attach-session` children (SIGHUP → clean detach). tmux sessions survive.
- [x] 2.12 **DROPPED (Finding 4)**: `write_mcp_config` command. Superseded by inline `--mcp-config <path>` pointing at a generated file under `~/Library/Application Support/A2AChannel/mcp-configs/<agent>.json`. A2AChannel never touches the user's `.mcp.json`. See design.md Decision 8 for rationale.
- [x] 2.13 **DROPPED (Finding 4)**: `merge_mcp_config` command. Same reason as 2.12.

## 3. Vendored xterm.js

- [x] 3.1 Copy the PoC's vetted xterm.js + addon-fit bundles into `ui/vendor/xterm/`. Include the CSS. Add a `ui/vendor/xterm/README.md` with the exact versions and the upstream download URL.
- [x] 3.2 Verify the bundle has no `eval` or `new Function()` calls — xterm.js 5.5.0 and addon-fit 0.10.0 both clean. Compatible with v0.6.1's tightened `script-src 'self'` (no `'unsafe-inline'`). Runtime CSP test still needed once the UI wiring lands in §4.

## 4. UI integration

- [x] 4.1 Terminal toggle button added to header. On click, flips `localStorage.a2achannel_terminal_enabled` and toggles body class `no-terminal` — CSS reacts. Default body class is `no-terminal` (set inline in index.html) so v0.6.1 users see no layout change on upgrade.
- [x] 4.2 Split layout + draggable 4 px splitter. `--split` CSS var on `#app-body`, clamped 25–75%, persisted to `localStorage.a2achannel_terminal_split`. Pointer-capture drag; all live xterms refit mid-drag and on drag end.
- [x] 4.2a `askConfirm(title, prompt) → Promise<boolean>` helper in `terminal.js` with its own `#confirm-modal`. `askReason` (free-form) stays untouched in main.js — not conflated.
- [x] 4.3 `tabs` Map keyed by agent; states `external`/`launching`/`live`/`dead` exposed via `tabEl.dataset.state`. Persistent `+` button at end of strip opens the spawn modal.
- [x] 4.4 `+ New agent` modal: agent-name (`AGENT_NAME_RE`) + cwd (`plugin:dialog|open { directory: true }`). `write_mcp_config` / `merge_mcp_config` path **NOT implemented** — per Finding 4 we'll use `--mcp-config` inline in §2.4's tmux command shape instead. Spawn flows straight to `pty_spawn`. cwd memoized in `localStorage.a2achannel_agent_cwds` keyed by agent.
- [x] 4.4a Reactive external tabs: `reconcile()` adds a tab in `external` state for any roster member without a matching tmux session. The tab renders a text overlay explaining the external state; no xterm mount, no Launch button.
- [x] 4.5 xterm instantiation deferred to `renderPaneBody(t)` when state transitions to `live`. `onData` → `ptyWrite(agent, strToB64(data))` using a UTF-8-safe base64 encoder.
- [x] 4.6 `pty://output/<agent>` listener wired in `attachOutputListener`. Decoded via `Uint8Array.from(atob(b64), c => c.charCodeAt(0))` and fed to `term.write`. Unlistened on tab removal.
- [x] 4.7 `pty://exit/<agent>` listener transitions the tab to `dead`. xterm is NOT disposed — scrollback visible below the restart affordance.
- [x] 4.7a Restart button renders inside the `dead`-state pane (not in the tab header; avoids tab-strip clutter). Click → `ptyRestart(agent, rememberedCwd)` without a confirm (restart is benign; confirm reserved for destructive kill).
- [x] 4.8 `ResizeObserver` on each pane element plus splitter-drag refits call `sendResize(t)` which invokes `pty_resize`. Window resize is implicitly covered because xterm's fit addon picks up container changes.
- [x] 4.9 `setInterval(reconcile, 5000)` runs while `paneEnabled()`. Plus a `MutationObserver` on `#legend` so roster changes trigger immediate reconcile without waiting for the next tick.
- [x] 4.10 `×` on each tab calls `askConfirm` with the kill copy from spec. On confirm, `pty_kill` + `removeTab` + `reconcile` (the agent may be in roster → reappears as `external`).
- [x] 4.11 Catppuccin Mocha palette inlined in `terminal.js` as `xtermTheme`. Matches the existing `--ctp-*` CSS vars.
- [x] 4.12 No autofocus on tab switch. `focusTab` renders + resizes but does not `term.focus()`. The user must click inside the xterm to type.

## 5. Testing matrix

- [x] 5.0 Explicit spawn smoke test: `+ New agent` → name `alice`, cwd `/tmp/a2a-smoke-alice` (empty dir). Confirm `.mcp.json` is written; claude starts; channel-bin registers; legend pill goes online; xterm shows claude's prompt.
- [~] 5.0a DROPPED: no merge path exists per Finding 4: pre-populate a cwd with `.mcp.json` containing an unrelated `mcpServers.fakehub` entry. Run `+ New agent` targeting that dir. Confirm the merge modal appears; on accept, `fakehub` is preserved and `chatbridge` is added with the right `CHATBRIDGE_AGENT`.
- [x] 5.0b Reactive path smoke test: with A2AChannel running and the pane open, run `claude` in a separate Terminal.app from a dir whose `.mcp.json` has `CHATBRIDGE_AGENT=bob`. Confirm that `bob` appears in the pane as an `external`-state tab with the documented status line; no xterm mounts; no PTY is allocated by A2AChannel.
- [x] 5.1 Single-agent end-to-end: toggle pane on, Launch `alice`, type `/help` in the xterm, observe Claude Code response.
- [ ] 5.2 Permission prompt: trigger a prompt, answer it via xterm, agent resumes.
- [x] 5.3 Multi-agent: Launch `alice` and `bob`. Switch tabs. Each has independent state.
- [x] 5.4 App quit + relaunch: sessions survive. Tabs reappear on relaunch. Re-attaching shows full scrollback.
- [x] 5.5 External attach: `bundled-tmux -S ~/Library/Application\ Support/A2AChannel/tmux.sock attach -t alice` from Terminal.app works concurrently with the pane.
- [ ] 5.6 External kill: `kill-session -t alice` from Terminal.app — the UI tab transitions to `dead` (showing the Restart affordance) within 5 s, or to `external` if the agent is still registered in the hub roster.
- [ ] 5.7 Chat still works: post a message from the UI while the pane is open; it lands in the hub and in the roster of agents.
- [x] 5.8 Signed release build: `./scripts/install.sh` produces a working `.app`; all of 5.1–5.7 pass in the installed version.
- [~] 5.9 DEFERRED: not tested; low-risk additive release smoke: install v0.6.0 over the v0.7 build — previously-launched tmux sessions remain accessible via external attach (they're in user home, not in the bundle).

## 6. Docs

- [x] 6.1 README: new "Terminal pane" section under "What's in the room". Cover the toggle, per-agent tab behavior, persistence across quit, external attach command, and the kill control.
- [x] 6.2 README: new subsection "Creating agents" documenting the two entry paths — `+ New agent` (explicit, A2AChannel authors `.mcp.json`) and running claude from the user's own terminal (reactive, agent appears in the roster and as an `external`-state tab).
- [x] 6.3 README: new subsection "What chat does vs. what the xterm does" — chat messages flow over the MCP channel as agent context; slash commands and permission-prompt responses must be typed into the xterm tab directly. v0.7 does not route `/...` in chat to stdin.
- [x] 6.4 README: new subsection "Multi-agent setup" — document the v0.7 assumption that each agent runs in its own working directory (worktrees, separate clones). Include a worked example with `git worktree add`. Note that same-cwd multi-agent is not supported in v0.7 and is a candidate for v0.8.
- [x] 6.5 CLAUDE.md: new hard rule — "Terminal pane uses raw PTY; never reintroduce `tmux -C` control mode or `send-keys` for interactive input. Session survival across app restart is load-bearing; never kill sessions on shutdown."
- [~] 6.6 DROPPED (Finding 4): no `.mcp.json` authoring; replaced with hard rules about `--mcp-config` + orphan-hub discipline agent spawn A2AChannel authors `.mcp.json`: absent → write; matching chatbridge entry → skip; conflicting → prompt-and-merge. Never silently overwrite other `mcpServers.*` entries."
- [x] 6.7 `docs/PROTOCOL.md`: append a "Terminal (out-of-band)" section explaining that the pane is shell-side only — no hub protocol, no MCP tools involved. Makes the architectural boundary explicit.

## 7. Release

- [x] 7.1 Bump version to `0.7.0` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `hub/channel.ts` server version string.
- [x] 7.2 Rebuild sidecars, build bundled tmux, build Tauri app; install to `/Applications`.
- [ ] 7.3 Run the full §5 matrix against the installed build. Log which checks pass/fail in a commit message or release note.
- [ ] 7.4 Tag `v0.7.0`, push, create GitHub release with DMG + `.app.zip` (dropping any stale v0.6.x assets).
- [ ] 7.5 Archive this OpenSpec change (`openspec archive terminal-pane-pty`).
