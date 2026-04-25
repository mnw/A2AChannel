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

// Reserved tmux session name for the human's pinned shell. Kept separate from agent
// sessions so it survives room filters and can't be confused with an agent entry.
pub const SHELL_SESSION_NAME: &str = "shell";

// Mirrors hub.ts AGENT_NAME_RE — re-enforced here so a bypassed UI validator can't
// smuggle shell metacharacters into tmux argv. Also rejects the reserved shell name.
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
    // Kept so the tmux attach-session child isn't reaped while we still read from the master.
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

// Written (0600) on every spawn so stale values self-heal. Loaded additively via `--mcp-config`;
// the user's cwd `.mcp.json` is still honored. `room` is baked into the env so channel-bin
// scopes its /agent-stream subscription correctly.
fn write_mcp_config_for(agent: &str, room: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = mcp_configs_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let path = dir.join(format!("{agent}.json"));
    let a2a_bin = resolve_a2a_bin()?;
    let cfg = serde_json::json!({
        "mcpServers": {
            "chatbridge": {
                "command": a2a_bin.to_string_lossy(),
                "args": [],
                "env": {
                    "A2A_MODE": "channel",
                    "CHATBRIDGE_AGENT": agent,
                    "CHATBRIDGE_ROOM": room
                }
            }
        }
    });
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Ok(path)
}

// Build the claude invocation. Direct-exec (no shell), so claude_path must be absolute —
// comes from config.json to avoid paying the .zshrc-loading cost on every spawn.
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
    // Pre-allow ack_permission so peer verdicts don't trigger a local permission
    // prompt on the acker — required for the peer-vote design in permission-relay.
    // Without this the feature is broken: a human would have to ack the ack.
    Ok(format!(
        "'{claude_escaped}' {mode_part}--mcp-config '{path_str}' --allowed-tools 'mcp__chatbridge__ack_permission' --dangerously-load-development-channels server:chatbridge"
    ))
}

// Open a PTY, attach to the named tmux session on our socket, register the
// handle in PtyRegistry, and spawn the reader task that forwards output bytes
// to the webview as `pty://output/<name>` events. Emits `pty://exit/<name>`
// and removes the handle when the reader ends. Caller owns the agent-name
// validation and session-creation steps — this helper only attaches + streams.
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

    // PTY reads are blocking — dedicated thread so we don't starve the tokio executor.
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

// Apply the standard tmux options + env to a session that already exists on
// our socket. Used by the reattach path on both agent and shell tabs. The
// remain-on-exit off is critical: legacy builds left it "on" which held
// panes after claude exits and broke the tab-close flow. tmux_run errors are
// ignored — these are best-effort setters against a known-live session.
fn configure_existing_session(name: &str, lang: &str) {
    let _ = tmux_run(&["set-option", "-t", name, "remain-on-exit", "off"]);
    let _ = tmux_run(&["set-option", "-t", name, "status", "off"]);
    let _ = tmux_run(&["set-environment", "-t", name, "TERM", "xterm-256color"]);
    let _ = tmux_run(&["set-environment", "-t", name, "COLORTERM", "truecolor"]);
    let _ = tmux_run(&["set-environment", "-t", name, "LANG", lang]);
    let _ = tmux_run(&["set-environment", "-t", name, "LC_ALL", lang]);
}

// Resolve UTF-8 locale for tmux sessions. GUI launches under launchd inherit
// a blank or "C" locale, which makes claude's terminal-capability detection
// downgrade to ASCII (logo renders as `____` instead of Braille/box-drawing).
// Prefer the user's LANG if it already contains "utf"; otherwise default to
// en_US.UTF-8 which ships with every macOS install.
fn resolve_utf8_locale() -> String {
    std::env::var("LANG")
        .ok()
        .filter(|v| v.to_lowercase().contains("utf"))
        .unwrap_or_else(|| "en_US.UTF-8".to_string())
}

// Validate a room label: 1..=64 chars, [A-Za-z0-9_.-] + spaces, no leading/trailing space.
// Mirrors hub.ts validRoomLabel so the two ends agree.
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

// Walk up from `cwd` looking for a `.git` directory; return that directory's basename.
// Falls back to the cwd basename when no git root is found. Empty string only if both
// paths have no filename component (pathological). Used as the spawn-modal's Room default.
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

    // Resolve room: explicit arg → validated; empty/missing → git-root basename fallback.
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
        // -x 80 -y 24 is load-bearing: without explicit dims tmux probes TIOCGWINSZ and we
        // have no controlling TTY. Real size is applied via SIGWINCH on attach.
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

// Spawn (or idempotently attach to) the pinned "shell" tmux session — the human's
// own scratch shell for cd / ls / git etc. No claude, no MCP, no room. Key `shell`
// in the PTY registry. Outputs stream via `pty://output/shell`. Survives app
// restart like agent sessions. Cross-room / cross-project by design.
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
    // -i + -l for parity with Terminal.app: explicit interactive + login. Without -i, zsh
    // still auto-enables interactive mode when stdin is a PTY, but some plugins' guards
    // (`[[ -o interactive ]]`) fire more reliably with the flag set explicitly.
    let shell_cmd = format!("'{}' -il", user_shell.replace('\'', r"'\''"));

    // Marker env var — .zshrc checks $A2ACHANNEL_SHELL to scope A2AChannel-only
    // theming (fzf/starship/yazi palettes) without affecting the user's regular shell.
    let a2a_marker_env = "A2ACHANNEL_SHELL=1";

    if session_exists(name) {
        configure_existing_session(name, &lang);
        // Shell-tab extras on top of the shared config:
        // - allow-passthrough lets DA1/DSR escapes (yazi's terminal-capability probe)
        //   reach xterm.js directly rather than getting swallowed by tmux. Silences
        //   yazi's "Terminal response timeout" startup warning.
        // - A2ACHANNEL_SHELL is a marker env var .zshrc checks to scope
        //   A2AChannel-only theming without affecting the user's regular shell.
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

// Is the shell tmux session currently live on our socket? Used by the UI to decide
// whether to auto-spawn on first pane-open.
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

// Spawn-modal prefill: given a cwd string, return the git-root basename (or cwd basename).
// Stays a pure function of the filesystem; no hub round-trip needed.
#[tauri::command]
pub fn resolve_default_room(cwd: String) -> String {
    default_room_for_cwd(std::path::Path::new(&cwd))
}
