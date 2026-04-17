use std::{fs, net::TcpListener, path::PathBuf, sync::Mutex};

use serde_json::json;
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::AsyncWriteExt;

struct HubState {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
}

fn target_triple() -> String {
    format!("{}-apple-darwin", std::env::consts::ARCH)
}

fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("A2AChannel")
}

fn discovery_file() -> PathBuf {
    app_data_dir().join("hub.url")
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

fn write_discovery_file(url: &str) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let target = discovery_file();
    let tmp = dir.join("hub.url.tmp");
    fs::write(&tmp, url).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &target)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), target.display()))?;
    Ok(())
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
fn get_hub_url(state: State<HubState>) -> Result<String, String> {
    state
        .url
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "hub URL not yet initialized".to_string())
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
                }
            }
        }
    });
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(HubState {
            child: Mutex::new(None),
            url: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_hub_url, get_mcp_template])
        .setup(|app| {
            let handle = app.handle().clone();

            let _ = fs::create_dir_all(logs_dir());

            let port = pick_free_port()?;
            let url = format!("http://127.0.0.1:{port}");
            println!("[setup] hub port: {port}");

            if let Err(e) = write_discovery_file(&url) {
                eprintln!("[setup] discovery file write failed: {e}");
            } else {
                println!(
                    "[setup] wrote discovery file: {}",
                    discovery_file().display()
                );
            }

            let shell = handle.shell();
            let cmd = shell
                .sidecar("hub-bin")
                .map_err(|e| format!("sidecar builder: {e}"))?
                .env("PORT", port.to_string());

            let (rx, child) = cmd.spawn().map_err(|e| format!("spawn hub-bin: {e}"))?;

            {
                let state = handle.state::<HubState>();
                *state.child.lock().unwrap() = Some(child);
                *state.url.lock().unwrap() = Some(url);
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
                let child_opt = state.child.lock().unwrap().take();
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
