## MODIFIED Requirements

### Requirement: Hub URL is published to a discovery file

On successful hub startup, the Rust shell SHALL write the hub URL to `~/Library/Application Support/A2AChannel/hub.url`. The file SHALL contain exactly the URL (e.g. `http://127.0.0.1:54831`), optionally terminated by a newline. The parent directory SHALL be created if it does not exist. The write SHALL be atomic: the Rust shell SHALL write to a temporary file in the same directory and rename it over the target. The discovery file SHALL be created with file mode `0600` (owner read/write only) so that other local users cannot observe the running hub's URL.

#### Scenario: Discovery file is written on first launch

- **WHEN** the app starts for the first time on a machine
- **AND** `~/Library/Application Support/A2AChannel/` does not yet exist
- **THEN** the directory is created
- **AND** `hub.url` is written with content matching the hub's actual URL
- **AND** `hub.url` has filesystem mode `0600`

#### Scenario: Discovery file is replaced atomically on restart

- **GIVEN** a previous run left `hub.url` containing `http://127.0.0.1:54831`
- **WHEN** the app starts again and obtains port `62144`
- **THEN** `hub.url` is updated atomically (rename-into-place)
- **AND** any reader observes either the full old content or the full new content, never partial
- **AND** the new file retains mode `0600`

## ADDED Requirements

### Requirement: Hub publishes an auth token alongside the URL

On successful hub startup, the Rust shell SHALL mint a cryptographically-random token (at least 32 bytes of entropy, URL-safe base64 encoded) and write it to `~/Library/Application Support/A2AChannel/hub.token`. The file SHALL contain exactly the token, optionally terminated by a newline. The write SHALL be atomic. The token file SHALL be created with file mode `0600`. The token SHALL be re-minted on every app launch (no persistence across restarts).

#### Scenario: Token file created at startup

- **WHEN** the app starts
- **THEN** `~/Library/Application Support/A2AChannel/hub.token` exists with mode `0600`
- **AND** its contents match `/^[A-Za-z0-9_-]{40,}\n?$/`
- **AND** the contents differ from any token written by a previous app session

#### Scenario: Token rotates on restart

- **GIVEN** the app is running with token `T1`
- **WHEN** the app quits and is relaunched
- **THEN** `hub.token` is replaced with a new token `T2`
- **AND** `T2` != `T1`

### Requirement: Tauri `get_hub_url` command returns both URL and token

The `get_hub_url` Tauri command SHALL return a JSON object of shape `{ url: string, token: string }`. The webview SHALL invoke this command at startup and use both values: `url` as the base for all hub requests, and `token` as the `Authorization: Bearer <token>` header on every mutating request.

#### Scenario: Webview receives full auth bundle

- **WHEN** the webview bootstrap invokes `get_hub_url`
- **THEN** the returned value has `url` matching `http://127.0.0.1:<port>` and `token` matching the contents of `hub.token`

### Requirement: channel-bin reads token alongside URL

`channel-bin` SHALL read the token from `hub.token` whenever it reads `hub.url`. If either file is missing or unreadable, `channel-bin` SHALL treat the connection as unavailable and apply backoff-and-retry (same as when the URL itself is missing). `channel-bin` SHALL send `Authorization: Bearer <token>` on all `POST /post` requests. The `GET /agent-stream` request need not carry the token (per the design decision that read endpoints remain unauthenticated in this change).

#### Scenario: channel-bin authenticates POST requests

- **GIVEN** `hub.url` and `hub.token` both exist
- **WHEN** the agent's Claude session calls the `post` tool
- **THEN** `channel-bin` issues `POST /post` with `Authorization: Bearer <token>` matching `hub.token`
- **AND** the hub accepts the request

#### Scenario: channel-bin retries if token file is missing

- **GIVEN** `hub.url` exists but `hub.token` is missing (e.g. race with app startup)
- **WHEN** `channel-bin` attempts to resolve the hub
- **THEN** it waits 2 seconds and re-reads both files before trying again
