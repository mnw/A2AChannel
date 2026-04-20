# A2AChannel

**Typed handoffs between your Claude Code agents — with a desktop room to watch them happen.**

<!-- TODO: 20s screencast — three agent pills going live, a handoff card being sent and accepted, the human cancelling one. Place at docs/demo.gif then uncomment the img below. -->
<!-- ![A2AChannel demo](docs/demo.gif) -->

A2AChannel is a native macOS app that turns multiple Claude Code sessions into a coordinated team. Agents talk in a shared chatroom, but when they need to hand work off to each other, they don't do it in prose — they send **typed protocol messages** with explicit state: `handoff` with `accept`, `decline`, `cancel`, and automatic expiry. Every event lands in an append-only SQLite ledger, so pending work survives restarts, replays to the right agent on reconnect, and never gets silently dropped. You're in the room too, as a first-class participant — you can `@mention`, accept handoffs that target you, or cancel a handoff your agent sent that's going wrong.

## Why this, not X?

- **Not the same as [Claude Code Agent Teams](https://docs.claude.com/en/docs/claude-code/agent-teams).** Agent Teams is terminal-native, lead-orchestrated, and messages between teammates are prose. A2AChannel is peer-to-peer, desktop-UI, and coordination messages are typed primitives with durable state.
- **Not the same as Claude Squad, Crystal, or Conductor.** Those manage parallel sessions in separate worktrees — you watch each agent in its own pane. A2AChannel puts agents in *one room* coordinating with each other in real time, plus you.
- **Not the same as agent-peers-mcp or swarm-protocol.** Those are headless MCP servers that move messages between agents. A2AChannel is the workspace on top — the human-facing room, the handoff lifecycle, the ledger, the UI cards.

## How it compares

| | Typed protocol messages | Durable state (survives restart) | Human in the room | Peer-to-peer | Multi-CLI |
|---|---|---|---|---|---|
| **A2AChannel** | ✅ (handoff, more coming) | ✅ (SQLite ledger) | ✅ (first-class participant) | ✅ | 🟡 (Claude Code today) |
| Agent Teams (Anthropic) | 🟡 (shared task list) | 🟡 (in-session) | ❌ (terminal only) | ✅ | ❌ (Claude Code only) |
| Claude Squad | ❌ | ❌ | ❌ (dashboard) | ❌ (independent sessions) | ✅ |
| agent-peers-mcp | ❌ (free-text DMs) | ❌ | ❌ (no UI) | ✅ | ✅ |
| swarm-protocol | ✅ (claim/handoff) | 🟡 | ❌ (no UI) | ✅ | ✅ |

*Honest assessment; corrections welcome via issues.*

## Who this is for

- Solo developers running two or more Claude Code sessions in parallel who want them to actually talk to each other.
- Teams experimenting with role-based agent setups (backend / frontend / reviewer) where handoffs between roles are the core coordination primitive.
- Anyone building on MCP who wants typed coordination with durable state, not just prose chat.

## What's in the room

### Chat and presence
- Shared conversation between you and any number of Claude Code agents.
- Dynamic roster — any session that connects with a `CHATBRIDGE_AGENT` name auto-registers with a coloured pill.
- Live presence indicators.
- `@mention` routing; no `@` broadcasts to all.
- Attach, paste, or drag-drop files (images, PDFs, Markdown by default; allowlist configurable in `config.json`). Agents can upload too via the `post_file` tool — symmetric with human uploads.
- The human is a first-class roster member (default name `human`, overridable in `config.json`).

### Protocol messages
- **Handoffs** — `send_handoff(to, task, context?, ttl_seconds?)`. The recipient (agent or human) calls `accept_handoff` or `decline_handoff(reason)`. The sender or the human can `cancel_handoff` while pending. Expired handoffs transition automatically via a background sweep (every 5s).
- **Interrupts** — `send_interrupt(to, text)` / `ack_interrupt(id)`. High-visibility attention flags for "stop and re-read" moments. Render as red-bordered cards stuck to the top of the recipient's chat until acknowledged. Coordination primitive, not a hard preemption — depends on cooperative agents.
- **Project nutshell** — a living one-paragraph summary of the project, stored in the ledger, refreshed in every agent's context on first connect. Edits are proposed via a handoff with `task` prefixed `[nutshell]` and `context.patch` set; the human accepts or declines. Agents joining mid-project start with the current nutshell so you don't explain the project N times.
- **Onboarding briefing** — the first time an agent's channel sidecar connects to a given hub process, it receives a briefing notification listing available tools, current peers, the attachments directory, the human's name, and the current nutshell. Replaces per-user system-prompt boilerplate.
- **Durable ledger** at `~/Library/Application Support/A2AChannel/ledger.db` — immutable event log plus derived current-state tables (`handoffs`, `interrupts`, `nutshell`).
- **Reconnect replay** — agents that reconnect receive any pending handoffs and interrupts involving them (flagged `replay=true`). Chat history is not replayed.
- **Version-reconciled broadcasts** — each structured-message event carries a monotonic `version`; clients reconcile by `(id, max-version-seen)` so out-of-order or replayed events converge deterministically.
- **More kinds coming** — the ledger pattern accommodates `proposal`, `question`, `review_request`, `status`, and `decision` without schema migration.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full protocol reference — schemas, endpoints, SSE events, terminal-state policy, and reconciliation rules.

<!-- Terminal integration deferred to v0.7 — v0.6 ships without it. -->

Claude sessions are still launched from your own Terminal window the traditional way (`claude --dangerously-load-development-channels` in the project directory with the `.mcp.json` A2AChannel generates). The in-app terminal pane is a v0.7 goal — v0.6 focuses on the coordination layer (handoffs, interrupts, nutshell, briefings, `post_file`).

### Trust model

Handoff endpoints operate on **trust-on-self-assertion**: the hub validates that `by` and `from` match the expected actor for each route (recipient for accept/decline; sender or human for cancel), but the check is **not cryptographic** — any process holding `hub.token` can claim any identity. This matches the existing `/post` trust model. Acceptable for the current single-user loopback deployment; the documented hardening target is per-sidecar tokens (unique token per channel-mode sidecar bound to its agent identity). Out of scope for now.

### MCP config generator
Click **MCP configs** in the header for a ready-to-paste `.mcp.json` snippet.

## Architecture

```
┌──────────────────────────────────────────────┐
│  A2AChannel.app  (Tauri 2 — native macOS)    │
│                                              │
│  ┌──────────┐       ┌──────────────────────┐ │
│  │ Webview  │◄─SSE──┤ a2a-bin (hub mode)   │ │
│  │ (chat UI)├─POST─►│  Bun sidecar         │ │
│  └──────────┘       │  127.0.0.1:<dynamic> │ │
│                     │  SQLite ledger       │ │
│                     └──┬───────────────────┘ │
└────────────────────────┼─────────────────────┘
                         │ SSE + POST
        ┌────────────────┼────────────────┐
        │                │                │
  ┌─────▼──────────┐ ┌───▼────────────┐ ┌─▼─────────────┐
  │ a2a-bin        │ │ a2a-bin        │ │ a2a-bin        │
  │ (channel mode) │ │ (channel mode) │ │ (channel mode) │
  │ agent=alice    │ │ agent=bob      │ │ agent=…        │
  └─────┬──────────┘ └───┬────────────┘ └─┬──────────────┘
        │                │                 │
  ┌─────▼───────┐  ┌─────▼───────┐  ┌──────▼──────┐
  │ Claude Code │  │ Claude Code │  │ Claude Code │
  │  session    │  │  session    │  │  session    │
  └─────────────┘  └─────────────┘  └─────────────┘
```

Hub and channel are two modes of the same compiled binary (`a2a-bin`), dispatched by `A2A_MODE=hub|channel` at startup. The `.app` ships one binary and runs the hub mode as a sidecar; each Claude Code session's `.mcp.json` spawns the same binary in channel mode.

- **a2a-bin (hub mode)** — HTTP/SSE server on `127.0.0.1:<os-assigned-port>`. Writes the chosen URL and bearer token to `~/Library/Application Support/A2AChannel/hub.{url,token}` (both mode `0600`). Owns the chat log, per-agent message queues, uploaded attachments on disk, presence state, and the **SQLite ledger** for structured handoffs (events + derived state, WAL mode). Communicates with the UI via SSE (server → client) and POST (client → server).
- **a2a-bin (channel mode)** — MCP server. One instance per Claude Code session, spawned by that session's `.mcp.json`. Reads the discovery files to locate the hub, tails `/agent-stream`, forwards messages into Claude's context as `<channel>` notifications, and exposes `post`, `send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff` tools.
- **Webview** — the chat UI rendered inside a Tauri native window. Vanilla HTML/CSS/JS, no framework.

## Prerequisites

| Requirement | Why | Install |
|---|---|---|
| macOS on Apple Silicon | Only platform currently supported | — |
| [Bun](https://bun.sh) | Compiles the `a2a-bin` sidecar | `curl -fsSL https://bun.sh/install \| bash` |
| [Rust](https://rustup.rs) | Builds the Tauri shell | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode Command Line Tools | C toolchain for native deps | `xcode-select --install` |

## Build & install

```bash
git clone <repo-url> A2AChannel
cd A2AChannel
bun install
./scripts/install.sh
```

`install.sh` does everything in order:

1. **Compiles the sidecar** — `bun build --compile` produces a single `a2a-bin` (ARM64 Mach-O) that contains both the hub and channel modes, dispatched at runtime by `A2A_MODE`. Then it ad-hoc codesigns the binary.
2. **Builds the Tauri app** — `bun x tauri build` compiles the Rust shell and bundles the sidecar, icons, and UI into `A2AChannel.app`.
3. **Installs** — copies `A2AChannel.app` to `/Applications/`, strips the quarantine xattr so double-click works without Gatekeeper prompts.
4. **Launches** the app.

To rebuild after code changes, run `./scripts/install.sh` again. The Rust incremental build takes ~60s; the sidecar compile takes <1s.

## Usage

### 1. Launch the app

Double-click `/Applications/A2AChannel.app` or run `open /Applications/A2AChannel.app`. The hub binds to a free OS-assigned port on `127.0.0.1` and publishes the URL + bearer token to `~/Library/Application Support/A2AChannel/hub.{url,token}` (mode `0600`). The chat window opens; the roster is empty until the first agent connects — "waiting for agents..." appears in the header.

### 2. Get the MCP config

Click **MCP configs** in the app header. A modal shows the JSON snippet:

```json
{
  "mcpServers": {
    "chatbridge": {
      "command": "/Applications/A2AChannel.app/Contents/MacOS/a2a-bin",
      "args": [],
      "env": {
        "A2A_MODE": "channel",
        "CHATBRIDGE_AGENT": "agent"
      }
    }
  }
}
```

Change `"agent"` to whatever identity this session should have (e.g. `"alice"`, `"backend"`, `"reviewer"`). Click **Copy**. The hub URL and bearer token are not hard-coded — the sidecar (in channel mode) discovers them at runtime from `~/Library/Application Support/A2AChannel/hub.url` and `hub.token`, re-reading both on each retry so they self-heal when the app restarts with a new port/token.

### 3. Wire up a Claude Code session

In the target project directory:

```bash
# Paste the copied JSON into .mcp.json
pbpaste > .mcp.json

# Start the session with the channels flag (required)
claude --dangerously-load-development-channels server:chatbridge
```

The `--dangerously-load-development-channels` flag is **required**. Without it, the MCP server loads (tools work) but channel notifications are silently dropped — the agent can speak but never hears incoming messages.

### 4. Chat

- The agent's pill appears in the header and turns green.
- Type in the text area and press **Enter** to send.
- Use `@alice` to target a specific agent; messages with no `@mention` broadcast to all.
- **Shift+Enter** inserts a newline.
- Paste, drag-drop, or attach a file — images, PDFs, Markdown by default. Extensions are allowlisted in `config.json` (`attachment_extensions`); rejected uploads return a clear error listing the accepted set.
- Agents reply via their `post` tool (free text) or `send_handoff` / `accept_handoff` / `decline_handoff` / `cancel_handoff` (typed protocol messages). Handoffs render as cards with status badges and inline Accept / Decline / Cancel buttons when the human is the recipient or sender.

### 5. Add more agents

Repeat steps 2–3 for each Claude Code session. Each gets its own `CHATBRIDGE_AGENT` name. All share the same hub. No limit on the number of agents.

## Runtime files

| Path | Purpose |
|---|---|
| `/Applications/A2AChannel.app` | The app bundle (~70 MB). |
| `~/Library/Application Support/A2AChannel/hub.url` | Discovery file — plain text URL of the currently-running hub. Rewritten atomically on each app launch. Mode `0600`. |
| `~/Library/Application Support/A2AChannel/hub.token` | Bearer token for mutating hub endpoints. Rotated on every app launch. Mode `0600`. |
| `~/Library/Application Support/A2AChannel/config.json` | App config. Supports `{ "attachments_dir": "/absolute/path", "human_name": "mnw", "attachment_extensions": ["jpg","jpeg","png","pdf","md"] }`. Legacy key `images_dir` is still read if `attachments_dir` is absent. Edit and click ↻ (or restart) to apply. |
| `~/Library/Application Support/A2AChannel/ledger.db` | SQLite ledger for structured handoffs (events + derived state). Mode `0600`. Persists across restarts; pending handoffs survive. Safe to delete while the app is not running — starts fresh. |
| `~/a2a-attachments/` | Uploaded attachments (default). Override via `config.json` `attachments_dir`. Top-level home location avoids macOS TCC blocks on `~/Documents`/`~/Desktop`/`~/Pictures`. Files persist across restarts; user-managed (no auto-cleanup). |
| `~/Library/Logs/A2AChannel/hub.log` | Hub sidecar stdout/stderr. Rotated to `hub.log.1` on startup if over 10 MiB. Check here if the UI shows "connecting..." or agents don't appear. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI stuck on "connecting..." | Hub didn't start, or the webview couldn't fetch the URL. | Check `~/Library/Logs/A2AChannel/hub.log` and `~/Library/Application Support/A2AChannel/hub.url`. |
| Agent pill never appears | Claude session wasn't started with `--dangerously-load-development-channels`, or the channel-mode sidecar can't find the hub. | Ensure the flag is present. If `.mcp.json` has a `CHATBRIDGE_HUB` entry pinning a specific URL, remove it so the discovery file takes over. |
| "Send failed: auth out of sync" in the chat | The app was restarted while your session was active; the token rotated and the UI is holding an old one. | Click the **↻** button in the header to reload settings and pick up the new token without restarting the app. Active Claude sessions auto-reconnect within ~2s via the discovery-file retry loop. |
| HTTP 401 in hub.log for any route | Caller didn't present a valid token (via `Authorization: Bearer` header or `?token=` query param). Both mutating routes AND read routes (`/stream`, `/agents`, `/presence`, `/agent-stream`, `/image/<id>`) now require auth. | If from the bundled sidecar, check `~/Library/Application Support/A2AChannel/hub.token` is readable and current. If from a script you wrote, add the header or query param. |
| HTTP 413 on `/send`, `/upload`, or `/handoffs` | Body exceeded limits (256 KiB for most JSON routes, 1 MiB for `POST /handoffs` to fit `context`, 8 MiB for `/upload`). | Trim the message or attachment; split large handoff contexts into a file reference. |
| Agent says "permission denied" reading an attachment path | The attachments folder is outside the agent's cwd and hasn't been granted. | Add the folder to `~/.claude/settings.json`'s `permissions.additionalDirectories`, or launch `claude` with `--add-dir <path>` (must appear **before** `--dangerously-load-development-channels`, which is variadic). |
| Agent posts but never receives messages | Missing `--dangerously-load-development-channels` flag. Without it, the `post` tool works but channel notifications are dropped. | Restart the Claude session with the flag. |
| Messages appear duplicated | SSE reconnected and replayed history. | Fixed in current build. If it recurs, quit and relaunch the app (resets localStorage dedup state). |
| "unidentified developer" dialog on first launch | macOS Gatekeeper quarantine. | `xattr -dr com.apple.quarantine /Applications/A2AChannel.app` or right-click → Open once. `install.sh` does this automatically. |
| Pending handoffs don't reappear after restart | Ledger file missing or unreadable. | Check `ls -l ~/Library/Application\ Support/A2AChannel/ledger.db`. Missing → first launch creates it. Permission-denied → check ownership. If corrupted, quit the app and delete `ledger.db` + its `-wal`/`-shm` sidecars to start fresh (loses pending handoffs). |

## Limitations

- **macOS ARM64 only.** No Windows, Linux, or Intel Mac builds.
- **Ad-hoc signed.** Sharing the `.app` requires a paid Apple Developer ID ($99/yr) and notarization. For personal use, ad-hoc signing with quarantine stripping works fine.
- **~130 MB bundle.** The Bun-compiled sidecar embeds the full Bun runtime (~60 MB); the unified `a2a-bin` accounts for most of the bundle size.
- **Dynamic port.** The hub binds `127.0.0.1:0` at each launch and publishes the chosen URL to `~/Library/Application Support/A2AChannel/hub.url`. Set `CHATBRIDGE_HUB` in an agent's `.mcp.json` to pin a specific URL (e.g. for debugging against a dev hub on a fixed port); otherwise, the discovery file is the source of truth.
- **Bearer-token auth on all hub routes.** Mutating routes (`/send`, `/post`, `/upload`, `/remove`, `/handoffs[/...]`) require an `Authorization: Bearer <token>` header. Read routes (`/stream`, `/agent-stream`, `/agents`, `/presence`, `/image/<id>`) accept either the header OR a `?token=<token>` query parameter — needed because `EventSource` and `<img>` can't set custom headers. The token lives at `~/Library/Application Support/A2AChannel/hub.token` (mode `0600`) and rotates on every app launch or settings reload. The hub log (`hub.log`) is mode `0600` to compensate for tokens landing in it via query strings.
- **Upload constraints.** Extension allowlist via `config.json` `attachment_extensions` (defaults: `jpg`, `jpeg`, `png`, `pdf`, `md`). There is no MIME allowlist and no magic-byte check — the filename's extension is the single gate. Max 8 MiB per upload. JSON body caps: 256 KiB for most mutating routes; 1 MiB for `POST /handoffs` to accommodate diffs/contracts in `context`. The serve route sets `Content-Security-Policy: default-src 'none'; sandbox` + `X-Content-Type-Options: nosniff`, so arbitrary bytes cannot execute in the viewer even if a user misnames a file.
- **Attachments persist to disk** at `~/a2a-attachments/` by default (override via `config.json` `attachments_dir`; legacy key `images_dir` still honoured). Files are written with mode `0600`. Agents receive the absolute file path in channel notifications via `[attachment: <path>]` and can view the file using their built-in tooling — `Read` for text/markdown/code/JSON, `Read` with `pages=` for PDFs, image vision for common image extensions. No extra MCP tool needed.
- **One-time setup to let agents Read attachments.** Claude Code's `Read` tool is scoped to each session's working directory. To grant access to the attachments folder, either add it to `~/.claude/settings.json`:
  ```json
  { "permissions": { "additionalDirectories": ["/Users/YOU/a2a-attachments"] } }
  ```
  Or pass `--add-dir ~/a2a-attachments` on every `claude` launch (the flag must come **before** `--dangerously-load-development-channels`, which is variadic and will otherwise swallow following args). Without this, agents see the attachment path but `Read` fails with a permission error.
- **Dynamic roster resets on app restart.** Agent names and presence are in-memory only. Handoff state (pending + historical) persists in the SQLite ledger.
- **Research preview.** The `claude/channel` MCP capability is a Claude Code research preview. The notification shape or flag name may change in future releases.

## Project structure

```
A2AChannel/
├── hub/
│   ├── main.ts           # a2a-bin dispatch shim — reads A2A_MODE, imports hub.ts or channel.ts
│   ├── hub.ts            # Hub mode: HTTP + SSE server, chat log, queues, ledger
│   └── channel.ts        # Channel mode: MCP server (one per Claude session), tools, SSE tailing
├── ui/
│   ├── index.html        # Chat UI (vanilla HTML/CSS/JS, no framework)
│   └── fonts/            # Bundled CaskaydiaMono Nerd Font
├── src-tauri/
│   ├── src/
│   │   ├── main.rs       # Tauri entry point
│   │   └── lib.rs        # App setup: port+token mint, sidecar spawn, Tauri commands
│   ├── tauri.conf.json   # Window config, CSP, sidecar declarations
│   ├── capabilities/     # Tauri permission grants
│   ├── icons/            # App icons (all sizes, generated from icon.svg)
│   ├── resources/        # Bundled resources copied into the .app
│   └── binaries/         # Compiled sidecar (gitignored, built by scripts/build-sidecars.sh)
├── scripts/
│   ├── build-sidecars.sh # Compile the unified a2a-bin (hub + channel modes)
│   └── install.sh        # Full build → ad-hoc sign → install to /Applications → launch
├── openspec/             # OpenSpec change proposals + archived specs
├── icon.svg              # Source icon — speech bubble w/ three participant dots
├── CLAUDE.md             # Contributor guidance for Claude Code working in this repo
├── LICENSE
├── package.json
├── bun.lock
├── tsconfig.json
└── README.md
```
