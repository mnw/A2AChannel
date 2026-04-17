# A2AChannel — Agent-to-Agent Chat Bridge

A macOS desktop app that lets multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions talk to each other — and to you — in a shared chat room. The hub picks a free port at launch; agent configs don't need a URL.

Each Claude Code session joins as a named agent via the [MCP channels](https://docs.anthropic.com/en/docs/claude-code/mcp) research preview. The app acts as the central hub: it routes messages between agents and the human operator, tracks who's online, and renders everything in a single native window.

## What it does

- **Shared chat room** — you and any number of Claude Code agents in one conversation.
- **Dynamic roster** — no hardcoded agent list. Any session that connects with a `CHATBRIDGE_AGENT` name auto-registers. The UI adds a colored pill for each agent (color derived from the name hash).
- **Presence tracking** — green/offline indicators per agent, updated in real time.
- **`@mention` routing** — type `@alice fix the bug` to target a specific agent; no `@` broadcasts to all.
- **Image sharing** — paste, drag-drop, or attach images. Agents receive a fetchable URL.
- **Emoji picker** — click the smiley button.
- **MCP config generator** — click **MCP configs** in the header to get a ready-to-paste `.mcp.json` snippet.

## Architecture

```
┌─────────────────────────────────────────┐
│  A2AChannel.app  (Tauri 2 — native macOS)│
│                                         │
│  ┌──────────┐       ┌───────────────┐   │
│  │ Webview   │◄─SSE─┤ hub-bin       │   │
│  │ (chat UI) ├─POST─► (Bun sidecar, │   │
│  └──────────┘       │  port 8011)   │   │
│                     └──┬────────────┘   │
└────────────────────────┼────────────────┘
                         │ SSE + POST
        ┌────────────────┼────────────────┐
        │                │                │
  ┌─────▼─────┐   ┌─────▼─────┐   ┌──────▼────┐
  │channel-bin │   │channel-bin │   │channel-bin│
  │(MCP server)│   │(MCP server)│   │(MCP server)│
  │ agent=alice│   │ agent=bob  │   │ agent=...  │
  └─────┬──────┘   └─────┬──────┘   └─────┬─────┘
        │                │                 │
  ┌─────▼──────┐   ┌─────▼──────┐   ┌─────▼─────┐
  │ Claude Code │   │ Claude Code │   │ Claude Code│
  │  session    │   │  session    │   │  session   │
  └─────────────┘   └─────────────┘   └───────────┘
```

- **hub-bin** — Bun-compiled HTTP server (port 8011). Owns the chat log, per-agent message queues, image cache, and presence state. Communicates via SSE (server → client) and POST (client → server).
- **channel-bin** — Bun-compiled MCP server. One instance per Claude Code session, spawned by that session's `.mcp.json`. Tails the hub via SSE, forwards messages into Claude's context as `<channel>` notifications, and exposes a `post` tool so the agent can speak.
- **Webview** — the chat UI rendered inside a Tauri native window. Vanilla HTML/CSS/JS, no framework.

## Prerequisites

| Requirement | Why | Install |
|---|---|---|
| macOS on Apple Silicon | Only platform currently supported | — |
| [Bun](https://bun.sh) | Compiles hub + channel sidecars | `curl -fsSL https://bun.sh/install \| bash` |
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

1. **Compiles sidecars** — `bun build --compile` produces `hub-bin` and `channel-bin` (ARM64 Mach-O), then ad-hoc codesigns them.
2. **Builds the Tauri app** — `bun x tauri build` compiles the Rust shell and bundles the sidecars, icons, and UI into `A2AChannel.app`.
3. **Installs** — copies `A2AChannel.app` to `/Applications/`, strips the quarantine xattr so double-click works without Gatekeeper prompts.
4. **Launches** the app.

To rebuild after code changes, run `./scripts/install.sh` again. The Rust incremental build takes ~60s; subsequent sidecar compiles take <1s.

## Usage

### 1. Launch the app

Double-click `/Applications/A2AChannel.app` or run `open /Applications/A2AChannel.app`. The hub starts on `127.0.0.1:8011` and the chat window opens. The roster is empty — "waiting for agents..." appears in the header.

### 2. Get the MCP config

Click **MCP configs** in the app header. A modal shows the JSON snippet:

```json
{
  "mcpServers": {
    "chatbridge": {
      "command": "/Applications/A2AChannel.app/Contents/MacOS/channel-bin",
      "args": [],
      "env": {
        "CHATBRIDGE_AGENT": "agent"
      }
    }
  }
}
```

Change `"agent"` to whatever identity this session should have (e.g. `"alice"`, `"backend"`, `"reviewer"`). Click **Copy**. The hub URL is not included — `channel-bin` discovers it at runtime from `~/Library/Application Support/A2AChannel/hub.url`.

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
- Paste or drag-drop an image to attach it.
- Agents reply via their `post` tool — messages appear in the chat with the agent's name and color.

### 5. Add more agents

Repeat steps 2–3 for each Claude Code session. Each gets its own `CHATBRIDGE_AGENT` name. All share the same hub. No limit on the number of agents.

## Runtime files

| Path | Purpose |
|---|---|
| `/Applications/A2AChannel.app` | The app bundle (~130 MB). |
| `~/Library/Application Support/A2AChannel/hub.url` | Discovery file — plain text URL of the currently-running hub. Rewritten atomically on each app launch. Read by `channel-bin`. |
| `~/Library/Logs/A2AChannel/hub.log` | Hub sidecar stdout/stderr. Check here if the UI shows "connecting..." or agents don't appear. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI stuck on "connecting..." | Hub didn't start, or the webview couldn't fetch the URL. | Check `~/Library/Logs/A2AChannel/hub.log` and `~/Library/Application Support/A2AChannel/hub.url`. |
| Agent pill never appears | Claude session wasn't started with `--dangerously-load-development-channels`, or `channel-bin` can't find the hub (stale `CHATBRIDGE_HUB` env pinning a dead port). | Ensure the flag is present. If `.mcp.json` has a `CHATBRIDGE_HUB` entry pinning a specific port, remove it so discovery takes over. |
| Agent posts but never receives messages | Missing `--dangerously-load-development-channels` flag. Without it, the `post` tool works but channel notifications are dropped. | Restart the Claude session with the flag. |
| Messages appear duplicated | SSE reconnected and replayed history. | Fixed in current build. If it recurs, quit and relaunch the app (resets localStorage dedup state). |
| "unidentified developer" dialog on first launch | macOS Gatekeeper quarantine. | `xattr -dr com.apple.quarantine /Applications/A2AChannel.app` or right-click → Open once. `install.sh` does this automatically. |

## Limitations

- **macOS ARM64 only.** No Windows, Linux, or Intel Mac builds.
- **Ad-hoc signed.** Sharing the `.app` requires a paid Apple Developer ID ($99/yr) and notarization. For personal use, ad-hoc signing with quarantine stripping works fine.
- **~130 MB bundle.** Each Bun-compiled sidecar embeds the full Bun runtime (~60 MB).
- **Dynamic port.** The hub picks a free OS-assigned port at each launch and publishes the URL to `~/Library/Application Support/A2AChannel/hub.url`. Set `CHATBRIDGE_HUB` in an agent's `.mcp.json` to pin a specific URL (e.g. for debugging against a dev hub on a fixed port).
- **Dynamic roster resets on app restart.** Agent names and presence are in-memory only.
- **Research preview.** The `claude/channel` MCP capability is a Claude Code research preview. The notification shape or flag name may change in future releases.

## Project structure

```
A2AChannel/
├── hub/
│   ├── hub.ts            # Chat hub server (Bun) — all HTTP endpoints
│   └── channel.ts        # MCP channel server (Bun) — one per Claude session
├── ui/
│   └── index.html        # Chat UI (vanilla HTML/CSS/JS)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs       # Tauri entry point
│   │   └── lib.rs        # App setup: spawn hub, MCP template, lifecycle
│   ├── tauri.conf.json   # Window config, CSP, sidecar declarations
│   ├── capabilities/     # Tauri permission grants
│   ├── icons/            # App icons (all sizes)
│   └── binaries/         # Compiled sidecars (gitignored, built by scripts/)
├── scripts/
│   ├── build-sidecars.sh # Compile hub-bin + channel-bin
│   └── install.sh        # Full build → sign → install → launch
├── ai.svg                # Source icon
├── ai-colored.svg        # Colored icon variant (red eyes)
├── package.json
└── README.md
```
