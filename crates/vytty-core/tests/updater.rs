//! The updater against a fake GitHub: signed checksums, side-by-side
//! download, refusal of tampered files and forged signatures, and the clean-up
//! after updates from the Electron versions.
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vytty_core::paths::{Launch, Paths};
use vytty_core::updater::Updater;

type Routes = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// A minimal HTTP/1.1 server: GET path -> body (404 otherwise).
async fn http_server(routes: Routes) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { break };
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = routes.lock().unwrap().get(&path).cloned();
                let resp = match body {
                    Some(b) => {
                        let mut r = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()).into_bytes();
                        r.extend(b);
                        r
                    }
                    None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                };
                let _ = s.write_all(&resp).await;
            });
        }
    });
    base
}

fn keypair() -> (SigningKey, String) {
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let mut der = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    der.extend_from_slice(sk.verifying_key().as_bytes());
    (sk, B64.encode(der))
}

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("vytty-upd-{}", vytty_core::util::uid()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn launch_appimage(file: &Path) -> Launch {
    Launch { exe: PathBuf::from("/tmp/.mount_x/vytty"), packaged: true, smoke_test: false, appimage: Some(file.to_path_buf()), env_data_dir: None, windows: false }
}

struct Release {
    routes: Routes,
    base: String,
}

async fn release(asset: &str, body: &[u8], sk: &SigningKey, tamper: bool) -> Release {
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    let base = http_server(routes.clone()).await;
    let sums = format!("{}  {asset}\n", hex::encode(Sha256::digest(body)));
    let sig = B64.encode(sk.sign(sums.as_bytes()).to_bytes());
    let dl = |n: &str| format!("{base}/download/v0.11.0/{n}");
    let rel = json!({
        "tag_name": "v0.11.0", "html_url": format!("{base}/tag/v0.11.0"), "body": "notes",
        "assets": [
            { "name": asset, "browser_download_url": dl(asset), "size": body.len() },
            { "name": "SHA256SUMS.txt", "browser_download_url": dl("SHA256SUMS.txt"), "size": 10 },
            { "name": "SHA256SUMS.txt.sig", "browser_download_url": dl("SHA256SUMS.txt.sig"), "size": 10 },
        ]
    });
    let mut r = routes.lock().unwrap();
    r.insert("/api".into(), rel.to_string().into_bytes());
    r.insert(format!("/download/v0.11.0/{asset}"), if tamper { b"evil".to_vec() } else { body.to_vec() });
    r.insert("/download/v0.11.0/SHA256SUMS.txt".into(), sums.into_bytes());
    r.insert("/download/v0.11.0/SHA256SUMS.txt.sig".into(), sig.into_bytes());
    drop(r);
    Release { routes, base }
}

#[tokio::test]
async fn appimage_update_side_by_side_then_cleanup() {
    let dir = tmp();
    let old = dir.join("Vytty-0.10.0.AppImage");
    std::fs::write(&old, b"old build").unwrap();
    let paths = Paths::new(dir.join("VyttyData"));
    paths.ensure_dirs().unwrap();
    let (sk, pk) = keypair();
    let body = b"new build ".repeat(1000);
    let rel = release("Vytty-0.11.0.AppImage", &body, &sk, false).await;
    let up = Updater::new(launch_appimage(&old), paths.clone(), "0.10.0").with_endpoints(&format!("{}/api", rel.base), &rel.base, vec![pk.clone()]);
    let info = up.check().await.unwrap();
    assert_eq!(info["mode"], json!("appimage"));
    assert_eq!(info["available"], json!(true));
    assert_eq!(info["canInstall"], json!(true), "{info}");
    let phases = Arc::new(Mutex::new(vec![]));
    let p2 = phases.clone();
    up.download(move |_, _, phase| p2.lock().unwrap().push(phase.to_string())).await.unwrap();
    assert!(phases.lock().unwrap().iter().any(|p| p == "verify"));
    let new_file = dir.join("Vytty-0.11.0.AppImage");
    assert_eq!(std::fs::read(&new_file).unwrap(), body);
    let relaunch = up.install().unwrap();
    assert_eq!(relaunch.exe, new_file);
    assert!(old.exists(), "the old build is kept until the new one has started");

    // "Restart" as the new version: the old build goes.
    let up2 = Updater::new(launch_appimage(&new_file), paths.clone(), "0.11.0");
    let removed = up2.cleanup();
    assert!(removed.contains(&old), "{removed:?}");
    assert!(!old.exists() && new_file.exists());
    assert!(!paths.update_state.exists());
    let _ = std::fs::remove_dir_all(dir);
    drop(rel.routes);
}

#[tokio::test]
async fn tampered_file_and_forged_signature_are_refused() {
    let dir = tmp();
    let old = dir.join("Vytty-0.10.0.AppImage");
    std::fs::write(&old, b"old").unwrap();
    let paths = Paths::new(dir.join("VyttyData"));
    let (sk, pk) = keypair();
    let rel = release("Vytty-0.11.0.AppImage", b"good", &sk, true).await;
    let up = Updater::new(launch_appimage(&old), paths.clone(), "0.10.0").with_endpoints(&format!("{}/api", rel.base), &rel.base, vec![pk]);
    up.check().await.unwrap();
    let e = up.download(|_, _, _| {}).await.unwrap_err().to_string();
    assert!(e.contains("does not match the signed checksum"), "{e}");
    assert!(!dir.join("Vytty-0.11.0.AppImage").exists());
    assert!(!dir.join("Vytty-0.11.0.AppImage.download").exists());

    let other = SigningKey::from_bytes(&[9u8; 32]);
    let rel2 = release("Vytty-0.11.0.AppImage", b"good", &other, false).await;
    let (_, pk) = keypair();
    let up = Updater::new(launch_appimage(&old), paths, "0.10.0").with_endpoints(&format!("{}/api", rel2.base), &rel2.base, vec![pk]);
    up.check().await.unwrap();
    let e = up.download(|_, _, _| {}).await.unwrap_err().to_string();
    assert!(e.contains("signature is not valid"), "{e}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unsigned_release_is_a_manual_download_and_dev_builds_never_update() {
    let dir = tmp();
    let old = dir.join("Vytty-0.10.0.AppImage");
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    let base = http_server(routes.clone()).await;
    routes.lock().unwrap().insert("/api".into(), json!({ "tag_name": "v0.11.0", "assets": [{ "name": "Vytty-0.11.0.AppImage", "browser_download_url": "x" }] }).to_string().into_bytes());
    let up = Updater::new(launch_appimage(&old), Paths::new(dir.join("d")), "0.10.0").with_endpoints(&format!("{base}/api"), &base, vec!["k".into()]);
    let info = up.check().await.unwrap();
    assert_eq!(info["canInstall"], json!(false));
    assert!(info["reason"].as_str().unwrap().contains("not signed"));
    let mut dev = launch_appimage(&old);
    dev.packaged = false;
    let up = Updater::new(dev, Paths::new(dir.join("d")), "0.10.0").with_endpoints(&format!("{base}/api"), &base, vec!["k".into()]);
    assert!(up.check().await.unwrap()["reason"].as_str().unwrap().contains("not a packaged release build"));
    let _ = std::fs::remove_dir_all(dir);
}

fn launch_windows(exe: &Path) -> Launch {
    Launch { exe: exe.to_path_buf(), packaged: true, smoke_test: false, appimage: None, env_data_dir: None, windows: true }
}

#[test]
fn cleanup_after_electron_portable_update() {
    // Vytty 0.10's updater saved Vytty-0.11.0-portable.exe next to the old
    // launcher and started it; the new version removes the old one.
    let dir = tmp();
    let old = dir.join("Vytty-0.10.0-portable.exe");
    let new = dir.join("Vytty-0.11.0-portable.exe");
    std::fs::write(&old, b"nsis launcher").unwrap();
    std::fs::write(&new, b"rust").unwrap();
    let paths = Paths::new(dir.join("VyttyData"));
    std::fs::create_dir_all(paths.data_dir.join(".chromium/Local Storage")).unwrap();
    std::fs::write(&paths.sessions, b"{}").unwrap();
    vytty_core::util::write_json(&paths.update_state, &json!({ "mode": "portable", "from": old, "to": new, "version": "0.11.0", "from_version": "0.10.0" })).unwrap();
    let removed = Updater::new(launch_windows(&new), paths.clone(), "0.11.0").cleanup();
    assert!(!old.exists() && new.exists(), "{removed:?}");
    assert!(!paths.data_dir.join(".chromium").exists(), "the Electron browser profile is gone");
    assert!(paths.sessions.exists(), "sessions are never touched");
    assert!(!paths.update_state.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cleanup_after_electron_folder_update_keeps_everything_else() {
    // Vytty 0.10's zip updater moved every old file aside, moved the new
    // Vytty.exe in and left a .vytty-cleanup mark.
    let dir = tmp();
    let exe = dir.join("Vytty.exe");
    std::fs::write(&exe, b"rust").unwrap();
    std::fs::write(dir.join("Vytty.exe.vytty-old"), b"electron exe").unwrap();
    std::fs::create_dir_all(dir.join("resources")).unwrap();
    std::fs::write(dir.join("resources/app.asar"), b"asar").unwrap();
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    std::fs::write(dir.join("locales/pl.pak"), b"").unwrap();
    for f in ["ffmpeg.dll", "icudtl.dat", "resources.pak", "LICENSES.chromium.html"] {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    std::fs::write(dir.join(".vytty-cleanup"), b"0.11.0").unwrap();
    std::fs::create_dir_all(dir.join(".vytty-update/0.11.0")).unwrap();
    std::fs::write(dir.join("my-notes.txt"), b"mine").unwrap();
    let paths = Paths::new(dir.join("VyttyData"));
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    std::fs::write(&paths.vault, b"{}").unwrap();
    std::fs::write(paths.data_dir.join("keep.vytty-old"), b"inside the data folder").unwrap();
    vytty_core::util::write_json(&paths.update_state, &json!({ "mode": "folder", "folder": dir, "version": "0.11.0" })).unwrap();
    Updater::new(launch_windows(&exe), paths.clone(), "0.11.0").cleanup();
    for gone in ["Vytty.exe.vytty-old", "resources", "locales", "ffmpeg.dll", "icudtl.dat", "resources.pak", "LICENSES.chromium.html", ".vytty-cleanup", ".vytty-update"] {
        assert!(!dir.join(gone).exists(), "{gone} should be removed");
    }
    assert!(exe.exists() && dir.join("my-notes.txt").exists() && paths.vault.exists());
    assert!(paths.data_dir.join("keep.vytty-old").exists(), "VyttyData is never touched");
    let _ = std::fs::remove_dir_all(dir);
}
