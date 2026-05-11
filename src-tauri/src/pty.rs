// PTY bridge: tmux owns the session; we attach one PTY per agent and bridge raw ANSI to xterm.js.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{
    app_data_dir, resolve_a2a_bin, resolve_anthropic_api_key, resolve_claude_path,
    resolve_tmux_bin,
};

// Reserved name for the human's pinned shell — kept separate so it survives room filters.
pub const SHELL_SESSION_NAME: &str = "shell";

// Mirrors hub.ts AGENT_NAME_RE; re-enforced here against bypassed-UI shell-metacharacter injection.
pub fn valid_agent_name(name: &str) -> bool {
    if name == SHELL_SESSION_NAME {
        return false;
    }
    let n = name.chars().count();
    if !(1..=64).contains(&n) {
        return false;
    }
    if matches!(name.chars().next(), Some(' ')) || matches!(name.chars().last(), Some(' ')) {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' ')
}

pub struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Kept alive so the tmux attach-session child isn't reaped while we still read from master.
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry(pub Arc<Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>>);

#[derive(Serialize, Clone)]
struct OutputPayload {
    agent: String,
    b64: String,
}

fn tmux_socket_path() -> PathBuf {
    app_data_dir().join("tmux.sock")
}

fn tmux_run(args: &[&str]) -> Result<String, String> {
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let out = Command::new(&tmux)
        .arg("-S")
        .arg(&sock)
        .args(args)
        .output()
        .map_err(|e| format!("tmux spawn: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "tmux {:?} failed (exit {}): {}",
            args,
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn session_exists(agent: &str) -> bool {
    let Ok(tmux) = resolve_tmux_bin() else {
        return false;
    };
    let sock = tmux_socket_path();
    Command::new(tmux)
        .arg("-S")
        .arg(sock)
        .args(["has-session", "-t"])
        .arg(agent)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn mcp_configs_dir() -> PathBuf {
    app_data_dir().join("mcp-configs")
}

// User-editable global MCP config; merged into per-agent .mcp.json with `chatbridge` force-injected.
// Non-standard `prompts: []` per server lets our picker know slash-prompts without a JSON-RPC handshake.
pub fn global_mcp_config_path() -> PathBuf {
    app_data_dir().join("mcp.json")
}

// Reserved name; user entries with this name are silently dropped from the global config.
const RESERVED_MCP_SERVER: &str = "chatbridge";

// Best-effort: missing/malformed file returns empty map, never an error.
pub fn read_global_mcp_servers() -> serde_json::Map<String, serde_json::Value> {
    let path = global_mcp_config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Default::default(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[mcp] {} parse failed: {e}", path.display());
            return Default::default();
        }
    };
    let mut servers = match parsed.get("mcpServers").and_then(|v| v.as_object()) {
        Some(m) => m.clone(),
        None => return Default::default(),
    };
    if servers.remove(RESERVED_MCP_SERVER).is_some() {
        eprintln!("[mcp] dropped reserved server name '{RESERVED_MCP_SERVER}' from global config");
    }
    servers
}

// Written (0600) on every spawn so stale values self-heal. Force-injects chatbridge LAST.
fn write_mcp_config_for(agent: &str, room: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = mcp_configs_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let path = dir.join(format!("{agent}.json"));
    let a2a_bin = resolve_a2a_bin()?;

    // `prompts` is our picker-only annotation; not part of the .mcp.json contract claude reads.
    let mut servers = read_global_mcp_servers();
    for (_, server_cfg) in servers.iter_mut() {
        if let Some(obj) = server_cfg.as_object_mut() {
            obj.remove("prompts");
        }
    }

    servers.insert(
        RESERVED_MCP_SERVER.to_string(),
        serde_json::json!({
            "command": a2a_bin.to_string_lossy(),
            "args": [],
            "env": {
                "A2A_MODE": "channel",
                "CHATBRIDGE_AGENT": agent,
                "CHATBRIDGE_ROOM": room
            }
        }),
    );

    let cfg = serde_json::json!({ "mcpServers": servers });
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Ok(path)
}

// Direct-exec (no shell), so claude_path must be absolute — comes from config.yml.
fn claude_command(agent: &str, room: &str, session_mode: Option<&str>) -> Result<String, String> {
    let cfg_path = write_mcp_config_for(agent, room)?;
    let path_str = cfg_path.to_string_lossy().replace('\'', r"'\''");
    let mode_part = match session_mode {
        Some("continue") => "--continue ",
        Some("resume")   => "--resume ",
        Some(other)      => return Err(format!("invalid session_mode: {other}")),
        None             => "",
    };
    let claude_path = resolve_claude_path();
    let claude_escaped = claude_path.to_string_lossy().replace('\'', r"'\''");
    // Pre-allow tools the briefing tells agents to use; otherwise normal chat flow raises permission cards.
    Ok(format!(
        "'{claude_escaped}' {mode_part}--mcp-config '{path_str}' --allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file' --dangerously-load-development-channels server:chatbridge"
    ))
}

// Caller owns name-validation + session-creation; this helper only attaches and streams.
fn attach_and_stream(
    app: AppHandle,
    registry: Arc<Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>>,
    name: &str,
    lang: &str,
) -> Result<(), String> {
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut builder = CommandBuilder::new(tmux);
    builder.arg("-S");
    builder.arg(sock);
    builder.arg("attach-session");
    builder.arg("-t");
    builder.arg(name);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("LANG", lang);
    builder.env("LC_ALL", lang);

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn attach-session: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    {
        let mut map = registry.lock().unwrap();
        map.insert(
            name.to_string(),
            Arc::new(Mutex::new(PtyHandle {
                master: pair.master,
                writer,
                _child: child,
            })),
        );
    }

    // PTY reads block; dedicated thread so we don't starve the tokio executor.
    let app_clone = app.clone();
    let name_clone = name.to_string();
    let registry_clone = registry.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let b64 = B64.encode(&buf[..n]);
                    let _ = app_clone.emit(
                        &format!("pty://output/{}", name_clone),
                        OutputPayload {
                            agent: name_clone.clone(),
                            b64,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&format!("pty://exit/{}", name_clone), &name_clone);
        let mut map = registry_clone.lock().unwrap();
        map.remove(&name_clone);
    });

    Ok(())
}

// remain-on-exit off is critical: legacy "on" held panes after claude exits and broke tab-close.
/// Ensure the named tmux session is configured. Returns Ok(true) when an existing
/// session was found and reconfigured, Ok(false) when no session exists (caller
/// creates one via `new-session`), Err when a CRITICAL tmux operation fails.
///
/// Critical operations (errors propagate):
///   - `set-option remain-on-exit off` — CLAUDE.md hard rule on Tab/respawn cleanup
///   - `resize-window -A` + `set-option window-size latest` — load-bearing window-sizing
///     handshake (pre-v0.6 regressed without it)
///
/// Best-effort operations (errors logged, not propagated):
///   - status bar toggle (cosmetic)
///   - env-var injection for TERM/COLORTERM (xterm has fallbacks)
///   - LANG/LC_ALL set-environment (the new-session path sets these via `-e`;
///     re-applying on existing sessions is best-effort because long-running
///     sessions inherit from their original `-e`)
///   - allow-passthrough (only matters if a feature uses passthrough sequences)
///   - refresh-client (cosmetic redraw)
///
/// Replaces the prior `configure_existing_session` whose 10 `let _ = tmux_run(...)`
/// calls swallowed every error including the CLAUDE.md-load-bearing `remain-on-exit
/// off` failure mode.
fn ensure_session_configured(agent: &str, lang: &str) -> Result<bool, String> {
    if !session_exists(agent) {
        return Ok(false);
    }

    // CRITICAL — propagate errors
    tmux_run(&["set-option", "-t", agent, "remain-on-exit", "off"])
        .map_err(|e| format!("ensure_session_configured/remain-on-exit: {e}"))?;
    // CRITICAL ORDER: resize FIRST then `latest`. resize-window -A pins window-size=manual implicitly;
    // setting `latest` first would be undone by the resize.
    tmux_run(&["resize-window", "-t", agent, "-A"])
        .map_err(|e| format!("ensure_session_configured/resize-window: {e}"))?;
    tmux_run(&["set-option", "-w", "-t", agent, "window-size", "latest"])
        .map_err(|e| format!("ensure_session_configured/window-size latest: {e}"))?;

    // Best-effort — log + continue
    if let Err(e) = tmux_run(&["set-option", "-t", agent, "status", "off"]) {
        eprintln!("[pty] ensure_session_configured/status-off (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", agent, "TERM", "xterm-256color"]) {
        eprintln!("[pty] ensure_session_configured/TERM (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", agent, "COLORTERM", "truecolor"]) {
        eprintln!("[pty] ensure_session_configured/COLORTERM (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", agent, "LANG", lang]) {
        eprintln!("[pty] ensure_session_configured/LANG (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", agent, "LC_ALL", lang]) {
        eprintln!("[pty] ensure_session_configured/LC_ALL (best-effort): {e}");
    }
    // Do NOT enable extended-keys/CSI-u: xterm.js doesn't speak it, breaks Shift+Enter for claude.
    if let Err(e) = tmux_run(&["set-option", "-t", agent, "allow-passthrough", "on"]) {
        eprintln!("[pty] ensure_session_configured/allow-passthrough (best-effort): {e}");
    }
    // Reset the window-size override so `latest` takes effect cleanly.
    if let Err(e) = tmux_run(&["set-option", "-w", "-u", "-t", agent, "window-size"]) {
        eprintln!("[pty] ensure_session_configured/window-size-unset (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["refresh-client", "-t", agent, "-S"]) {
        eprintln!("[pty] ensure_session_configured/refresh-client (best-effort): {e}");
    }

    Ok(true)
}

/// Pure: build the `tmux new-session -d -s <agent> -e ... -x 80 -y 24 -c <cwd> <spawn_cmd>`
/// argv as a vector of owned strings. No I/O, no tmux invocation, no environment reads —
/// the locale + API-key env decisions live in the caller. Owned-strings shape lets the
/// caller pass references to args via `iter().map(String::as_str).collect()`.
///
/// CRITICAL: `spawn_cmd` is passed as a SINGLE argv element. Splitting it on whitespace
/// would re-trigger the v0.6 regression where quoted `--mcp-config '/path with spaces'`
/// got split by /bin/sh's argv-join into multiple tokens.
fn build_spawn_argv(
    agent: &str,
    cwd: &str,
    lang: &str,
    api_key: Option<&str>,
    spawn_cmd: &str,
) -> Vec<String> {
    let mut argv: Vec<String> = Vec::with_capacity(20);
    argv.push("new-session".to_string());
    argv.push("-d".to_string());
    argv.push("-s".to_string());
    argv.push(agent.to_string());
    argv.push("-e".to_string());
    argv.push("TERM=xterm-256color".to_string());
    argv.push("-e".to_string());
    argv.push("COLORTERM=truecolor".to_string());
    argv.push("-e".to_string());
    argv.push(format!("LANG={lang}"));
    argv.push("-e".to_string());
    argv.push(format!("LC_ALL={lang}"));
    if let Some(key) = api_key {
        argv.push("-e".to_string());
        argv.push(format!("ANTHROPIC_API_KEY={key}"));
    }
    // -x 80 -y 24 load-bearing: without dims tmux probes TIOCGWINSZ and we have no controlling TTY.
    argv.push("-x".to_string());
    argv.push("80".to_string());
    argv.push("-y".to_string());
    argv.push("24".to_string());
    argv.push("-c".to_string());
    argv.push(cwd.to_string());
    argv.push(spawn_cmd.to_string()); // single argv element — preserves quoting in spawn_cmd
    argv
}

// launchd inherits "C" locale; claude downgrades capability detection to ASCII without UTF-8.
fn resolve_utf8_locale() -> String {
    std::env::var("LANG")
        .ok()
        .filter(|v| v.to_lowercase().contains("utf"))
        .unwrap_or_else(|| "en_US.UTF-8".to_string())
}

// Mirrors hub.ts validRoomLabel.
fn valid_room_label(room: &str) -> bool {
    let n = room.chars().count();
    if !(1..=64).contains(&n) {
        return false;
    }
    if matches!(room.chars().next(), Some(' ')) || matches!(room.chars().last(), Some(' ')) {
        return false;
    }
    room.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' ')
}

// Spawn-modal Room default: git-root basename, falling back to cwd basename.
pub fn default_room_for_cwd(cwd: &std::path::Path) -> String {
    let mut p = cwd;
    loop {
        if p.join(".git").exists() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                return name.to_string();
            }
        }
        match p.parent() {
            Some(parent) => p = parent,
            None => break,
        }
    }
    cwd.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("default")
        .to_string()
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    agent: String,
    cwd: String,
    session_mode: Option<String>,
    room: Option<String>,
) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }

    let resolved_room = match room.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) if valid_room_label(r) => r.to_string(),
        Some(r) => return Err(format!("invalid room: {r}")),
        None => default_room_for_cwd(std::path::Path::new(&cwd)),
    };

    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&agent) {
            return Err(format!("agent '{agent}' already attached"));
        }
    }

    let spawn_cmd = claude_command(&agent, &resolved_room, session_mode.as_deref())?;
    let api_key = resolve_anthropic_api_key();
    let lang = resolve_utf8_locale();

    // Reconfigure-existing-or-create. Errors from CRITICAL tmux operations propagate
    // (was silently swallowed via `let _ = tmux_run(...)` in the prior shape).
    let existed = ensure_session_configured(&agent, &lang)?;
    if !existed {
        let argv = build_spawn_argv(&agent, &cwd, &lang, api_key.as_deref(), &spawn_cmd);
        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        tmux_run(&argv_refs)?;
        // Best-effort — status bar off is cosmetic.
        if let Err(e) = tmux_run(&["set-option", "-t", &agent, "status", "off"]) {
            eprintln!("[pty] pty_spawn/status-off (best-effort): {e}");
        }
    }

    attach_and_stream(app, state.0.clone(), &agent, &lang)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, PtyRegistry>,
    agent: String,
    b64: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let handle_arc = {
        let map = state.0.lock().unwrap();
        map.get(&agent)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent}"))?
    };
    let mut h = handle_arc.lock().unwrap();
    h.writer
        .write_all(&bytes)
        .map_err(|e| format!("write: {e}"))?;
    h.writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyRegistry>,
    agent: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle_arc = {
        let map = state.0.lock().unwrap();
        map.get(&agent)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent}"))?
    };
    let h = handle_arc.lock().unwrap();
    h.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(agent: String) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }
    tmux_run(&["kill-session", "-t", &agent])?;
    Ok(())
}

// Pinned "shell" tmux session — human's scratch shell. No claude, no MCP, no room.
#[tauri::command]
pub fn pty_spawn_shell(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let name = SHELL_SESSION_NAME;
    {
        let map = state.0.lock().unwrap();
        if map.contains_key(name) {
            return Ok(()); // already attached
        }
    }

    let lang = resolve_utf8_locale();
    let lang_env = format!("LANG={lang}");
    let lc_all_env = format!("LC_ALL={lang}");

    let user_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    // -il for parity with Terminal.app; explicit -i so plugin `[[ -o interactive ]]` guards fire.
    let shell_cmd = format!("'{}' -il", user_shell.replace('\'', r"'\''"));

    // .zshrc checks $A2ACHANNEL_SHELL to scope A2AChannel-only theming.
    let a2a_marker_env = "A2ACHANNEL_SHELL=1";

    let existed_shell = ensure_session_configured(name, &lang)?;
    if existed_shell {
        // allow-passthrough lets yazi's DA1/DSR probes reach xterm.js (silences "response timeout").
        let _ = tmux_run(&["set-option", "-t", name, "allow-passthrough", "on"]);
        let _ = tmux_run(&["set-environment", "-t", name, "A2ACHANNEL_SHELL", "1"]);
    } else {
        let args: Vec<&str> = vec![
            "new-session", "-d", "-s", name,
            "-e", "TERM=xterm-256color",
            "-e", "COLORTERM=truecolor",
            "-e", &lang_env,
            "-e", &lc_all_env,
            "-e", a2a_marker_env,
            "-x", "80",
            "-y", "24",
            "-c", &home,
            &shell_cmd,
        ];
        tmux_run(&args)?;
        let _ = tmux_run(&["set-option", "-t", name, "status", "off"]);
        let _ = tmux_run(&["set-option", "-t", name, "allow-passthrough", "on"]);
    }

    attach_and_stream(app, state.0.clone(), name, &lang)
}

#[tauri::command]
pub fn pty_shell_exists() -> Result<bool, String> {
    Ok(session_exists(SHELL_SESSION_NAME))
}

#[tauri::command]
pub fn pty_list() -> Result<Vec<String>, String> {
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let out = Command::new(tmux)
        .arg("-S")
        .arg(sock)
        .args(["list-sessions", "-F", "#S"])
        .output()
        .map_err(|e| format!("tmux list-sessions spawn: {e}"))?;
    if !out.status.success() {
        // "no server running" is exit 1 — treat as empty.
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let names: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| valid_agent_name(l))
        .collect();
    Ok(names)
}

#[tauri::command]
pub fn resolve_default_room(cwd: String) -> String {
    default_room_for_cwd(std::path::Path::new(&cwd))
}

// Live cwd of the agent's pane (tracks `cd`), not the original spawn path.
pub fn pane_current_path(agent: &str) -> Result<PathBuf, String> {
    if !valid_agent_name(agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let raw = tmux_run(&[
        "display-message", "-p", "-t", agent, "#{pane_current_path}",
    ])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("no pane_current_path for agent '{agent}'"));
    }
    Ok(PathBuf::from(trimmed))
}

// pty_capture_turn — deterministic single-turn TUI capture (geometry + pipe-pane + completion markers).
const CAPTURE_COLS: u16 = 240;
const CAPTURE_ROWS: u16 = 100;
const CAPTURE_RESIZE_SETTLE_MS: u64 = 200;
const CAPTURE_POLL_MS: u64 = 50;
const CAPTURE_DEFAULT_TIMEOUT_MS: u32 = 15_000;
const CAPTURE_KEEP_RECENT: usize = 10;
const CAPTURE_QUIESCENCE_MIN_MS: u64 = 1_500;
const CAPTURE_QUIESCENCE_STABLE_MS: u64 = 1_500;
const CAPTURE_READ_MAX_BYTES: usize = 256 * 1024;

const ALT_SCREEN_ENTER: &[u8] = b"\x1B[?1049h";
const ALT_SCREEN_EXIT: &[u8] = b"\x1B[?1049l";
const CURSOR_SHOW: &[u8] = b"\x1B[?25h";

#[derive(Serialize, Clone)]
pub struct CaptureResult {
    log_path: String,
    start_ms: u64,
    end_ms: u64,
    /// Completion reason: "alt-exit" | "idle-prompt" | "quiescence" | "timeout"
    status: String,
}

fn captures_dir(agent: &str) -> PathBuf {
    PathBuf::from("/tmp/a2a").join(agent).join("captures")
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn find_subsequence(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() || needle.len() > haystack.len() - from {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

// Inline-mode idle signature: divider line, then `❯ ` prompt, then CURSOR_SHOW within 256 bytes.
fn detect_idle_prompt(buf: &[u8], from: usize) -> bool {
    const PROMPT_GLYPH: &[u8] = "❯ ".as_bytes();
    const DIVIDER_GLYPH: &[u8] = "─".as_bytes();
    let mut search_from = from;
    while let Some(p) = find_subsequence(buf, PROMPT_GLYPH, search_from) {
        let prompt_line_start = buf[..p].iter().rposition(|&c| c == b'\n').unwrap_or(0);
        if prompt_line_start > 0 {
            let above_end = prompt_line_start;
            let above_start = buf[..above_end].iter().rposition(|&c| c == b'\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            let above_line = &buf[above_start..above_end];
            let mut divider_count = 0usize;
            let mut i = 0;
            while i + DIVIDER_GLYPH.len() <= above_line.len() {
                if &above_line[i..i + DIVIDER_GLYPH.len()] == DIVIDER_GLYPH {
                    divider_count += 1;
                    i += DIVIDER_GLYPH.len();
                } else {
                    i += 1;
                }
            }
            if divider_count >= 30 {
                let scan_end = (p + 256).min(buf.len());
                if find_subsequence(&buf[..scan_end], CURSOR_SHOW, p).is_some() {
                    return true;
                }
            }
        }
        search_from = p + PROMPT_GLYPH.len();
    }
    false
}

fn prune_captures(dir: &std::path::Path, keep: usize) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?;
            if !name.ends_with(".log") || name.contains(".partial") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, p))
        })
        .collect();
    logs.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    for (_, p) in logs.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

#[tauri::command]
pub fn pty_capture_turn(
    state: State<'_, PtyRegistry>,
    agent: String,
    input: String,
    timeout_ms: Option<u32>,
) -> Result<CaptureResult, String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let timeout = timeout_ms.unwrap_or(CAPTURE_DEFAULT_TIMEOUT_MS) as u64;

    let cap_dir = captures_dir(&agent);
    std::fs::create_dir_all(&cap_dir)
        .map_err(|e| format!("mkdir {}: {e}", cap_dir.display()))?;

    let cleanup_geometry = || {
        // CRITICAL ORDER: resize FIRST then `latest`; resize-window pins window-size=manual implicitly.
        if let Err(e) = tmux_run(&["resize-window", "-t", &agent, "-A"]) {
            eprintln!("[capture] resize -A failed: {e}");
        }
        let _ = tmux_run(&["set-option", "-w", "-u", "-t", &agent, "window-size"]);
        if let Err(e) = tmux_run(&["set-option", "-w", "-t", &agent, "window-size", "latest"]) {
            eprintln!("[capture] restore window-size failed: {e}");
        }
        if let Err(e) = tmux_run(&["refresh-client", "-t", &agent, "-S"]) {
            eprintln!("[capture] refresh-client failed: {e}");
        }
    };
    let cleanup_pipe = || {
        let _ = tmux_run(&["pipe-pane", "-t", &agent]);
    };

    // Geometry FIRST so resize redraw doesn't pollute the captured stream.
    if let Err(e) = tmux_run(&["set-option", "-w", "-t", &agent, "window-size", "manual"]) {
        return Err(format!("set window-size manual: {e}"));
    }
    if let Err(e) = tmux_run(&[
        "resize-window", "-t", &agent,
        "-x", &CAPTURE_COLS.to_string(),
        "-y", &CAPTURE_ROWS.to_string(),
    ]) {
        cleanup_geometry();
        return Err(format!("resize-window: {e}"));
    }
    std::thread::sleep(std::time::Duration::from_millis(CAPTURE_RESIZE_SETTLE_MS));

    let start_ms = epoch_ms();
    let log_path = cap_dir.join(format!("turn-{start_ms}.log"));
    if let Err(e) = std::fs::write(&log_path, b"") {
        cleanup_geometry();
        return Err(format!("touch {}: {e}", log_path.display()));
    }

    // pipe-pane BEFORE inject so we don't miss leading bytes.
    let pipe_target = format!(
        "cat >> '{}'",
        log_path.to_string_lossy().replace('\'', r"'\''")
    );
    if let Err(e) = tmux_run(&["pipe-pane", "-o", "-t", &agent, &pipe_target]) {
        cleanup_geometry();
        return Err(format!("pipe-pane on: {e}"));
    }

    let bytes = input.as_bytes().to_vec();
    let write_result = (|| -> Result<(), String> {
        let handle_arc = {
            let map = state.0.lock().unwrap();
            map.get(&agent).cloned().ok_or_else(|| format!("unknown agent: {agent}"))?
        };
        let mut h = handle_arc.lock().unwrap();
        h.writer.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
        h.writer.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    })();
    if let Err(e) = write_result {
        cleanup_pipe();
        cleanup_geometry();
        return Err(format!("inject: {e}"));
    }

    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut file_handle = match std::fs::File::open(&log_path) {
        Ok(f) => f,
        Err(e) => {
            cleanup_pipe();
            cleanup_geometry();
            return Err(format!("open {}: {e}", log_path.display()));
        }
    };
    let inject_instant = std::time::Instant::now();
    let deadline = inject_instant + std::time::Duration::from_millis(timeout);
    let mut last_change = inject_instant;
    let mut alt_screen_seen = false;
    let mut status: Option<&'static str> = None;

    while std::time::Instant::now() < deadline {
        let mut chunk = Vec::with_capacity(4096);
        if file_handle.read_to_end(&mut chunk).is_ok() && !chunk.is_empty() {
            buf.extend_from_slice(&chunk);
            last_change = std::time::Instant::now();
        }

        if !alt_screen_seen && find_subsequence(&buf, ALT_SCREEN_ENTER, 0).is_some() {
            alt_screen_seen = true;
        }

        if alt_screen_seen {
            let mut last_enter = 0usize;
            let mut search = 0usize;
            while let Some(p) = find_subsequence(&buf, ALT_SCREEN_ENTER, search) {
                last_enter = p;
                search = p + ALT_SCREEN_ENTER.len();
            }
            if find_subsequence(&buf, ALT_SCREEN_EXIT, last_enter + ALT_SCREEN_ENTER.len()).is_some() {
                status = Some("alt-exit");
                break;
            }
        }

        if !alt_screen_seen && detect_idle_prompt(&buf, 0) {
            status = Some("idle-prompt");
            break;
        }

        let elapsed = inject_instant.elapsed().as_millis() as u64;
        let stable = last_change.elapsed().as_millis() as u64;
        if !buf.is_empty()
            && elapsed >= CAPTURE_QUIESCENCE_MIN_MS
            && stable >= CAPTURE_QUIESCENCE_STABLE_MS
        {
            status = Some("quiescence");
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(CAPTURE_POLL_MS));
    }
    let final_status = status.unwrap_or("timeout");

    cleanup_pipe();
    cleanup_geometry();

    // Timeouts retained for forensics; only prune on success.
    if final_status != "timeout" {
        prune_captures(&cap_dir, CAPTURE_KEEP_RECENT);
    }

    Ok(CaptureResult {
        log_path: log_path.to_string_lossy().to_string(),
        start_ms,
        end_ms: epoch_ms(),
        status: final_status.to_string(),
    })
}

// Idempotent heal so a stuck pane (e.g. interrupted capture left window-size=manual) self-heals.
#[tauri::command]
pub fn pty_heal_geometry(agent: String) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    // CRITICAL ORDER: resize FIRST then `latest`; resize-window pins window-size=manual implicitly.
    let _ = tmux_run(&["resize-window", "-t", &agent, "-A"]);
    let _ = tmux_run(&["set-option", "-w", "-u", "-t", &agent, "window-size"]);
    let _ = tmux_run(&["set-option", "-w", "-t", &agent, "window-size", "latest"]);
    let _ = tmux_run(&["refresh-client", "-t", &agent, "-S"]);
    Ok(())
}

// `capture-pane -p` returns FULL current state (replaced a pipe-pane tap that missed the footer redraw).
#[tauri::command]
pub fn pty_tap_read(agent: String, duration_ms: Option<u32>) -> Result<String, String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    // Sleep first so claude has time to redraw the footer after the preceding keypress (e.g. Shift+Tab).
    let duration = duration_ms.unwrap_or(250).clamp(0, 2000) as u64;
    if duration > 0 {
        std::thread::sleep(std::time::Duration::from_millis(duration));
    }
    Ok(tmux_run(&["capture-pane", "-p", "-t", &agent]).unwrap_or_default())
}

// /tmp/a2a/ path-prefix guard prevents arbitrary file read via JS misuse.
#[tauri::command]
pub fn pty_read_capture(log_path: String, max_bytes: Option<u32>) -> Result<String, String> {
    let cap = max_bytes.map(|n| n as usize).unwrap_or(CAPTURE_READ_MAX_BYTES);
    let path = std::path::Path::new(&log_path);
    if !path.starts_with("/tmp/a2a/") {
        return Err(format!("path outside capture dir: {log_path}"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {log_path}: {e}"))?;
    let trimmed = if bytes.len() > cap { &bytes[..cap] } else { &bytes[..] };
    Ok(String::from_utf8_lossy(trimmed).to_string())
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    #[test]
    fn alt_screen_exit_substring_match() {
        let buf = b"prefix\x1B[?1049henter then content \x1B[?1049l done";
        assert!(find_subsequence(buf, ALT_SCREEN_ENTER, 0).is_some());
        assert!(find_subsequence(buf, ALT_SCREEN_EXIT, 0).is_some());
        let enter_pos = find_subsequence(buf, ALT_SCREEN_ENTER, 0).unwrap();
        let exit_pos = find_subsequence(buf, ALT_SCREEN_EXIT, 0).unwrap();
        assert!(exit_pos > enter_pos);
    }

    #[test]
    fn idle_prompt_detects_divider_prompt_cursor() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"some prior content\n");
        for _ in 0..40 {
            buf.extend_from_slice("─".as_bytes());
        }
        buf.extend_from_slice(b"\n\xE2\x9D\xAF \x1B[?25h");
        assert!(detect_idle_prompt(&buf, 0));
    }

    #[test]
    fn idle_prompt_rejects_short_divider() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"text\n");
        for _ in 0..10 {
            buf.extend_from_slice("─".as_bytes());
        }
        buf.extend_from_slice(b"\n\xE2\x9D\xAF \x1B[?25h");
        assert!(!detect_idle_prompt(&buf, 0));
    }

    #[test]
    fn idle_prompt_requires_cursor_show_after_prompt() {
        let mut buf = Vec::new();
        for _ in 0..40 {
            buf.extend_from_slice("─".as_bytes());
        }
        buf.extend_from_slice(b"\n\xE2\x9D\xAF no cursor follows");
        assert!(!detect_idle_prompt(&buf, 0));
    }

    #[test]
    fn prune_keeps_n_most_recent_logs() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("a2a-prune-test-{}-{}", epoch_ms(), n));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            let p = dir.join(format!("turn-{i}.log"));
            std::fs::write(&p, b"x").unwrap();
            // Sleep so SystemTime ordering is deterministic.
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        prune_captures(&dir, 3);
        let remaining: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_ignores_partial_files() {
        let dir = std::env::temp_dir().join(format!("a2a-prune-partial-{}", epoch_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("turn-1.log"), b"x").unwrap();
        std::fs::write(dir.join("turn-2.partial.log"), b"x").unwrap();
        std::fs::write(dir.join("turn-3.log"), b"x").unwrap();
        prune_captures(&dir, 1);
        let remaining: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod spawn_argv_tests {
    //! Pure-function tests for `build_spawn_argv`. No tmux required.

    use super::build_spawn_argv;

    #[test]
    fn argv_starts_with_new_session_form() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude --resume");
        assert_eq!(&argv[0..4], &["new-session", "-d", "-s", "alice"]);
    }

    #[test]
    fn argv_includes_terminal_env_vars() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude");
        let joined = argv.join(" ");
        assert!(joined.contains("TERM=xterm-256color"), "missing TERM env: {joined}");
        assert!(joined.contains("COLORTERM=truecolor"), "missing COLORTERM env: {joined}");
        assert!(joined.contains("LANG=en_US.UTF-8"), "missing LANG env: {joined}");
        assert!(joined.contains("LC_ALL=en_US.UTF-8"), "missing LC_ALL env: {joined}");
    }

    #[test]
    fn argv_includes_anthropic_api_key_when_provided() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", Some("sk-test-123"), "claude");
        let joined = argv.join(" ");
        assert!(joined.contains("ANTHROPIC_API_KEY=sk-test-123"), "missing API key env: {joined}");
    }

    #[test]
    fn argv_omits_anthropic_api_key_when_none() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude");
        let joined = argv.join(" ");
        assert!(!joined.contains("ANTHROPIC_API_KEY"), "should omit API key env when None: {joined}");
    }

    #[test]
    fn argv_includes_xy_dimensions_and_cwd() {
        let argv = build_spawn_argv("alice", "/some/cwd", "en_US.UTF-8", None, "claude");
        // -x 80 -y 24 is load-bearing: tmux probes TIOCGWINSZ without these dims.
        assert!(argv.iter().any(|s| s == "-x"));
        assert!(argv.iter().any(|s| s == "80"));
        assert!(argv.iter().any(|s| s == "-y"));
        assert!(argv.iter().any(|s| s == "24"));
        assert!(argv.iter().any(|s| s == "/some/cwd"));
    }

    #[test]
    fn argv_passes_spawn_cmd_as_single_element() {
        // The v0.6 regression: a spawn cmd containing quoted paths-with-spaces was being
        // tokenized by /bin/sh's argv-join. The fix is to pass spawn_cmd as a SINGLE
        // tmux argv element so tmux sees it as one shell-quoted command-string argument.
        let spawn_cmd = r#"claude --mcp-config '/Users/me/Some Path/mcp.json' --dangerously-load-development-channels server:chatbridge"#;
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, spawn_cmd);
        let last = argv.last().unwrap();
        // The spawn_cmd appears verbatim as a SINGLE argv element — quotes, spaces, and all.
        assert_eq!(last, spawn_cmd);
        // Sanity: no element of argv splits the spawn_cmd into multiple tokens.
        let occurrences = argv.iter().filter(|s| s.contains("--mcp-config")).count();
        assert_eq!(occurrences, 1, "spawn_cmd appears multiple times — got split: {argv:?}");
    }

    #[test]
    fn argv_cwd_with_spaces_preserved_as_single_element() {
        let argv = build_spawn_argv("alice", "/Users/me/Path With Spaces", "en_US.UTF-8", None, "claude");
        // The -c flag's value MUST be one element; -c then its arg.
        let cwd_idx = argv.iter().position(|s| s == "-c").expect("missing -c");
        assert_eq!(argv[cwd_idx + 1], "/Users/me/Path With Spaces");
    }
}
