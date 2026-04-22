// PTY bridge for the v0.7 terminal pane.
//
// Architecture (per openspec terminal-pane-pty design Decision 1+2):
//   - tmux owns the session (lives across A2AChannel quits).
//   - For each agent, we run `tmux attach-session -t <agent>` inside a PTY
//     whose master is bridged to xterm.js over Tauri events. Raw ANSI only;
//     NO `tmux -C` control mode, NO `send-keys` for interactive input.
//   - Session creation is a single chained invocation:
//         tmux new-session -A -d -s <a> -c <cwd> '<cmd>' ; set-option -t <a> remain-on-exit on
//   - Commands spawned through tmux go through `$SHELL -ic "..."` so
//     .zshrc aliases (claude is aliased by Anthropic's installer) resolve.
//     See POC_NOTES.md Finding 1.

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

// ── Agent name validation ─────────────────────────────────────────
// Mirrors hub.ts AGENT_NAME_RE: letters, digits, _.- and space, 1..64,
// first and last non-space. Re-enforced defensively here so a bypassed
// UI validator can't smuggle shell metacharacters into tmux argv.
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

// ── State ─────────────────────────────────────────────────────────
pub struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Kept so the child (`tmux attach-session`) isn't reaped while we still
    // have a reader on the master. When the tab is closed or the session
    // is killed, dropping the handle drops the child.
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry(pub Arc<Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>>);

#[derive(Serialize, Clone)]
struct OutputPayload {
    agent: String,
    b64: String,
}

// ── tmux helpers ──────────────────────────────────────────────────
fn tmux_socket_path() -> PathBuf {
    app_data_dir().join("tmux.sock")
}

// Run a bounded tmux command (no PTY; just exit-code + stdout). Used for
// new-session, set-option, list-sessions, kill-session, respawn-pane.
// Returns stdout on success, Err(stderr or exit code) on failure.
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
    // `has-session` returns exit 0 if present, 1 if absent, tmux errors on bad name.
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

// Directory where per-agent MCP config files live. 0700 on the dir; 0600
// on each file. Files are rewritten on every spawn so stale values heal.
fn mcp_configs_dir() -> PathBuf {
    app_data_dir().join("mcp-configs")
}

// Write an MCP config JSON for `agent` pointing at the bundled a2a-bin
// sidecar in channel mode. Returns the absolute path written.
//
// Per POC_NOTES.md Finding 4, this replaces the user-space `.mcp.json`
// authoring flow — claude's `--mcp-config <path>` loads this file as a
// supplementary server list. The user's own `.mcp.json` in cwd is still
// loaded (unless we add --strict-mcp-config, which we don't).
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

// Build the claude invocation for this agent. Loads the generated MCP
// config so `chatbridge` registers and channel-bin connects to the hub,
// and enables development channels (required for the
// `notifications/claude/channel` path the sidecar uses).
//
// Claude's absolute path comes from config.json (`claude_path`, defaults
// to `~/.claude/local/claude`). We do NOT source the user's `.zshrc` to
// find it — that was the biggest spawn-latency cost (1–5 s of plugin
// loading per launch). Users with non-default claude locations edit
// config.json once and click ↻.
//
// The whole string becomes the argument to `/bin/sh -c` via tmux's
// argv-join, so single-quote escaping around paths preserves spaces
// (e.g. `Application Support`).
fn claude_command(agent: &str, session_mode: Option<&str>) -> Result<String, String> {
    let cfg_path = write_mcp_config_for(agent)?;
    // Escape single-quotes in the MCP-config path defensively.
    let path_str = cfg_path.to_string_lossy().replace('\'', r"'\''");
    // Optional session-mode prefix. `--continue` = most recent conversation
    // in cwd (no arg). `--resume` = open claude's interactive session
    // picker (no arg). Claude tracks its own state under
    // ~/.claude/projects/ — A2AChannel does not persist session IDs.
    let mode_part = match session_mode {
        Some("continue") => "--continue ",
        Some("resume")   => "--resume ",
        Some(other)      => return Err(format!("invalid session_mode: {other}")),
        None             => "",
    };
    let claude_path = resolve_claude_path();
    let claude_escaped = claude_path.to_string_lossy().replace('\'', r"'\''");
    // `server:<name>` is the v2.1+ argument shape for
    // --dangerously-load-development-channels. Confirmed by inspecting
    // the user's existing claude sessions via `ps auxww`. The flag is
    // hidden from `--help` so this shape isn't documented anywhere
    // public; if claude's CLI changes it again, update here.
    Ok(format!(
        "'{claude_escaped}' {mode_part}--mcp-config '{path_str}' --dangerously-load-development-channels server:chatbridge"
    ))
}

// ── Commands ──────────────────────────────────────────────────────
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

    // Idempotent: if we already hold a handle for this agent, it means a
    // tab is already attached. Refuse rather than spawn a duplicate.
    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&agent) {
            return Err(format!("agent '{agent}' already attached"));
        }
    }

    // Claude command — absolute path to binary, parseable directly by
    // /bin/sh -c (tmux's argv-join fallback). No zsh wrapper, so no
    // .zshrc sourcing cost (was 1–5 s per spawn). See claude_command().
    let spawn_cmd = claude_command(&agent, session_mode.as_deref())?;
    let api_key = resolve_anthropic_api_key();

    if session_exists(&agent) {
        // Session outlived a prior A2AChannel instance. Do NOT run
        // `new-session -A` — with an existing session, -A devolves to
        // attach-session, which needs a TTY for the invoking client.
        // Our Rust shell has no controlling TTY, so it fails with
        // "open terminal failed: not a terminal".
        //
        // Force `remain-on-exit off` on every attach — sessions created
        // by older A2AChannel builds (v0.7-alpha) had it ON, which
        // holds the pane after claude exits and prevents pty://exit
        // from firing. Also hide tmux's default status bar since the
        // A2AChannel tab already labels the session.
        let _ = tmux_run(&["set-option", "-t", &agent, "remain-on-exit", "off"]);
        let _ = tmux_run(&["set-option", "-t", &agent, "status", "off"]);
    } else {
        // Fresh create. `-x 80 -y 24` is load-bearing: without explicit
        // dimensions, tmux tries to probe the invoking terminal's size
        // via TIOCGWINSZ. No TTY → "open terminal failed: not a
        // terminal". Dimensions are just defaults — the PTY we attach
        // below will SIGWINCH tmux to the real xterm size immediately.
        //
        // NOTE: no `remain-on-exit` — when claude exits (via /exit,
        // crash, or graceful shutdown from the ×/kill path), the pane
        // exits, the session dies, and the UI's pty://exit handler
        // removes the tab. Cleaner than the held-pane + Restart UX.
        // `spawn_cmd` is passed as a SINGLE argv element so tmux
        // doesn't split it on whitespace when joining argv for
        // /bin/sh -c. API key (if configured) goes through tmux's
        // `-e` session-env flag so processes in the session inherit
        // it; we don't touch `.zshrc`.
        let api_env = api_key
            .as_ref()
            .map(|k| format!("ANTHROPIC_API_KEY={k}"));
        let mut args: Vec<&str> = vec!["new-session", "-d", "-s", &agent];
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
        // Hide the default tmux status bar — redundant with the
        // A2AChannel tab label and costs a row.
        let _ = tmux_run(&["set-option", "-t", &agent, "status", "off"]);
    }

    // Now attach via a PTY we own. This is the xterm-facing side.
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
    // xterm.js advertises itself as xterm-256color; declare it here so
    // tmux (and anything claude spawns via Bash) has a valid terminfo
    // entry. Without this, users whose shell config doesn't export TERM
    // see `open terminal failed: terminal does not support clear`.
    builder.env("TERM", "xterm-256color");

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

    // Blocking reader on a dedicated thread (PTY reads would starve the
    // tokio executor). Emits base64-encoded chunks; on EOF, emits exit and
    // drops the handle.
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

// Dispose the whole tmux session. The PTY reader loop will detect EOF on
// the attach client's stdout, emit pty://exit, and drop the handle from
// the registry. Semantically distinct from restart.
#[tauri::command]
pub fn pty_kill(agent: String) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }
    tmux_run(&["kill-session", "-t", &agent])?;
    Ok(())
}

// Return the set of tmux sessions currently on our socket. Filter to
// valid agent names so a stray session with unusual characters doesn't
// leak into the UI tab strip.
#[tauri::command]
pub fn pty_list() -> Result<Vec<String>, String> {
    // list-sessions returns exit 1 when no sessions exist — treat as empty.
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let out = Command::new(tmux)
        .arg("-S")
        .arg(sock)
        .args(["list-sessions", "-F", "#S"])
        .output()
        .map_err(|e| format!("tmux list-sessions spawn: {e}"))?;
    if !out.status.success() {
        // "no server running" is exit 1 with stderr noise; return [].
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
