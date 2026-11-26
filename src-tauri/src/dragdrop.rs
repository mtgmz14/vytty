//! Files in and out of the window.
//!
//! Out (SFTP panel -> file manager): small files are downloaded while the
//! mouse is pressed and dragged as real files; large ones as empty
//! placeholders whose drop target is then found by watching the user's
//! folders (vytty_core::dragout), with the download going straight there.
//!
//! In (file manager -> SFTP panel / terminal): on Linux the window reports
//! dropped paths itself and they are handed to the page; on Windows the page
//! asks WebView2 for the paths of the dropped File objects (win.rs).
use crate::App;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, WebviewWindow};
use vytty_core::events::Event;

const ICON: &[u8] = include_bytes!("../icons/32x32.png");

fn native_drag(app: &AppHandle, window: &WebviewWindow, files: Vec<std::path::PathBuf>, done: impl FnOnce(bool) + Send + 'static) {
    let w = window.clone();
    let done = std::sync::Mutex::new(Some(done));
    let _ = app.run_on_main_thread(move || {
        let finish = move |r: drag::DragResult, _pos: drag::CursorPosition| {
            if let Some(f) = done.lock().unwrap().take() {
                f(matches!(r, drag::DragResult::Dropped));
            }
        };
        #[cfg(target_os = "linux")]
        let res = match w.gtk_window() {
            Ok(gw) => drag::start_drag(&gw, drag::DragItem::Files(files), drag::Image::Raw(ICON.to_vec()), finish, drag::Options::default()),
            Err(_) => return,
        };
        #[cfg(not(target_os = "linux"))]
        let res = drag::start_drag(&w, drag::DragItem::Files(files), drag::Image::Raw(ICON.to_vec()), finish, drag::Options::default());
        if let Err(e) = res {
            eprintln!("[vytty] drag failed: {e}");
        }
    });
}

/// sftp:startDrag - `deferred` drags placeholders (large files, folders).
pub fn start(app: &AppHandle, window: &WebviewWindow, st: &Arc<App>, id: String, items: Vec<Value>, deferred: bool) {
    let app = app.clone();
    let window = window.clone();
    let st = st.clone();
    tauri::async_runtime::spawn(async move {
        if !deferred {
            match st.mgr.prepare_drag(&id, &items).await {
                Ok(files) => native_drag(&app, &window, files.into_iter().map(Into::into).collect(), |_| {}),
                Err(e) => st.emit(Event::SftpError { message: e.to_string() }),
            }
            return;
        }
        let ph = match vytty_core::dragout::make_placeholders(&items) {
            Ok(p) => p,
            Err(e) => {
                st.emit(Event::SftpError { message: e.to_string() });
                return;
            }
        };
        let since = SystemTime::now();
        let home = dirs_home();
        // Watch the user's folders before the drag starts, so the drop is seen.
        let watch = vytty_core::dragout::watch_drop(&items[0], since, &home);
        let (tx, rx) = tokio::sync::oneshot::channel();
        native_drag(&app, &window, ph.files.clone(), move |dropped| {
            let _ = tx.send(dropped);
        });
        let dropped = rx.await.unwrap_or(true);
        let dest = if dropped { watch.result(Duration::from_secs(4)).await } else { None };
        let _ = std::fs::remove_dir_all(&ph.dir);
        let Some(dest) = dest else {
            if dropped {
                st.emit(Event::DragResult { r: json!({ "ok": false, "unknown": true, "items": items, "id": id }) });
            }
            return;
        };
        st.emit(Event::DragResult { r: json!({ "started": true, "dest": dest, "count": items.len(), "id": id }) });
        match st.mgr.sftp_op(&id, "downloadPaths", &json!({ "items": items, "localDir": dest })).await {
            Ok(_) => st.emit(Event::DragResult { r: json!({ "ok": true, "dest": dest, "count": items.len(), "id": id }) }),
            Err(e) => st.emit(Event::DragResult { r: json!({ "ok": false, "dest": dest, "error": e.to_string(), "id": id }) }),
        }
    });
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into).unwrap_or_default()
}

/// Linux / macOS: the window reports dropped files with their paths.
pub fn watch_native_drops(window: &WebviewWindow, st: Arc<App>) {
    let w = window.clone();
    window.on_window_event(move |ev| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = ev {
            let scale = w.scale_factor().unwrap_or(1.0);
            let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
            st.emit(Event::FileDrop { paths, x: position.x / scale, y: position.y / scale });
        }
    });
}
