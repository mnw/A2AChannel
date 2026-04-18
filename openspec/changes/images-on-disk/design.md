## Context

Images today live in an in-memory `Map<id, {ctype, data}>` capped at 64 entries (FIFO eviction). The hub serves them at `/image/<id>` with security-hardening's defanging headers. The UI attaches them as `<img src="/image/<id>">` in rendered messages. Agents receive `[image: /image/<id>]` inlined into the channel-notification text, but the channel protocol only carries strings — agents see the URL, not the image.

Claude Code's built-in `Read` tool natively perceives image files: when Claude runs `Read <path>` on a PNG/JPEG/GIF/WEBP file, the image is ingested as a proper multimodal content block and the model can see it. This is the opening that makes disk-backed storage strictly better than the in-memory LRU: we get free image perception for agents, plus persistence for the UI, at the cost of one configurable folder on the user's machine.

The app is macOS-only, single-user, local-loopback, and just shipped v0.3.0 → security-hardening. This change is strictly additive to that one: nothing in the auth or upload-validation layer moves.

## Goals / Non-Goals

**Goals:**
- Make images viewable to agents without introducing a new MCP tool.
- Let chat-log image references survive the 64-image cap (there is no cap after this change — files accumulate on disk).
- Let the user choose where images live and clean them up with normal file-manager operations.
- Preserve every security invariant from `hub-request-safety`: magic-byte validation, MIME allowlist, response headers.

**Non-Goals:**
- **Automatic cleanup / retention policy.** Files grow forever by default. A user who cares can add cron, or we add a policy later with a spec of its own.
- **Sync or remote storage.** Local filesystem only; no iCloud, no S3, no sharing beyond what the user does manually.
- **UI for folder selection.** Config file edit + restart is the initial UX. A settings modal with a folder picker is a separate change.
- **Image resizing / format conversion.** Bytes land as-uploaded. If a user uploads a 20MB PNG (which currently fails the 8 MiB cap), it still fails. Nothing here touches limits.
- **Persistence of the chat log itself.** Explicitly rejected in earlier discussion — avoids context-pollution asymmetry between UI and agents.
- **Thumbnail generation.** `<img>` in the UI is browser-native; no need.

## Decisions

### 1. Default folder: `~/Documents/A2AChannel/images/`

Chosen over `~/Pictures/`, `~/Library/…`, and `~/.a2achannel/` for three reasons:
- **Discoverable.** `~/Documents` is where non-technical users look first.
- **Not app data.** `~/Library/Application Support/A2AChannel/` already holds secrets (the token) and discovery state. Mixing user content there muddies the boundary.
- **`~/Pictures` is too narrow.** User content that happens to be images includes screenshots, annotated diagrams, sketches, etc. `Documents/` is the right scope.

Alternative considered: user's **current working directory** at app launch. Rejected — non-deterministic, would break on app relaunches from Finder (cwd = `/`).

### 2. Config mechanism: single-file JSON at `~/Library/Application Support/A2AChannel/config.json`

Shape:
```json
{ "images_dir": "/absolute/path/here" }
```

Read by Rust at startup. If missing, malformed, or `images_dir` absent, default applies. If present and valid, the folder is created if needed and used. Rust creates the file on first launch with the default value so users can find and edit it.

**Why JSON:** easy to read, serde already in deps, extensible (future: `log_dir`, `token_file_override`, etc.) without breaking.

**Why not env var only:** env vars don't persist across GUI launches cleanly on macOS. A user who edits `launchd` plists to set env for a bundle is not the target audience here.

**Why not TOML/YAML:** one-field config; any format works; JSON has zero new deps.

### 3. File naming: `<id>.<ext>`

`<id>` is the same 16-char URL-safe base64 ID already minted in `handleUpload` (via `randomId()`). `<ext>` is mapped from the validated MIME:

| MIME | Extension |
|---|---|
| `image/png` | `.png` |
| `image/jpeg` | `.jpg` |
| `image/gif` | `.gif` |
| `image/webp` | `.webp` |

**Why include the extension in the URL** (`/image/<id>.<ext>`) **and filename:**
- Browsers (and `<img>`) sniff extension in addition to Content-Type in some edge cases.
- Finder/Preview/macOS file associations all key off extension.
- The `Read` tool in Claude Code uses the extension to decide how to handle the file.
- Using the same string (`<id>.<ext>`) as URL path and disk filename means zero rewriting — the URL and the file agree.

**Why not preserve the original uploaded filename:** leaks PII (user's filename pattern), sync-unsafe (two "screenshot.png" uploads collide), and irrelevant to the functional goal. Random ID is cleaner.

### 4. `agentEntry()` URL → path rewrite

Today:
```ts
function agentEntry(entry) {
  if (!entry.image) return entry;
  const suffix = `\n[image: ${entry.image}]`;
  return { ...entry, text: entry.text + suffix };
}
```

After: the suffix uses the absolute disk path, not the HTTP URL.
```ts
const absPath = `${IMAGES_DIR}/${entry.image.slice("/image/".length)}`;
const suffix = `\n[image: ${absPath}]`;
```

**Why do the rewrite in the hub, not in `channel.ts`:** the hub knows `IMAGES_DIR` natively (it's the one writing files). `channel.ts` doesn't need to know where the folder is; it just forwards the notification text. Keeping the rewrite one layer up means every channel subscriber gets the same resolved path.

**Edge case:** what if the agent is running on a different user account or (hypothetically) a different machine? The absolute path would be wrong. Not in scope — single-user local-loopback is the stated boundary.

### 5. No in-memory caching

`imageStore` and `IMAGE_CACHE_MAX` disappear. Every `/image/<id>.<ext>` hits disk.

**Why no cache:**
- Loopback + local APFS read: sub-millisecond for typical image sizes.
- Adding a cache reintroduces eviction semantics we just got rid of.
- Memory footprint shrinks. Simpler code.

If ever needed, a trivial LRU can be layered back on top; the disk is the source of truth.

### 6. Read flow: `handleImage` streams from disk

```ts
async function handleImage(id: string): Response {
  const filepath = `${IMAGES_DIR}/${id}`;
  const file = Bun.file(filepath);
  if (!(await file.exists())) return json({ error: "not found" }, { status: 404 });
  const ctype = mimeFromExt(id);       // derived from filename's trailing .ext
  return new Response(file, {
    headers: {
      "Content-Type": ctype,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
```

`Bun.file(path)` returns a `BunFile` that the Response streams lazily. No buffering.

**Path-traversal guard:** the id matches `/^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i` before we join it into the path; no `..`, no `/`, no nulls possible.

### 7. System-instructions nudge for the agent

Current `channel.ts` system string ends with:
```
Keep messages concise; large artifacts belong in files.
```

Appended:
```
Messages may reference images as [image: <absolute-path>]; use the Read tool on that path to view them.
```

One sentence. Not aggressive — agents that don't need to see the image can ignore the reference. Agents that want to view it know how.

**Why not put this in the channel notification itself:** would bloat every message with instructions. Better to set the expectation once at session start.

### 8. Rust config loading

Minimal surface:
```rust
#[derive(Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    images_dir: Option<String>,
}

fn load_config() -> AppConfig {
    let path = app_data_dir().join("config.json");
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}
```

No schema versioning (v1). If the file is malformed, ignore and use defaults; log once. On first launch, write a default config so the file exists for users to edit.

**Why tolerate malformed config:** users *will* edit this by hand. Crashing the app on a trailing comma is hostile.

## Risks / Trade-offs

- **Filesystem permissions.** Default folder is user-owned. If the user configures a path they can't write (e.g. a read-only volume), uploads fail. Surface in `hub.log` and in the upload response. → Acceptable — user-controllable means user-responsible.

- **Unbounded disk growth.** No retention. Users who upload heavily accumulate files. → Mitigation: document clearly. Revisit with a real retention policy if the pain shows up.

- **Absolute paths leak the user's home dir.** The agent's context contains `/Users/<username>/Documents/…`. Not a new leak — already leaks via the terminal banner, `pwd`, every tool output. Not worth defending against.

- **Disk I/O on the hot path.** Every image view hits disk. APFS + small files = negligible. SSE throughput is unaffected. If this ever matters, add a tiny LRU; not speculating about it.

- **`channel.ts` instructions change is model-visible.** Any model that was trained/tuned against the current instructions string might behave very slightly differently. Not a real risk at this abstraction level.

- **Config file tamper window.** User-editable JSON file; could point to a system-sensitive folder (e.g. `/System`, `/etc`). Writes to those will fail at the OS level; 500 from the hub. Not an attack vector for anyone who already has shell access to the user's account.

## Migration Plan

1. Build + install the new version.
2. On first launch, Rust creates `~/Documents/A2AChannel/images/` (if missing), writes default `config.json` (if missing), starts the hub with `A2A_IMAGES_DIR` set.
3. In-memory image cache is gone. The chat log is already reset on restart, so no stale `/image/<id>` references survive — none to break.
4. Existing active Claude sessions continue with their existing channel-bin (not restarted). New images uploaded from the webview will reach those agents as absolute paths; old image references are moot because the old hub is gone.
5. No user action required beyond launching.

Rollback: reinstall the prior DMG. Old `/image/<id>` URLs resume working against the in-memory LRU. Folder on disk remains untouched (user can delete it manually).

## Open Questions

- **Should we also migrate the discovery file from `~/Library/Application Support/…` to the config-visible path?** No. Those are app-internal state, not user content. The distinction stays.
- **Should uploads also support pasting absolute local paths (no upload, just reference a file the user has)?** Future feature. Current scope is upload-only.
- **Should the UI expose a "Reveal images folder" button?** Nice-to-have. Out of scope here; would require bringing `tauri-plugin-opener` back (we dropped it after the MCP-config-modal refactor).
