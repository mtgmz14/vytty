//! Native file dialogs (on a worker thread, so the window keeps painting).
use std::path::PathBuf;
use tauri::WebviewWindow;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

#[derive(Default)]
pub struct Opts {
    pub title: Option<String>,
    /// (name, extensions); an entry with "*" means any file and adds no filter.
    pub filters: Vec<(String, Vec<String>)>,
    pub directory: Option<PathBuf>,
    pub file_name: Option<String>,
}

fn builder(window: &WebviewWindow, o: &Opts) -> FileDialogBuilder<tauri::Wry> {
    let mut b = window.dialog().file().set_parent(window);
    if let Some(t) = &o.title {
        b = b.set_title(t);
    }
    for (name, exts) in &o.filters {
        if exts.iter().any(|e| e == "*") {
            continue;
        }
        let e: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        b = b.add_filter(name, &e);
    }
    if !o.filters.is_empty() && o.filters.iter().all(|(_, e)| !e.iter().any(|x| x == "*")) {
        b = b.add_filter("All files", &["*"]);
    }
    if let Some(d) = &o.directory {
        b = b.set_directory(d);
    }
    if let Some(f) = &o.file_name {
        b = b.set_file_name(f);
    }
    b
}

fn path(p: Option<tauri_plugin_dialog::FilePath>) -> Option<PathBuf> {
    p.and_then(|f| f.into_path().ok())
}

pub async fn open_file(window: &WebviewWindow, o: Opts) -> Option<PathBuf> {
    let b = builder(window, &o);
    tokio::task::spawn_blocking(move || path(b.blocking_pick_file())).await.ok().flatten()
}

pub async fn open_files(window: &WebviewWindow, o: Opts) -> Vec<PathBuf> {
    let b = builder(window, &o);
    tokio::task::spawn_blocking(move || b.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()).await.unwrap_or_default()
}

pub async fn open_dir(window: &WebviewWindow, o: Opts) -> Option<PathBuf> {
    let b = builder(window, &o);
    tokio::task::spawn_blocking(move || path(b.blocking_pick_folder())).await.ok().flatten()
}

pub async fn open_dirs(window: &WebviewWindow, o: Opts) -> Vec<PathBuf> {
    let b = builder(window, &o);
    tokio::task::spawn_blocking(move || b.blocking_pick_folders().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()).await.unwrap_or_default()
}

pub async fn save_file(window: &WebviewWindow, o: Opts) -> Option<PathBuf> {
    let b = builder(window, &o);
    tokio::task::spawn_blocking(move || path(b.blocking_save_file())).await.ok().flatten()
}
