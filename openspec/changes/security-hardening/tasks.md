## 1. Rust shell — token minting and discovery

- [x] 1.1 Add a dependency-free random helper: generate 32 random bytes via `getrandom` crate (or stdlib `std::env::random` alt). Encode as URL-safe base64 with no padding.
- [x] 1.2 In `setup()`, mint the token once and store it in `HubState` alongside the existing `url`.
- [x] 1.3 Write `~/Library/Application Support/A2AChannel/hub.token` with mode `0o600` via an atomic write helper (analogous to existing `write_discovery_file`).
- [x] 1.4 Tighten `hub.url` to mode `0o600` on write (modify `write_discovery_file`).
- [x] 1.5 Change `get_hub_url` Tauri command to return a serde-serialized struct `{ url: String, token: String }` instead of a bare string.
- [x] 1.6 Pass the token to the hub sidecar via env var `A2A_TOKEN=<token>` on spawn.
- [x] 1.7 Replace shutdown-path `.unwrap()` on mutex locks with `.unwrap_or_else(|e| e.into_inner())` in `RunEvent::ExitRequested` / `CloseRequested` / `Destroyed` handlers.

## 2. Rust shell — log rotation at startup

- [x] 2.1 Before calling `OpenOptions::new().append(true).open(&log_path)`, check `fs::metadata(&log_path)`.
- [x] 2.2 If size exceeds 10 MiB (`10 * 1024 * 1024`), `fs::rename(log_path, log_path.with_extension("log.1"))` before opening.
- [x] 2.3 Tolerate metadata/rename errors (log to eprintln; do not abort startup).

## 3. Hub — auth middleware

- [x] 3.1 Read `A2A_TOKEN` from env at hub startup; hold in a module-level constant.
- [x] 3.2 Write a small `requireAuth(req: Request): Response | null` helper: returns a `401` Response if `Authorization` header is missing, malformed, or token mismatch; returns `null` otherwise.
- [x] 3.3 Use constant-time comparison (`crypto.timingSafeEqual` via `Buffer` equivalents in Bun; or a manual byte-XOR reducer if Bun does not expose it).
- [x] 3.4 Call `requireAuth` at the top of `/send`, `/post`, `/remove`, `/upload` handlers. Return the `401` Response if non-null.
- [x] 3.5 Leave `/agents`, `/presence`, `/stream`, `/agent-stream`, `/image/:id` unauthenticated.

## 4. Hub — body size and content-length enforcement

- [x] 4.1 Before `req.json()` in `/send`, `/post`, `/remove`: read `req.headers.get('content-length')`; if missing, return `411`; if parseable but > 262144, return `413`.
- [x] 4.2 Extract into a helper `requireJsonBody(req, max = 262144): Response | null`.
- [x] 4.3 Apply to all three JSON POST routes.

## 5. Hub — upload hardening

- [x] 5.1 Remove `'image/svg+xml'` from `ALLOWED_IMAGE_TYPES`.
- [x] 5.2 Add magic-byte table: `{ "image/png": [0x89, 0x50, 0x4E, 0x47], "image/jpeg": [0xFF, 0xD8, 0xFF], "image/gif": [0x47, 0x49, 0x46, 0x38], "image/webp": /* RIFF....WEBP */ [...] }`.
- [x] 5.3 In `handleUpload`, after reading the file buffer, compare the first bytes against the expected signature for the declared MIME. For WEBP, verify bytes 0..3 are `RIFF` and bytes 8..11 are `WEBP`.
- [x] 5.4 Reject mismatches with `400 { "error": "content does not match declared type <MIME>" }`.
- [x] 5.5 In `handleImage`, add response headers `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`.

## 6. Hub — `/send` image-URL and target validation

- [x] 6.1 In `handleSend`, if `body.image` is present, test against `/^\/image\/[A-Za-z0-9_-]+$/`. Reject non-matches with `400 { "error": "invalid image url" }`.
- [x] 6.2 In `handleSend` targets-array branch: iterate once to validate every entry (accepting `"all"` as a special case). If any entry is neither `"all"` nor a known agent, return `400` immediately.
- [x] 6.3 Only after validation, resolve `"all"` to the current roster.

## 7. Hub — `/post` case-sensitive agent resolution

- [x] 7.1 In `handlePost`, stop lowercasing `body.to` before agent lookup.
- [x] 7.2 Derive a local `reserved = rawTo.toLowerCase()` for checking against `"you"` / `"all"`.
- [x] 7.3 For agent name lookup, use the original `rawTo` against `knownAgents.has(rawTo)`.
- [x] 7.4 Update tests / smoke-checks to cover mixed-case agent names (`Drupal`, `Alice`).

## 8. Hub — miscellaneous hygiene

- [x] 8.1 Replace `agentQueues.get(t)!` non-null assertions with `const q = agentQueues.get(t); if (!q) continue;` in both send/post handlers.
- [x] 8.2 Remove redundant `validName(frm)` call in `handlePost` where `ensureAgent` already validates.
- [x] 8.3 Log SSE parse failures (`JSON.parse` catch in `makeSSE` and `channel.ts`) via `console.error` / `console.warn` instead of silently continuing.
- [x] 8.4 Drop the `Access-Control-Allow-Origin: *` header entirely from mutating routes once auth is in place. Retain on read routes pending the WebSocket migration decision.

## 9. channel.ts — token support

- [x] 9.1 Extend `resolveHubUrl()` → `resolveHub()` returning `{ url, token } | null`. Read `hub.token` alongside `hub.url` in the same lookup path.
- [x] 9.2 In the `post` tool handler, attach `Authorization: Bearer <token>` to the outgoing fetch.
- [x] 9.3 On receiving `401`, re-read both files once before retrying (handles the rotation-on-app-restart case).
- [x] 9.4 Leave `/agent-stream` request unauthenticated (per design).

## 10. UI — token attachment on mutating requests

- [x] 10.1 Change `bootstrap()` to expect `{ url, token }` from `invoke('get_hub_url')`; store both in module-scope variables.
- [x] 10.2 Wrap `fetch(BUS + ...)` calls for `/send`, `/remove`, `/upload` in a small helper that adds `Authorization: Bearer <token>`.
- [x] 10.3 Leave `new EventSource(BUS + '/stream' + ...)` unchanged (read endpoint).
- [x] 10.4 On `401` response, surface a clear error message in the chat UI (auth failure = desynced token = app restarted during session).

## 11. UI — image URL validation

- [x] 11.1 Replace `u.startsWith('http')` in `imgUrl()` with `/^https?:\/\//.test(u)`.
- [x] 11.2 Add a guard in `addMessage()` rendering: if `data.image` is present and does not match either `^/image/[A-Za-z0-9_-]+$` or `^https?://` (for pre-change compatibility), drop it silently.
- [x] 11.3 Remove inline `onclick="window.open(this.src)"` from the rendered `<img>`. Add a delegated click listener on `#messages` that matches `.msg-body img`, re-validates the src, and calls `window.open` only on `/image/...` or `https?://` URLs.

## 12. UI — bounded memory on long sessions

- [x] 12.1 After each `messagesEl.appendChild(div)` in `addMessage`, check `messagesEl.childElementCount`. If > 2000, remove `messagesEl.firstChild` in a while loop until 2000.
- [x] 12.2 In `applyRoster`, rebuild `NAMES` and `COLORS` from scratch (seed with the static entries, then add roster) rather than patching them.

## 13. UI — error surfacing and parse logging

- [x] 13.1 In `send()` error path, parse the hub response as JSON before surfacing; fall back to raw text only if parse fails. Show `error` field if present.
- [x] 13.2 Same for `legendEl` remove-click handler.
- [x] 13.3 In `es.onmessage`, replace silent `try { ... } catch (_) {}` with `try { ... } catch (e) { console.warn('[sse] parse', e); }`.

## 14. Documentation

- [x] 14.1 Update `README.md` troubleshooting: document new `hub.token` file; note that an app restart rotates the token and requires no manual action.
- [x] 14.2 Update `CLAUDE.md` Hard rules: add "Mutating hub endpoints require `Authorization: Bearer <token>`; the token is read from `hub.token`." Add "SVG uploads are not supported."
- [x] 14.3 Update `CLAUDE.md` architecture section to describe the two-file discovery contract.
- [x] 14.4 No README changes needed for end-user workflow (MCP template unchanged; auth is transparent to the user).

## 15. Verification

- [x] 15.1 Build via `./scripts/install.sh`. Confirm `hub.token` exists with mode `0600`.
- [x] 15.2 `curl http://127.0.0.1:<port>/send -X POST` without auth → confirm 401.
- [x] 15.3 Same curl with `Authorization: Bearer $(cat hub.token)` → confirm 200.
- [x] 15.4 `curl http://127.0.0.1:<port>/send -X POST -H "Content-Length: 300000" -H "Authorization: Bearer ..."` → confirm 413 without body consumed.
- [x] 15.5 Upload an SVG via `/upload` → confirm 400.
- [x] 15.6 Upload a PNG with magic bytes tampered → confirm 400.
- [x] 15.7 `curl -v http://127.0.0.1:<port>/image/<known-id>` → confirm `Content-Security-Policy`, `X-Content-Type-Options`, `Cache-Control` headers present.
- [x] 15.8 `POST /send` with `image: "http://evil.example.com/x.gif"` → confirm 400.
- [x] 15.9 Register agent `Drupal`; send `POST /post` with `from: "Drupal", to: "you", text: "hi"` → confirm 200; send `POST /post` with `to: "Drupal"` from another agent → confirm message is enqueued.
- [x] 15.10 `POST /send` with `targets: ["all", "NonExistent"]` → confirm 400.
- [ ] 15.11 Start a Claude Code session; round-trip a message; confirm agent pill appears green; confirm message visible in app.
- [ ] 15.12 Restart A2AChannel; verify active Claude session reconnects within one backoff cycle; verify token rotated in `hub.token`; verify `channel-bin` sends the new token (check `hub.log` for no 401s post-reconnect).
- [ ] 15.13 Send 3000 messages rapidly via script; confirm `#messages` in the DOM tops out at ~2000 children (inspect via webview devtools if available, or document as manual-visual check).
- [x] 15.14 Rotate `hub.log` by padding to > 10 MiB, restart app, verify `hub.log.1` exists and new `hub.log` starts small.
- [ ] 15.15 Run an unauthenticated cross-origin fetch from a test HTML page served on a different localhost port: confirm `/send` fails with 401 and no chat entry is created.
