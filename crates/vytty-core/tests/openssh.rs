//! Against a real OpenSSH server (sshd started by the test as the current
//! user, public key login): a passphrase-protected key, a shell, SFTP up and
//! down, a local port forward, and the legacy algorithms older network gear
//! needs. Runs when VYTTY_TEST_SSHD points at sshd (CI installs it).
use serde_json::{json, Value};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Duration, Instant};
use vytty_core::conn::Manager;
use vytty_core::events::{Event, Ui};
use vytty_core::logger::Logger;
use vytty_core::paths::Paths;
use vytty_core::store::Store;
use vytty_core::vault::Vault;

fn sshd_path() -> Option<String> {
    std::env::var("VYTTY_TEST_SSHD").ok().filter(|p| Path::new(p).exists())
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn user() -> String {
    let out = Command::new("id").arg("-un").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Sshd {
    child: Child,
    port: u16,
    dir: PathBuf,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn data(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data").join(name)
}

fn start_sshd(sshd: &str, extra: &str) -> Sshd {
    let dir = std::env::temp_dir().join(format!("vytty-sshd-{}", vytty_core::util::uid()));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, kind) in [("host_rsa", "rsa"), ("host_ed25519", "ed25519")] {
        let st = Command::new("ssh-keygen").args(["-q", "-t", kind, "-N", "", "-f"]).arg(dir.join(name)).status().unwrap();
        assert!(st.success());
    }
    std::fs::copy(data("user_ed25519_encrypted.pub"), dir.join("authorized_keys")).unwrap();
    let port = free_port();
    let cfg = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host_rsa\nHostKey {d}/host_ed25519\nPidFile {d}/sshd.pid\n\
AuthorizedKeysFile {d}/authorized_keys\nUsePAM no\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n\
PubkeyAuthentication yes\nAllowTcpForwarding yes\nSubsystem sftp internal-sftp\nLogLevel ERROR\n{extra}\n",
        d = dir.display()
    );
    std::fs::File::create(dir.join("sshd_config")).unwrap().write_all(cfg.as_bytes()).unwrap();
    let child = Command::new(sshd).arg("-D").arg("-e").arg("-f").arg(dir.join("sshd_config")).spawn().unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < end, "sshd did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
    Sshd { child, port, dir }
}

struct Rec {
    events: Mutex<Vec<Event>>,
    ui: OnceLock<Weak<Ui>>,
}

fn manager() -> (Arc<Manager>, Arc<Rec>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("vytty-interop-{}", vytty_core::util::uid()));
    let paths = Paths::new(dir.clone());
    paths.ensure_dirs().unwrap();
    let rec = Arc::new(Rec { events: Mutex::new(vec![]), ui: OnceLock::new() });
    let r2 = rec.clone();
    let ui = Ui::new(Arc::new(move |ev: Event| {
        if let Event::Prompt { req_id, kind, .. } = &ev {
            // Host key: yes. Key passphrase: the test key's.
            let answer = if kind == "hostkey" { json!(true) } else { json!({ "value": "key-pass", "save": false }) };
            if let Some(ui) = r2.ui.get().and_then(|w| w.upgrade()) {
                ui.reply(*req_id, answer);
            }
        }
        r2.events.lock().unwrap().push(ev);
    }));
    rec.ui.set(Arc::downgrade(&ui)).ok();
    let store = Arc::new(Store::new(paths.clone()));
    let vault = Arc::new(Vault::new(paths.vault.clone()));
    vault.create("").unwrap();
    let settings = Arc::new(RwLock::new(store.get_settings()));
    let mgr = Manager::new(ui, store, vault, settings, Logger::new(paths.default_logs.clone()));
    (mgr, rec, dir)
}

impl Rec {
    fn text(&self, id: &str) -> String {
        self.events.lock().unwrap().iter().filter_map(|e| match e { Event::Data { id: i, data } if i == id => Some(data.clone()), _ => None }).collect()
    }
    fn closed(&self, id: &str) -> Option<String> {
        self.events.lock().unwrap().iter().find_map(|e| match e { Event::Closed { id: i, reason } if i == id => Some(reason.clone()), _ => None })
    }
    fn status(&self, id: &str) -> Option<String> {
        self.events.lock().unwrap().iter().rev().find_map(|e| match e { Event::Status { id: i, state, .. } if i == id => Some(state.clone()), _ => None })
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

fn session(port: u16, legacy: bool, forwards: Value) -> Value {
    json!({ "id": "s1", "name": "openssh", "protocol": "ssh", "host": "127.0.0.1", "port": port, "username": user(),
            "keyPath": data("user_ed25519_encrypted"), "legacyAlgorithms": legacy, "forwards": forwards })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openssh_key_shell_sftp_and_forward() {
    let Some(sshd) = sshd_path() else {
        eprintln!("VYTTY_TEST_SSHD not set - skipped");
        return;
    };
    let srv = start_sshd(&sshd, "");
    // A TCP echo service for the port forward.
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    let fwd_port = free_port();
    let (mgr, rec, dir) = manager();
    let fw = json!([{ "type": "L", "listenHost": "127.0.0.1", "listenPort": fwd_port, "destHost": "127.0.0.1", "destPort": echo_port }]);
    mgr.open("c1".into(), json!({ "session": session(srv.port, false, fw), "cols": 120, "rows": 30 }));
    until("connected", || rec.status("c1").as_deref() == Some("connected") || rec.closed("c1").is_some()).await;
    assert_eq!(rec.status("c1").as_deref(), Some("connected"), "closed: {:?} text: {}", rec.closed("c1"), rec.text("c1"));
    mgr.write("c1", "echo vytty-$((6*7))-interop\n");
    until("shell output", || rec.text("c1").contains("vytty-42-interop")).await;

    // SFTP: upload, list, download, remove.
    let local = dir.join("up.bin");
    let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&local, &payload).unwrap();
    let home = mgr.sftp_op("c1", "realpath", &json!({ "path": "." })).await.unwrap();
    let remote_dir = format!("{}/vytty-sftp-{}", home.as_str().unwrap(), std::process::id());
    mgr.sftp_op("c1", "mkdir", &json!({ "path": remote_dir })).await.unwrap();
    let n = mgr.sftp_op("c1", "uploadPaths", &json!({ "locals": [local], "remoteDir": remote_dir })).await.unwrap();
    assert_eq!(n, json!(1));
    let list = mgr.sftp_op("c1", "list", &json!({ "path": remote_dir })).await.unwrap();
    assert_eq!(list[0]["name"], json!("up.bin"));
    assert_eq!(list[0]["size"], json!(payload.len()));
    let back = dir.join("back");
    mgr.sftp_op("c1", "downloadPaths", &json!({ "items": [{ "path": format!("{remote_dir}/up.bin"), "isDir": false }], "localDir": back })).await.unwrap();
    assert_eq!(std::fs::read(back.join("up.bin")).unwrap(), payload);
    mgr.sftp_op("c1", "remove", &json!({ "items": [{ "path": remote_dir, "isDir": true }] })).await.unwrap();
    assert!(mgr.sftp_op("c1", "stat", &json!({ "path": remote_dir })).await.is_err());

    // The local forward reaches the echo service through sshd.
    until("forward listening", || rec.text("c1").contains("[forward]")).await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", fwd_port)).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    s.write_all(b"through-the-tunnel").await.unwrap();
    let mut buf = [0u8; 18];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf, b"through-the-tunnel");

    mgr.close("c1");
    until("closed", || rec.closed("c1").is_some()).await;
    let _ = std::fs::remove_dir_all(dir);
    drop(srv);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openssh_legacy_algorithms() {
    let Some(sshd) = sshd_path() else {
        eprintln!("VYTTY_TEST_SSHD not set - skipped");
        return;
    };
    // What an older Cisco IOS offers: SHA-1 key exchange, CBC, HMAC-SHA1, an ssh-rsa host key.
    let srv = start_sshd(&sshd, "KexAlgorithms diffie-hellman-group14-sha1\nCiphers aes128-cbc\nMACs hmac-sha1\nHostKeyAlgorithms ssh-rsa");
    let (mgr, rec, dir) = manager();
    mgr.open("old".into(), json!({ "session": session(srv.port, false, json!([])) }));
    until("refused", || rec.closed("old").is_some()).await;
    let reason = rec.closed("old").unwrap();
    assert!(reason.starts_with("Error") && reason.contains("Legacy algorithms"), "{reason}");
    mgr.open("legacy".into(), json!({ "session": session(srv.port, true, json!([])) }));
    until("connected", || rec.status("legacy").as_deref() == Some("connected") || rec.closed("legacy").is_some()).await;
    assert_eq!(rec.status("legacy").as_deref(), Some("connected"), "{:?}", rec.closed("legacy"));
    mgr.write("legacy", "echo legacy-ok\n");
    until("legacy shell", || rec.text("legacy").contains("legacy-ok")).await;
    mgr.close("legacy");
    until("closed", || rec.closed("legacy").is_some()).await;
    let _ = std::fs::remove_dir_all(dir);
    drop(srv);
}
