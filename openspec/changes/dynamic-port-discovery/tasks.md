## 1. Rust shell — port binding and discovery file

- [x] 1.1 Replace the `HUB_PORT: &str = "8011"` constant in `src-tauri/src/lib.rs` with a runtime-computed port
- [x] 1.2 Add a helper that binds `TcpListener::bind("127.0.0.1:0")`, reads `local_addr().port()`, and drops the listener
- [x] 1.3 Add a helper that resolves the discovery-file path via `dirs::data_dir()` joined with `A2AChannel/hub.url`
- [x] 1.4 Implement atomic discovery-file write: write to `hub.url.tmp` in the same directory, then `std::fs::rename` onto `hub.url` (ensure parent dir exists first)
- [x] 1.5 In `setup()`, call the port helper before spawning the sidecar, persist the port in a `Mutex<Option<u16>>` app state, write the discovery file, then spawn `hub-bin` with `PORT=<port>` env
- [x] 1.6 Log the chosen port to stdout so it appears in `hub.log` for troubleshooting

## 2. Rust shell — Tauri command for UI

- [x] 2.1 Add `#[tauri::command] fn get_hub_url(state: State<HubPortState>) -> Result<String, String>` that returns the stored `http://127.0.0.1:<port>` URL
- [x] 2.2 Register the command in `generate_handler!` alongside `get_mcp_template`
- [x] 2.3 Update `get_mcp_template` to omit the `CHATBRIDGE_HUB` entry from the returned JSON (leave only `CHATBRIDGE_AGENT`)

## 3. UI — bootstrap sequence

- [x] 3.1 Change `const BUS = 'http://127.0.0.1:8011'` in `ui/index.html` to `let BUS = ''`
- [x] 3.2 Add an async `bootstrap()` function that awaits `window.__TAURI__.core.invoke('get_hub_url')`, assigns to `BUS`, then proceeds with `loadRoster()` and `connect()`
- [x] 3.3 Replace the existing `loadRoster().then(connect)` top-level call with `bootstrap()`
- [x] 3.4 Keep the plain-browser fallback (`BUS = 'http://127.0.0.1:8011'` if no Tauri globals) for dev testing
- [x] 3.5 Update the MCP config modal's fallback template literal (in the `fallbackTemplate()` function) to omit `CHATBRIDGE_HUB`

## 4. channel.ts — discovery-file fallback

- [x] 4.1 Add a `resolveHubUrl()` helper that implements the lookup priority: env var > discovery file > null
- [x] 4.2 Resolve the discovery-file path using `os.homedir() + '/Library/Application Support/A2AChannel/hub.url'`
- [x] 4.3 In `tailHub()`, call `resolveHubUrl()` at the start of each loop iteration (not just once at startup) so stale URLs self-heal
- [x] 4.4 If `resolveHubUrl()` returns null, log a `[channel] hub not found, waiting...` line once per retry cycle and proceed with the 2s backoff
- [x] 4.5 Leave the existing reconnect backoff unchanged (2s); rely on it for convergence

## 5. Configuration — CSP and app config

- [x] 5.1 Edit `src-tauri/tauri.conf.json`: change `connect-src` entry `http://127.0.0.1:8011` → `http://127.0.0.1:*`
- [x] 5.2 Same file: change `img-src` entry `http://127.0.0.1:8011` → `http://127.0.0.1:*`
- [x] 5.3 Verify no other CSP directives reference port 8011

## 6. Documentation

- [x] 6.1 Update `CLAUDE.md` hard rules: remove the "port 8011 in three places" rule; replace with a rule about the discovery file contract (`~/Library/Application Support/A2AChannel/hub.url` is the single source of truth, do not hardcode the port anywhere)
- [x] 6.2 Update `CLAUDE.md` architecture section to describe the port-discovery flow
- [x] 6.3 Update `README.md` "Wiring an agent" section: the MCP config no longer contains a `CHATBRIDGE_HUB` entry
- [x] 6.4 Update `README.md` troubleshooting: if the user sees "hub not found" retries, check that `A2AChannel.app` is running and the discovery file exists

## 7. Verification

- [x] 7.1 Build via `./scripts/install.sh`; confirm `A2AChannel.app` starts and the chosen port appears in `~/Library/Logs/A2AChannel/hub.log`
- [x] 7.2 Confirm `~/Library/Application Support/A2AChannel/hub.url` contains `http://127.0.0.1:<port>` matching the log
- [x] 7.3 Confirm `curl $(cat ~/Library/Application\ Support/A2AChannel/hub.url)/agents` returns the roster
- [ ] 7.4 Hold port 8011 with `nc -l 8011 &` before launching the app; confirm the app starts on a different port without error
- [ ] 7.5 Paste the MCP template from the modal into a test project's `.mcp.json`; confirm no `CHATBRIDGE_HUB` key is present
- [ ] 7.6 Start a Claude session with that `.mcp.json`; confirm agent registers and appears in the UI within 2–4 seconds
- [ ] 7.7 Start a Claude session BEFORE launching the app; launch the app; confirm the agent converges within 2–4 seconds of app launch
- [ ] 7.8 Kill the app (leaving the stale `hub.url`); restart it; confirm running Claude sessions reconnect within one backoff cycle
- [ ] 7.9 Manually set `CHATBRIDGE_HUB=http://127.0.0.1:9999` in one session's `.mcp.json` (non-existent port); confirm that session fails to connect while other sessions (using discovery) still work
