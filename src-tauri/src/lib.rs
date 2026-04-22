mod pty;

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write as _},
    net::TcpListener,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::AsyncWriteExt;

const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024; // rotate hub.log if it exceeds 10 MiB
const TOKEN_BYTES: usize = 32;

struct HubState {
    child: Mutex<Option<CommandChild>>,
    info: Mutex<Option<HubInfo>>,
    attachments_dir: Mutex<Option<PathBuf>>,
    human_name: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct HubInfo {
    url: String,
    token: String,
}

#[derive(Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    attachments_dir: Option<String>,
    // Legacy key, read only if `attachments_dir` is absent. Kept so configs
    // written by ≤ v0.4.x continue to work after the v0.5.0 rename.
    #[serde(default)]
    images_dir: Option<String>,
    #[serde(default)]
    human_name: Option<String>,
    #[serde(default)]
    attachment_extensions: Option<Vec<String>>,
    // Absolute path to the `claude` binary. Defaults to Anthropic's
    // installer location. Declared in config so we can skip sourcing
    // the user's `.zshrc` to find it — the single biggest cost in
    // agent spawn latency (1–5 s of plugin loading per launch).
    #[serde(default)]
    claude_path: Option<String>,
    // Optional Anthropic API key. Left empty by default; users whose
    // claude install uses keychain OAuth (the usual case) don't need
    // to set this. When non-empty, passed to tmux via `new-session -e`
    // so claude inherits it without us sourcing `.zshrc`.
    #[serde(default)]
    anthropic_api_key: Option<String>,
}

const RESERVED_NAMES: &[&str] = &["you", "all", "system"];

fn default_attachment_extensions() -> Vec<String> {
    vec!["jpg", "jpeg", "png", "pdf", "md"]
        .into_iter()
        .map(String::from)
        .collect()
}

// Validate one extension entry. Lowercase letters/digits, no dot,
// 1..=10 chars. Anything else is rejected so the env var stays a
// well-formed comma-separated list.
fn valid_extension(ext: &str) -> bool {
    let n = ext.chars().count();
    if !(1..=10).contains(&n) {
        return false;
    }
    ext.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

// Resolve the configured attachment extensions, falling back to the
// default set on missing/empty config. Filters out invalid entries
// silently so a typo doesn't brick uploads — the validated set is
// logged on startup so users can see what survived.
fn resolve_attachment_extensions() -> Vec<String> {
    let cfg = load_config();
    let raw = cfg
        .attachment_extensions
        .unwrap_or_else(default_attachment_extensions);
    let mut clean: Vec<String> = raw
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| valid_extension(e))
        .collect();
    clean.sort();
    clean.dedup();
    if clean.is_empty() {
        eprintln!(
            "[setup] attachment_extensions is empty after validation; falling back to defaults"
        );
        return default_attachment_extensions();
    }
    clean
}

fn target_triple() -> String {
    format!("{}-apple-darwin", std::env::consts::ARCH)
}

pub(crate) fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("A2AChannel")
}

fn discovery_file() -> PathBuf {
    app_data_dir().join("hub.url")
}

fn token_file() -> PathBuf {
    app_data_dir().join("hub.token")
}

fn config_file() -> PathBuf {
    app_data_dir().join("config.json")
}

fn ledger_file() -> PathBuf {
    app_data_dir().join("ledger.db")
}

fn default_human_name() -> String {
    "human".to_string()
}

// Validate a human name against the same constraints the hub applies to
// agent names: must match AGENT_NAME_RE and must not be reserved.
// Returns Err(message) on invalid input.
fn validate_human_name(name: &str) -> Result<(), String> {
    if RESERVED_NAMES
        .iter()
        .any(|r| r.eq_ignore_ascii_case(name))
    {
        return Err(format!(
            "human_name '{name}' collides with a reserved word ({}). \
             Choose a different name in config.json.",
            RESERVED_NAMES.join(", ")
        ));
    }
    // Mirror the hub's regex check without pulling in a regex crate:
    // enforce length + allowed-chars + boundary-non-space manually.
    let n = name.chars().count();
    if !(1..=64).contains(&n) {
        return Err(format!("human_name '{name}' must be 1..=64 characters"));
    }
    let allowed = |c: char| {
        c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' '
    };
    if !name.chars().all(allowed) {
        return Err(format!(
            "human_name '{name}' contains characters outside [A-Za-z0-9 _.-]"
        ));
    }
    let first = name.chars().next().unwrap();
    let last = name.chars().last().unwrap();
    if first == ' ' || last == ' ' {
        return Err(format!(
            "human_name '{name}' must not start or end with a space"
        ));
    }
    Ok(())
}

fn default_attachments_dir() -> PathBuf {
    // Top-level home directory avoids macOS TCC protections on
    // ~/Documents, ~/Desktop, ~/Downloads, ~/Pictures — otherwise the
    // agent's Read tool fails with EPERM even after `--add-dir`.
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("a2a-attachments")
}

fn default_claude_path() -> PathBuf {
    // Anthropic's default-installer wrapper script location.
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".claude/local/claude")
}

// Expand a leading `~` or `$HOME` in a user-provided path into the
// actual home directory. Config paths are persisted as strings; this
// gives us portability across Macs without having to bake an absolute
// path into the seed config.
fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(trimmed)
}

// Resolve the claude binary path for agent spawns. Reads config on
// every call so clicking ↻ (reload settings) picks up edits without
// an app relaunch. Empty or missing → Anthropic's installer default.
pub fn resolve_claude_path() -> PathBuf {
    let cfg = load_config();
    let raw = cfg
        .claude_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match raw {
        Some(s) => expand_tilde(&s),
        None => default_claude_path(),
    }
}

// Optional ANTHROPIC_API_KEY to inject into claude's env at spawn.
// Empty/unset → nothing injected; claude falls back to its keychain
// OAuth (the usual case).
pub fn resolve_anthropic_api_key() -> Option<String> {
    let cfg = load_config();
    cfg.anthropic_api_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn load_config() -> AppConfig {
    let path = config_file();
    match fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<AppConfig>(&s) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!(
                    "[setup] config.json exists but failed to parse ({}), using defaults: {e}",
                    path.display()
                );
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

// Resolve the effective human identity name. Config override wins;
// otherwise "human". Fails loudly on invalid input so misconfig never
// ships as silent behavior drift.
fn resolve_human_name() -> Result<String, String> {
    let cfg = load_config();
    let name = cfg.human_name.clone().unwrap_or_else(default_human_name);
    validate_human_name(&name)?;
    Ok(name)
}

// Choose the attachments folder (config override or default), ensure it
// exists. On first launch, write a default config.json so users can find
// and edit it.
fn resolve_attachments_dir_and_seed(human_name: &str, extensions: &[String]) -> PathBuf {
    let cfg = load_config();
    // Prefer the modern key; fall back to the deprecated `images_dir` so
    // configs from v0.4.x still resolve. Empty strings and nulls both
    // count as "not set" so a user leaving the key blank falls through
    // to the default rather than writing to an empty PathBuf.
    let pick = |opt: Option<String>| -> Option<String> {
        opt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let dir = pick(cfg.attachments_dir)
        .or_else(|| pick(cfg.images_dir))
        .map(PathBuf::from)
        .unwrap_or_else(default_attachments_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[setup] create attachments dir {} failed: {e}", dir.display());
    }
    // Seed config.json on first launch. `attachments_dir` is included as
    // `null` so the default applies on every machine (no user-specific
    // absolute path baked into the seed) while still letting a new user
    // discover the key and replace `null` with a path. Empty string and
    // `null` both resolve to the default in `pick` above.
    let cfg_path = config_file();
    if !cfg_path.exists() {
        let seed = json!({
            "human_name": human_name,
            "attachments_dir": serde_json::Value::Null,
            "attachment_extensions": extensions,
            "claude_path": "~/.claude/local/claude",
            "anthropic_api_key": "",
        });
        if let Err(e) = fs::create_dir_all(cfg_path.parent().unwrap_or(&PathBuf::from("/tmp"))) {
            eprintln!("[setup] create config dir failed: {e}");
        }
        if let Err(e) = fs::write(
            &cfg_path,
            serde_json::to_string_pretty(&seed).unwrap_or_default() + "\n",
        ) {
            eprintln!("[setup] seed config.json at {} failed: {e}", cfg_path.display());
        }
    }
    dir
}

fn logs_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join("Library/Logs/A2AChannel"))
        .unwrap_or_else(|| PathBuf::from("/tmp/A2AChannel-logs"))
}

fn resolve_a2a_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    // In bundled .app: Contents/MacOS/a2a-bin (Tauri strips the triple).
    // In `tauri dev`: ./a2a-bin-<triple> (triple retained).
    let plain = dir.join("a2a-bin");
    if plain.exists() {
        return Ok(plain);
    }
    let with_triple = dir.join(format!("a2a-bin-{}", target_triple()));
    if with_triple.exists() {
        return Ok(with_triple);
    }
    Err(format!(
        "a2a-bin not found in {} (looked for 'a2a-bin' and 'a2a-bin-{}')",
        dir.display(),
        target_triple()
    ))
}

// Locate the bundled tmux binary.
//   - Bundled .app: Contents/Resources/tmux (Tauri's bundle.resources dest).
//   - `tauri dev`: src-tauri/resources/tmux (source checkout).
// Mirrors resolve_a2a_bin() shape; both get called at PTY spawn time.
pub(crate) fn resolve_tmux_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    // Tauri's bundle.resources copies files preserving the source path
    // structure, so `src-tauri/resources/tmux` lands at
    // `Contents/Resources/resources/tmux` in the bundled .app, NOT at
    // the flat `Contents/Resources/tmux` path. Check both shapes so we
    // survive a Tauri behavior change.
    let candidates = [
        exe_dir.join("../Resources/resources/tmux"), // bundled .app
        exe_dir.join("../Resources/tmux"),           // flat fallback
        exe_dir.join("../../resources/tmux"),        // `tauri dev` (src-tauri/target/.../a2achannel)
    ];
    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    Err(format!(
        "tmux not found near {} (checked {:?})",
        exe_dir.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
    ))
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn mint_token() -> Result<String, String> {
    let mut buf = [0u8; TOKEN_BYTES];
    File::open("/dev/urandom")
        .map_err(|e| format!("open /dev/urandom: {e}"))?
        .read_exact(&mut buf)
        .map_err(|e| format!("read urandom: {e}"))?;
    let mut out = String::with_capacity(TOKEN_BYTES * 2);
    for b in &buf {
        out.push_str(&format!("{:02x}", b));
    }
    Ok(out)
}

fn chmod_0600(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 0600 {}: {e}", path.display()))
}

fn atomic_write(dir: &Path, name: &str, contents: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let target = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    // Discard any leftover from a prior crash. We then create with
    // O_EXCL + mode 0600 so the file never exists with looser perms,
    // closing the chmod-after-write race.
    let _ = fs::remove_file(&tmp);
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("create_new {}: {e}", tmp.display()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, &target)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), target.display()))?;
    Ok(())
}

fn write_discovery_file(url: &str) -> Result<(), String> {
    atomic_write(&app_data_dir(), "hub.url", url)
}

fn write_token_file(token: &str) -> Result<(), String> {
    atomic_write(&app_data_dir(), "hub.token", token)
}

fn rotate_log_if_oversized(log_path: &Path) {
    match fs::metadata(log_path) {
        Ok(m) if m.len() > LOG_ROTATE_BYTES => {
            let rotated = log_path.with_extension("log.1");
            if let Err(e) = fs::rename(log_path, &rotated) {
                eprintln!(
                    "[setup] log rotation failed ({} → {}): {e}",
                    log_path.display(),
                    rotated.display()
                );
            } else {
                // Rotated archive may still hold tokens — keep it 0600 too.
                let _ = chmod_0600(&rotated);
            }
        }
        _ => {}
    }
}

async fn stream_to_log(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    log_path: PathBuf,
) {
    use tokio::fs::OpenOptions;
    let mut f = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[hub-log] open {}: {e}", log_path.display());
            return;
        }
    };
    // Tokens land in this log via SSE/image URL query strings (see
    // requireReadAuth in hub.ts). Always tighten to 0600 — the create()
    // above doesn't override existing perms on a pre-existing file.
    if let Err(e) = chmod_0600(&log_path) {
        eprintln!("[hub-log] {e}");
    }
    while let Some(ev) = rx.recv().await {
        let line = match ev {
            CommandEvent::Stdout(b) => format!("{}\n", String::from_utf8_lossy(&b)),
            CommandEvent::Stderr(b) => format!("[err] {}\n", String::from_utf8_lossy(&b)),
            CommandEvent::Terminated(p) => format!("[terminated] code={:?}\n", p.code),
            CommandEvent::Error(e) => format!("[error] {e}\n"),
            _ => continue,
        };
        let _ = f.write_all(line.as_bytes()).await;
    }
}

#[tauri::command]
fn get_hub_url(state: State<HubState>) -> Result<HubInfo, String> {
    let guard = state.info.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .clone()
        .ok_or_else(|| "hub info not yet initialized".to_string())
}

#[tauri::command]
fn get_attachments_dir(state: State<HubState>) -> Result<String, String> {
    let guard = state.attachments_dir.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .clone()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "attachments dir not yet initialized".to_string())
}

#[tauri::command]
fn get_human_name(state: State<HubState>) -> Result<String, String> {
    let guard = state.human_name.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .clone()
        .ok_or_else(|| "human name not yet initialized".to_string())
}

#[tauri::command]
fn open_config_file() -> Result<(), String> {
    let path = config_file();
    if !path.exists() {
        return Err(format!("config file not found at {}", path.display()));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(())
}

// Re-read config.json and restart the hub sidecar with fresh env.
// Returns the new {url, token} so the UI can hot-swap its bootstrap values
// without a full app restart. Active Claude sessions' channel-bin subprocesses
// reconnect automatically via the discovery-file retry loop.
#[tauri::command]
fn reload_settings(
    handle: tauri::AppHandle,
    state: State<HubState>,
) -> Result<HubInfo, String> {
    // Re-resolve config.
    let human_name = resolve_human_name()?;
    let extensions = resolve_attachment_extensions();
    let attachments_dir = resolve_attachments_dir_and_seed(&human_name, &extensions);
    let ledger_path = ledger_file();

    // Mint fresh port + token (same policy as first boot).
    let port = pick_free_port()?;
    let url = format!("http://127.0.0.1:{port}");
    let token = mint_token()?;

    // Kill the existing child before writing new discovery files so there's no
    // window where two hub-bin processes race for the same port.
    {
        let child_opt = state.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(child) = child_opt {
            let _ = child.kill();
        }
    }

    // Write discovery files atomically so any racing channel-bin retries see
    // consistent (url, token) pairs.
    if let Err(e) = write_discovery_file(&url) {
        return Err(format!("write discovery file: {e}"));
    }
    if let Err(e) = write_token_file(&token) {
        return Err(format!("write token file: {e}"));
    }

    // Spawn a fresh sidecar with the new env.
    let shell = handle.shell();
    let cmd = shell
        .sidecar("a2a-bin")
        .map_err(|e| format!("sidecar builder: {e}"))?
        .env("PORT", port.to_string())
        .env("A2A_MODE", "hub")
        .env("A2A_TOKEN", &token)
        .env("A2A_ATTACHMENTS_DIR", attachments_dir.to_string_lossy().to_string())
        .env("A2A_LEDGER_DB", ledger_path.to_string_lossy().to_string())
        .env("A2A_HUMAN_NAME", &human_name)
        .env("A2A_ALLOWED_EXTENSIONS", extensions.join(","));
    let (rx, child) = cmd.spawn().map_err(|e| format!("spawn a2a-bin: {e}"))?;

    // Update state.
    let new_info = HubInfo {
        url: url.clone(),
        token: token.clone(),
    };
    {
        *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        *state.info.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_info.clone());
        *state.attachments_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(attachments_dir);
        *state.human_name.lock().unwrap_or_else(|e| e.into_inner()) = Some(human_name);
    }

    // Stream the new sidecar's output to the same log file.
    let log_path = logs_dir().join("hub.log");
    tauri::async_runtime::spawn(async move {
        stream_to_log(rx, log_path).await;
    });

    println!("[settings] hub restarted on port {port}");
    Ok(new_info)
}

// Compile-time version string from Cargo.toml's [package] version. The
// UI reads this on boot and stamps it into the brand-meta slot so the
// label always matches the build. release.sh bumps Cargo.toml → rebuild
// → UI shows the new version with zero manual sync.
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_mcp_template() -> Result<String, String> {
    let a2a_bin = resolve_a2a_bin()?;
    let cfg = json!({
        "mcpServers": {
            "chatbridge": {
                "command": a2a_bin.to_string_lossy(),
                "args": [],
                "env": {
                    "A2A_MODE": "channel",
                    "CHATBRIDGE_AGENT": "agent",
                }
            }
        }
    });
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}


pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(HubState {
            child: Mutex::new(None),
            info: Mutex::new(None),
            attachments_dir: Mutex::new(None),
            human_name: Mutex::new(None),
        })
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_hub_url,
            get_app_version,
            get_mcp_template,
            get_attachments_dir,
            get_human_name,
            open_config_file,
            reload_settings,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let _ = fs::create_dir_all(logs_dir());
            let log_path = logs_dir().join("hub.log");
            rotate_log_if_oversized(&log_path);

            let port = pick_free_port()?;
            let url = format!("http://127.0.0.1:{port}");
            let token = mint_token()?;
            println!("[setup] hub port: {port}");

            if let Err(e) = write_discovery_file(&url) {
                eprintln!("[setup] discovery file write failed: {e}");
            }
            if let Err(e) = write_token_file(&token) {
                eprintln!("[setup] token file write failed: {e}");
            }

            // Resolve human identity first so it can seed config.json if missing.
            let human_name = match resolve_human_name() {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[setup] invalid human_name: {e}");
                    return Err(Box::<dyn std::error::Error>::from(e));
                }
            };
            println!("[setup] human name: {human_name}");

            let extensions = resolve_attachment_extensions();
            println!("[setup] attachment extensions: {}", extensions.join(","));

            let attachments_dir = resolve_attachments_dir_and_seed(&human_name, &extensions);
            println!("[setup] attachments dir: {}", attachments_dir.display());

            let ledger_path = ledger_file();
            println!("[setup] ledger: {}", ledger_path.display());

            let shell = handle.shell();
            let cmd = shell
                .sidecar("a2a-bin")
                .map_err(|e| format!("sidecar builder: {e}"))?
                .env("PORT", port.to_string())
                .env("A2A_MODE", "hub")
                .env("A2A_TOKEN", &token)
                .env("A2A_ATTACHMENTS_DIR", attachments_dir.to_string_lossy().to_string())
                .env("A2A_LEDGER_DB", ledger_path.to_string_lossy().to_string())
                .env("A2A_HUMAN_NAME", &human_name)
                .env("A2A_ALLOWED_EXTENSIONS", extensions.join(","));

            let (rx, child) = cmd.spawn().map_err(|e| format!("spawn a2a-bin: {e}"))?;

            {
                let state = handle.state::<HubState>();
                *state
                    .child
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(child);
                *state
                    .info
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(HubInfo { url, token });
                *state
                    .attachments_dir
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(attachments_dir);
                *state
                    .human_name
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(human_name);
            }

            tauri::async_runtime::spawn(async move {
                stream_to_log(rx, log_path).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Tauri app")
        .run(|handle, event| {
            let kill = || {
                let state = handle.state::<HubState>();
                let child_opt = state
                    .child
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(child) = child_opt {
                    let _ = child.kill();
                }
                // PTY handles: Tauri's managed-state Drop chain fires when
                // the app exits, which drops each PtyHandle → drops its
                // `tmux attach-session` child → SIGHUP → the attach client
                // detaches cleanly. The tmux sessions themselves live on
                // the detached socket; they MUST survive app quit per the
                // v0.7 design (Decision 2). Do not call pty_kill here.
            };
            match event {
                RunEvent::ExitRequested { .. } => kill(),
                RunEvent::WindowEvent {
                    event: WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed,
                    ..
                } => kill(),
                RunEvent::Exit => kill(),
                _ => {}
            }
        });
}
