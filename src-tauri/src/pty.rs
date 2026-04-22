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

// Mirrors hub.ts AGENT_NAME_RE — re-enforced here so a bypassed UI validator can't
// smuggle shell metacharacters into tmux argv.
pub fn valid_agent_name(name: &str) -> bool {
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
// the user's cwd `.mcp.json` is still honored.
fn write_mcp_config_for(agent: &str) -> Result<PathBuf, String> {
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
                    "CHATBRIDGE_AGENT": agent
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
fn claude_command(agent: &str, session_mode: Option<&str>) -> Result<String, String> {
    let cfg_path = write_mcp_config_for(agent)?;
    let path_str = cfg_path.to_string_lossy().replace('\'', r"'\''");
    let mode_part = match session_mode {
        Some("continue") => "--continue ",
        Some("resume")   => "--resume ",
        Some(other)      => return Err(format!("invalid session_mode: {other}")),
        None             => "",
    };
    let claude_path = resolve_claude_path();
    let claude_escaped = claude_path.to_string_lossy().replace('\'', r"'\''");
    Ok(format!(
        "'{claude_escaped}' {mode_part}--mcp-config '{path_str}' --dangerously-load-development-channels server:chatbridge"
    ))
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    agent: String,
    cwd: String,
    session_mode: Option<String>,
) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }

    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&agent) {
            return Err(format!("agent '{agent}' already attached"));
        }
    }

    let spawn_cmd = claude_command(&agent, session_mode.as_deref())?;
    let api_key = resolve_anthropic_api_key();

    // UTF-8 locale for the session. GUI launches under launchd inherit
    // a blank or "C" locale, which makes claude's terminal-capability
    // detection downgrade to ASCII (logo renders as `____` instead of
    // Braille/box-drawing). Prefer the user's LANG if it's already
    // UTF-8-ful; otherwise default to en_US.UTF-8 which ships with
    // every macOS install.
    let lang = std::env::var("LANG")
        .ok()
        .filter(|v| v.to_lowercase().contains("utf"))
        .unwrap_or_else(|| "en_US.UTF-8".to_string());
    let lang_env = format!("LANG={lang}");
    let lc_all_env = format!("LC_ALL={lang}");

    if session_exists(&agent) {
        let _ = tmux_run(&["set-option", "-t", &agent, "remain-on-exit", "off"]);
        let _ = tmux_run(&["set-option", "-t", &agent, "status", "off"]);
        let _ = tmux_run(&["set-environment", "-t", &agent, "TERM", "xterm-256color"]);
        let _ = tmux_run(&["set-environment", "-t", &agent, "LANG", &lang]);
        let _ = tmux_run(&["set-environment", "-t", &agent, "LC_ALL", &lang]);
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
    builder.arg(&agent);
    builder.env("TERM", "xterm-256color");
    builder.env("LANG", &lang);
    builder.env("LC_ALL", &lang);

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
        let mut map = state.0.lock().unwrap();
        map.insert(
            agent.clone(),
            Arc::new(Mutex::new(PtyHandle {
                master: pair.master,
                writer,
                _child: child,
            })),
        );
    }

    // PTY reads are blocking — dedicated thread so we don't starve the tokio executor.
    let app_clone = app.clone();
    let agent_clone = agent.clone();
    let registry = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let b64 = B64.encode(&buf[..n]);
                    let _ = app_clone.emit(
                        &format!("pty://output/{}", agent_clone),
                        OutputPayload {
                            agent: agent_clone.clone(),
                            b64,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&format!("pty://exit/{}", agent_clone), &agent_clone);
        let mut map = registry.lock().unwrap();
        map.remove(&agent_clone);
    });

    Ok(())
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
