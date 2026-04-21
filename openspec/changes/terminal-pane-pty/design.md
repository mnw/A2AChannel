## Context

v0.6 attempted to ship an embedded terminal pane alongside the coordination protocol. Two shapes were tried: a Terminal.app spawn, then an embedded xterm.js + `tmux -C` control-mode bridge. The embedded version's input loop was broken and couldn't be debugged in the release window — the feature was reverted and deferred. The archived roadmap at `openspec/changes/archive/2026-04-21-v06-roadmap/tasks.md` §3 documents the post-mortem, and the ratified `openspec/specs/terminal-projection/spec.md` still describes the control-mode design.

The user goal is single-window operation: launch `claude` agents, send slash-commands, and answer interactive permission prompts without context-switching to Terminal.app. A "Terminal.app escape hatch" was considered and rejected on those grounds — it satisfies the same surface capabilities but breaks the workflow the feature exists to enable.

The technical thesis for v0.7: the v0.6 bridge layered three fragile parsers (`%output`/`%begin`/`%end` framing in tmux control mode, modifier-key encoding through `send-keys -l`, xterm.js VT consumption). Any one of them failing produces a silent input loop break with no obvious culprit. The winning move is to drop the middle two and let xterm.js talk ANSI directly to tmux through a raw PTY — the pattern every standalone terminal emulator already uses successfully.

Current constraints:
- macOS ARM64 only.
- Vanilla HTML/CSS/JS in `ui/` (no framework, no bundler).
- Ad-hoc codesign; no Apple notarization in the build pipeline.
- Bun-compiled `a2a-bin` for hub and channel modes stays untouched — this feature is shell-side only.
- Bundle ceiling ~150 MB; v0.6.0 sits ~130 MB, v0.7 adds ~1.4 MB.

## Goals / Non-Goals

**Goals:**
- Embedded per-agent terminal pane that renders raw tmux output via xterm.js.
- Human can launch agents (`claude --dangerously-load-development-channels`), type slash-commands, answer interactive prompts — all inside A2AChannel.
- Sessions survive app quit/restart and remain attachable from the user's own Terminal.app for debugging.
- Build discipline that actually ships: PoC-gate before integration so the v0.6 failure mode can't repeat.

**Non-Goals:**
- tmux windows / multiple panes per session. One session, one tab.
- Theming API. Single Catppuccin-matched theme, hard-coded.
- Agent-owned session control. Humans create/destroy sessions; agents receive input via their existing MCP channel plus whatever the human types into the tmux pane.
- Replacing the existing MCP-based chat protocol. The terminal pane is additive — `post`, `post_file`, `handoff`, `interrupt` continue as-is.
- Multi-client conflict resolution beyond tmux's native behavior.
- Cross-platform (still macOS ARM64).

## Decisions

### 1. Raw PTY bridge, not `tmux -C` control mode

**Decision:** Rust side spawns a PTY using `portable-pty`, runs `bundled-tmux -S <sock> new-session -A -s <agent> -d claude ...` for session creation, then spawns a child `bundled-tmux -S <sock> attach-session -t <agent>` inside a second PTY whose master is bridged to xterm.js. Raw bytes both directions. No parser.

**Alternatives considered:**
- `tmux -C` control mode (v0.6's approach) — rejected. The parser is what killed v0.6; every extra layer increases debug surface when things fail silently.
- Custom Rust PTY without tmux — rejected. Loses session persistence across app restart, which is the single-biggest benefit of involving tmux at all.
- `nix-pty` / `pty-process` / `expectrl` crates — rejected. `portable-pty` is what WezTerm and the Alacritty ecosystem use; largest real-world mileage.

**Details:**
- One `PtyHandle` per agent, stored in `Arc<Mutex<HashMap<String, PtyHandle>>>` on Tauri state.
- `PtyHandle` owns: the `PtyPair` (master + slave fds), the spawned `Child`, a write-side `Box<dyn Write + Send>`, and the reader task's `JoinHandle`.
- Output reader: spawned `tokio::task` that loops on `master.try_clone_reader()?.read()`, emitting each chunk as a `pty://output/<agent>` event with the bytes as a `Vec<u8>` (Tauri serializes as a JSON array of integers — fine for chunks up to ~64 KiB; keep read buffer at 8 KiB).
- Input: `#[tauri::command] fn pty_write(agent: String, bytes: Vec<u8>)`. Acquires the mutex, finds the handle, calls `writer.write_all(&bytes)`. Returns unit; errors logged + returned as `Err(String)`.
- Resize: `#[tauri::command] fn pty_resize(agent: String, cols: u16, rows: u16)`. Calls `master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })`. Must be called at least once after the xterm renders or tmux defaults to 80×24 and output line-wraps wrong.

### 2. tmux orchestration: raw-PTY attach, session-dies-on-exit, no restart affordance

**Decision (as shipped):** `bundled-tmux -S ~/Library/Application Support/A2AChannel/tmux.sock`. All sessions created on this socket. App quit does NOT kill sessions. App launch queries `list-sessions -F '#S'` and rebuilds the tab strip from the result.

Session creation is a single `new-session -d` call — no chained options, no `remain-on-exit`. When claude exits for any reason (user types `/exit`, crash, graceful `/exit` from the kill path), the pane exits, the tmux session dies, and `pty://exit/<agent>` fires — the UI removes the tab on its own. If the user wants a fresh claude, they click `+ New agent` again.

```
bundled-tmux -S <sock> new-session -d -s <agent> -x 80 -y 24 -c <cwd>
  '<SHELL> -ic "claude --mcp-config <path> --dangerously-load-development-channels server:chatbridge"'
```

The entire shell command is passed as a SINGLE tmux argv element — see Decision 8/9 and Runtime Finding #8 for why argv splitting is load-bearing.

On attach to an already-existing session (app restart → auto-attach), A2AChannel defensively runs `set-option -t <agent> remain-on-exit off` to undo any legacy session created by an earlier v0.7-alpha that did set it ON. This keeps the `/exit` → tab-close flow consistent for sessions that outlive A2AChannel.

**State machine (simplified from earlier draft):**

- `external` — agent in hub roster, no tmux session we own.
- `launching` — spawn in progress.
- `live` — we own a PTY, xterm attached, claude running.
- (no `dead` state; claude exit = tab remove)

**Login-shell wrapper (`$SHELL -ic`) resolves the `claude` PATH problem.** Anthropic's installer creates `claude` as a `.zshrc` alias (not a PATH binary). Login shells don't source `.zshrc` by default, so `-l -c` misses the alias. Interactive shells (`-ic`) do source `.zshrc` and the alias resolves. Same mechanism handles any other user-scoped tool the project's MCP config needs (docker, npm, uvx — all of which need the user's PATH).

**Alternatives considered:**
- `remain-on-exit on` + `respawn-pane -k` for restart (earlier draft of this decision) — rejected. The held-pane state was visually identical to a live claude (both show a cursor at the bottom), so users couldn't tell if claude was alive or dead without poking it. `pty_restart` + a "Restart claude" button added UI complexity for a state that users only hit on crashes, and the cwd had to be memoized separately. Dropping it collapsed four moving parts (Rust command + handler + JS button + state branch) for a cleaner UX.
- Per-session socket — rejected. `list-sessions` becomes a directory walk; cross-session muxing breaks.
- `~/.config/A2AChannel/tmux.sock` (original v0.6 spec) — rejected. Other app state lives in `Application Support`; consistency wins.
- `'claude ...; exec $SHELL'` suffix (earliest draft) — rejected. The fallback shell was visually identical to a live claude.
- `send-keys -t <agent> 'claude ...' Enter` for restart — rejected. Aliases around the send-keys ban in Decision 1; no longer relevant since restart itself was dropped.
- `which claude` from Rust at startup — rejected. `which` runs under launchd PATH; same blind spot as hardcoding.

**Details:**
- Shell resolution: `env::var("SHELL")` with `/bin/zsh` fallback.
- `-x 80 -y 24` is load-bearing on `new-session`. Without explicit dimensions, tmux probes the invoking TTY via `TIOCGWINSZ`; our Rust shell has no controlling terminal, so the probe fails with "open terminal failed: not a terminal". Dimensions are just defaults — the PTY attach below will SIGWINCH tmux to the real xterm size immediately.
- External attach works as-is: `bundled-tmux -S <path> attach -t <agent>` from any terminal.
- Session name validated against `AGENT_NAME_RE` on the JS side before invoking `pty_spawn`. Rust re-validates defensively.
- tmux status bar is hidden (`set-option status off`) on every spawn and every auto-attach — redundant with the A2AChannel tab label.

### 3. Output channel: Tauri events with base64-encoded binary payload

**Decision:** Output streams via `app.emit_all("pty://output/<agent>", payload)`. JS side uses `listen("pty://output/<agent>", handler)`. Input uses `invoke` (fire-and-forget). Asymmetric on purpose — output is many-to-one-stream per session; input is discrete user actions.

Event payload shape: `{ "agent": string, "b64": string }` where `b64` is the standard base64 encoding of the raw chunk. JS decodes via `Uint8Array.from(atob(b64), c => c.charCodeAt(0))` and writes to xterm via `term.write(bytes)`.

**Alternatives considered:**
- Request/response `invoke` with long-poll — rejected. Doesn't match Tauri's model; latency per chunk.
- Single shared `pty://output` event with an `agent` field — rejected. Every tab's handler fires on every chunk, wasting cycles and forcing per-message filtering in JS.
- `bytes: number[]` payload (earlier draft) — rejected. 8 KiB binary → ~28 KiB JSON (`[65,66,67,…]`); at 100 KB/s output that's ~350 KB/s of transient allocations per tab. Base64 is 1.33x smaller than the raw payload size and parses on a hot path (`atob` is a browser native); ~2.6x better than int-array JSON end-to-end.
- Tauri 2 `Channel<Vec<u8>>` with binary frames — rejected *for v0.7*. Cleanest long-term answer (no encoding, no JSON pass). Defer to v0.8 once the rest of the pane is stable; base64 covers us until then.

**Details:**
- Reader task buffer: 8 KiB. Larger doesn't help (terminals are latency-sensitive); smaller adds event overhead.
- Event name contains the agent for fan-out efficiency. Unlisten on tab close.
- If profiling shows render-phase stuttering under base64, add a `requestAnimationFrame` coalescer in JS that accumulates incoming chunks and flushes to `term.write` once per frame. Orthogonal to the payload encoding — can land independently.

### 4. PoC gate is a task, not a doc line

**Decision:** Task 0 of `tasks.md` is "build a scratch Tauri project that proves the PTY↔xterm loop end-to-end" with explicit success criteria. No subsequent integration tasks are unblocked until Task 0 is checked off. The PoC scratch project lives outside the A2AChannel repo.

**Alternatives considered:**
- Skip the PoC, start integrating — rejected. This is exactly what killed v0.6.
- PoC inside the A2AChannel repo on a branch — rejected. Tempts premature integration. Scratch repo forces focus on the bridge alone.

**Details:**
- PoC success criteria (explicit, ordered):
  1. `type 'echo hi' + Enter` → see `hi` on next line.
  2. `vim /tmp/x`, arrow keys navigate, `:wq` writes.
  3. Ctrl-C cancels a running `sleep 100`.
  4. Window resize propagates: `stty size` reflects xterm dimensions.
  5. UTF-8 renders: `printf '\xe2\x98\x83\n'` → ☃.
  6. Replace `bash` with bundled tmux: all of 1–5 still work.
  7. Replace bash-inside-tmux with `claude --dangerously-load-development-channels`: slash commands work, permission prompts answerable.
- PoC deliverable: one-line URL in tasks.md pointing at the scratch repo + a short "what I learned" paragraph before integration begins.

### 5. UI: right-side vertical tab strip, opt-in via header toggle

**Decision:** Header gets a terminal toggle. When enabled, the window splits: chat on the left (fluid), tab strip + xterm pane on the right (fixed ~60% when open). Tabs list all currently-known agents; tapping "Launch" on an agent whose session doesn't exist creates it; tapping an existing tab attaches. Preference persists in `localStorage` under `a2achannel_terminal_enabled`. Default false on first launch so existing users see no UI disruption on upgrade.

**Alternatives considered:**
- Always-visible pane — rejected. Chat-only users don't need it and the window gets cramped on 13" laptops.
- Bottom pane instead of right — rejected. Terminal output is line-oriented and benefits from vertical space; chat is message-oriented and benefits from horizontal width.
- Per-pane tabs below the chat — rejected. Visual split confusion.

**Details:**
- One xterm.js instance per *visible* tab, lazily created on first focus, torn down on tab close (not on switch — switching just hides).
- Fit-addon handles resize on container size change; `ResizeObserver` on the pane element fires `fit.fit()` → `pty_resize`.
- Explicit × on each tab issues `pty_kill` after a custom confirm (not browser `confirm()` — Tauri's webview swallows it).

### 6. No hub-side changes

**Decision:** Hub and channel protocol stay exactly as v0.6. The terminal pane is Rust-shell + UI only. tmux sessions are independent of the hub's `knownAgents` roster — they can coexist out of sync (a tmux session can exist for an agent whose channel-bin is disconnected, and vice versa).

**Alternatives considered:**
- Hub tracks tmux session state and exposes it via SSE — rejected. Adds coupling without user value for v0.7. Reconsider if multi-machine deployment ever happens.

**Details:**
- UI merges two lists to populate the tab strip: `knownAgents` (from the hub) and `pty_list()` (from Tauri). Union, keyed by agent name. Agents in one list but not the other get a visual indicator (e.g., "session only" / "channel only").

### 7. Two entry paths for creating an agent

**Decision:** Agents appear in the tab strip via either an **explicit** in-app creation flow or a **reactive** flow when an already-running claude (started by the user from their own terminal) registers with the hub. Both are supported on equal footing.

**Explicit path:**
- UI surfaces a `+ New agent` control in the tab strip.
- Click → modal prompts for name (`AGENT_NAME_RE`-validated) + cwd (Tauri `open({ directory: true })` picker).
- A2AChannel writes `.mcp.json` into the chosen cwd per the rule in Decision 8, then spawns the tmux session, then allocates the PTY, then the attached xterm tab renders claude's startup.
- The resulting tab is a full-fat "live+PTY" tab: we own the PTY, we can kill it, we see output.

**Reactive path:**
- User has their own `.mcp.json` in some project dir, runs `claude` from Terminal.app.
- channel-bin registers the agent name with the hub.
- Hub broadcasts roster update. UI receives it and adds a tab.
- This tab is **display-only**: the xterm is not mounted (we don't own the PTY); the tab shows a status line "running outside A2AChannel" and offers a "Move into pane" affordance that calls `pty_spawn` (which will `new-session -A -s` → attach if a matching tmux session somehow exists, or create a fresh one in a cwd the user picks — the old external claude keeps running on its own process, and the user can quit it manually).

**Alternatives considered:**
- Explicit-only — rejected. Doesn't match existing v0.6 workflow where users launch claude from their own terminal; would force a UX change that has nothing to do with the terminal pane goal.
- Reactive-only — rejected. Requires the user to have a second Terminal.app open every time they want to spin up a new agent, which is exactly the context-switch we're eliminating.

**Details:**
- The tab strip's state machine has four states per agent: `external` (reactive, no PTY), `launching` (explicit, tmux spawn in progress), `live` (we own a PTY, xterm attached), `dead` (session killed; tab shows a Launch affordance if the agent is still in `knownAgents`).
- No hub protocol change — the roster already carries everything we need.

### 8. `.mcp.json` authoring — DROPPED IN FAVOR OF `--mcp-config` (v0.7 post-mortem)

**Status:** this decision is superseded. v0.7 ships **does not** touch the user's `.mcp.json`. See Finding 4 in the scratch-PoC's POC_NOTES.md and the revised §2 implementation.

**What ended up shipping:**

- A2AChannel writes a per-agent MCP config file at `~/Library/Application Support/A2AChannel/mcp-configs/<agent>.json` (mode `0600`, regenerated on every spawn).
- The tmux-spawned claude command passes `--mcp-config <path>` pointing at that file.
- Claude loads our config **additively** alongside any `.mcp.json` in the agent's cwd. The user's existing project MCP servers (docker, context7, serena, etc.) are preserved; we only add `chatbridge`.
- No prompt modal, no merge logic, no overwrite worry — the user's project files are never touched.

**Why the original design was dropped:** the authoring path (absent/matches/merge) added ~30% of v0.7 scope for no real benefit once we discovered `--mcp-config` exists. The PoC revealed this during criterion G. Dropping the authoring scope removed Decision 10 (symlink policy) entirely — no file write, no confused-deputy concern — and eliminated two Tauri commands, a confirm modal, a spec requirement, and ~4 CLAUDE.md hard rules.

**Keep for archive: original design text below was superseded.**

<details>
<summary>Original Decision 8 text (for archaeological reference)</summary>

### 8-orig. `.mcp.json` authoring by A2AChannel

**Decision:** On explicit-path spawn, A2AChannel inspects the chosen cwd for an existing `.mcp.json`. Three outcomes:

1. **File absent** → A2AChannel writes the file using the same template returned by `get_mcp_template`, substituting the chosen agent name into `CHATBRIDGE_AGENT`. No prompt.
2. **File present and the chatbridge entry matches** (same command path + `CHATBRIDGE_AGENT` equals the requested name) → proceed as if file absent; no write, no prompt. Idempotent.
3. **File present but doesn't contain a matching chatbridge entry** → modal prompts the user: *"`.mcp.json` already exists in this folder. Add A2AChannel's chatbridge entry? (Keeps any other MCP servers in the file.)"* → on accept, merge the `mcpServers.chatbridge` key into the existing JSON and rewrite; on decline, abort the spawn with a message (`spawn cancelled — no chatbridge config written`).

**Alternatives considered:**
- Always overwrite — rejected. Destroys any existing `mcpServers.<other>` entries the user has.
- Never write (current v0.6 behavior — user copies from the Reveal MCP Configs modal) — rejected. That's exactly the setup friction v0.7 is trying to remove.
- Warn only when chatbridge entry exists with a different agent name — rejected. Silently adding to a foreign-owned `.mcp.json` surprises the user; prompt instead.

**Details:**
- New Tauri command: `write_mcp_config(cwd, agent) -> { action: "wrote" | "merged" | "already_matches" | "declined", path }`. The UI decides based on the return whether to proceed with `pty_spawn`.
- The merge path preserves JSON formatting where possible — use `serde_json::Value` read, modify, `to_string_pretty`, write. Document that a user's hand-formatted comments/trailing commas will be normalized if a merge happens.
- Path validation: cwd must be an existing directory; reject symlinks that resolve outside the user's home (defense against a confused-deputy attack where a user is tricked into picking a symlink into `/`). This is stricter than `post_file`'s symlink policy — see Decision 10.

</details>

### 9. Chat-to-agent is context; xterm input is stdin (v0.7 scope)

**Decision:** For v0.7, the UI makes no attempt to route chat input or slash commands through the xterm PTY. Chat messages go over the MCP channel as they have since v0.3; slash commands must be typed into the xterm tab that owns the agent's PTY.

**Alternatives considered:**
- Auto-route messages starting with `/` into `pty_write` — rejected for v0.7. Too easy to misfire (a `/` at the start of a chat message unrelated to a slash command sends bytes to stdin and claude sees garbage). The feature is worth building later with an explicit opt-in affordance; not now.

**Details:**
- README documents the distinction explicitly under "Terminal pane" → "What chat does vs. what xterm does."
- This decision is revisited in v0.8+ if the distinction proves confusing in practice.

### 10. `.mcp.json` symlink policy asymmetry with `post_file`

**Decision:** `write_mcp_config` / `merge_mcp_config` reject symlinked cwds that point outside the user's home. `post_file` (from v0.6) does NOT reject symlinks in the file path.

The asymmetry is deliberate: writing a config file into a path is a stronger trust boundary than reading a file on behalf of an agent. A user picking a directory via a native dir picker is typically not going to pick a symlink to `/`, but confused-deputy scenarios exist (dotfile managers, IDE workspace roots). Reading a symlinked source file is a normal everyday pattern; writing a config through a symlink into a system path is not.

Documented here rather than left implicit so nobody "fixes" the inconsistency later.

### 11. Multi-agent, one-cwd-per-agent (v0.7 assumption)

**Decision:** v0.7 assumes each agent runs in its own working directory (typically a git worktree or a separate clone). The `.mcp.json` authoring (Decision 8) encodes this — one `CHATBRIDGE_AGENT` value per dir.

**Alternatives considered:**
- Support multi-agent-per-cwd via per-agent `.mcp.json` files (e.g. `.mcp.alice.json`, launched via `claude --mcp-config .mcp.alice.json`) — rejected for v0.7. Requires a config-file-selection UX the current feature doesn't have, and the value is unclear until someone actually runs into the limit. Revisit in v0.8+ if users ask.

**Details:**
- README's "Multi-agent setup" section walks through the worktree pattern (`git worktree add ../project-alice` + launch alice from there, etc.) as the recommended shape.
- No code enforcement — users can point multiple agents at the same cwd today; the only failure mode is that both channel-bins register the same agent name and collide. Benign, self-correcting.

## Risks / Trade-offs

**[Risk] macOS hardened runtime blocks PTY allocation.** → Mitigation: test in a signed release build *before* building the UI. If blocked, add `com.apple.security.cs.allow-jit` + `com.apple.security.cs.allow-unsigned-executable-memory` to entitlements and re-test. Discovering this at release tag is the second-worst outcome after the v0.6 failure.

**[Risk] PoC gate slips because integration feels "90% there".** → Mitigation: tasks.md structure makes the gate explicit. Task 0's success criteria are all-or-nothing — if any of 1–7 fail, no integration tasks start. Enforced by task dependencies, not discipline.

**[Risk] `portable-pty` interaction with `tokio` runtime.** → Mitigation: read loop runs in a blocking thread via `tokio::task::spawn_blocking`, not on the async executor. Pty read is a blocking syscall and will starve the tokio scheduler otherwise.

**[Risk] Output flood from verbose agents OOMs the Tauri event bus.** → Mitigation: reader task buffers 8 KiB chunks; no coalescing. Tauri's event channel is bounded per listener. If flood becomes a real problem, add a small ringbuffer on the Rust side and emit at a fixed rate — but ship the naive version first.

**[Risk] tmux session survives a broken app and the user has no way to get back in.** → Mitigation: document the bundled-tmux socket path in README. User always has `bundled-tmux -S <path> attach` as a recovery channel.

**[Risk] Tab-strip state drifts from tmux's actual session set after app crash + external `tmux kill-session`.** → Mitigation: call `pty_list()` on pane toggle and every 5s while the pane is visible. Cheap; keeps UI honest.

**[Risk] Bundled tmux binary gets flagged by Gatekeeper on a notarized distribution.** → Mitigation: out of scope for v0.7 (ad-hoc sign only). If/when notarization enters the roadmap, revisit — likely need to notarize the tmux binary separately and embed a signed copy.

**[Risk] `codesign --deep` on nested bundled tmux may hit library-validation issues on some macOS versions.** → Mitigation: sign the bundled tmux binary explicitly *before* signing the outer `.app`, not via `--deep` alone. Order: `codesign --force --sign - src-tauri/resources/tmux` → tauri build → `codesign --force --sign - A2AChannel.app`. `--deep` stays as belt-and-suspenders but is no longer the sole mechanism for the nested binary.

**[Risk] xterm.js CSP compatibility in the current Tauri 2 nonce-CSP + `script-src 'self' 'unsafe-inline'`.** → Mitigation: §3.2 of tasks.md pins this against the exact CSP string from `src-tauri/tauri.conf.json`. If xterm.js 5.x uses any `eval`-like path on a hot rendering code path, fall back to the canvas renderer (which is pure DOM) instead of WebGL.

**[Cosmetic] tmux's default "Pane is dead (status N, …)" message renders in the xterm after claude exits.** → Mitigation: accept for v0.7 — the `dead`-state tab header and Restart button make it clear what happened. v0.8 can customize via `set-option -t <agent> pane-dead-text '…'` (tmux 3.4+) and/or a UI overlay on top of the xterm while dead.

**[Trade-off]** PoC-first discipline delays visible progress on the feature by 2–3 days. Worth it because v0.6's failure cost ~1 week and shipped nothing. A green PoC is the highest-leverage work in the change.

## Migration Plan

- **Users on v0.6.x:** no migration needed. Terminal pane is off by default; enabling it in the header creates tmux sessions on first launch. Chat protocol untouched.
- **Config:** optional `terminal_enabled_default` key in `config.json` considered but rejected — `localStorage` is enough.
- **Ledger:** no schema change.
- **MCP protocol:** no new tools, no new routes. Agents see no difference.
- **Rollback:** downgrade to v0.6.x. Any running tmux sessions stay (they're in user home, not app bundle) and can be re-attached from the user's own terminal with `tmux -S <path> attach -t <agent>`. UI pane disappears.

## Runtime findings that shipped (post-spec discoveries)

These were found during v0.7 integration and changed the implementation from the original spec. All are reflected in the shipping code.

1. **Claude is a shell alias, not a PATH binary.** Anthropic's installer creates `claude` as a `.zshrc` alias pointing at `~/.claude/local/claude`. The original `$SHELL -l -c` wrapper (Decision 2) didn't work because login shells don't source `.zshrc`. Fix: switched to `$SHELL -ic` (interactive) so the alias resolves.
2. **`--dangerously-load-development-channels` takes `server:<name>` in claude 2.1+.** The flag is hidden from `--help`; old docs said it took bare flag (no arg). Current correct form: `--dangerously-load-development-channels server:chatbridge`. `pty.rs::claude_command` is the single point of truth; update there if claude changes it again.
3. **`--mcp-config` is additive with the user's `.mcp.json`.** Not exclusive. This is what enabled dropping Decision 8. Without `--strict-mcp-config` (which we never pass), claude merges both sources.
4. **Claude 2.1+ shows a "development channels" confirmation prompt on every launch.** "I am using this for local development / Exit" — auto-dismissed via output-scan of the option text in `terminal.js::maybeAutoDismissDevChannels`. Time-based `setTimeout` Enters were tried first and lost to variable MCP init time (2 s to 10 s depending on docker/npm/uvx server cold starts).
5. **tmux `remain-on-exit on` blocks the `/exit` → tab-close flow.** Originally in Decision 2 for "restart claude in held pane" semantics. Dropped: when claude exits for any reason, pane exits, session dies, tab removes. Cleaner UX; legacy sessions have the option force-unset on auto-attach.
6. **tmux's alt-screen buffer doesn't flush to a fresh attach client.** Claude renders server-side fine, but the xterm stays blank until SIGWINCH triggers a redraw. Fix: after the output-scan dismisses the warning, we send a resize cycle (rows ±1) to force a full redraw. A 15 s fallback cycle covers edge cases where the warning never appears (claude error before startup).
7. **`new-session` needs `-x 80 -y 24` explicit dimensions.** Tauri's Rust shell has no controlling TTY; without explicit dimensions tmux tries to probe the invoking terminal via `TIOCGWINSZ` and errors "open terminal failed: not a terminal". Dimensions are just defaults — our PTY resize fires SIGWINCH to the real xterm size immediately after attach.
8. **tmux argv must be a single shell-command, not split.** `/bin/sh -c "<joined-argv>"` is how tmux runs the command. Passing `zsh`, `-ic`, `command-string` as three argv gets joined to `zsh -ic command-string`, which /bin/sh then tokenizes — zsh sees only `command-string`'s first word as its script and silently drops the rest. Fix: concatenate into a single argv with proper single-quote escaping around the inner command.
9. **Orphan hubs are a dev-process footgun.** `pkill a2achannel` (the `install.sh` shortcut I kept using) doesn't always trigger Tauri's Exit handler that kills the hub sidecar. Orphan hubs stay alive on their port; new `channel-bin` SSE connections glue to them instead of the current hub. Always use `./scripts/install.sh` (it has an orphan-sweep pass). Added as a CLAUDE.md hard rule.

## Open Questions

1. **xterm.js version pin.** 5.3 vs 5.5. Later has better Unicode 15 support but ~20 KB larger. Recommend 5.5 — the delta is noise against the 60 MB Bun runtime.
2. **Reactive-path "Move into pane" affordance.** Resolved: drop for v0.7. Users kill the external claude themselves before launching in-pane if they want to bring it inside. Revisit in v0.8 if users ask.
3. **`.mcp.json` merge preservation.** Resolved: merge confirm modal displays a one-line warning — *"Merging will re-format the file; JSON comments and trailing commas will be lost."*
