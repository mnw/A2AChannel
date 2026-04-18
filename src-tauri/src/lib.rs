use std::{
    fs::{self, File},
    io::Read,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
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
    images_dir: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Clone)]
struct HubInfo {
    url: String,
    token: String,
}

#[derive(Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    images_dir: Option<String>,
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

fn token_file() -> PathBuf {
    app_data_dir().join("hub.token")
}

fn config_file() -> PathBuf {
    app_data_dir().join("config.json")
}

fn default_images_dir() -> PathBuf {
    // Top-level home directory avoids macOS TCC protections on
    // ~/Documents, ~/Desktop, ~/Downloads, ~/Pictures — otherwise the
    // agent's Read tool fails with EPERM even after `--add-dir`.
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("a2a-images")
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

// Choose the images folder (config override or default), ensure it exists.
// On first launch, write a default config.json so users can find and edit it.
fn resolve_images_dir() -> PathBuf {
    let cfg = load_config();
    let dir = cfg
        .images_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(default_images_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[setup] create images dir {} failed: {e}", dir.display());
    }
    // Seed config.json with the resolved path so it's discoverable.
    let cfg_path = config_file();
    if !cfg_path.exists() {
        let seed = json!({ "images_dir": dir.to_string_lossy() });
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
    fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    // Tighten perms before the rename so there's no window where the file is world-readable.
    chmod_0600(&tmp)?;
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
fn get_images_dir(state: State<HubState>) -> Result<String, String> {
    let guard = state.images_dir.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .clone()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "images dir not yet initialized".to_string())
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
        .manage(HubState {
            child: Mutex::new(None),
            info: Mutex::new(None),
            images_dir: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_hub_url,
            get_mcp_template,
            get_images_dir
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

            let images_dir = resolve_images_dir();
            println!("[setup] images dir: {}", images_dir.display());

            let shell = handle.shell();
            let cmd = shell
                .sidecar("a2a-bin")
                .map_err(|e| format!("sidecar builder: {e}"))?
                .env("PORT", port.to_string())
                .env("A2A_MODE", "hub")
                .env("A2A_TOKEN", &token)
                .env("A2A_IMAGES_DIR", images_dir.to_string_lossy().to_string());

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
                    .images_dir
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(images_dir);
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
