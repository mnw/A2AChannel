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

const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;
const TOKEN_BYTES: usize = 32;

struct HubState {
    child: Mutex<Option<CommandChild>>,
    info: Mutex<Option<HubInfo>>,
    human_name: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct HubInfo {
    url: String,
    token: String,
}

#[derive(Deserialize, Serialize, Default, Clone)]
struct FontsConfig {
    // Sans/proportional: body, chat, modals.
    #[serde(default)]
    ui: Option<String>,
    // Monospace: UI labels + terminal panes; user value sits before protected Nerd/Symbol fallback chain.
    #[serde(default)]
    mono: Option<String>,
}

#[derive(Deserialize, Serialize, Default, Clone)]
struct AppConfig {
    #[serde(default)]
    attachments_dir: Option<String>,
    // Legacy key for configs from ≤ v0.4.x; read only when `attachments_dir` is absent.
    #[serde(default)]
    images_dir: Option<String>,
    #[serde(default)]
    human_name: Option<String>,
    #[serde(default)]
    attachment_extensions: Option<Vec<String>>,
    #[serde(default)]
    claude_path: Option<String>,
    #[serde(default)]
    anthropic_api_key: Option<String>,
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    font_scale: Option<f32>,
    #[serde(default)]
    fonts: Option<FontsConfig>,
    #[serde(default)]
    editor: Option<String>,
    // In-memory chat history ring-buffer cap. Also bounds how many entries get
    // hydrated from a persisted JSONL transcript on hub restart, so it doubles
    // as the per-agent context-replay budget.
    #[serde(default)]
    chat_history_limit: Option<u32>,
}

#[derive(Serialize, Clone, Default)]
struct UiFonts {
    ui: String,
    mono: String,
}

#[derive(Serialize, Clone)]
struct UiSettings {
    theme: String,
    font_scale: f32,
    fonts: UiFonts,
}

const VALID_THEMES: &[&str] = &["default", "rose-pine-dawn", "rose-pine-moon"];
const FONT_SCALE_MIN: f32 = 0.85;
const FONT_SCALE_MAX: f32 = 1.25;
const FONT_NAME_MAX: usize = 64;

const RESERVED_NAMES: &[&str] = &["you", "all", "system"];

fn default_attachment_extensions() -> Vec<String> {
    vec!["jpg", "jpeg", "png", "pdf", "md"]
        .into_iter()
        .map(String::from)
        .collect()
}

fn valid_extension(ext: &str) -> bool {
    let n = ext.chars().count();
    if !(1..=10).contains(&n) {
        return false;
    }
    ext.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

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

// Default 1000 entries; clamped to [10, 100_000] so a misconfig can't crash the
// hub or starve agents on reconnect.
const CHAT_HISTORY_LIMIT_DEFAULT: u32 = 1000;
const CHAT_HISTORY_LIMIT_MIN: u32 = 10;
const CHAT_HISTORY_LIMIT_MAX: u32 = 100_000;

fn resolve_chat_history_limit() -> u32 {
    let raw = load_config()
        .chat_history_limit
        .unwrap_or(CHAT_HISTORY_LIMIT_DEFAULT);
    raw.clamp(CHAT_HISTORY_LIMIT_MIN, CHAT_HISTORY_LIMIT_MAX)
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
    app_data_dir().join("config.yml")
}

fn legacy_config_file() -> PathBuf {
    app_data_dir().join("config.json")
}

fn ledger_file() -> PathBuf {
    app_data_dir().join("ledger.db")
}

fn default_human_name() -> String {
    "human".to_string()
}

// Mirrors hub.ts AGENT_NAME_RE plus reserved-word check.
fn validate_human_name(name: &str) -> Result<(), String> {
    if RESERVED_NAMES
        .iter()
        .any(|r| r.eq_ignore_ascii_case(name))
    {
        return Err(format!(
            "human_name '{name}' collides with a reserved word ({}). \
             Choose a different name in config.yml.",
            RESERVED_NAMES.join(", ")
        ));
    }
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
    // Top-level ~/ avoids macOS TCC — ~/Documents etc. block the agent's Read tool.
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("a2a-attachments")
}

fn default_claude_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".claude/local/claude")
}

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

pub fn resolve_anthropic_api_key() -> Option<String> {
    let cfg = load_config();
    cfg.anthropic_api_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn load_config() -> AppConfig {
    let path = config_file();
    match fs::read_to_string(&path) {
        Ok(s) => match serde_yml::from_str::<AppConfig>(&s) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!(
                    "[setup] config.yml exists but failed to parse ({}), using defaults: {e}",
                    path.display()
                );
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

// Carry legacy config.json values forward into config.yml on first launch after upgrade.
fn load_legacy_json_config() -> Option<AppConfig> {
    let path = legacy_config_file();
    let s = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<AppConfig>(&s) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            eprintln!(
                "[setup] legacy config.json present but failed to parse ({}): {e}",
                path.display()
            );
            None
        }
    }
}

fn resolve_theme() -> String {
    let cfg = load_config();
    let raw = cfg
        .theme
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    if VALID_THEMES.iter().any(|t| *t == raw) {
        raw
    } else {
        eprintln!(
            "[setup] theme '{raw}' not in {VALID_THEMES:?}; falling back to default"
        );
        "default".to_string()
    }
}

fn resolve_font_scale() -> f32 {
    let cfg = load_config();
    let raw = cfg.font_scale.unwrap_or(1.0);
    if !raw.is_finite() {
        return 1.0;
    }
    raw.clamp(FONT_SCALE_MIN, FONT_SCALE_MAX)
}

// Whitelist prevents breaking out of the webview's CSS string composer.
fn sanitize_font_name(raw: Option<String>) -> String {
    let Some(s) = raw else { return String::new() };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() > FONT_NAME_MAX {
        eprintln!("[setup] font name '{trimmed}' exceeds {FONT_NAME_MAX} chars; ignored");
        return String::new();
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if !ok {
        eprintln!(
            "[setup] font name '{trimmed}' contains characters outside [A-Za-z0-9 ._-]; ignored"
        );
        return String::new();
    }
    trimmed.to_string()
}

fn resolve_fonts() -> UiFonts {
    let cfg = load_config();
    let f = cfg.fonts.unwrap_or_default();
    UiFonts {
        ui:   sanitize_font_name(f.ui),
        mono: sanitize_font_name(f.mono),
    }
}

fn resolve_human_name() -> Result<String, String> {
    let cfg = load_config();
    let name = cfg.human_name.clone().unwrap_or_else(default_human_name);
    validate_human_name(&name)?;
    Ok(name)
}

fn resolve_attachments_dir_and_seed(human_name: &str, extensions: &[String]) -> PathBuf {
    let cfg = load_config();
    let pick = |opt: Option<String>| -> Option<String> {
        opt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let dir = pick(cfg.attachments_dir.clone())
        .or_else(|| pick(cfg.images_dir.clone()))
        .map(PathBuf::from)
        .unwrap_or_else(default_attachments_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[setup] create attachments dir {} failed: {e}", dir.display());
    }
    let cfg_path = config_file();
    if !cfg_path.exists() {
        // Carry forward legacy config.json values on first launch after upgrade.
        let legacy = load_legacy_json_config().unwrap_or_default();
        let seed_human_name = legacy
            .human_name
            .as_deref()
            .unwrap_or(human_name);
        let seed_attachments_dir = legacy
            .attachments_dir
            .or(legacy.images_dir)
            .unwrap_or_default();
        let seed_extensions: Vec<String> = legacy
            .attachment_extensions
            .unwrap_or_else(|| extensions.to_vec());
        let seed_claude_path = legacy
            .claude_path
            .unwrap_or_else(|| "~/.claude/local/claude".to_string());
        let seed_api_key = legacy.anthropic_api_key.unwrap_or_default();
        let seed_theme = legacy
            .theme
            .filter(|s| VALID_THEMES.iter().any(|t| *t == s.as_str()))
            .unwrap_or_else(|| "default".to_string());
        let seed_font_scale = legacy
            .font_scale
            .filter(|f| f.is_finite())
            .map(|f| f.clamp(FONT_SCALE_MIN, FONT_SCALE_MAX))
            .unwrap_or(1.0);
        let legacy_fonts = legacy.fonts.unwrap_or_default();
        let seed_fonts = UiFonts {
            ui:   sanitize_font_name(legacy_fonts.ui),
            mono: sanitize_font_name(legacy_fonts.mono),
        };
        let seed_editor = legacy
            .editor
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let seed_chat_history_limit = legacy
            .chat_history_limit
            .map(|n| n.clamp(CHAT_HISTORY_LIMIT_MIN, CHAT_HISTORY_LIMIT_MAX))
            .unwrap_or(CHAT_HISTORY_LIMIT_DEFAULT);

        let yaml = render_seed_yaml(
            seed_human_name,
            &seed_attachments_dir,
            &seed_extensions,
            &seed_claude_path,
            &seed_api_key,
            &seed_theme,
            seed_font_scale,
            &seed_fonts,
            &seed_editor,
            seed_chat_history_limit,
        );

        if let Err(e) = fs::create_dir_all(cfg_path.parent().unwrap_or(&PathBuf::from("/tmp"))) {
            eprintln!("[setup] create config dir failed: {e}");
        }
        if let Err(e) = fs::write(&cfg_path, yaml) {
            eprintln!("[setup] seed config.yml at {} failed: {e}", cfg_path.display());
        } else {
            println!("[setup] seeded config.yml at {}", cfg_path.display());
        }
    }
    dir
}

// Hand-rolled YAML to preserve comments; serde_yml::to_string drops them.
#[allow(clippy::too_many_arguments)]
fn render_seed_yaml(
    human_name: &str,
    attachments_dir: &str,
    extensions: &[String],
    claude_path: &str,
    api_key: &str,
    theme: &str,
    font_scale: f32,
    fonts: &UiFonts,
    editor: &str,
    chat_history_limit: u32,
) -> String {
    let attachments_line = if attachments_dir.is_empty() {
        "attachments_dir: null".to_string()
    } else {
        format!("attachments_dir: {}", yaml_string(attachments_dir))
    };
    let mut ext_block = String::from("attachment_extensions:\n");
    for e in extensions {
        ext_block.push_str(&format!("  - {e}\n"));
    }
    let api_line = if api_key.is_empty() {
        "anthropic_api_key: \"\"".to_string()
    } else {
        format!("anthropic_api_key: {}", yaml_string(api_key))
    };

    format!(
        "# A2AChannel config. Applied on launch; click Reload to re-read.\n\
         \n\
         # Identity shown in the roster.\n\
         human_name: {human_name}\n\
         \n\
         # Path to the claude binary. ~ expands to your home dir.\n\
         claude_path: {claude_path}\n\
         \n\
         # Optional. Exported to spawned claude sessions if non-empty.\n\
         {api_line}\n\
         \n\
         # Where uploaded files persist. null → ~/a2a-attachments.\n\
         {attachments_line}\n\
         \n\
         # Allowed upload extensions. Lowercase, no leading dot.\n\
         {ext_block}\
         \n\
         # Theme: default | rose-pine-dawn | rose-pine-moon.\n\
         theme: {theme}\n\
         \n\
         # Multiplier on every UI text size. 1 = default.\n\
         # 0.85 = smaller, 1.25 = larger. Values outside that range\n\
         # are clamped.\n\
         font_scale: {font_scale}\n\
         \n\
         # Override fonts. Name must match a font installed on this Mac\n\
         # (case-sensitive). Each value is PREPENDED to the built-in chain;\n\
         # Claude Code's required fonts (Nerd Font for box-drawing, Apple\n\
         # Symbols, Apple Color Emoji) are always retained as fallbacks and\n\
         # cannot be removed. Allowed chars: A-Z a-z 0-9 space . _ -\n\
         # Empty = use the built-in default.\n\
         #   ui   — chat / modals / proportional UI text\n\
         #   mono — code, labels, terminal panes\n\
         fonts:\n  \
         ui: \"{ui}\"\n  \
         mono: \"{mono}\"\n\
         \n\
         # Editor opened by the agent tab's editor button.\n\
         # Cwd of the agent's tmux pane is appended as the last arg.\n\
         # Examples:\n\
         #   editor: code           # VS Code CLI in PATH\n\
         #   editor: cursor         # Cursor CLI in PATH\n\
         #   editor: subl           # Sublime Text CLI in PATH\n\
         #   editor: open -a Cursor # macOS app bundle launcher\n\
         # Empty disables the button.\n\
         editor: \"{editor}\"\n\
         \n\
         # In-memory chat ring-buffer size. Doubles as the replay budget on hub\n\
         # restart: when a room has persistent transcripts on, this many entries\n\
         # are reloaded from JSONL into memory and replayed to reconnecting\n\
         # agents (token cost in their context window). Default 1000. Clamped\n\
         # to [10, 100000].\n\
         chat_history_limit: {chat_history_limit}\n",
        ui                 = fonts.ui,
        mono               = fonts.mono,
        editor             = editor,
        chat_history_limit = chat_history_limit,
    )
}

fn yaml_string(v: &str) -> String {
    let needs_quote = v.is_empty()
        || v.starts_with(|c: char| c.is_whitespace() || "!&*?|>%@`".contains(c))
        || v.contains(':')
        || v.contains('#')
        || v.contains('"')
        || v.contains('\'')
        || v.contains('\n');
    if needs_quote {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        v.to_string()
    }
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
    // Bundled: Contents/MacOS/a2a-bin. Dev: ./a2a-bin-<triple>.
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

pub(crate) fn resolve_tmux_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    // bundle.resources preserves source structure → tmux can land in two locations.
    let candidates = [
        exe_dir.join("../Resources/resources/tmux"),
        exe_dir.join("../Resources/tmux"),
        exe_dir.join("../../resources/tmux"),
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
    // O_EXCL + mode 0600 below closes the chmod-after-write race; discard any leftover tmp first.
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
                // Rotated archive may still hold tokens (query-string auth).
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
    // Tokens leak via SSE/image query strings; enforce 0600.
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

// chatbridge omitted from template intentionally; it's force-injected per-agent and stripped from user configs.
#[tauri::command]
fn open_global_mcp_config() -> Result<(), String> {
    let path = pty::global_mcp_config_path();
    if !path.exists() {
        let template = serde_json::to_string_pretty(&json!({
            "_comment": "Global MCP servers shared by all A2AChannel agents. Standard .mcp.json schema. \
                         Each server may carry an optional non-standard `prompts: [\"name\", ...]` array \
                         which lets the slash picker show /mcp__<server>__<name> as a discoverable command. \
                         The `chatbridge` server is reserved by A2AChannel; entries with that name are \
                         silently dropped on save.",
            "mcpServers": {}
        })).map_err(|e| e.to_string())?;
        std::fs::write(&path, template)
            .map_err(|e| format!("create {}: {e}", path.display()))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(())
}

// Returns new {url, token} so the UI can hot-swap without relaunching.
#[tauri::command]
fn reload_settings(
    handle: tauri::AppHandle,
    state: State<HubState>,
) -> Result<HubInfo, String> {
    let human_name = resolve_human_name()?;
    let extensions = resolve_attachment_extensions();
    let attachments_dir = resolve_attachments_dir_and_seed(&human_name, &extensions);
    let ledger_path = ledger_file();
    let chat_history_limit = resolve_chat_history_limit();

    let port = pick_free_port()?;
    let url = format!("http://127.0.0.1:{port}");
    let token = mint_token()?;

    // Kill first so two hub-bin processes never race for the same port.
    {
        let child_opt = state.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(child) = child_opt {
            let _ = child.kill();
        }
    }

    if let Err(e) = write_discovery_file(&url) {
        return Err(format!("write discovery file: {e}"));
    }
    if let Err(e) = write_token_file(&token) {
        return Err(format!("write token file: {e}"));
    }

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
        .env("A2A_ALLOWED_EXTENSIONS", extensions.join(","))
        .env("A2A_CHAT_HISTORY_LIMIT", chat_history_limit.to_string());
    let (rx, child) = cmd.spawn().map_err(|e| format!("spawn a2a-bin: {e}"))?;

    let new_info = HubInfo {
        url: url.clone(),
        token: token.clone(),
    };
    {
        *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        *state.info.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_info.clone());
        *state.human_name.lock().unwrap_or_else(|e| e.into_inner()) = Some(human_name);
    }

    let log_path = logs_dir().join("hub.log");
    tauri::async_runtime::spawn(async move {
        stream_to_log(rx, log_path).await;
    });

    println!("[settings] hub restarted on port {port}");
    Ok(new_info)
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// tokens.css multiplies every --fs-* by var(--ui-font-scale).
#[tauri::command]
fn get_ui_settings() -> UiSettings {
    UiSettings {
        theme: resolve_theme(),
        font_scale: resolve_font_scale(),
        fonts: resolve_fonts(),
    }
}

// Editor cmd from config.yml; cwd is the agent's live pane path (tracks `cd`), appended as last arg.
#[tauri::command]
fn open_in_editor(agent: String) -> Result<String, String> {
    let cfg = load_config();
    let raw_editor = cfg
        .editor
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "editor not configured — set `editor:` in config.yml".to_string()
        })?;

    let cwd = pty::pane_current_path(&agent)?;
    if !cwd.exists() {
        return Err(format!("cwd does not exist: {}", cwd.display()));
    }

    // Split on whitespace so "open -a Cursor" works as well as bare "code"; first token may use ~.
    let mut parts = raw_editor.split_whitespace();
    let cmd_token = parts
        .next()
        .ok_or_else(|| "editor value is empty after trimming".to_string())?;
    let cmd_path = expand_tilde(cmd_token);
    let leading_args: Vec<&str> = parts.collect();

    let mut command = std::process::Command::new(&cmd_path);
    for a in &leading_args {
        command.arg(a);
    }
    command.arg(&cwd);
    command
        .spawn()
        .map_err(|e| format!("spawn '{cmd_token}' failed: {e}"))?;
    Ok(cwd.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
struct SlashCommandEntry {
    name: String,
    description: String,
}

// Scans cwd + ~/.claude commands/skills + global MCP `prompts: []` annotations. Built-ins not included.
#[tauri::command]
fn slash_discover_for_agent(agent: String) -> Vec<SlashCommandEntry> {
    let mut out: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let cwd = pty::pane_current_path(&agent).ok();
    let home = dirs::home_dir();
    let roots: Vec<PathBuf> = [cwd.as_deref(), home.as_deref()]
        .into_iter()
        .flatten()
        .map(|p| p.join(".claude"))
        .collect();
    for root in &roots {
        scan_commands_dir(&root.join("commands"), &mut out);
        scan_skills_dir(&root.join("skills"), &mut out);
    }
    let global_servers = pty::read_global_mcp_servers();
    for (server_name, server_cfg) in global_servers.iter() {
        let prompts = server_cfg.get("prompts").and_then(|v| v.as_array());
        let description = server_cfg
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(arr) = prompts {
            for p in arr {
                if let Some(prompt_name) = p.as_str() {
                    let full = format!("mcp__{server_name}__{prompt_name}");
                    out.entry(full).or_insert_with(|| description.clone());
                }
            }
        }
    }
    out.into_iter()
        .map(|(name, description)| SlashCommandEntry { name, description })
        .collect()
}

fn scan_commands_dir(dir: &Path, out: &mut std::collections::BTreeMap<String, String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let desc = read_frontmatter_description(&path).unwrap_or_default();
        out.entry(stem).or_insert(desc);
    }
}

fn scan_skills_dir(dir: &Path, out: &mut std::collections::BTreeMap<String, String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let desc = read_frontmatter_description(&skill_md).unwrap_or_default();
        out.entry(name).or_insert(desc);
    }
}

// Tolerant: handles Claude Code's single-line, optionally-quoted value shape only.
fn read_frontmatter_description(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let mut lines = raw.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            let v = rest.trim().trim_matches(|c: char| c == '"' || c == '\'');
            if !v.is_empty() {
                // ~120 char cap keeps the picker compact.
                let truncated: String = v.chars().take(120).collect();
                return Some(truncated);
            }
        }
    }
    None
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
    // Wipe WKWebView disk cache before webview creation; otherwise stale assets persist.
    if let Some(cache_root) = dirs::cache_dir() {
        let base = cache_root.join("com.mnw.a2achannel/WebKit");
        let _ = fs::remove_dir_all(base.join("NetworkCache"));
        let _ = fs::remove_dir_all(base.join("CacheStorage"));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(HubState {
            child: Mutex::new(None),
            info: Mutex::new(None),
            human_name: Mutex::new(None),
        })
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_hub_url,
            get_app_version,
            get_mcp_template,
            slash_discover_for_agent,
            get_human_name,
            get_ui_settings,
            open_config_file,
            open_global_mcp_config,
            open_in_editor,
            reload_settings,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            pty::resolve_default_room,
            pty::pty_spawn_shell,
            pty::pty_shell_exists,
            pty::pty_capture_turn,
            pty::pty_read_capture,
            pty::pty_heal_geometry,
            pty::pty_tap_read
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

            let chat_history_limit = resolve_chat_history_limit();
            println!("[setup] chat history limit: {chat_history_limit}");

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
                .env("A2A_ALLOWED_EXTENSIONS", extensions.join(","))
                .env("A2A_CHAT_HISTORY_LIMIT", chat_history_limit.to_string());

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
                // PTY handles Drop → attach-session SIGHUP → detach cleanly. tmux sessions intentionally survive.
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
