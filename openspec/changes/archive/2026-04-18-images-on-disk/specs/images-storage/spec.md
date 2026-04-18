## ADDED Requirements

### Requirement: Images folder is resolved at startup with user override

The Rust shell SHALL resolve the images folder from the following sources, in priority order:

1. `images_dir` field in `~/Library/Application Support/A2AChannel/config.json`, if present and non-empty.
2. Otherwise, the default `~/Documents/A2AChannel/images/`.

The resolved path SHALL be created (including intermediate directories) if it does not exist. The resolved path SHALL be passed to `hub-bin` via the `A2A_IMAGES_DIR` environment variable. If the file `config.json` does not exist on first launch, the Rust shell SHALL create it containing the default configuration `{ "images_dir": "<default-path>" }`.

A malformed or unreadable `config.json` SHALL be ignored (default applies); the app SHALL NOT fail to start because of it.

#### Scenario: First launch creates default config and folder

- **WHEN** the app launches on a fresh machine
- **AND** neither `config.json` nor `~/Documents/A2AChannel/images/` exists
- **THEN** the folder is created
- **AND** `config.json` is written with `{ "images_dir": "/Users/<you>/Documents/A2AChannel/images" }`

#### Scenario: Custom folder via config

- **GIVEN** `config.json` contains `{ "images_dir": "/Volumes/Data/a2a-images" }` and the path exists and is writable
- **WHEN** the app launches
- **THEN** `A2A_IMAGES_DIR=/Volumes/Data/a2a-images` is passed to `hub-bin`
- **AND** subsequent uploads land in that folder

#### Scenario: Malformed config falls back to default

- **GIVEN** `config.json` contains `{ this is not json`
- **WHEN** the app launches
- **THEN** a warning is logged and the default folder is used
- **AND** the app does not crash

### Requirement: Uploads are persisted to the images folder

`POST /upload` SHALL, after magic-byte validation succeeds, write the uploaded bytes to disk at `<A2A_IMAGES_DIR>/<id>.<ext>`, where `<id>` is the random URL-safe base64 ID and `<ext>` is derived from the validated MIME (`.png` / `.jpg` / `.gif` / `.webp`). The hub SHALL no longer maintain an in-memory image cache; every retrieved image is read from disk.

#### Scenario: PNG upload lands on disk

- **WHEN** a client uploads a valid PNG
- **THEN** the file `<A2A_IMAGES_DIR>/<id>.png` exists and contains exactly the uploaded bytes
- **AND** the upload response is `{ url: "/image/<id>.png", id: "<id>" }`

#### Scenario: Upload to unwritable folder fails with clear error

- **GIVEN** `A2A_IMAGES_DIR` points at a read-only location
- **WHEN** a client uploads a valid PNG
- **THEN** the hub responds with a 500 and body containing an error pointing at the folder
- **AND** the failure is logged to `hub.log`

### Requirement: Images are served from disk with hardening headers

`GET /image/<id>.<ext>` SHALL read the file from `<A2A_IMAGES_DIR>/<id>.<ext>` and stream its contents in the response body. If the file does not exist, the hub SHALL respond `404`. The response SHALL carry the hardening headers from `hub-request-safety`: `Content-Type` matching the extension's MIME, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=3600`. The hub SHALL reject path components that would escape the images folder (e.g. containing `..`, `/`, or a null byte) with `400`.

#### Scenario: Served bytes match disk contents

- **GIVEN** a previous upload wrote `<A2A_IMAGES_DIR>/abc.png`
- **WHEN** a client issues `GET /image/abc.png`
- **THEN** the response body is byte-identical to the file
- **AND** all four hardening headers are present

#### Scenario: Path traversal rejected

- **WHEN** a client issues `GET /image/..%2Fpasswd`
- **THEN** the hub responds `400` without touching the filesystem

#### Scenario: Missing file returns 404

- **WHEN** a client issues `GET /image/not-an-id.png`
- **THEN** the hub responds `404`

### Requirement: Agents receive absolute file paths

When the hub inlines an image reference into text delivered via `notifications/claude/channel` (the `agentEntry` transformation applied to any entry with an `image` field), the suffix SHALL be `[image: <ABSOLUTE_PATH>]` where `<ABSOLUTE_PATH>` is `<A2A_IMAGES_DIR>/<id>.<ext>`. This applies only to agent-facing deliveries; the chat log and `/stream` broadcasts continue to carry the URL-form `image` field for the UI.

#### Scenario: Agent sees absolute path, UI sees URL

- **GIVEN** `A2A_IMAGES_DIR` is `/Users/alice/Documents/A2AChannel/images`
- **AND** a chat entry has `image: "/image/xyz.png"`
- **WHEN** the hub delivers the entry to the webview via `/stream`
- **THEN** the event body contains `"image": "/image/xyz.png"`
- **WHEN** the hub delivers the same entry to an agent via `/agent-stream`
- **THEN** the event body's `text` field ends with `[image: /Users/alice/Documents/A2AChannel/images/xyz.png]`

### Requirement: channel.ts instructions nudge agents to read image paths

The MCP server instructions string in `channel.ts` SHALL include a one-line hint telling the agent how to view referenced images: specifically, that messages may contain `[image: <path>]` references and that the Read tool on that path renders the image.

#### Scenario: Instructions contain the hint

- **WHEN** a client lists the MCP server's capabilities
- **THEN** the `instructions` string contains the phrase `use the Read tool` (or equivalent guidance) in the context of image paths

### Requirement: Tauri command exposes the images folder path

The Rust shell SHALL expose a Tauri command `get_images_dir` that returns the currently-resolved images folder as a string. The webview MAY invoke this command to display or operate on the path (e.g. in a future Reveal-in-Finder button). The command SHALL return the same value that was written to `A2A_IMAGES_DIR`.

#### Scenario: Webview fetches the images dir

- **WHEN** the webview invokes `get_images_dir`
- **THEN** the returned string is an existing directory path
- **AND** it matches `A2A_IMAGES_DIR` in the running `hub-bin`

