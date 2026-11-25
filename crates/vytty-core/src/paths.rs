//! Where Vytty keeps its data. Vytty is portable: everything lives next to
//! the executable in "VyttyData" (or ./data when running a development build).
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub settings: PathBuf,
    pub sessions: PathBuf,
    pub vault: PathBuf,
    pub known_hosts: PathBuf,
    pub update_state: PathBuf,
    pub default_logs: PathBuf,
    /// The web view's profile (local storage, caches).
    pub webview: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        Paths {
            settings: data_dir.join("settings.json"),
            sessions: data_dir.join("sessions.json"),
            vault: data_dir.join("vault.json"),
            known_hosts: data_dir.join("known_hosts.json"),
            update_state: data_dir.join("update-state.json"),
            default_logs: data_dir.join("logs"),
            webview: data_dir.join(".webview"),
            data_dir,
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.default_logs)?;
        Ok(())
    }
}

/// How this copy was installed; decides how it updates and where data goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallMode {
    /// Windows, Vytty-x.y.z-portable.exe (a single file, data next to it).
    Portable,
    /// Windows, Vytty.exe from the zip (or renamed), data next to it.
    Folder,
    /// Linux AppImage.
    AppImage,
    /// Installed with winget: updated by winget.
    Winget,
}

impl InstallMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            InstallMode::Portable => "portable",
            InstallMode::Folder => "folder",
            InstallMode::AppImage => "appimage",
            InstallMode::Winget => "winget",
        }
    }
}

/// What the process was started as; collected once in main and passed around.
#[derive(Clone, Debug)]
pub struct Launch {
    pub exe: PathBuf,
    /// A release build (development builds keep data in ./data and never update).
    pub packaged: bool,
    pub smoke_test: bool,
    pub appimage: Option<PathBuf>,
    pub env_data_dir: Option<PathBuf>,
    pub windows: bool,
}

impl Launch {
    pub fn from_env(packaged: bool) -> Self {
        let args: Vec<String> = std::env::args().collect();
        Launch {
            exe: std::env::current_exe().unwrap_or_default(),
            packaged,
            smoke_test: args.iter().any(|a| a == "--smoke-test"),
            appimage: std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()),
            env_data_dir: std::env::var_os("VYTTY_DATA_DIR").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()),
            windows: cfg!(windows),
        }
    }

    /// The file the user starts (and the updater replaces).
    pub fn user_file(&self) -> PathBuf {
        match &self.appimage {
            Some(a) if !self.windows => a.clone(),
            _ => self.exe.clone(),
        }
    }

    pub fn install_mode(&self) -> Option<InstallMode> {
        if !self.packaged {
            return None;
        }
        if self.windows {
            if is_winget_path(&self.exe) {
                return Some(InstallMode::Winget);
            }
            let full = self.exe.to_string_lossy();
            let name = full.rsplit(['\\', '/']).next().unwrap_or("");
            return Some(if crate::update_verify::is_old_build_name(name) { InstallMode::Portable } else { InstallMode::Folder });
        }
        if self.appimage.is_some() {
            return Some(InstallMode::AppImage);
        }
        None
    }

    pub fn data_dir(&self, dev_dir: &Path) -> PathBuf {
        if let Some(d) = &self.env_data_dir {
            return d.clone();
        }
        // CI smoke test of a packaged build: never touch a real data folder.
        if self.smoke_test {
            return std::env::temp_dir().join(format!("vytty-smoke-{}", std::process::id()));
        }
        if !self.packaged {
            return dev_dir.to_path_buf();
        }
        // winget replaces its package folder on upgrade: keep the data outside it.
        if self.windows && is_winget_path(&self.exe) {
            if let Some(local) = dirs::data_local_dir() {
                return local.join("Vytty").join("VyttyData");
            }
        }
        // The AppImage itself is mounted read-only: keep the data next to the .AppImage file.
        let base = self.user_file();
        let dir = base.parent().map(Path::to_path_buf).unwrap_or_default();
        let candidate = dir.join("VyttyData");
        if candidate.exists() || dir_writable(&dir) {
            return candidate;
        }
        // Installed somewhere read-only (e.g. /usr/bin): the per-user data folder.
        dirs::data_dir().map(|d| d.join("Vytty")).unwrap_or(candidate)
    }
}

pub fn is_winget_path(p: &Path) -> bool {
    let s = p.to_string_lossy().replace('/', "\\").to_lowercase();
    s.contains("\\microsoft\\winget\\packages\\")
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".vytty-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(exe: &str, windows: bool) -> Launch {
        Launch { exe: PathBuf::from(exe), packaged: true, smoke_test: false, appimage: None, env_data_dir: None, windows }
    }

    #[test]
    fn install_modes() {
        assert_eq!(launch(r"D:\Tools\Vytty-0.11.0-portable.exe", true).install_mode(), Some(InstallMode::Portable));
        assert_eq!(launch(r"D:\Tools\Vytty\Vytty.exe", true).install_mode(), Some(InstallMode::Folder));
        assert_eq!(
            launch(r"C:\Users\me\AppData\Local\Microsoft\WinGet\Packages\mtgmz14.Vytty_x\Vytty.exe", true).install_mode(),
            Some(InstallMode::Winget)
        );
        let mut l = launch("/tmp/.mount_x/vytty", false);
        assert_eq!(l.install_mode(), None);
        l.appimage = Some(PathBuf::from("/home/me/Apps/Vytty-0.11.0.AppImage"));
        assert_eq!(l.install_mode(), Some(InstallMode::AppImage));
        assert_eq!(l.user_file(), PathBuf::from("/home/me/Apps/Vytty-0.11.0.AppImage"));
        let mut dev = l.clone();
        dev.packaged = false;
        assert_eq!(dev.install_mode(), None);
    }

    #[test]
    fn data_dir_next_to_the_appimage_not_inside_its_mount() {
        let dir = std::env::temp_dir().join(format!("vytty-paths-{}", crate::util::uid()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut l = launch("/tmp/.mount_x/vytty", false);
        l.appimage = Some(dir.join("Vytty-0.11.0.AppImage"));
        assert_eq!(l.data_dir(Path::new("/dev")), dir.join("VyttyData"));
        l.env_data_dir = Some(PathBuf::from("/custom"));
        assert_eq!(l.data_dir(Path::new("/dev")), PathBuf::from("/custom"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
