## Why

Two problems with the current image handling, both stemming from in-memory-only storage:

1. **Agents can't perceive images.** The chatbridge channel protocol delivers notifications as string content. When the UI attaches an image, agents receive a URL (`[image: /image/abc123]`) but nothing they can actually see. The only workarounds today are (a) an explicit `fetch_image` MCP tool that encodes and returns the bytes (extra tool surface), or (b) the user pastes the image outside the channel. Neither is ergonomic.
2. **The 64-slot LRU evicts silently.** Long-running sessions lose image references from older messages as newer uploads push them out. Chat history survives (bounded at 1000 entries) but image URLs in that history break.

The fix is to drop the in-memory cache and write uploads to a user-controllable folder on disk. Agents receive the **absolute file path** of each image (not an HTTP URL) and view it by reading the file — using Claude Code's built-in `Read` tool, which natively perceives image files. No new MCP tool, no new protocol surface. The image cache becomes the filesystem, which the user already knows how to manage.

## What Changes

- Hub uploads are persisted to disk at `<IMAGES_DIR>/<id>.<ext>` instead of the in-memory `imageStore` map.
- `<IMAGES_DIR>` defaults to `~/Documents/A2AChannel/images/` and is user-configurable via `~/Library/Application Support/A2AChannel/config.json` with a field `{ "images_dir": "/absolute/path" }`.
- The Rust shell resolves the effective folder at startup, creates it if missing, and passes the path to `hub-bin` via a new env var `A2A_IMAGES_DIR`.
- **BREAKING (for any external consumer of `/upload` responses):** upload response now returns `{ url: "/image/<id>.<ext>", id: "<id>" }` with the extension embedded in the URL. The extension is derived from the validated MIME (`.png`, `.jpg`, `.gif`, `.webp`).
- **BREAKING (for the image-URL validation regex):** `IMAGE_URL_RE` is broadened to `/^\/image\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i` on both server and UI sides.
- `GET /image/<id>.<ext>` now reads bytes from disk (not memory); hardening headers from security-hardening are preserved.
- `agentEntry()` rewrites `/image/<id>.<ext>` → `<IMAGES_DIR>/<id>.<ext>` (absolute path) when inlining into agent-facing text.
- `channel.ts` system-instructions string gains a one-line nudge: "To see images referenced as `[image: <path>]`, use your Read tool on that path."
- New Tauri command `get_images_dir() -> String` exposes the resolved path for the UI (for display or future Reveal-in-Finder button).
- The `imageStore` in-memory map and `IMAGE_CACHE_MAX` constant are removed from `hub.ts`.

## Capabilities

### New Capabilities
- `images-storage`: How uploaded images are persisted, located, and surfaced to clients. Covers disk layout, folder configuration, upload persistence, read-from-disk rendering, and the URL↔path rewrite delivered to agents.

### Modified Capabilities
- `hub-request-safety`: Upload response shape changes (`url` includes file extension); `/send` image-URL regex broadens; `/image/<id>` path segment broadens to `<id>.<ext>`.

## Impact

- **Code**: `src-tauri/src/lib.rs` (config load, images dir resolution, `get_images_dir` command, `A2A_IMAGES_DIR` env on sidecar spawn), `hub/hub.ts` (disk-backed `handleUpload`/`handleImage`, URL shape, `agentEntry` rewrite, removed `imageStore`/`IMAGE_CACHE_MAX`), `hub/channel.ts` (instructions tweak), `ui/index.html` (`IMAGE_URL_RE` broadened).
- **APIs**: `/upload` response shape gains extension in `url`. `/image/<id>.<ext>` replaces `/image/<id>`. New Tauri command `get_images_dir`.
- **Filesystem**: new directory `~/Documents/A2AChannel/images/` (or custom path). Files persist across app restarts. No automatic cleanup — user-managed.
- **Agent experience**: agents who were using the `fetch_image`-style workflow don't need to (we never shipped one). Agents receive an absolute local path they can read directly with `Read`.
- **Backwards compatibility**: Existing chat-log references to `/image/<id>` (no extension) become invalid after upgrade. Since the chat log itself resets on hub restart, this is a non-issue — the upgrade is a restart.
- **Documentation**: `README.md` gains a row for the images folder. `CLAUDE.md` hard rules mention the new storage layer.
