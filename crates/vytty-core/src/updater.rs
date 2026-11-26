//! Updates from GitHub releases.
//!
//! Every download is checked against SHA256SUMS.txt, whose Ed25519 signature
//! must match a key built into the app. No helper processes, no installer:
//! Vytty is one executable. A versioned file (Vytty-0.11.0-portable.exe,
//! Vytty-0.11.0.AppImage) gets the new version saved next to it, started, and
//! the old file removed only after the new one has started; a renamed copy
//! (Vytty.exe from the zip) is swapped in place (the running file is renamed
//! aside, which Windows allows). "Notify only" in the settings never downloads.
//!
//! Also tidies up after updates from the Electron versions (0.10 and older):
//! the old portable .exe, the Electron files of an updated zip folder, the
//! launcher's unpacked copies in %LOCALAPPDATA%\Vytty\app and the old
//! browser profile. Only files that are recognisably ours are ever deleted.
use crate::paths::{InstallMode, Launch, Paths};
use crate::update_verify as v;
use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;

pub const REPO: &str = "mtgmz14/vytty";
pub const RELEASES_URL: &str = "https://github.com/mtgmz14/vytty/releases";
const OLD: &str = ".vytty-old";
const STAGING: &str = ".vytty-update";
const CLEANUP_MARK: &str = ".vytty-cleanup";

#[derive(Clone, Debug)]
struct Latest {
    version: String,
    asset: Option<(String, String, u64)>,
    sums: Option<String>,
    sig: Option<String>,
    can_install: bool,
}

#[derive(Clone, Debug)]
struct Prepared {
    file: PathBuf,
    target: PathBuf,
    side_by_side: bool,
    version: String,
    mode: InstallMode,
}

pub struct Updater {
    launch: Launch,
    paths: Paths,
    version: String,
    keys: Vec<String>,
    latest: Mutex<Option<Latest>>,
    prepared: Mutex<Option<Prepared>>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    base_url: String,
    api_url: String,
}

/// What `install` asks the app to do: start this file, then quit.
pub struct Relaunch {
    pub exe: PathBuf,
}

impl Updater {
    pub fn new(launch: Launch, paths: Paths, version: &str) -> Self {
        Updater {
            launch,
            paths,
            version: version.to_string(),
            keys: v::trusted_keys(),
            latest: Mutex::new(None),
            prepared: Mutex::new(None),
            cancel: Mutex::new(None),
            base_url: RELEASES_URL.into(),
            api_url: format!("https://api.github.com/repos/{REPO}/releases/latest"),
        }
    }

    /// Tests: a fake GitHub and other trusted keys.
    pub fn with_endpoints(mut self, api_url: &str, base_url: &str, keys: Vec<String>) -> Self {
        self.api_url = api_url.into();
        self.base_url = base_url.into();
        self.keys = keys;
        self
    }

    pub fn mode(&self) -> Option<InstallMode> {
        self.launch.install_mode()
    }

    fn self_updating(&self) -> bool {
        matches!(self.mode(), Some(InstallMode::Portable | InstallMode::Folder | InstallMode::AppImage))
    }

    pub fn info(&self) -> Value {
        json!({ "mode": self.mode().map(|m| m.as_str()), "selfUpdate": self.self_updating(), "signingKeys": self.keys.len() })
    }

    /// Why this copy cannot install an update itself (shown in the update dialog).
    fn manual_reason(&self) -> String {
        match self.mode() {
            Some(InstallMode::Winget) => "This copy was installed with winget. Update it with: winget upgrade mtgmz14.Vytty".into(),
            None => "This copy cannot update itself (it is not a packaged release build).".into(),
            _ => String::new(),
        }
    }

    /// The release asset this copy updates from: on Windows always the single
    /// .exe (the zip holds the same file), on Linux the AppImage.
    fn asset_kind(&self) -> Option<&'static str> {
        match self.mode()? {
            InstallMode::Portable | InstallMode::Folder => Some("portable"),
            InstallMode::AppImage => Some("appimage"),
            InstallMode::Winget => None,
        }
    }

    /// The GitHub API allows 60 unauthenticated requests per hour per IP, which
    /// an office behind one NAT can use up. The release page redirect has no
    /// such limit; asset URLs follow the fixed naming scheme.
    async fn release_from_redirect(&self) -> Result<Value> {
        let res = crate::http::client().head(format!("{}/latest", self.base_url)).send().await?;
        let url = res.url().to_string();
        let tag = url.split("/releases/tag/").nth(1).map(|t| t.trim_end_matches('/').to_string()).filter(|t| !t.is_empty());
        let Some(tag) = tag else { bail!("Could not determine the latest release ({})", res.status().as_u16()) };
        let tag = percent_encoding::percent_decode_str(&tag).decode_utf8_lossy().to_string();
        let ver = tag.trim_start_matches(['v', 'V']).to_string();
        let asset = |name: String| json!({ "name": name, "browser_download_url": format!("{}/download/{tag}/{name}", self.base_url), "size": 0 });
        let mut assets: Vec<Value> = ["portable", "folder", "appimage"].iter().filter_map(|m| v::asset_name_for(m, &ver)).map(asset).collect();
        assets.push(asset(v::SUMS_NAME.into()));
        assets.push(asset(v::SIG_NAME.into()));
        Ok(json!({ "tag_name": tag, "html_url": format!("{}/tag/{tag}", self.base_url), "body": "", "assets": assets }))
    }

    pub async fn check(&self) -> Result<Value> {
        let res = crate::http::client().get(&self.api_url).header("Accept", "application/vnd.github+json").send().await.map_err(|e| anyhow!("Could not reach GitHub: {e}"))?;
        let status = res.status().as_u16();
        let rel: Value = match status {
            200..=299 => res.json().await?,
            403 | 429 => self.release_from_redirect().await?,
            _ => bail!("GitHub returned {status}"),
        };
        let version = crate::util::s(rel.get("tag_name")).trim_start_matches(['v', 'V']).to_string();
        let assets = rel.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let find = |name: &str| assets.iter().find(|a| crate::util::s(a.get("name")) == name).map(|a| crate::util::s(a.get("browser_download_url")));
        let asset = self.asset_kind().and_then(|k| v::asset_name_for(k, &version)).and_then(|name| {
            assets.iter().find(|a| crate::util::s(a.get("name")) == name).map(|a| (name, crate::util::s(a.get("browser_download_url")), a.get("size").and_then(|x| x.as_u64()).unwrap_or(0)))
        });
        let sums = find(v::SUMS_NAME);
        let sig = find(v::SIG_NAME);
        let mut reason = self.manual_reason();
        if reason.is_empty() && asset.is_none() {
            reason = "The release has no download for this kind of installation.".into();
        }
        if reason.is_empty() && self.keys.is_empty() {
            reason = "This build cannot verify updates.".into();
        }
        if reason.is_empty() && (sums.is_none() || sig.is_none()) {
            reason = "The release is not signed for automatic updates. Download it from GitHub instead.".into();
        }
        let can_install = reason.is_empty();
        let out = json!({
            "available": v::newer(&version, &self.version),
            "current": self.version,
            "version": version,
            "notes": crate::util::s(rel.get("body")),
            "page": rel.get("html_url").and_then(|u| u.as_str()).unwrap_or(RELEASES_URL),
            "mode": self.mode().map(|m| m.as_str()),
            "asset": asset.as_ref().map(|(n, u, s)| json!({ "name": n, "url": u, "size": s })),
            "sums": sums,
            "sig": sig,
            "canInstall": can_install,
            "reason": reason,
        });
        *self.latest.lock().unwrap() = Some(Latest { version, asset, sums, sig, can_install });
        Ok(out)
    }

    pub fn cancel(&self) {
        if let Some(c) = self.cancel.lock().unwrap().as_ref() {
            c.store(true, Ordering::SeqCst);
        }
    }

    async fn fetch_text(url: &str) -> Result<String> {
        let res = crate::http::client().get(url).send().await?;
        if !res.status().is_success() {
            bail!("Download of {} failed ({})", url.rsplit('/').next().unwrap_or(url), res.status().as_u16());
        }
        Ok(res.text().await?)
    }

    /// Downloads and verifies the update; `progress(got, total, phase)`.
    pub async fn download(&self, progress: impl Fn(u64, u64, &str)) -> Result<String> {
        let latest = self.latest.lock().unwrap().clone().filter(|l| l.can_install).ok_or_else(|| anyhow!("No update to download"))?;
        let mode = self.mode().ok_or_else(|| anyhow!("No update to download"))?;
        let (name, url, size) = latest.asset.clone().ok_or_else(|| anyhow!("No update to download"))?;
        let cancel = Arc::new(AtomicBool::new(false));
        *self.cancel.lock().unwrap() = Some(cancel.clone());
        let target = self.launch.user_file();
        let dir = target.parent().map(Path::to_path_buf).ok_or_else(|| anyhow!("No folder for {}", target.display()))?;
        let part = dir.join(format!("{name}.download"));
        let result = async {
            // 1. The signed checksum list decides what we accept.
            let (sums_text, signature) = tokio::try_join!(Self::fetch_text(latest.sums.as_deref().unwrap()), Self::fetch_text(latest.sig.as_deref().unwrap()))?;
            let expected = v::expected_hash(&sums_text, &signature, &self.keys, &name, &latest.version)?;
            // 2. Download next to the target (same volume, so the last step is a rename).
            let res = crate::http::client().get(&url).send().await?;
            if !res.status().is_success() {
                bail!("Download failed ({})", res.status().as_u16());
            }
            let total = res.content_length().unwrap_or(size);
            let mut out = tokio::fs::File::create(&part).await.map_err(|e| no_access(&dir, e))?;
            let mut hash = Sha256::new();
            let mut got = 0u64;
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if cancel.load(Ordering::SeqCst) {
                    bail!("Download cancelled");
                }
                let chunk = chunk?;
                hash.update(&chunk);
                out.write_all(&chunk).await?;
                got += chunk.len() as u64;
                progress(got, total, "download");
            }
            out.flush().await?;
            out.sync_all().await.ok();
            drop(out);
            // 3. Must be exactly the file the release signed.
            progress(got, total, "verify");
            if hex::encode(hash.finalize()) != expected {
                bail!("The downloaded file does not match the signed checksum - not installed");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))?;
            }
            // A versioned name gets the new version's name next to it; a renamed
            // copy ("Vytty.exe", used by shortcuts) keeps its name.
            let file_name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let side_by_side = v::is_old_build_name(&file_name);
            let dest = if side_by_side { dir.join(&name) } else { PathBuf::from(format!("{}.new", target.display())) };
            let _ = std::fs::remove_file(&dest);
            crate::util::rename_retry(&part, &dest)?;
            *self.prepared.lock().unwrap() = Some(Prepared { file: dest, target: target.clone(), side_by_side, version: latest.version.clone(), mode });
            Ok(latest.version.clone())
        }
        .await;
        *self.cancel.lock().unwrap() = None;
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        result
    }

    fn write_state(&self, state: Value) {
        let mut s = state;
        s["from_version"] = json!(self.version);
        s["at"] = json!(chrono::Utc::now().to_rfc3339());
        let _ = crate::util::write_json(&self.paths.update_state, &s);
    }

    /// Arranges the switch to the new version; the caller starts `exe` and quits.
    pub fn install(&self) -> Result<Relaunch> {
        let p = self.prepared.lock().unwrap().clone().ok_or_else(|| anyhow!("Nothing prepared"))?;
        if p.side_by_side {
            self.write_state(json!({ "mode": p.mode.as_str(), "from": p.target, "to": p.file, "version": p.version }));
            return Ok(Relaunch { exe: p.file });
        }
        let old = PathBuf::from(format!("{}{OLD}", p.target.display()));
        let _ = std::fs::remove_file(&old);
        crate::util::rename_retry(&p.target, &old)?;
        if let Err(e) = crate::util::rename_retry(&p.file, &p.target) {
            let _ = crate::util::rename_retry(&old, &p.target);
            bail!("Could not replace {}: {e}", p.target.display());
        }
        if let Some(dir) = p.target.parent() {
            let _ = std::fs::write(dir.join(CLEANUP_MARK), &p.version);
        }
        self.write_state(json!({ "mode": p.mode.as_str(), "from": old, "to": p.target, "version": p.version }));
        Ok(Relaunch { exe: p.target })
    }

    /// A few seconds after a successful start: removes what the previous
    /// version left behind. Returns what was removed (for the log and tests).
    pub fn cleanup(&self) -> Vec<PathBuf> {
        let mut removed = vec![];
        let Some(mode) = self.mode() else { return removed };
        let current = self.launch.user_file();
        let dir = current.parent().map(Path::to_path_buf).unwrap_or_default();
        let state = crate::util::read_json(&self.paths.update_state);
        if let Some(st) = &state {
            let same_version = crate::util::s(st.get("version")) == self.version;
            let from = crate::util::s(st.get("from"));
            if same_version && !from.is_empty() {
                let from = PathBuf::from(&from);
                let from_name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let same_dir = from.parent().map(|d| same_path(d, &dir)).unwrap_or(false);
                let ours = v::is_old_build_name(&from_name) || from_name.ends_with(OLD);
                if same_dir && ours && !same_path(&from, &current) && remove_file(&from) {
                    removed.push(from);
                }
            }
            if same_version {
                let _ = std::fs::remove_file(&self.paths.update_state);
            }
        }
        // Left-overs next to the executable.
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            let abandoned = name.starts_with("Vytty-")
                && name.ends_with(".download")
                && std::fs::metadata(&p).and_then(|m| m.modified()).map(|t| SystemTime::now().duration_since(t).unwrap_or_default() > Duration::from_secs(86400)).unwrap_or(false);
            if (name.ends_with(OLD) || abandoned) && p.is_file() && remove_file(&p) {
                removed.push(p);
            }
        }
        // An updated zip folder (also one updated by Vytty 0.10's updater).
        let mark = dir.join(CLEANUP_MARK);
        if mark.exists() {
            if mode == InstallMode::Folder && dir.join("resources").join("app.asar").is_file() {
                removed.extend(remove_electron_files(&dir));
            }
            for p in walk_old_files(&dir) {
                if remove_file(&p) {
                    removed.push(p);
                }
            }
            let _ = std::fs::remove_dir_all(dir.join(STAGING));
            let _ = std::fs::remove_file(&mark);
        } else if dir.join(STAGING).is_dir() && self.cancel.lock().unwrap().is_none() {
            let _ = std::fs::remove_dir_all(dir.join(STAGING));
        }
        // The Electron portable launcher unpacked each version once to
        // %LOCALAPPDATA%\Vytty\app\<version> (about 275 MB each).
        if self.launch.windows {
            if let Some(app) = dirs::data_local_dir().map(|d| d.join("Vytty").join("app")) {
                for e in std::fs::read_dir(&app).into_iter().flatten().flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    let electron = v::parse_version(&name).0.first().is_some_and(|m| *m == 0) && !v::newer(&name, "0.10.99") && e.path().join(".complete").exists();
                    if electron && std::fs::remove_dir_all(e.path()).is_ok() {
                        removed.push(e.path());
                    }
                }
                if std::fs::read_dir(&app).map(|mut r| r.next().is_none()).unwrap_or(false) {
                    let _ = std::fs::remove_dir(&app);
                }
            }
        }
        // The Electron browser profile in the data folder.
        let chromium = self.paths.data_dir.join(".chromium");
        if chromium.is_dir() && std::fs::remove_dir_all(&chromium).is_ok() {
            removed.push(chromium);
        }
        removed
    }
}

fn no_access(dir: &Path, e: std::io::Error) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        anyhow!("No write access to {}", dir.display())
    } else {
        anyhow!("{}: {e}", dir.display())
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    n(a) == n(b)
}

fn remove_file(p: &Path) -> bool {
    std::fs::remove_file(p).is_ok()
}

fn walk_old_files(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if d == root && (name == "VyttyData" || name == STAGING) {
                    continue; // user data: never touched
                }
                stack.push(p);
            } else if name.ends_with(OLD) {
                out.push(p);
            }
        }
    }
    out
}

/// The runtime files of the Electron builds (0.10 and older) in an app
/// folder that was updated to this version.
const ELECTRON_FILES: [&str; 17] = [
    "chrome_100_percent.pak", "chrome_200_percent.pak", "resources.pak", "icudtl.dat", "snapshot_blob.bin", "v8_context_snapshot.bin",
    "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll", "d3dcompiler_47.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll",
    "dxcompiler.dll", "dxil.dll", "LICENSE.electron.txt", "LICENSES.chromium.html",
];

fn remove_electron_files(dir: &Path) -> Vec<PathBuf> {
    let mut removed = vec![];
    for f in ELECTRON_FILES {
        let p = dir.join(f);
        if p.is_file() && remove_file(&p) {
            removed.push(p);
        }
        let old = dir.join(format!("{f}{OLD}"));
        if old.is_file() && remove_file(&old) {
            removed.push(old);
        }
    }
    for d in ["resources", "locales"] {
        let p = dir.join(d);
        if p.is_dir() && std::fs::remove_dir_all(&p).is_ok() {
            removed.push(p);
        }
    }
    removed
}
