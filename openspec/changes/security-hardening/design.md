## Context

The hub listens on `127.0.0.1:<random-port>` and emits `Access-Control-Allow-Origin: *` on every response. In modern browsers, loopback does not grant privilege — any visited page can `fetch` `http://127.0.0.1:<port>/anything`, and `*` CORS makes the response readable. The dynamic port is discoverable by scanning 1024–65535 or by reading the world-readable discovery file. Once discovered, an attacker can invoke every endpoint: read history, impersonate agents (`/post` trusts the `from` field), post as the user (`/send`), remove agents (`/remove`), or upload content (`/upload`).

On top of that, a review found standalone issues whose cost is low but whose fix aligns naturally with the auth work: SVG uploads that can embed JavaScript, absent body-size limits that enable trivial RAM exhaustion, a case-sensitivity bug in `/post` that breaks any mixed-case agent name, silent-success when one of several requested targets is unknown, unbounded DOM growth in long sessions, unbounded log growth, stale UI state for departed agents, and a few minor Rust/TS hygiene items.

The current architecture:
- Rust shell owns the hub lifecycle, mints the port, writes `hub.url`, exposes `get_hub_url()` to the webview, kills the child on exit.
- Bun sidecar (`a2a-bin`) runs the hub HTTP/SSE server, owns chat log, roster, images.
- `channel-bin` (same binary, `A2A_MODE=channel`) is spawned by Claude Code per session, reads `hub.url`, tails `/agent-stream`, posts via `/post`.
- Webview loads `index.html` from the Tauri bundle, fetches URL via `invoke`, then connects to the hub directly over HTTP.

Threat model: a **local adversary with browser control** (malicious webpage the user visits, or hostile iframe/extension) is in scope. A local adversary with shell access on the same account is out of scope — they can read any app data regardless. Remote network adversaries are out of scope as long as we stay bound to `127.0.0.1`.

## Goals / Non-Goals

**Goals:**
- Make the loopback interface the *last* line of defense, not the only one. Mutating operations require a secret known only to authorized clients.
- Close the SVG stored-XSS primitive: neither accept SVG on upload nor return one with a client-claimed MIME.
- Bound hub memory use under adversarial input.
- Fix the case-sensitivity bug in `/post` that actively misdelivers messages for any agent with an uppercase letter.
- Bound long-running-session resource growth: DOM size, log file size, in-memory name/color maps.
- Maintain backward compatibility for users upgrading from v0.3.0: no manual intervention beyond reinstalling the app and restarting Claude sessions.

**Non-Goals:**
- **Rate limiting.** Adds complexity (sliding windows, key derivation, per-endpoint limits) that pays off only in a multi-tenant context we don't have. If a token leaks and is abused, the user will notice and can kill the app.
- **CSP tightening (removing `'unsafe-inline'`).** Would require rewriting every inline `<style>`/`<script>` site in `index.html`. The current attack surface that `'unsafe-inline'` covers is zero (no untrusted HTML rendered). Revisit when we have concrete XSS sinks.
- **TLS / authenticated agents / multi-user / remote access.** All imply architecture this change does not deliver. Loopback-only stays.
- **SSE message dedup on the UI side beyond what's already done.** `lastSeenId` already handles resume; DOM trim is separate.
- **Agent-side history replay.** Previously explored and decided against.
- **UI UX polish on error surfacing** beyond parsing the JSON response body. Not a security concern; not a design concern in this change.

## Decisions

### 1. Token shape, storage, and rotation

A single 32-byte URL-safe base64 string (≈43 chars printable), generated via `getrandom`/OsRng at Rust-shell startup, held in memory for the process lifetime, and written to disk at `~/Library/Application Support/A2AChannel/hub.token` with `0o600` permissions.

**Rotation:** the token is re-minted on every app launch. No persistence across app restarts. Consumers (`channel-bin`, webview) must be prepared to re-read the file on auth failure.

**Why rotation-on-launch:** aligns with the hub's existing "session identity" model (`SESSION_ID` in `hub.ts`). A token that outlives the hub session would need a reason to persist — we have none. Short-lived tokens also constrain replay windows if the file is ever read by something stale.

**Why a separate file instead of a single JSON discovery file:** the webview and `channel-bin` already have code that reads `hub.url` as plain text. Reshaping that to JSON would force both to parse/validate; a second file is simpler and keeps the existing contract stable. The two files are read as a pair.

**Alternative considered:** mTLS with a self-signed cert. Overkill for loopback, blows up bundle size, and browsers will refuse to fetch over `https://` to a self-signed cert without user consent theater. Rejected.

**Alternative considered:** HMAC-signed requests with a shared secret. Equivalent security to bearer tokens but much more code. Rejected on simplicity grounds.

### 2. Which endpoints require auth

| Endpoint | Method | Auth required? | Rationale |
|---|---|---|---|
| `/agents` | GET | **No** | Public state; leaks no secrets; hub has nothing *but* this list besides chat content. |
| `/presence` | GET | **No** | Same. |
| `/stream` | GET | **No** | Publishes chat history; everything here is already user-generated or agent-generated content visible to the authorized user anyway. Requiring auth would force cookies/headers on `EventSource`, which is painful (EventSource can't set headers — we'd need a token query param, which then leaks into access logs). |
| `/agent-stream?agent=X` | GET | **No** | Same reasoning as `/stream`; same EventSource constraint. |
| `/image/:id` | GET | **No** | Serves user-uploaded bytes; auth here would break rendering in messages. Compensating control: tightened response headers (see decision 5). |
| `/send` | POST | **Yes** | Impersonates the user. |
| `/post` | POST | **Yes** | Impersonates an agent. Hub-side ensureAgent means even unknown names register. |
| `/remove` | POST | **Yes** | Destructive. |
| `/upload` | POST | **Yes** | Consumes resources + can be used for exfiltration. |

**Why not gate reads:** `EventSource` in browsers cannot send custom headers. Options would be query-param tokens (leak to logs), cookies (cross-origin pain), or moving to WebSocket (bigger refactor). The trade-off is that reads leak chat content to an attacker who discovers the hub. That's bad, but it's the user's own content, and the attacker still cannot *inject* anything without auth. The attacker also cannot `fetch('/stream')` and read the body because `EventSource` is one direction — actually they can `fetch` the SSE endpoint and read chunks. So read-protection is genuinely lost. Acceptable trade-off for this change; can revisit with WebSocket later.

### 3. Body size limit: 256 KiB on JSON routes

Enforced via `Content-Length` header check before calling `req.json()`. If missing or exceeded, respond `413` immediately. 256 KiB accommodates pathologically long messages (far beyond anything typed by a human) while bounding RAM at roughly `bodies × 256 KiB × concurrent requests`.

**Alternative considered:** streaming parse with cutoff. Overkill for our traffic pattern; messages are tiny.

### 4. Upload validation: magic bytes + tightened response

On `/upload`:
- Keep current `ALLOWED_IMAGE_TYPES` set minus `image/svg+xml`.
- Read the first 32 bytes before parsing full body; match against known magic bytes per declared MIME (`\x89PNG`, `\xff\xd8\xff` for JPEG, `GIF87a`/`GIF89a`, `RIFF....WEBP`).
- Reject mismatches with `400`.

On `GET /image/:id`:
- Serve the bytes we stored (which we now trust because they passed magic-byte validation).
- Add `Content-Security-Policy: default-src 'none'; sandbox` header.
- Add `X-Content-Type-Options: nosniff` header.
- Keep `Content-Type` as the verified MIME.

**Why not `Content-Disposition: attachment`:** that would break the `<img src="/image/:id">` render path in the UI. The CSP + nosniff combination defangs the file even if it were maliciously crafted — the document can't run scripts or load sub-resources.

### 5. UI: image URL validation at both ends

Server-side in `handleSend`: if `body.image` is present, validate `/^\/image\/[A-Za-z0-9_-]+$/`; reject non-matches with `400`. This prevents storing arbitrary URLs in chat history.

Client-side in `imgUrl()` / attachment rendering: keep a regex guard as defense-in-depth, but now with server-side validation it's belt-and-suspenders. Replace the loose `startsWith('http')` check with `^https?:\/\/`. Replace inline `onclick` with a delegated listener that re-validates before calling `window.open`.

### 6. Case-sensitive agent resolution in `/post`

Current:
```ts
const rawTo = (body.to ?? "you").toLowerCase();
// ...
else if (knownAgents.has(rawTo)) targets = [rawTo];
```

New:
```ts
const rawTo = (body.to ?? "you");
const reservedMatch = rawTo.toLowerCase();
if (reservedMatch === "you") targets = [];
else if (reservedMatch === "all") targets = [...knownAgents.keys()].filter((a) => a !== frm);
else if (knownAgents.has(rawTo)) targets = [rawTo];
else return 400;
```

Only the *reserved-word* branches lowercase. Real agent names match verbatim. This fixes the bug where `to: "Drupal"` failed for the case-sensitive registered name "Drupal".

### 7. Target-list completeness

Current `/send` handler short-circuits on `"all"`:
```ts
for (const t of body.targets) {
  if (t === "all") { resolved = [...known]; broadcast = true; break; }
  ...
}
```

If the caller passes `targets: ["all", "nonexistent"]`, the unknown target is never validated.

New: validate every entry first, *then* resolve `"all"`:
```ts
for (const t of body.targets) {
  if (t !== "all" && !knownAgents.has(t)) return 400;
}
// then resolve
```

This makes the array semantics consistent with the single-target path.

### 8. Log rotation at startup

In Rust at setup: before opening `hub.log` for append, check its size. If > 10 MiB, rename it to `hub.log.1` (overwriting any previous `hub.log.1`) and start fresh. One generation of backup, one-shot at launch. No runtime rotation (would require a timer thread; over-engineering).

**Why at startup, not mid-run:** avoids log-file-descriptor contention with the async append stream. App restarts are frequent enough during dev, and for production a user restart is weeks at most.

### 9. UI DOM trim

After each `addMessage()`, if `messagesEl.childElementCount > 2000`, remove `messagesEl.firstChild` in a loop until back to 2000. Constant-time amortized (only trims by 1 most calls; bigger trims on pathological SSE replay).

**Why 2000:** human-visible history; well beyond typical session length; arbitrary bound chosen to catch pathological growth without being user-visible.

### 10. NAMES/COLORS rebuild on roster update

Currently `applyRoster` appends to `NAMES[a.name]` and `COLORS[a.name]` for each agent in the new roster — but never deletes entries for agents that departed. New: rebuild both objects from scratch (`NAMES = { you: 'You', system: 'System', all: 'All' }`, then re-add from roster). Keeps memory bounded across churn.

### 11. Rust mutex poison tolerance

Replace `state.child.lock().unwrap()` with `state.child.lock().unwrap_or_else(|e| e.into_inner())` in shutdown paths. Accepts that a prior thread panicked while holding the lock; we still want to kill the child.

## Risks / Trade-offs

- **[Read endpoints remain open]** → Any webpage that discovers the port can read chat history. Mitigation: port is randomized per launch; brute-force port scan is detectable; short-term this is accepted risk. Long-term fix: move SSE to authenticated WebSocket.

- **[Token leaks in ps/env]** → We pass the token through env vars to `channel-bin` (via `.mcp.json`)? **No — we don't.** Token is read from the discovery file at runtime, never passed via env. Avoids leaking into `ps aux`.

- **[File race on startup]** → Rust writes token, hub reads token. Small window where hub is up but token file write hasn't landed. Mitigation: hub-bin reads token at first auth check (not at startup), and the reader side (channel-bin) already has retry logic. Not a real-world concern.

- **[SVG eviction]** → Old chats with SVG images can no longer render once the in-memory LRU evicts the upload. Since the image store already caps at 64 images, this is effectively never-visible after a short period. Acceptable.

- **[Case-sensitivity fix is behavior-change]** → Any code that was working by accident on lowercase names will continue to work. Code that was broken (mixed-case) now works. No one breaks.

- **[Log rotation is single-gen]** → If hub.log fills rapidly between restarts, we lose history. Trade-off: simplicity over completeness. Users who care can tail in real-time.

- **[Mutex poison tolerance masks bugs]** → Swallowing poison is the right call in shutdown paths (we want cleanup to run), but could mask a real panic elsewhere. Panics are logged to stderr regardless, so debuggability isn't lost.

## Migration Plan

1. User installs v0.4.0 (next release after this change ships).
2. On first launch, Rust mints a new token and writes both files.
3. Webview receives `{ url, token }` from updated `get_hub_url`; UI attaches `Authorization: Bearer <token>` on mutating fetches.
4. For each Claude Code session:
   - `channel-bin` gets the same binary as before, but now reads `hub.token` alongside `hub.url`.
   - Existing SSE/POST round-trips continue to work after the session restarts (MCP doesn't reattach mid-session).
5. No `.mcp.json` changes required.

Rollback: reinstall v0.3.0. Token files on disk are harmless; old hub ignores them.

## Open Questions

- **Should `/upload` also require a magic-bytes match for content-types we add in the future?** Yes — fold the check into a small lookup table so adding a new MIME is one line.
- **Should `hub.token` live in the same file as `hub.url`, JSON-encoded?** Explicitly rejected above for simplicity. Revisit if we ever need more discovery metadata.
- **Do we also want to set `SameSite` / `Secure` on any cookies?** N/A — we don't use cookies.
