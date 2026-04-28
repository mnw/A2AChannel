# A2AChannel

> Coordination primitives for parallel Claude Code sessions — messages, handoffs, interrupts, permission relay.

![demo](docs/demo.gif)

## Why

Claude Code sub-agents share their parent's context. Separate Claude Code sessions don't — each is its own island. A2AChannel gives independent sessions a shared room, structured handoffs, and interrupts, so they can coordinate without you shuttling context between windows. Agents launch from the app itself — bundled terminal pane, bundled tmux, no `.mcp.json` editing, no separate windows to juggle.

The coordination is a protocol, not a chat app. Every message is a typed primitive with durable state, logged to an append-only SQLite ledger. You're in the room too. Handoffs and interrupts persist across restarts; pending work replays to the right agent on reconnect.

## Layout

```
┌─ titlebar ────────────────────────────────────────────────────────────────┐
│  ⤴ MCP configs   ⊕ MCP servers   ⚙ Settings   ↻ Reload   …   8% · 80%    │
├─ header ────────────────────────────────────────────────────────────────  │
│  💬 Room: [ EU Space ▾ ]  + agent  ⏸ Pause  ▶ Resume                      │
├─ nutshell strip (per-room project summary, click Edit to propose) ───────│
│  Nutshell   "Building the new map ..."                            [Edit] │
├─ room persistence row ────────────────────────────────────────────────── │
│  ⬤ Persist chat transcript    Active: 12 lines (3 KB) · 0 chunks  [Archive & reset]
├─ chat panel ───────────────────────────────────────┬─ terminal pane ────┤
│  human → planner: do the thing                     │ [shell] [planner] [+] │
│  planner → human: done; here's the diff            │ ❯ /usage              │
│  [a2a-capture] (panel response, code-fenced)       │   Status   Config…    │
│                                                    │                       │
│  …                                                 │                       │
├─ composer ─────────────────────────────────────────┤                       │
│  [ message… ]                              [Send]  │                       │
│  Enter send · Shift+Enter newline · @name · /cmd   │                       │
│  · Shift+Tab cycle modes                           │                       │
└────────────────────────────────────────────────────┴──────────────────────┘
```

- **Titlebar** — left side has icon buttons (Reveal MCP-configs in Finder, Edit global MCP servers, Settings/config.yml, Reload). Right side has the **usage pill** (compact `Session 8% · resets 3h 51m | Weekly 80%` populated passively from claude's banner).
- **Header** — room switcher dropdown + `+ agent` spawn button + `Pause`/`Resume` interrupt fanout.
- **Nutshell** — one-paragraph per-room project summary. Click *Edit* to propose an update via the handoff primitive; it broadcasts to every peer on accept.
- **Room persistence row** — toggle (orange when on) + footprint + *Archive & reset* button. Visible only when a concrete room is selected. See *Persistent transcripts* below.
- **Chat panel** — left half by default, drag the splitter to resize. Mention popover (`@`), slash picker (`/`), emoji, attachments. Composer at the bottom with a focus-revealed hint row.
- **Terminal pane** — right half. Pinned **shell** tab (your `$SHELL -il`, cross-room) plus one tab per spawned agent. The active tab pulses orange when the agent needs attention.

## Rooms

Every agent is registered in exactly one **room**; the human is a super-user visible in every room. `target: "all"` broadcasts, same-room agent-to-agent handoffs, and per-room nutshells all fan out within a room — no cross-project context pollution. Explicit peer targeting (`to: "<name>"`) still crosses rooms when you want it to.

The spawn modal's **Room** field defaults to the git-root basename of the chosen cwd (walks up looking for `.git`; falls back to cwd basename). A datalist suggests rooms already in use. External-spawn agents without `CHATBRIDGE_ROOM` fall back to `default`.

A **Pause / Resume** pair of buttons next to the room switcher fans out canned interrupts to every agent in the currently-selected room — cooperative stop-and-re-read, not preemption.

## Human affordances

**Shell tab** — pinned to the top of the terminal pane, cross-room, cross-project. A real tmux session running your `$SHELL -il` in `$HOME`; survives app restart with full scrollback, attachable from another terminal via the bundled tmux socket. Runs whatever you want — nvim, lazygit, fzf, docker, your dev server. Separate from agent tabs; `claude` belongs in an `+ agent` tab, not here.

**Usage pill** — compact `Session 8% · resets 3h 51m | Weekly 80% ⚠ · resets 20h 51m` in the header. Populated passively when any agent naturally prints claude's usage banner (e.g. on `/cost`). No polling, no API calls, no effect on your sessions. Ticks down once a minute; dims after 15 min stale; turns orange at >75%, red at >90%. Click a chip to copy the reset delta.

## Four primitives

### Messages — `post`, `post_file`

Free-text conversation. Send to `you` for the human, `<agent-name>` for a peer, or `all` to broadcast. `post_file` uploads a file from disk and delivers it to peers as `[attachment: <absolute-path>]`; 8 MiB cap, extension allowlist (jpg/jpeg/png/pdf/md by default).

| Tool | Required fields |
|---|---|
| `post` | `text`, `to` |
| `post_file` | `path`, optional `to`, optional `caption` |

### Handoffs — `send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff`

Transfer a bounded unit of work to another participant. The recipient accepts or declines; declines require a reason so the sender can re-route. Handoffs carry a structured `context` payload (up to 1 MiB — diffs, contracts, file refs) and a TTL; expired handoffs transition automatically.

Decline-with-reason is the key mechanic: unlike chat, the sender gets a routable signal back, not silence.

| Tool | Required fields |
|---|---|
| `send_handoff` | `to`, `task`, optional `context`, optional `ttl_seconds` (default 3600) |
| `accept_handoff` | `handoff_id`, optional `comment` |
| `decline_handoff` | `handoff_id`, `reason` |
| `cancel_handoff` | `handoff_id`, optional `reason` |

Handoffs with `task` prefixed `[nutshell]` and `context.patch` set update the project's shared summary atomically on accept — one-line broadcast to every peer.

A **nutshell** is the project's shared running summary — one paragraph every agent sees at the top of the room. Any agent can propose an update by sending a handoff with `task: "[nutshell] ..."` and a `context.patch` string. On accept, the patch replaces the current summary and broadcasts to all peers.

### Interrupts — `send_interrupt`, `ack_interrupt`

Soft preemption. Surfaces a red-bordered card stuck to the top of the recipient's chat until they acknowledge. Not a hard kill — the recipient keeps running — but a required ack means the signal can't be silently dropped. Reserve for genuine "stop and re-read this" moments.

| Tool | Required fields |
|---|---|
| `send_interrupt` | `to`, `text` (≤500 chars) |
| `ack_interrupt` | `interrupt_id` |

### Permission relay — `ack_permission`

Claude Code's tool-use approvals (the `Bash`/`Write`/`Edit` prompts that pause the agent) are forwarded to the chat as sticky red cards pinned at the top of the window. Allow or Deny from anywhere in the app — no more hunting through xterm tabs to unblock an agent. The xterm dialog stays live as a fallback.

Any agent can ack any pending permission via `ack_permission({ request_id, behavior })`, so a dedicated `reviewer` agent can auto-approve routine tool calls. Requires Claude Code **2.1.81+**, and for reviewer-style auto-ack, pre-allow the `ack_permission` MCP tool in the acking agent's `/permissions`.

**Chat-first** is the clean path — chatbridge relays the verdict upstream and Claude Code closes its own xterm dialog. **Xterm-first** leaves the chat card as a "ghost" because Claude Code doesn't notify the channel when the local dialog wins. Click the small **×** on the card to dismiss; the ledger records `status="dismissed"` (separate from allowed/denied, so the audit trail stays truthful — the hub never actually saw a verdict).

### Slash commands from chat

Type `/` at the start of the composer to drive an agent's slash commands without leaving the chat. A picker opens listing every command available across the live agents in the **currently-selected room** — built-ins (`/clear`, `/compact`, `/help`, `/cost`, `/model`, `/context`, `/usage`, …) plus whatever lives under `.claude/commands/` and `.claude/skills/` for each agent's cwd, plus your personal `~/.claude/...`. Each entry shows an `N/M agents` badge (how many of the room's live agents support it).

Sends require explicit targeting:

| Composer text | What happens |
|---|---|
| `/clear` | refused — `specify @agent or @all` |
| `/context @builder` | bytes typed into `builder`'s xterm; response mirrored back to chat as a `[a2a-capture]` code block |
| `/clear @all` | bytes typed into every live, non-busy agent in the room |
| `/openspec-propose ... @planner` | bytes typed; ` - answer in chatbridge` auto-appended so the agent posts its result back via `mcp__chatbridge__post` |

Two dispatch paths based on the command type:

- **Panel commands** (`/context`, `/usage`, `/cost`, `/memory`, `/agents`, `/skills`, `/help`, `/mcp`, `/model`, `/status`, `/permissions`, `/config`, `/release-notes`, `/doctor`) go through a deterministic capture orchestrator that forces tmux geometry to 240×100 (avoiding narrow-width self-corruption), tees the panel render to a per-turn log, and posts the cleaned content back to chat under the agent's avatar.
- **Everything else** (custom `.claude/commands/`, MCP prompts, model-delegated work like `/openspec-propose`) takes a simple write-and-forget path. ` - answer in chatbridge` is auto-appended so the agent's response reaches chat via `mcp__chatbridge__post` instead of getting stranded in the terminal. The directive is skipped if you already wrote it in your args.

Routing: `/`-prefixed messages bypass the channel entirely and write raw bytes to the agent's tmux PTY (via `pty_write` and `pty_capture_turn` Tauri commands). They do **not** become MCP `notifications/claude/channel` messages.

Guardrails:

- Slash mode is **disabled** when the room dropdown is on `All rooms` — pick a concrete room first. Cross-room slash broadcasts are intentionally not possible.
- Agents with a pending permission or interrupt are **auto-skipped** from `@all` expansion (the audit row notes the skip + reason). Claude's internal modal states (mid-stream, slash-picker open) are unobservable from outside the PTY; if a send lands in a bad state you'll see it in the xterm.
- `/clear` and `/compact` targeting more than one agent prompt for confirmation (irreversible per-agent context wipe).
- `external`-state agents (claude sessions A2AChannel doesn't own a PTY for) are not selectable from the slash `@`-popover.

Each successful send produces a single `system` row in the chat log: `human → /clear @all (planner, builder, reviewer, docs)`. The audit row is in-memory only — lost on hub restart unless the room has persistent transcripts on (see below).

### Mode cycling (Shift+Tab)

Claude's three modes (Auto / Accept Edits / Plan / Normal) cycle on Shift+Tab. From chat:

- **Press Shift+Tab in the composer** → broadcasts to every live agent in the current room. Same room rules as slash.
- **Type `Shift+Tab @agent`** + Send → targets one agent. Variants accepted: `shift+tab`, `shifttab`, `shift-tab`. Case-insensitive.

After each send the audit row reports the actual mode each agent landed on (`Plan`, `Accept Edits`, `Auto`, `Normal`) by reading claude's prompt-frame footer via `tmux capture-pane`. No client-side guessing — drift-free even if you also press Shift+Tab in the visible terminal.

## Quickstart

1. Install: `brew tap mnw/a2achannel && brew install --cask a2achannel`. Launch the app.
2. Click **`+ agent`** in the header, enter a name, pick the project directory, **Launch**. A2AChannel spawns `claude --dangerously-load-development-channels` inside a bundled tmux session in an embedded terminal tab. No `.mcp.json` editing, no separate terminal.
3. Repeat for each agent. They register with the hub, appear in the roster pills, and can `post`/`send_handoff` to each other and to you.

The `--dangerously-load-development-channels` flag is mandatory — it's what makes the `chatbridge` MCP channel deliverable to Claude. Without it, agents can `post` but never hear incoming messages. A2AChannel's terminal pane always passes it; if you launch `claude` from your own terminal instead, you add it yourself.

## Install

### Homebrew (recommended)

```bash
brew tap mnw/a2achannel
brew install --cask a2achannel
```

Apple Silicon macOS only. `brew upgrade --cask a2achannel` to update, `brew uninstall --zap --cask a2achannel` for a full wipe including `~/Library/Application Support/A2AChannel`.

Ad-hoc signed — on first launch macOS may ask you to confirm via **System Settings → Privacy & Security → Open Anyway**.

### From source

| Requirement | Install |
|---|---|
| macOS on Apple Silicon | — |
| [Bun](https://bun.sh) | `curl -fsSL https://bun.sh/install \| bash` |
| [Rust](https://rustup.rs) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode Command Line Tools | `xcode-select --install` |

```bash
git clone https://github.com/mnw/A2AChannel.git
cd A2AChannel
bun install
./scripts/install.sh
```

`install.sh` compiles the Bun sidecar, builds the Tauri shell, ad-hoc codesigns, copies to `/Applications`, and launches. Rebuilds on rerun (~60 s Rust incremental).

Contributors with push access: `./scripts/release.sh <version>` bumps versions, tags, builds, uploads the GitHub release, and updates the Homebrew tap in one shot.

## Running agents

**Inside the app** (default): `+ agent` button → name + cwd → Launch. Terminal pane opens with an xterm tab for each agent. Slash commands, permission prompts, and interactive tools work there directly. The tab pulses orange when an agent needs your attention.

**From your own terminal** (classic): copy the MCP config (click the file-icon in the header), paste into your project's `.mcp.json`, then:

```bash
claude --dangerously-load-development-channels server:chatbridge
```

The agent appears in the roster the moment `chatbridge` registers; in the app's terminal pane it shows as an `external`-state tab (A2AChannel doesn't own its PTY).

## Config

`~/Library/Application Support/A2AChannel/config.yml` (seeded with comments on first launch):

```yaml
human_name: human
claude_path: ~/.claude/local/claude
anthropic_api_key: ""
attachments_dir: null
attachment_extensions:
  - jpg
  - jpeg
  - png
  - pdf
  - md
theme: default               # default | rose-pine-dawn | rose-pine-moon
font_scale: 1.0              # 0.85 – 1.25
fonts:
  ui: ""                     # prepended to the built-in chain; empty = use defaults
  mono: ""
editor: ""                   # e.g. `code`, `cursor`, `subl`, `open -a Cursor`
chat_history_limit: 1000     # in-memory ring buffer + replay budget on restart, [10..100000]
```

Edit, click **↻** in the header to reload — hub restarts with the new values, no app relaunch.

- `claude_path` defaults to Anthropic's installer location; override if yours lives elsewhere.
- `anthropic_api_key` left empty means claude uses its keychain OAuth (the usual case); set it for API-key auth without touching your shell.
- `chat_history_limit` doubles as the per-agent context-replay budget on hub restart for rooms with persistent transcripts on. Lower it (e.g. 200) if agents reconnect into too much history.

**Global MCP servers** at `~/Library/Application Support/A2AChannel/mcp.json` (open via the connector-graph icon in the titlebar). Servers in this file are merged into every per-agent `.mcp.json` at spawn time; the `chatbridge` server name is reserved by A2AChannel and silently stripped from your config.

## Architecture

<details>
<summary>System diagram</summary>

```
┌─────────────────────────────────────────────────────────────┐
│  A2AChannel.app  (Tauri 2 — native macOS)                   │
│                                                             │
│  ┌─────────────────────┐        ┌───────────────────────┐   │
│  │ Webview             │◄─SSE───┤ a2a-bin (hub mode)    │   │
│  │  chat  | term pane  ├─POST──►│  Bun sidecar          │   │
│  │  (xterm.js in pane) │        │  127.0.0.1:<dynamic>  │   │
│  └──────┬──────────────┘        │  SQLite ledger        │   │
│         │ Tauri IPC              └──┬───────────────────┘   │
│         ▼                           │                       │
│  ┌──────────────┐                   │                       │
│  │ pty.rs       │  spawns & attaches│                       │
│  │ portable-pty │──► bundled tmux ──┼──► claude (per agent) │
│  │ registry     │   (shared sock)   │        │              │
│  └──────────────┘                   │        │ stdio        │
│                                     │        ▼              │
│                                     │   a2a-bin (channel)   │
└─────────────────────────────────────┼────────┬──────────────┘
                                      │        │ SSE + POST
        (agents from external terminals)       │
        ┌──────────────────────────────┼───────┤
  ┌─────▼──────────┐  ┌────────────────▼───┐  ┌▼───────────────┐
  │ a2a-bin        │  │ a2a-bin            │  │ a2a-bin        │
  │ (channel mode) │  │ (channel mode)     │  │ (channel mode) │
  │ agent=alice    │  │ agent=bob (ext)    │  │ agent=…        │
  └─────┬──────────┘  └───┬────────────────┘  └─┬──────────────┘
        │                 │                     │
  ┌─────▼───────┐   ┌─────▼───────┐       ┌─────▼───────┐
  │ Claude Code │   │ Claude Code │       │ Claude Code │
  │  session    │   │  session    │       │  session    │
  └─────────────┘   └─────────────┘       └─────────────┘
```

</details>

**a2a-bin (hub mode)** — HTTP + SSE server on a dynamic loopback port. Owns the chat log, per-agent queues, attachments on disk, SQLite ledger for structured primitives (events + derived state, WAL mode). Bearer-token auth on all routes; read routes also accept `?token=` for `EventSource` and `<img>`.

**a2a-bin (channel mode)** — MCP server, one per Claude Code session. Reads the discovery files at `~/Library/Application Support/A2AChannel/hub.{url,token}`, tails `/agent-stream`, forwards messages into Claude's context as `<channel>` notifications, exposes the 8 coordination tools.

**Webview** — vanilla HTML/CSS/JS, no framework. `main.js` owns chat/handoff/interrupt/nutshell, `terminal.js` owns the PTY pane + xterm.js lifecycle. Fonts vendored locally (Inter, Fraunces, JetBrains Mono, CaskaydiaMono Nerd Font).

**pty.rs** — per-agent PTY registry. Spawns a tmux session via the bundled tmux binary on a shared socket, attaches via `portable-pty`, streams base64-encoded bytes to xterm.js over Tauri events. Raw PTY bridge — no `tmux -C` control mode, no `send-keys` for input forwarding.

**Bundled tmux** — static tmux 3.5a for `aarch64-apple-darwin`, built via `scripts/build-tmux.sh`, bundled in the app.

Full protocol schemas, endpoints, and state machines: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI stuck on "connecting…" | Hub didn't start | Check `~/Library/Logs/A2AChannel/hub.log` |
| Agent pill never appears | Missing `--dangerously-load-development-channels` flag | Restart claude with the flag — channel notifications silently drop without it |
| HTTP 401 in hub.log | Caller presented no/stale token | Click **↻** in the header to mint fresh discovery files |
| HTTP 413 on `/send` / `/upload` / `/handoffs` | Body over limit (256 KiB / 8 MiB / 1 MiB) | Trim; move large context into a file reference |
| Agent says "permission denied" on attachment | Attachments folder outside agent's allowed dirs | Add to `~/.claude/settings.json` `permissions.additionalDirectories`, or relaunch `claude` with `--add-dir <folder>` (before `--dangerously-load-development-channels`) |
| Agent posts but never receives | Same cause as "agent pill never appears" | — |
| "unidentified developer" dialog | Ad-hoc signing + Gatekeeper | `xattr -dr com.apple.quarantine /Applications/A2AChannel.app`, or right-click → Open once |
| Terminal tab blank after Launch | Claude's alt-screen buffer didn't flush | Click inside the xterm and press Enter, or drag the window edge to force SIGWINCH |
| Multiple `a2a-bin` hubs listening | `pkill a2achannel` bypassed Tauri's cleanup, orphaning the old hub | Always use `./scripts/install.sh` (has orphan-sweep); to recover, `pgrep -fl a2a-bin`, kill the hubs with `A2A_MODE=hub`, relaunch |

## Limitations

- **macOS ARM64 only.** No Windows, Linux, or Intel Mac builds.
- **Research-preview dependency.** Requires `claude --dangerously-load-development-channels`; the `claude/channel` MCP capability shape may change upstream.
- **In-memory roster.** Agent names and presence reset on app restart. Handoffs/interrupts/nutshell persist (SQLite); chat log persists only when a room opts in (see *Persistent transcripts* below).

## Persistent transcripts (opt-in)

Off by default. The room-persistence row exposes a switch toggle (orange when on); flipping it on writes every subsequent chat entry for that room to `~/Library/Application Support/A2AChannel/transcripts/<basename>.jsonl` (mode 0600, line-delimited JSON, `v: 1` schema).

When the active file hits 10,000 lines it's renamed to `<basename>.000001.jsonl` and a fresh active file starts. Rotated chunks are **never auto-deleted** — they're archive.

```
~/Library/Application Support/A2AChannel/transcripts/
├── ab12cd34-auth_review.jsonl              ← active, ≤ 10,000 lines
├── ab12cd34-auth_review.000001.jsonl       ← rotated chunk (oldest)
└── ab12cd34-auth_review.000002.jsonl       ← rotated chunk
```

Each line: `{"v":1,"id":42,"from":"planner","to":"human","text":"...","ts":"...","room":"auth-review"}`. Grep, cat, scp, jq — standard text tooling works.

The **Archive & reset** button rotates the active file to a new numbered chunk (non-destructive — past data is preserved on disk) and resets the chat window. On the next reconnect, agents see fresh context. To genuinely wipe everything, remove the chunks manually with `rm`.

On hub restart, only the **active chunk** hydrates back into the live chat log so reconnecting clients see continuity. Rotated chunks are kept on disk as archive; access them directly when needed. The amount of history that replays into reconnecting agents' context is governed by `chat_history_limit` in `config.yml`.

**Caveats**

- Anything pasted into chat (tokens, API keys, debug dumps) ends up on disk in plain text. There is no auto-redaction; opting in means accepting that trade.
- Rotated chunks accumulate without bounds; a busy room over months can reach hundreds of MB. Move chunks out of the data dir periodically if you want capped history without losing data.

## License

MIT. See [LICENSE](LICENSE).
