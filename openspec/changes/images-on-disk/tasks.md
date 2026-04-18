## 1. Rust shell — config, folder resolution, Tauri command

- [x] 1.1 Define `struct AppConfig { images_dir: Option<String> }` with `#[derive(serde::Deserialize, Default)]`.
- [x] 1.2 Add `fn config_file() -> PathBuf` returning `<app_data_dir>/config.json`.
- [x] 1.3 Add `fn load_config() -> AppConfig` that reads the file; returns `AppConfig::default()` on any error (with eprintln! warning if the file exists but fails to parse).
- [x] 1.4 Add `fn default_images_dir() -> PathBuf` returning `<home>/Documents/A2AChannel/images`.
- [x] 1.5 Add `fn resolve_images_dir() -> PathBuf` that prefers config override else falls back to default, and `fs::create_dir_all`s the result.
- [x] 1.6 On first launch (if `config.json` absent), write a minimal default config referencing the resolved path.
- [x] 1.7 Store the resolved images-dir path in `HubState.info` alongside url/token, or in a new `images_dir: Mutex<Option<String>>` field.
- [x] 1.8 Add `#[tauri::command] fn get_images_dir(state: State<HubState>) -> Result<String, String>` returning the stored path.
- [x] 1.9 Register `get_images_dir` in `generate_handler!`.
- [x] 1.10 Pass the resolved path to the sidecar via `A2A_IMAGES_DIR` env on `cmd.env(...)`.

## 2. Hub — disk-backed storage

- [x] 2.1 Read `A2A_IMAGES_DIR` at module load; fail clearly if missing (constant `IMAGES_DIR`).
- [x] 2.2 Remove `imageStore` map and `IMAGE_CACHE_MAX` constant; delete the cache-eviction loop in `handleUpload`.
- [x] 2.3 Add a MIME→ext map (`image/png→png`, etc.) keyed off the existing `ALLOWED_IMAGE_TYPES` membership.
- [x] 2.4 Broaden `IMAGE_URL_RE` to `/^\/image\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i`.
- [x] 2.5 In `handleUpload`, after magic-byte validation: compute `<id>.<ext>`, write bytes atomically (`Bun.write(tmp); rename → target`), respond `{ url: "/image/<id>.<ext>", id: "<id>" }`.
- [x] 2.6 Rewrite `handleImage` to:
  - Validate the path segment against a strict regex `/^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i`; reject non-matches with `400`.
  - `path.join(IMAGES_DIR, segment)` to get the absolute path.
  - Use `Bun.file(absPath).exists()` check → `404` if not there.
  - Stream via `new Response(Bun.file(absPath), { headers: … })`; preserve all four hardening headers.
- [x] 2.7 Update `agentEntry` to rewrite `/image/<id>.<ext>` → `<IMAGES_DIR>/<id>.<ext>` in the `[image: …]` suffix.
- [x] 2.8 Add a helper `mimeFromExt(filename: string): string` used by `handleImage` to set the Content-Type.

## 3. channel.ts — agent instructions nudge

- [x] 3.1 Append one sentence to the `instructions` string in the `new Server(...)` constructor: "Messages may reference images as [image: <absolute-path>]; use the Read tool on that path to view them."
- [x] 3.2 Leave everything else (tool definitions, tailHub loop, token auth) unchanged.

## 4. UI — image URL validation broadening

- [x] 4.1 Update the client-side `IMAGE_URL_RE` constant in `ui/index.html` to `/^\/image\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i`.
- [x] 4.2 No other UI changes needed: uploads still POST /upload, response shape change is backward-compatible (the `url` is still a string), rendering still uses `imgUrl()` which prepends BUS.

## 5. Documentation

- [x] 5.1 README: add row to runtime-files table for `~/Documents/A2AChannel/images/` and the config file path. Note that images persist across app restarts.
- [x] 5.2 README: add troubleshooting line: "Agents can't see images → confirm they have the Read tool available and that the channel-bin's instructions include the image-path hint (reinstall if missing)."
- [x] 5.3 CLAUDE.md Hard rules: add "Images are persisted to `<A2A_IMAGES_DIR>/<id>.<ext>`; agents receive absolute paths in channel text."
- [x] 5.4 CLAUDE.md architecture section: note that `hub.ts` no longer holds image bytes in memory.

## 6. Verification

- [x] 6.1 Build via `./scripts/install.sh`. Confirm `~/Library/Application Support/A2AChannel/config.json` is created with the default `images_dir`.
- [x] 6.2 Confirm `~/Documents/A2AChannel/images/` exists.
- [x] 6.3 Upload a PNG via the UI. Confirm a file appears in `~/Documents/A2AChannel/images/<id>.png` with the exact bytes (diff against source).
- [x] 6.4 `curl $(cat ~/Library/Application\ Support/A2AChannel/hub.url)/image/<id>.png` → confirm 200 with correct Content-Type and hardening headers.
- [x] 6.5 Edit `config.json` to `{ "images_dir": "/tmp/a2a-test-images" }`. Relaunch app. Confirm `/tmp/a2a-test-images/` is created, new uploads land there, old uploads 404.
- [x] 6.6 Restore default `config.json`. Confirm fallback works.
- [ ] 6.7 Start a Claude Code session. Upload an image via the UI. Confirm the agent receives `[image: /Users/<you>/Documents/A2AChannel/images/<id>.png]`. Have the agent `Read` that path and confirm it perceives the image (describe what it sees).
- [x] 6.8 `POST /send` with `image: "/image/abc"` (no extension) → confirm `400 invalid image url`.
- [x] 6.9 `GET /image/..%2Fpasswd` → confirm `400` (path traversal rejected).
- [x] 6.10 `GET /image/nonexistent.png` → confirm `404`.
- [ ] 6.11 Restart the app. Confirm a previously-uploaded image URL (from before restart) still loads in the chat history if that entry is re-broadcast — note that chat log itself clears on restart, so this is a "the files survive" check via direct `curl`, not via history replay.
