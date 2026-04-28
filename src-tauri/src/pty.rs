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
fn configure_existing_session(name: &str, lang: &str) {
    let _ = tmux_run(&["set-option", "-t", name, "remain-on-exit", "off"]);
    let _ = tmux_run(&["set-option", "-t", name, "status", "off"]);
    let _ = tmux_run(&["set-environment", "-t", name, "TERM", "xterm-256color"]);
    let _ = tmux_run(&["set-environment", "-t", name, "COLORTERM", "truecolor"]);
    let _ = tmux_run(&["set-environment", "-t", name, "LANG", lang]);
    let _ = tmux_run(&["set-environment", "-t", name, "LC_ALL", lang]);
    // Do NOT enable extended-keys/CSI-u: xterm.js doesn't speak it, breaks Shift+Enter for claude.
    let _ = tmux_run(&["set-option", "-t", name, "allow-passthrough", "on"]);
    // CRITICAL ORDER: resize FIRST then `latest`. resize-window -A pins window-size=manual implicitly;
    // setting `latest` first would be undone by the resize.
    let _ = tmux_run(&["resize-window", "-t", name, "-A"]);
    let _ = tmux_run(&["set-option", "-w", "-u", "-t", name, "window-size"]);
    let _ = tmux_run(&["set-option", "-w", "-t", name, "window-size", "latest"]);
    let _ = tmux_run(&["refresh-client", "-t", name, "-S"]);
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
    let lang_env = format!("LANG={lang}");
    let lc_all_env = format!("LC_ALL={lang}");

    if session_exists(&agent) {
        configure_existing_session(&agent, &lang);
    } else {
        // -x 80 -y 24 load-bearing: without dims tmux probes TIOCGWINSZ and we have no controlling TTY.
        let api_env = api_key
            .as_ref()
            .map(|k| format!("ANTHROPIC_API_KEY={k}"));
        let mut args: Vec<&str> = vec!["new-session", "-d", "-s", &agent];
        args.push("-e");
        args.push("TERM=xterm-256color");
        args.push("-e");
        args.push("COLORTERM=truecolor");
        args.push("-e");
        args.push(&lang_env);
        args.push("-e");
        args.push(&lc_all_env);
        if let Some(ref env) = api_env {
            args.push("-e");
            args.push(env);
        }
        args.extend_from_slice(&[
            "-x", "80",
            "-y", "24",
            "-c", &cwd,
            &spawn_cmd,
        ]);
        tmux_run(&args)?;
        let _ = tmux_run(&["set-option", "-t", &agent, "status", "off"]);
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

    if session_exists(name) {
        configure_existing_session(name, &lang);
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

// =============================================================================
// pty_await_pattern — generic regex-poll-with-timeout primitive
// =============================================================================
//
// Mirrors `terminal-control-mcp`'s `await_output` shape. First consumer is the
// permission-scraper; future "wait for build to finish" / "detect prompt
// return" detectors compose this rather than carrying their own poll loops.

const AWAIT_DEFAULT_TIMEOUT_MS: u32 = 60_000;
const AWAIT_DEFAULT_POLL_MS: u32 = 100;
const AWAIT_DEFAULT_CONFIRMATIONS: u32 = 4;

#[derive(Serialize, Clone)]
pub struct AwaitResult {
    matched: bool,
    elapsed_ms: u64,
    last_snapshot: String,
    matched_text: Option<String>,
}

fn capture_pane(agent: &str) -> String {
    tmux_run(&["capture-pane", "-p", "-t", agent]).unwrap_or_default()
}

#[tauri::command]
pub fn pty_await_pattern(
    agent: String,
    pattern: String,
    timeout_ms: Option<u32>,
    poll_interval_ms: Option<u32>,
) -> Result<AwaitResult, String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let re = regex::Regex::new(&pattern).map_err(|e| format!("regex compile: {e}"))?;
    let timeout = timeout_ms.unwrap_or(AWAIT_DEFAULT_TIMEOUT_MS) as u64;
    let poll = poll_interval_ms.unwrap_or(AWAIT_DEFAULT_POLL_MS).max(20) as u64;
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(timeout);
    let mut last_snapshot = String::new();
    while std::time::Instant::now() < deadline {
        last_snapshot = capture_pane(&agent);
        if let Some(m) = re.find(&last_snapshot) {
            return Ok(AwaitResult {
                matched: true,
                elapsed_ms: started.elapsed().as_millis() as u64,
                matched_text: Some(m.as_str().to_string()),
                last_snapshot,
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(poll));
    }
    Ok(AwaitResult {
        matched: false,
        elapsed_ms: started.elapsed().as_millis() as u64,
        matched_text: None,
        last_snapshot,
    })
}

#[tauri::command]
pub fn pty_await_pattern_absent(
    agent: String,
    pattern: String,
    timeout_ms: Option<u32>,
    confirmations: Option<u32>,
    poll_interval_ms: Option<u32>,
) -> Result<AwaitResult, String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let re = regex::Regex::new(&pattern).map_err(|e| format!("regex compile: {e}"))?;
    let timeout = timeout_ms.unwrap_or(AWAIT_DEFAULT_TIMEOUT_MS) as u64;
    let needed = confirmations.unwrap_or(AWAIT_DEFAULT_CONFIRMATIONS).max(1);
    let poll = poll_interval_ms.unwrap_or(AWAIT_DEFAULT_POLL_MS).max(20) as u64;
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(timeout);
    let mut absent_count: u32 = 0;
    let mut last_snapshot = String::new();
    while std::time::Instant::now() < deadline {
        last_snapshot = capture_pane(&agent);
        if re.is_match(&last_snapshot) {
            absent_count = 0;
        } else {
            absent_count += 1;
            if absent_count >= needed {
                return Ok(AwaitResult {
                    matched: true,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    matched_text: None,
                    last_snapshot,
                });
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(poll));
    }
    Ok(AwaitResult {
        matched: false,
        elapsed_ms: started.elapsed().as_millis() as u64,
        matched_text: None,
        last_snapshot,
    })
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
