## Why

A code review of the v0.3.0 release identified a coherent class of issues rooted in one architectural weakness: the hub treats the loopback interface as a trust boundary (`Access-Control-Allow-Origin: *` on every route) when it is not. Any webpage the user visits can discover the hub's dynamic port, interact with every endpoint, read chat history, impersonate agents, and exfiltrate uploads. Sitting next to that are several smaller issues (SVG stored-XSS primitive, unbounded JSON bodies, case-sensitivity bug, DOM memory growth, log growth) that compound the blast radius or present standalone bugs. This change turns the loopback interface from the *only* defense into the *last* defense, fixes the incidental bugs discovered alongside, and tightens long-running-session hygiene.

## What Changes

- **BREAKING (for `channel-bin` running against an older hub, and for any external consumer of the hub):** mutating endpoints (`/send`, `/post`, `/remove`, `/upload`) require `Authorization: Bearer <token>`. The token is minted per hub session and published alongside the hub URL in the discovery file.
- **BREAKING:** `ALLOWED_IMAGE_TYPES` no longer includes `image/svg+xml`. Existing chats can still reference previously-uploaded SVGs until eviction; new uploads of that MIME are rejected.
- **BREAKING (in spirit):** `handlePost` no longer lowercases the `to` field when matching it against known agents. Agents with mixed-case names (e.g. `Drupal`, `Alice`) now receive their messages correctly; any code that happened to rely on case-insensitive lookup will observe different behavior.
- JSON request bodies are capped at 256 KiB (rejected with `413` above the limit).
- Uploads validate the first bytes of the payload against the declared MIME (magic-byte sniffing) and are served with `Content-Security-Policy: default-src 'none'; sandbox` plus `Content-Disposition: attachment` for defense-in-depth.
- `body.image` on `/send` is validated server-side against `^/image/[A-Za-z0-9_-]+$`; arbitrary URLs are rejected.
- `targets: ["all", "unknown"]` now fails with `400` instead of silently succeeding — every listed target is validated before `"all"` short-circuits.
- Discovery file (`hub.url`) is written with `0600` permissions; a new sibling file `hub.token` receives the same treatment.
- Hub log rotates on startup if it exceeds 10 MiB (old file renamed to `hub.log.1`, replaced).
- Rust shutdown path tolerates lock poisoning (`lock().unwrap_or_else(|e| e.into_inner())`) so a prior thread panic cannot block child cleanup.
- UI trims `#messages` to the last 2000 nodes to bound DOM growth on long sessions; `NAMES` and `COLORS` maps are rebuilt (not patched) when the roster changes, so departed agents don't linger in memory.
- UI removes the inline `onclick` on rendered `<img>` attachments in favor of a delegated `addEventListener` click handler that whitelists the URL before `window.open`.
- UI parses hub JSON error responses before surfacing them, instead of printing the raw body.
- SSE parse failures are logged to `console.warn` (UI) / `console.error` (channel-bin) instead of being swallowed.
- Rate limiting and CSP tightening (removing `'unsafe-inline'` from `script-src`) are explicitly **out of scope** for this change — documented in `design.md` under Non-Goals.

## Capabilities

### New Capabilities
- `hub-request-safety`: How the hub validates, authenticates, bounds, and sanitizes every incoming request — auth tokens, body size caps, upload content-type enforcement, image-URL validation, target-list completeness, case-sensitive agent resolution.

### Modified Capabilities
- `hub-discovery`: The discovery file contract now includes a secret token in addition to the URL, and both files have tightened filesystem permissions.

## Impact

- **Code**:
  - `src-tauri/src/lib.rs` — mint token at startup, write `hub.token` with `0600`, expose in `get_hub_url`, tolerate poisoned locks, rotate `hub.log`.
  - `hub/hub.ts` — auth middleware on mutating routes, body size check, magic-byte validation on upload, SVG removal, image-URL validation on `/send`, target-list completeness fix, case-sensitive agent lookup in `/post`, log SSE parse errors, tighten image-serve headers.
  - `hub/channel.ts` — read and send bearer token on `/post` and `/agent-stream`; re-read if token changes.
  - `ui/index.html` — receive token from `get_hub_url`, attach `Authorization` header on every mutating fetch, validate image URLs before rendering, DOM-trim messages, rebuild `NAMES`/`COLORS`, delegated click handler, parse error JSON, log parse failures.
  - `src-tauri/tauri.conf.json` — CSP unchanged (tightening deferred).
- **APIs**: new header requirement on four endpoints; new response code `413` on bodies over 256 KiB; new response code `401` on auth failure. New Tauri command return shape: `get_hub_url` returns `{ url, token }` instead of a bare URL string.
- **Filesystem**: new file `~/Library/Application Support/A2AChannel/hub.token` (mode `0600`); `hub.url` permission tightened to `0600`; `hub.log` rotated on startup if oversized.
- **Backwards compatibility**: existing `.mcp.json` files continue to work (v0.3.0 channel-bin also gets the auth changes — they're either both on or both off; there is no mixed-version support scenario because the Tauri app ships both at once).
- **Docs**: `README.md` troubleshooting additions, `CLAUDE.md` hard-rule additions (auth header requirement, SVG excluded, body cap).
