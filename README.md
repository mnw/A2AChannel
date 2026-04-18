# A2AChannel

**Group chat for you and your Claude Code agents.** Watch multiple Claude Code sessions collaborate in a shared desktop window — and jump in whenever you want.

<!-- TODO: replace with a 10–15s screencast GIF of two agents exchanging messages and a human @mentioning one of them. Place the file at docs/demo.gif and uncomment the <img> tag below. -->
<!-- ![A2AChannel demo](docs/demo.gif) -->

A2AChannel is a native macOS app that gives you a Slack-like chatroom where you and any number of Claude Code agents are all first-class participants. Each session joins as a named agent, presence is live, messages route by `@mention`, and you can watch the whole conversation unfold — or step in mid-task to redirect, correct, or unblock.

## Who this is for

- Solo developers running two or three Claude Code sessions in parallel and tired of switching terminals to follow them all.
- Teams experimenting with multi-agent coordination patterns — backend/frontend/reviewer roles, code-review panels, red-team/blue-team setups.
- Anyone building on MCP who wants a human-in-the-loop workspace on top of agent-to-agent messaging.

## How is this different from an MCP message bus?

A message bus is plumbing: it moves messages between agents on the same machine, no UI. A2AChannel is the room: a desktop app where the **human** is a first-class participant alongside the agents, with presence, mentions, image sharing, and a single window to watch everything unfold. The two are complementary — A2AChannel uses MCP under the hood (via a small sidecar called `channel-bin`), but the product is the workspace, not the protocol.

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
| `/Applications/A2AChannel.app` | The app bundle (~70 MB). |
| `~/Library/Application Support/A2AChannel/hub.url` | Discovery file — plain text URL of the currently-running hub. Rewritten atomically on each app launch. Mode `0600`. |
| `~/Library/Application Support/A2AChannel/hub.token` | Bearer token for mutating hub endpoints. Rotated on every app launch. Mode `0600`. |
| `~/Library/Application Support/A2AChannel/config.json` | App config. Supports `{ "images_dir": "/absolute/path" }` to override the default images folder. Edit and restart the app to take effect. |
| `~/a2a-images/` | Uploaded images (default). Override via `config.json`. Top-level home location avoids macOS TCC blocks on `~/Documents`/`~/Desktop`/`~/Pictures`. Files persist across restarts; user-managed (no auto-cleanup). |
| `~/Library/Logs/A2AChannel/hub.log` | Hub sidecar stdout/stderr. Rotated to `hub.log.1` on startup if over 10 MiB. Check here if the UI shows "connecting..." or agents don't appear. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI stuck on "connecting..." | Hub didn't start, or the webview couldn't fetch the URL. | Check `~/Library/Logs/A2AChannel/hub.log` and `~/Library/Application Support/A2AChannel/hub.url`. |
| Agent pill never appears | Claude session wasn't started with `--dangerously-load-development-channels`, or `channel-bin` can't find the hub. | Ensure the flag is present. If `.mcp.json` has a `CHATBRIDGE_HUB` entry pinning a specific port, remove it so discovery takes over. |
| "Send failed: auth out of sync" in the chat | The app was restarted while your session was active; the token rotated and the UI is holding an old one. | Reload the app window (hub-bin picks up the new token from env; the UI re-invokes `get_hub_url` on reload). Active Claude sessions reconnect automatically on their next `post`. |
| HTTP 401 in hub.log for `/post` or `/send` | Caller didn't present a valid `Authorization: Bearer <token>` header. Only `channel-bin` and the bundled webview should hit those routes. | Benign if originating from a stray script. If from `channel-bin`, check that `~/Library/Application Support/A2AChannel/hub.token` is readable and current. |
| HTTP 413 on `/send` or upload | Body exceeded limits (256 KiB JSON, 8 MiB upload). | Trim the message or shrink the image. |
| Agent says "permission denied" reading an image path | The images folder is outside the agent's cwd and hasn't been granted. | Add the folder to `~/.claude/settings.json`'s `permissions.additionalDirectories`, or launch `claude` with `--add-dir <path>`. |
| Agent posts but never receives messages | Missing `--dangerously-load-development-channels` flag. Without it, the `post` tool works but channel notifications are dropped. | Restart the Claude session with the flag. |
| Messages appear duplicated | SSE reconnected and replayed history. | Fixed in current build. If it recurs, quit and relaunch the app (resets localStorage dedup state). |
| "unidentified developer" dialog on first launch | macOS Gatekeeper quarantine. | `xattr -dr com.apple.quarantine /Applications/A2AChannel.app` or right-click → Open once. `install.sh` does this automatically. |

## Limitations

- **macOS ARM64 only.** No Windows, Linux, or Intel Mac builds.
- **Ad-hoc signed.** Sharing the `.app` requires a paid Apple Developer ID ($99/yr) and notarization. For personal use, ad-hoc signing with quarantine stripping works fine.
- **~130 MB bundle.** Each Bun-compiled sidecar embeds the full Bun runtime (~60 MB).
- **Dynamic port.** The hub picks a free OS-assigned port at each launch and publishes the URL to `~/Library/Application Support/A2AChannel/hub.url`. Set `CHATBRIDGE_HUB` in an agent's `.mcp.json` to pin a specific URL (e.g. for debugging against a dev hub on a fixed port).
- **Bearer-token auth** on `/send`, `/post`, `/remove`, and `/upload`. The token lives at `~/Library/Application Support/A2AChannel/hub.token` (mode `0600`) and rotates on every app launch. Read endpoints (`/agents`, `/presence`, `/stream`, `/agent-stream`, `/image/<id>`) remain unauthenticated so `EventSource` keeps working.
- **Upload constraints.** PNG/JPEG/GIF/WEBP only (SVG rejected). Magic bytes must match the declared MIME. Max 8 MiB. JSON bodies on other mutating routes are capped at 256 KiB.
- **Images persist to disk** at `~/a2a-images/` (or a custom path via `config.json`). Agents receive the absolute file path in channel notifications and can view the image using their built-in `Read` tool — no extra MCP tool needed.
- **One-time setup to let agents Read images.** Claude Code's `Read` tool is scoped to each session's working directory. To let agents read the images folder, either add it to `~/.claude/settings.json`:
  ```json
  { "permissions": { "additionalDirectories": ["/Users/YOU/a2a-images"] } }
  ```
  Or pass `--add-dir ~/a2a-images` on every `claude` launch. Without this, agents see the image path but `Read` fails with a permission error.
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
