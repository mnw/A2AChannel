## Why

The hub port is currently hardcoded to `8011` in four places (`src-tauri/src/lib.rs`, `hub/hub.ts`, `src-tauri/tauri.conf.json` CSP, and every `.mcp.json` file in every agent project). This creates three concrete pains: port collisions leave the app unable to start with only `EADDRINUSE` in the log; changing the port requires editing four sites and rebuilding the bundle; and two simultaneous instances of the app cannot run on the same machine. The workaround — manually keeping four files in sync and avoiding 8011 globally — is fragile and leaks into every agent project's MCP config.

## What Changes

- **BREAKING** `.mcp.json` files no longer need or use the `CHATBRIDGE_HUB` env var. Existing configs with an explicit URL still work (honored as an override); configs without it now use on-disk discovery.
- The Rust shell binds a free TCP port chosen by the OS at startup (port `0`), reads the assigned port, and passes it to the `hub-bin` sidecar via env var.
- On startup the Rust shell writes a discovery file at `~/Library/Application Support/A2AChannel/hub.url` containing the current hub URL.
- `channel-bin` reads the discovery file when `CHATBRIDGE_HUB` is unset or empty. It re-reads on each reconnect attempt so stale URLs self-heal.
- A new Tauri command `get_hub_url()` replaces the hardcoded `BUS` constant in the webview; the UI queries for its hub URL at startup.
- CSP widens `connect-src` and `img-src` from `http://127.0.0.1:8011` to `http://127.0.0.1:*`, permitting any local port.
- The MCP config modal generator no longer emits `CHATBRIDGE_HUB` in the template.
- The CLAUDE.md hard rule about "port 8011 hardcoded in three places" is removed, replaced with a rule about the discovery file contract.

## Capabilities

### New Capabilities
- `hub-discovery`: Defines how the hub advertises its listening address at runtime and how peers (webview, `channel-bin`) locate it without hardcoded configuration.

### Modified Capabilities
<!-- No existing specs exist yet; nothing to modify -->

## Impact

- **Code**: `src-tauri/src/lib.rs` (bind port, write discovery file, add Tauri command, manage cleanup), `hub/hub.ts` (continue reading `PORT` env — no change needed), `hub/channel.ts` (add discovery file fallback), `ui/index.html` (fetch URL via invoke before opening SSE), `src-tauri/tauri.conf.json` (CSP wildcard), `src-tauri/capabilities/default.json` (no change expected).
- **APIs**: New Tauri command `get_hub_url()`. New filesystem contract: `~/Library/Application Support/A2AChannel/hub.url` written by the app, read by `channel-bin`.
- **Dependencies**: None added. Uses standard library for port binding and filesystem.
- **Documentation**: `CLAUDE.md` hard rules updated. `README.md` MCP setup steps simplified (no URL to paste).
- **Backwards compatibility**: Existing `.mcp.json` files continue to work via the `CHATBRIDGE_HUB` env var override. Users who rebuild after this change get simpler configs; users with old configs get warned in `hub.log` but function correctly so long as the app happens to land on the same port they pinned (unlikely post-change — the README will tell them to remove the env var).
