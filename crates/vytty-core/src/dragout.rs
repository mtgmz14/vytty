//! Deferred drag-out for large remote files (the WinSCP trick).
//! A file can only be dragged out of the window once it exists on disk, and a
//! big file cannot be downloaded while the user holds the mouse. So we drag
//! empty placeholders with the real names from a unique temp folder. The file
//! manager copies them to wherever the user drops; we then find where they
//! landed and download the real content straight into them.
//!
//! Finding the drop uses file system notifications only (the user's folders
//! are watched while the drag is in progress). No helper processes: earlier
//! versions asked a hidden PowerShell for the open Explorer folders, which
//! endpoint protection rightly treats as suspicious.
use crate::conn::sftp::drag_root;
use crate::util::s;
use anyhow::Result;
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// Profile folders that are never a drop target and are busy enough to flood
/// a recursive watcher (browser caches live in AppData).
const SKIP_DIRS: [&str; 8] = ["appdata", "application data", "local settings", "node_modules", "scoop", "go", "miniconda3", "anaconda3"];

pub struct Placeholders {
    pub dir: PathBuf,
    pub files: Vec<PathBuf>,
}

fn remote_name(item: &Value) -> String {
    let p = s(item.get("path"));
    p.rsplit('/').find(|x| !x.is_empty()).unwrap_or("file").to_string()
}

/// 0-byte files (or empty folders) named like the remote items.
pub fn make_placeholders(items: &[Value]) -> Result<Placeholders> {
    let dir = drag_root().join(format!("d-{}", hex::encode(crate::util::random_bytes::<6>())));
    std::fs::create_dir_all(&dir)?;
    let mut files = vec![];
    for it in items {
        let name = remote_name(it);
        if name == ".." || name == "." || name.contains(['\\', '/']) {
            anyhow::bail!("Unsafe file name {name}");
        }
        let p = dir.join(&name);
        if crate::util::truthy(it.get("isDir")) {
            std::fs::create_dir_all(&p)?;
        } else {
            std::fs::write(&p, b"")?;
        }
        files.push(p);
    }
    Ok(Placeholders { dir, files })
}

/// The well-known folders a drop most likely lands in.
pub fn known_dirs(home: &Path) -> Vec<PathBuf> {
    let mut out = vec![home.join("Desktop"), home.join("Downloads"), home.join("Documents"), home.join("OneDrive").join("Desktop")];
    for v in ["OneDrive", "OneDriveCommercial"] {
        if let Some(d) = std::env::var_os(v) {
            let d = PathBuf::from(d);
            out.push(d.join("Desktop"));
            out.push(d);
        }
    }
    if let Some(p) = std::env::var_os("PUBLIC") {
        out.push(PathBuf::from(p).join("Desktop"));
    }
    let mut seen = HashSet::new();
    out.retain(|d| seen.insert(d.clone()));
    out
}

/// (dir, recursive) pairs to watch. On Windows and macOS recursive watching is
/// one kernel subscription per folder, so every top-level folder of the
/// profile (except AppData & co.) is covered. On Linux it walks the whole
/// tree, so only the known folders are used.
pub fn watch_targets(home: &Path, recursive_ok: bool) -> Vec<(PathBuf, bool)> {
    let mut targets = vec![(home.to_path_buf(), false)];
    if recursive_ok {
        if let Ok(rd) = std::fs::read_dir(home) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if !is_dir || name.starts_with('.') || SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
                    continue;
                }
                targets.push((e.path(), true));
            }
        }
    }
    for d in known_dirs(home) {
        let covered = targets.iter().any(|(t, rec)| *t == d || (*rec && d.starts_with(t)));
        if !covered {
            targets.push((d, false));
        }
    }
    targets.retain(|(d, _)| d.is_dir());
    targets
}

/// A dropped copy: same name, still empty, created after the drag started.
pub fn is_placeholder(p: &Path, is_dir: bool, since: SystemTime) -> bool {
    let Ok(md) = std::fs::metadata(p) else { return false };
    let newest = [md.created().ok(), md.modified().ok()].into_iter().flatten().max();
    let limit = since.checked_sub(Duration::from_secs(2)).unwrap_or(since);
    if newest.map(|t| t < limit).unwrap_or(true) {
        return false;
    }
    if is_dir {
        md.is_dir() && std::fs::read_dir(p).map(|mut r| r.next().is_none()).unwrap_or(false)
    } else {
        md.is_file() && md.len() == 0
    }
}

pub struct DropWatch {
    _watchers: Vec<notify::RecommendedWatcher>,
    found: Arc<Mutex<Option<PathBuf>>>,
    name: String,
    is_dir: bool,
    since: SystemTime,
    home: PathBuf,
}

/// Starts watching before the drag begins.
pub fn watch_drop(first: &Value, since: SystemTime, home: &Path) -> DropWatch {
    let name = remote_name(first);
    let is_dir = crate::util::truthy(first.get("isDir"));
    let found: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let root = drag_root();
    let mut watchers = vec![];
    for (dir, recursive) in watch_targets(home, cfg!(any(windows, target_os = "macos"))) {
        let f = found.clone();
        let n = name.clone();
        let r = root.clone();
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            for p in ev.paths {
                if p.file_name().map(|x| x.to_string_lossy() == n).unwrap_or(false) && !p.starts_with(&r) && f.lock().unwrap().is_none() && is_placeholder(&p, is_dir, since) {
                    *f.lock().unwrap() = p.parent().map(Path::to_path_buf);
                }
            }
        };
        if let Ok(mut w) = notify::recommended_watcher(handler) {
            if w.watch(&dir, if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive }).is_ok() {
                watchers.push(w);
            }
        }
    }
    DropWatch { _watchers: watchers, found, name, is_dir, since, home: home.to_path_buf() }
}

impl DropWatch {
    fn poll(&self) -> Option<PathBuf> {
        let limit = self.since.checked_sub(Duration::from_secs(2)).unwrap_or(self.since);
        for d in known_dirs(&self.home) {
            let p = d.join(&self.name);
            if is_placeholder(&p, self.is_dir, self.since) {
                return Some(d);
            }
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let sub = e.path();
                let recent = std::fs::metadata(&sub).and_then(|m| m.modified()).map(|t| t >= limit).unwrap_or(false);
                if sub.is_dir() && recent && is_placeholder(&sub.join(&self.name), self.is_dir, self.since) {
                    return Some(sub);
                }
            }
        }
        None
    }

    /// The folder the first item was dropped into, or None. The file manager
    /// copies asynchronously, so this keeps looking for a few seconds after
    /// the drop, polling the known folders as a fallback.
    pub async fn result(self, timeout: Duration) -> Option<PathBuf> {
        let end = std::time::Instant::now() + timeout;
        loop {
            if let Some(f) = self.found.lock().unwrap().clone() {
                return Some(f);
            }
            if let Some(f) = self.poll() {
                return Some(f);
            }
            if std::time::Instant::now() >= end {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn finds_where_a_placeholder_was_dropped() {
        let home = std::env::temp_dir().join(format!("vytty-drop-{}", crate::util::uid()));
        std::fs::create_dir_all(home.join("Desktop/project")).unwrap();
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        let item = json!({ "path": "/var/log/big.tar.gz", "isDir": false });
        let ph = make_placeholders(std::slice::from_ref(&item)).unwrap();
        assert_eq!(std::fs::metadata(&ph.files[0]).unwrap().len(), 0);
        let since = SystemTime::now();
        let watch = watch_drop(&item, since, &home);
        let target = home.join("Desktop/project");
        let t2 = target.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::write(t2.join("big.tar.gz"), b"").unwrap();
        });
        assert_eq!(watch.result(Duration::from_secs(4)).await, Some(target));
        // A file that was there before the drag is not a drop.
        std::fs::write(home.join("Downloads/old.bin"), b"").unwrap();
        let later = SystemTime::now() + Duration::from_secs(10);
        assert!(!is_placeholder(&home.join("Downloads/old.bin"), false, later));
        let _ = std::fs::remove_dir_all(&ph.dir);
        let _ = std::fs::remove_dir_all(home);
    }
}
