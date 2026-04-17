use std::{fs, path::PathBuf, sync::Mutex};

use serde_json::json;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::AsyncWriteExt;

const HUB_PORT: &str = "8011";

struct HubState(Mutex<Option<CommandChild>>);

fn target_triple() -> String {
    format!("{}-apple-darwin", std::env::consts::ARCH)
}

fn logs_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join("Library/Logs/A2AChannel"))
        .unwrap_or_else(|| PathBuf::from("/tmp/A2AChannel-logs"))
}

fn resolve_channel_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    // In bundled .app: Contents/MacOS/channel-bin (no triple).
    // In `tauri dev`: ./channel-bin-<triple> (triple retained).
    let plain = dir.join("channel-bin");
    if plain.exists() {
        return Ok(plain);
    }
    let with_triple = dir.join(format!("channel-bin-{}", target_triple()));
    if with_triple.exists() {
        return Ok(with_triple);
    }
    Err(format!(
        "channel-bin not found in {} (looked for 'channel-bin' and 'channel-bin-{}')",
        dir.display(),
        target_triple()
    ))
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
fn get_mcp_template() -> Result<String, String> {
    let channel_bin = resolve_channel_bin()?;
    let cfg = json!({
        "mcpServers": {
            "chatbridge": {
                "command": channel_bin.to_string_lossy(),
                "args": [],
                "env": {
                    "CHATBRIDGE_AGENT": "agent",
                    "CHATBRIDGE_HUB": format!("http://127.0.0.1:{HUB_PORT}"),
                }
            }
        }
    });
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(HubState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_mcp_template])
        .setup(|app| {
            let handle = app.handle().clone();

            let _ = fs::create_dir_all(logs_dir());

            let shell = handle.shell();
            let cmd = shell
                .sidecar("hub-bin")
                .map_err(|e| format!("sidecar builder: {e}"))?
                .env("PORT", HUB_PORT);

            let (rx, child) = cmd.spawn().map_err(|e| format!("spawn hub-bin: {e}"))?;

            {
                let state = handle.state::<HubState>();
                *state.0.lock().unwrap() = Some(child);
            }

            let log_path = logs_dir().join("hub.log");
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
                let child_opt = state.0.lock().unwrap().take();
                if let Some(child) = child_opt {
                    let _ = child.kill();
                }
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
