// Cockpit's WebKit shell. It owns one thing the Node server cannot: the native window.
//
//   launch  -> start the bundled Node running host/sidecar.cjs, with its own state folder
//   ready   -> open the window at the sidecar's one-time entry URL; the server answers it with
//              the window key as an HttpOnly cookie (server/http/window-entry.ts)
//   events  -> sidecar stdout "@@cockpit {…}" lines become page events (preview-open, …)
//   quit    -> ask the sidecar to stop every agent and process, wait for it, then exit
//
// The page talks to the server over HTTP/SSE exactly as in Electron. The only native calls it
// gets are the commands below, granted at run time to the server's exact origin and nothing else.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::Color;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, RunEvent, Theme, TitleBarStyle, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

const CONTROL: &str = "@@cockpit ";
// Keep in step with --canvas-app in web/src/styles/tokens.css so the window never flashes.
const CANVAS_LIGHT: Color = Color(0xfa, 0xfa, 0xf9, 0xff);
const CANVAS_DARK: Color = Color(0x20, 0x20, 0x20, 0xff);
// The sidecar's own grace is 5 s (src-tauri/host/sidecar.ts); this only covers a hung sidecar.
const STOP_WAIT: Duration = Duration::from_secs(8);

#[derive(Default)]
struct Sidecar {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    origin: Option<String>,
}

struct Shell(Mutex<Sidecar>);

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn set_theme(app: AppHandle, mode: String) {
    let theme = match mode.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(theme);
    }
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    if text.len() > 2_000_000 {
        return Err("Too much text to copy".into());
    }
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("pbcopy has no input")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// The system folder chooser, attached to Cockpit. None when cancelled.
#[tauri::command]
async fn pick_folder() -> Option<String> {
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", "POSIX path of (choose folder with prompt \"Choose a project folder\")"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8(output.stdout).ok()?;
    let path = path.trim().trim_end_matches('/');
    (!path.is_empty()).then(|| path.to_string())
}

/// The candidate keeps its own state unless COCKPIT_HOME says otherwise, so it can never write
/// to the installed app's conversations (~/.agent-cockpit) at the same time.
fn state_root(app: &AppHandle) -> PathBuf {
    if let Some(home) = std::env::var_os("COCKPIT_HOME") {
        return PathBuf::from(home);
    }
    app.path()
        .app_data_dir()
        .expect("an app data folder")
        .join("state")
}

fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let node = exe.parent().ok_or("no executable folder")?.join("node");
    let host = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("host");
    let mut child = Command::new(&node)
        .arg(host.join("sidecar.cjs"))
        .env("COCKPIT_HOME", state_root(app))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("sidecar has no output")?;
    {
        let shell = app.state::<Shell>();
        let mut sidecar = shell.0.lock().unwrap();
        sidecar.stdin = child.stdin.take();
        sidecar.child = Some(child);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match line.strip_prefix(CONTROL) {
                Some(json) => match serde_json::from_str::<Value>(json) {
                    Ok(message) => on_message(&app, message),
                    Err(error) => eprintln!("[cockpit-shell] unreadable control line: {error}"),
                },
                // Ordinary server logging; the control lines (which carry the entry token) are never echoed.
                None => println!("{line}"),
            }
        }
        // Output closed: the sidecar has exited. Without a server the window is useless.
        app.exit(0);
    });
    Ok(())
}

fn on_message(app: &AppHandle, message: Value) {
    match message["type"].as_str() {
        Some("ready") => {
            let (Some(url), Some(entry)) = (message["url"].as_str(), message["entry"].as_str()) else {
                return;
            };
            let app = app.clone();
            let url = url.to_string();
            let entry = entry.to_string();
            let handle = app.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Err(error) = open_window(&app, &url, &entry) {
                    eprintln!("[cockpit-shell] window: {error}");
                    app.exit(1);
                }
            });
        }
        Some("preview-open") => {
            let _ = app.emit_to("main", "cockpit:preview-open", message["preview"].clone());
        }
        Some("failed") => {
            eprintln!("[cockpit-shell] server did not start: {}", message["message"]);
        }
        _ => {}
    }
}

fn open_window(app: &AppHandle, url: &str, entry: &str) -> Result<(), String> {
    let origin = url::Url::parse(url).map_err(|e| e.to_string())?;
    let origin_text = origin.origin().ascii_serialization();
    app.state::<Shell>().0.lock().unwrap().origin = Some(origin_text.clone());
    // The native calls, for the server's exact origin only: not a preview on another local port.
    app.add_capability(
        CapabilityBuilder::new("cockpit-window")
            .window("main")
            .remote(format!("{origin_text}/*"))
            .permission("core:event:default")
            .permission("allow-app-version")
            .permission("allow-set-theme")
            .permission("allow-copy-text")
            .permission("allow-pick-folder"),
    )
    .map_err(|e| e.to_string())?;

    let entry_url = format!("{origin_text}/__cockpit/enter?t={entry}");
    let dark = app
        .get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .map(|t| t == Theme::Dark)
        .unwrap_or(false);
    let allowed = origin_text.clone();
    let window = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(entry_url.parse().map_err(|e: url::ParseError| e.to_string())?),
    )
    .title("Cockpit")
    .inner_size(1360.0, 860.0)
    .min_inner_size(980.0, 640.0)
    .title_bar_style(TitleBarStyle::Overlay)
    .hidden_title(true)
    .traffic_light_position(LogicalPosition::new(16.0, 16.0))
    .background_color(if dark { CANVAS_DARK } else { CANVAS_LIGHT })
    // Anything that is not Cockpit's own page opens in the default browser, never in the window.
    .on_navigation(move |target| {
        if target.origin().ascii_serialization() == allowed {
            return true;
        }
        if matches!(target.scheme(), "http" | "https") {
            let _ = Command::new("/usr/bin/open").arg(target.as_str()).spawn();
        }
        false
    })
    .build()
    .map_err(|e| e.to_string())?;

    let events = window.clone();
    window.on_window_event(move |event| match event {
        // macOS convention: closing the window keeps Cockpit (and running agents) alive.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = events.hide();
        }
        // The page drops the room it keeps for the window buttons while they are hidden.
        WindowEvent::Resized(_) => {
            let full = events.is_fullscreen().unwrap_or(false);
            let _ = events.emit("cockpit:full-screen", full);
        }
        _ => {}
    });
    Ok(())
}

/// Asks the sidecar to stop (it stops every agent and process first), then waits for it.
fn stop_sidecar(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let mut sidecar = shell.0.lock().unwrap();
    if let Some(mut stdin) = sidecar.stdin.take() {
        let _ = stdin.write_all(b"{\"type\":\"quit\"}\n");
        // Dropping stdin closes the pipe as well, which the sidecar also treats as quit.
    }
    if let Some(mut child) = sidecar.child.take() {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < STOP_WAIT => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    eprintln!("[cockpit-shell] server did not stop in time; ending it");
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Shell(Mutex::new(Sidecar::default())))
        .invoke_handler(tauri::generate_handler![app_version, set_theme, copy_text, pick_folder])
        .setup(|app| {
            start_sidecar(app.handle()).map_err(|e| e.into())
        })
        .build(tauri::generate_context!())
        .expect("Cockpit could not start");

    app.run(|app, event| match event {
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        RunEvent::Exit => stop_sidecar(app),
        _ => {}
    });
}
