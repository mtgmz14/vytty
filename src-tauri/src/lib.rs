//! The Vytty window: Tauri glue around vytty-core. The UI (src/renderer) talks
//! to the backend through one command, `call(ch, args)`, with the same channel
//! names the Electron preload used ("settings:get", "conn:open", ...), and gets
//! everything else as events on one channel (see src/renderer/bridge.js).
mod commands;
mod dialogs;
mod dragdrop;
#[cfg(debug_assertions)]
mod e2e;
#[cfg(windows)]
mod win;

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager as _, WebviewUrl, WebviewWindowBuilder};
use vytty_core::conn::Manager;
use vytty_core::events::{Event, Ui};
use vytty_core::logger::Logger;
use vytty_core::paths::{Launch, Paths};
use vytty_core::store::Store;
use vytty_core::updater::Updater;
use vytty_core::vault::Vault;

pub struct App {
    pub launch: Launch,
    pub paths: Paths,
    pub store: Arc<Store>,
    pub vault: Arc<Vault>,
    pub settings: Arc<RwLock<Value>>,
    pub logger: Arc<Logger>,
    pub ui: Arc<Ui>,
    pub mgr: Arc<Manager>,
    pub updater: Arc<Updater>,
    pub channel: Arc<Mutex<Option<Channel<Event>>>>,
    pub ready: AtomicBool,
    pub pending_urls: Mutex<Vec<Value>>,
    pub allow_close: AtomicBool,
    pub maximized: AtomicBool,
    pub picked_imports: Mutex<HashSet<PathBuf>>,
    pub clipboard: Mutex<Option<arboard::Clipboard>>,
    pub e2e: Option<PathBuf>,
}

impl App {
    pub fn emit(&self, ev: Event) {
        self.ui.emit(ev)
    }

    /// ssh:// / telnet:// links: to the window when it is ready, queued before.
    pub fn open_urls(&self, list: Vec<Value>) {
        if list.is_empty() {
            return;
        }
        if self.ready.load(Ordering::SeqCst) {
            self.emit(Event::OpenUrl { list: Value::Array(list) });
        } else {
            self.pending_urls.lock().unwrap().extend(list);
        }
    }

    /// The file that ssh:// links and shortcuts start (stays valid across updates
    /// of a renamed copy; a versioned portable file changes with each update).
    pub fn link_target(&self) -> String {
        self.launch.user_file().to_string_lossy().to_string()
    }
}

fn fatal(title: &str, text: &str) -> ! {
    eprintln!("{title}: {text}");
    // Never block an unattended run (CI smoke test) on a dialog.
    #[cfg(windows)]
    if !std::env::args().any(|a| a == "--smoke-test") {
        win::message_box(title, text);
    }
    std::process::exit(2);
}

/// Started by our own updater: wait for the old process to finish, so the
/// single-instance check does not mistake it for a running copy.
fn wait_for_previous() {
    for a in std::env::args() {
        if let Some(pid) = a.strip_prefix("--vytty-wait-pid=").and_then(|p| p.parse::<u32>().ok()) {
            let end = std::time::Instant::now() + Duration::from_secs(15);
            while std::time::Instant::now() < end && process_alive(pid) {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    win::process_alive(pid)
}

#[cfg(debug_assertions)]
const DEBUG_CONSOLE: &str = r#"(() => {
  const send = (m) => { try { window.__TAURI_INTERNALS__.invoke('call', { ch: 'e2e', args: ['log', String(m)] }); } catch (_) {} };
  window.addEventListener('error', (e) => send(`page error: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => send(`page rejection: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`));
  const ce = console.error;
  console.error = (...a) => { send('console.error: ' + a.map((x) => (x && x.stack) || x).join(' ')); ce.apply(console, a); };
})();"#;
#[cfg(not(debug_assertions))]
const DEBUG_CONSOLE: &str = "";

pub fn run() {
    wait_for_previous();
    let packaged = !cfg!(debug_assertions);
    let launch = Launch::from_env(packaged);
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("data");
    let paths = Paths::new(launch.data_dir(&dev_dir));
    if let Err(e) = paths.ensure_dirs() {
        fatal("Vytty", &format!("Cannot create the data folder {}: {e}", paths.data_dir.display()));
    }
    #[cfg(windows)]
    if let Err(msg) = win::check_webview2() {
        fatal("Vytty", &msg);
    }
    let smoke = launch.smoke_test;
    let e2e: Option<PathBuf> = if cfg!(debug_assertions) { std::env::var_os("VYTTY_E2E").map(PathBuf::from) } else { None };

    let store = Arc::new(Store::new(paths.clone()));
    let settings = Arc::new(RwLock::new(store.get_settings()));
    let logger = Logger::new(paths.default_logs.clone());
    logger.configure(&settings.read().unwrap()["logging"]);
    let vault = Arc::new(Vault::new(paths.vault.clone()));
    let channel: Arc<Mutex<Option<Channel<Event>>>> = Arc::new(Mutex::new(None));
    let ch2 = channel.clone();
    let ui = Ui::new(Arc::new(move |ev: Event| {
        if let Some(c) = ch2.lock().unwrap().as_ref() {
            let _ = c.send(ev);
        }
    }));
    let mgr = Manager::new(ui.clone(), store.clone(), vault.clone(), settings.clone(), logger.clone());
    let updater = Arc::new(Updater::new(launch.clone(), paths.clone(), env!("CARGO_PKG_VERSION")));
    let first_urls = vytty_core::urlhandler::urls_from_args(&std::env::args().collect::<Vec<_>>());
    let app_state = Arc::new(App {
        launch,
        paths: paths.clone(),
        store,
        vault,
        settings,
        logger,
        ui,
        mgr,
        updater,
        channel,
        ready: AtomicBool::new(false),
        pending_urls: Mutex::new(first_urls),
        allow_close: AtomicBool::new(false),
        maximized: AtomicBool::new(false),
        picked_imports: Mutex::new(HashSet::new()),
        clipboard: Mutex::new(None),
        e2e: e2e.clone(),
    });

    let mut builder = tauri::Builder::default();
    if !smoke && e2e.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Some(st) = app.try_state::<Arc<App>>() {
                st.open_urls(vytty_core::urlhandler::urls_from_args(&argv));
            }
        }));
    }
    let state_for_setup = app_state.clone();
    let result = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![commands::call, commands::subscribe])
        .setup(move |app| {
            let st = state_for_setup.clone();
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Vytty")
                .inner_size(1360.0, 860.0)
                .min_inner_size(760.0, 480.0)
                .decorations(false)
                .visible(false)
                .background_color(tauri::window::Color(0x16, 0x17, 0x1a, 0xff))
                .data_directory(st.paths.webview.clone())
                .devtools(true);
            // Development and test builds: page errors go to the terminal.
            if cfg!(debug_assertions) {
                b = b.initialization_script(DEBUG_CONSOLE);
            }
            // HTML5 drag and drop inside the page (session tree, tabs, SFTP)
            // needs the webview's own drop handling on Windows; dropped file
            // paths come from WebView2 itself (win.rs).
            if cfg!(windows) {
                b = b.disable_drag_drop_handler();
            }
            let window = b.build()?;
            #[cfg(windows)]
            win::install_file_path_bridge(&window, st.clone());
            dragdrop::watch_native_drops(&window, st.clone());
            if st.launch.smoke_test {
                // Fails the CI job if the UI never comes up.
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_secs(60));
                    eprintln!("SMOKE FAIL: timed out waiting for the UI");
                    std::process::exit(3);
                });
            }
            if std::env::args().any(|a| a == "--devtools") {
                window.open_devtools();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(st) = window.app_handle().try_state::<Arc<App>>().map(|s| s.inner().clone()) else { return };
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if !st.allow_close.load(Ordering::SeqCst) && st.ready.load(Ordering::SeqCst) {
                        api.prevent_close();
                        st.emit(Event::CloseRequest);
                    }
                }
                tauri::WindowEvent::Resized(_) => {
                    let m = window.is_maximized().unwrap_or(false);
                    if st.maximized.swap(m, Ordering::SeqCst) != m {
                        st.emit(Event::WinState { maximized: m });
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    st.mgr.close_all();
                    st.logger.flush();
                    vytty_core::conn::sftp::cleanup_drag_temp();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|_app, _event| {}),
        Err(e) => fatal("Vytty", &format!("Could not start: {e}")),
    }
}

/// app:ready - the UI is up.
pub fn on_ready(app: &tauri::AppHandle, st: &Arc<App>) {
    if st.launch.smoke_test {
        let mode = st.updater.mode().map(|m| m.as_str()).unwrap_or("dev");
        println!("SMOKE OK {} {}", env!("CARGO_PKG_VERSION"), mode);
        let _ = std::fs::remove_dir_all(&st.paths.data_dir);
        app.exit(0);
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    if st.ready.swap(true, Ordering::SeqCst) {
        return;
    }
    let queued: Vec<Value> = std::mem::take(&mut *st.pending_urls.lock().unwrap());
    st.open_urls(queued);
    #[cfg(debug_assertions)]
    if let Some(script) = st.e2e.clone() {
        e2e::start(app, st, &script);
    }
    let up = st.updater.clone();
    let settings = st.settings.clone();
    let link = st.link_target();
    let packaged = st.launch.packaged;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        for p in up.cleanup() {
            eprintln!("[vytty] removed {}", p.display());
        }
        // Keep the link registration pointing at the current executable.
        let on = settings.read().unwrap()["integrations"]["urlHandler"].as_bool().unwrap_or(false);
        if on && packaged {
            let _ = vytty_core::urlhandler::set(true, &link, packaged);
        }
    });
}

pub fn app_info(st: &App, window: &tauri::WebviewWindow) -> Value {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        o => o,
    };
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": st.paths.data_dir,
        "logDir": st.logger.log_dir(),
        "platform": platform,
        "capabilities": { "serial": true, "local": true },
        "install": st.updater.info(),
        "systemDark": window.theme().map(|t| t == tauri::Theme::Dark).unwrap_or(true),
        "runtime": format!("Tauri {} (WebView {})", tauri::VERSION, tauri::webview_version().unwrap_or_default()),
    })
}
