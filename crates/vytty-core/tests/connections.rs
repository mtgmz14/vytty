//! Connections against real servers started by the test: an SSH server (russh)
//! with password login, an echoing shell and direct-tcpip forwarding (for the
//! jump host), and a Telnet server that negotiates NAWS and asks for a login.
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vytty_core::conn::Manager;
use vytty_core::events::{Event, Ui};
use vytty_core::logger::Logger;
use vytty_core::paths::Paths;
use vytty_core::store::Store;
use vytty_core::vault::Vault;

// ------------------------------------------------------------------ harness

struct Rec {
    events: Mutex<Vec<Event>>,
    answers: Mutex<HashMap<String, Value>>,
    ui: OnceLock<Weak<Ui>>,
}

impl Rec {
    fn text(&self, id: &str) -> String {
        self.events.lock().unwrap().iter().filter_map(|e| match e { Event::Data { id: i, data } if i == id => Some(data.clone()), _ => None }).collect()
    }
    fn closed(&self, id: &str) -> Option<String> {
        self.events.lock().unwrap().iter().find_map(|e| match e { Event::Closed { id: i, reason } if i == id => Some(reason.clone()), _ => None })
    }
    fn prompts(&self, kind: &str) -> Vec<Value> {
        self.events.lock().unwrap().iter().filter_map(|e| match e { Event::Prompt { kind: k, payload, .. } if k == kind => Some(payload.clone()), _ => None }).collect()
    }
}

struct Harness {
    mgr: Arc<Manager>,
    rec: Arc<Rec>,
    dir: PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn harness(answers: &[(&str, Value)]) -> Harness {
    let dir = std::env::temp_dir().join(format!("vytty-conn-{}", vytty_core::util::uid()));
    let paths = Paths::new(dir.clone());
    paths.ensure_dirs().unwrap();
    let rec = Arc::new(Rec { events: Mutex::new(vec![]), answers: Mutex::new(answers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()), ui: OnceLock::new() });
    let r2 = rec.clone();
    let ui = Ui::new(Arc::new(move |ev: Event| {
        if let Event::Prompt { req_id, kind, .. } = &ev {
            let answer = r2.answers.lock().unwrap().get(kind).cloned().unwrap_or(Value::Null);
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
    let logger = Logger::new(paths.default_logs.clone());
    Harness { mgr: Manager::new(ui, store, vault, settings, logger), rec, dir }
}

async fn until(what: &str, ms: u64, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

fn secret(pw: &str) -> Map<String, Value> {
    [("password".to_string(), json!(pw))].into_iter().collect()
}

// --------------------------------------------------------------- SSH server

#[derive(Clone)]
struct SshServer {
    prompt: String,
    forward: bool,
    live: Arc<AtomicUsize>,
}

struct SshConn(SshServer, std::collections::HashSet<ChannelId>);

impl Drop for SshConn {
    fn drop(&mut self) {
        self.0.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl russh::server::Handler for SshConn {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "admin" && password == "secret" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: Some(MethodSet::from(&[MethodKind::Password][..])), partial_success: false })
        }
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: russh::server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        self.1.insert(channel);
        session.data(channel, format!("Welcome\r\n{}", self.0.prompt).into_bytes())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        // Echo on the shell only (forwarded channels carry their own data).
        if self.1.contains(&channel) {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _oa: &str,
        _op: u32,
        reply: russh::server::ChannelOpenHandle,
        _s: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.0.forward {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        match tokio::net::TcpStream::connect((host, port as u16)).await {
            Ok(mut tcp) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut st = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut st).await;
                });
            }
            Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
        }
        Ok(())
    }
}

async fn ssh_server(prompt: &str, forward: bool) -> (SocketAddr, Arc<AtomicUsize>) {
    let key = russh::keys::decode_secret_key(include_str!("data/host_ed25519"), None).unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let live = Arc::new(AtomicUsize::new(0));
    let srv = SshServer { prompt: prompt.to_string(), forward, live: live.clone() };
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { break };
            srv.live.fetch_add(1, Ordering::SeqCst);
            let cfg = config.clone();
            let h = SshConn(srv.clone(), Default::default());
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(cfg, sock, h).await {
                    let _ = running.await;
                }
            });
        }
    });
    (addr, live)
}

fn ssh_session(id: &str, addr: SocketAddr) -> Value {
    json!({ "id": id, "name": "sw1", "protocol": "ssh", "host": "127.0.0.1", "port": addr.port(), "username": "admin" })
}

// -------------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_host_key_prompt_stored_password_echo_close() {
    let (addr, _) = ssh_server("SW1#", false).await;
    let h = harness(&[("hostkey", json!(true))]);
    h.mgr.vault.set("s1", &secret("secret")).unwrap();
    h.mgr.open("c1".into(), json!({ "session": ssh_session("s1", addr), "cols": 100, "rows": 30 }));
    until("prompt", 10000, || h.rec.text("c1").contains("SW1#")).await;
    assert_eq!(h.rec.prompts("hostkey").len(), 1);
    let known = h.mgr.store.known_host(&format!("[127.0.0.1]:{}", addr.port())).expect("host key remembered");
    assert!(known.starts_with("SHA256:"), "{known}");
    h.mgr.write("c1", "show ver\r");
    until("echo", 5000, || h.rec.text("c1").contains("show ver")).await;
    h.mgr.close("c1");
    until("closed", 5000, || h.rec.closed("c1").is_some()).await;
    assert_eq!(h.rec.closed("c1").unwrap(), "Closed by user");

    // Second connection: the key is known now, no question.
    h.mgr.open("c2".into(), json!({ "session": ssh_session("s1", addr) }));
    until("prompt 2", 10000, || h.rec.text("c2").contains("SW1#")).await;
    assert_eq!(h.rec.prompts("hostkey").len(), 1);
    h.mgr.close_all();
    until("closed 2", 5000, || h.rec.closed("c2").is_some()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_changed_host_key_refused() {
    let (addr, _) = ssh_server("SW1#", false).await;
    let h = harness(&[("hostkey", json!(false))]);
    h.mgr.store.save_known_host(&format!("[127.0.0.1]:{}", addr.port()), "SHA256:somethingelse").unwrap();
    h.mgr.vault.set("s1", &secret("secret")).unwrap();
    h.mgr.open("c1".into(), json!({ "session": ssh_session("s1", addr) }));
    until("closed", 10000, || h.rec.closed("c1").is_some()).await;
    assert!(h.rec.closed("c1").unwrap().starts_with("Error"), "{:?}", h.rec.closed("c1"));
    assert_eq!(h.rec.prompts("hostkey")[0]["previous"], json!("SHA256:somethingelse"), "the UI is told the key changed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_password_asked_and_retried() {
    let (addr, _) = ssh_server("SW1#", false).await;
    let h = harness(&[("hostkey", json!(true)), ("secret", json!({ "value": "secret", "save": true }))]);
    h.mgr.vault.set("s1", &secret("wrong")).unwrap();
    h.mgr.open("c1".into(), json!({ "session": ssh_session("s1", addr) }));
    until("prompt", 10000, || h.rec.text("c1").contains("SW1#")).await;
    let asked = h.rec.prompts("secret");
    assert_eq!(asked.len(), 1);
    assert!(asked[0]["label"].as_str().unwrap().starts_with("Wrong password"));
    assert_eq!(h.mgr.vault.get("s1").unwrap()["password"], json!("secret"), "the corrected password was saved");
    h.mgr.close("c1");
    until("closed", 5000, || h.rec.closed("c1").is_some()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_via_jump_host_closes_both() {
    let (target, target_live) = ssh_server("TARGET#", false).await;
    let (jump, jump_live) = ssh_server("JUMP#", true).await;
    let h = harness(&[("hostkey", json!(true))]);
    h.mgr.vault.set("s1", &secret("secret")).unwrap();
    h.mgr.vault.set("j1", &secret("secret")).unwrap();
    let mut s = ssh_session("s1", target);
    s["jump"] = json!({ "session": ssh_session("j1", jump) });
    h.mgr.open("c1".into(), json!({ "session": s }));
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end && !h.rec.text("c1").contains("TARGET#") && h.rec.closed("c1").is_none() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(h.rec.text("c1").contains("TARGET#"), "text {:?} closed {:?} prompts {:?}", h.rec.text("c1"), h.rec.closed("c1"), h.rec.prompts("hostkey"));
    assert!(h.rec.text("c1").contains("Via jump host"));
    assert_eq!(jump_live.load(Ordering::SeqCst), 1);
    h.mgr.close("c1");
    until("closed", 5000, || h.rec.closed("c1").is_some()).await;
    until("jump connection closed with the tab", 5000, || jump_live.load(Ordering::SeqCst) == 0 && target_live.load(Ordering::SeqCst) == 0).await;

    // A failing target must not leave the jump connection open.
    let mut s = ssh_session("s1", target);
    s["port"] = json!(1); // nothing listens there
    s["jump"] = json!({ "session": ssh_session("j1", jump) });
    h.mgr.open("c2".into(), json!({ "session": s }));
    until("closed 2", 10000, || h.rec.closed("c2").is_some()).await;
    assert!(h.rec.closed("c2").unwrap().starts_with("Error"));
    until("jump connection ended", 5000, || jump_live.load(Ordering::SeqCst) == 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn telnet_naws_auto_login_and_utf8() {
    const IAC: u8 = 255;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let received = Arc::new(Mutex::new(Vec::<u8>::new()));
    let rx = received.clone();
    tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        s.write_all(&[IAC, 253, 31]).await.unwrap(); // DO NAWS
        s.write_all(b"\r\nUser Access Verification\r\n\r\nUsername: ").await.unwrap();
        let mut buf = [0u8; 4096];
        let mut stage = 0;
        loop {
            let n = match s.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            rx.lock().unwrap().extend_from_slice(&buf[..n]);
            let all = rx.lock().unwrap().clone();
            let text = String::from_utf8_lossy(&all).to_string();
            if stage == 0 && text.contains("netops\r") {
                stage = 1;
                s.write_all(b"Password: ").await.unwrap();
            } else if stage == 1 && text.contains("t3lnet\r") {
                stage = 2;
                s.write_all(b"\r\nR1#").await.unwrap();
            } else if stage == 2 {
                s.write_all(&buf[..n]).await.unwrap();
            }
        }
    });
    let h = harness(&[]);
    h.mgr.vault.set("t1", &secret("t3lnet")).unwrap();
    h.mgr.open("c1".into(), json!({ "session": { "id": "t1", "name": "r1", "protocol": "telnet", "host": "127.0.0.1", "port": port, "username": "netops" }, "cols": 100, "rows": 30 }));
    until("logged in", 10000, || h.rec.text("c1").contains("R1#")).await;
    h.mgr.write("c1", "ÿ");
    until("echo", 5000, || received.lock().unwrap().windows(2).any(|w| w == [0xc3, 0xbf])).await;
    let all = received.lock().unwrap().clone();
    assert!(all.windows(3).any(|w| w == [IAC, 251, 31]), "WILL NAWS");
    assert!(all.windows(9).any(|w| w == [IAC, 250, 31, 0, 100, 0, 30, IAC, 240]), "window size 100x30");
    h.mgr.resize("c1", 120, 40);
    until("new size", 5000, || received.lock().unwrap().windows(9).any(|w| w == [IAC, 250, 31, 0, 120, 0, 40, IAC, 240])).await;
    h.mgr.close("c1");
    until("closed", 5000, || h.rec.closed("c1").is_some()).await;
    // The session log went to the device's file (prompt "R1#").
    h.mgr.logger.flush();
    let logs = vytty_core::logger::read_dir_file_names(&h.dir.join("logs"));
    assert!(logs.iter().any(|f| f.starts_with("R1#")), "{logs:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn telnet_unreachable_times_out() {
    let h = harness(&[]);
    {
        let mut s = h.mgr.settings.write().unwrap();
        s["ssh"]["readyTimeout"] = json!(1500);
    }
    let started = Instant::now();
    h.mgr.open("c1".into(), json!({ "session": { "protocol": "telnet", "host": "10.255.255.1", "port": 23 } }));
    until("closed", 6000, || h.rec.closed("c1").is_some()).await;
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(h.rec.closed("c1").unwrap().starts_with("Error"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_while_connecting_is_immediate() {
    // A server that accepts the TCP connection and then never says a word.
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut keep = vec![];
        while let Ok((s, _)) = silent.accept().await {
            keep.push(s);
        }
    });
    let h = harness(&[]);
    h.mgr.open("c1".into(), json!({ "session": { "protocol": "ssh", "host": "127.0.0.1", "port": port, "username": "x" } }));
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.mgr.close("c1");
    until("closed", 2000, || h.rec.closed("c1").is_some()).await;
    assert_eq!(h.rec.closed("c1").unwrap(), "Closed by user");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_shell_runs_and_reports_exit() {
    let h = harness(&[]);
    h.mgr.open("c1".into(), json!({ "session": { "protocol": "local", "shell": "/bin/sh", "shellArgs": "-c 'echo hello-from-pty; exit 3'" } }));
    until("exit", 10000, || h.rec.closed("c1").is_some()).await;
    assert!(h.rec.text("c1").contains("hello-from-pty"));
    assert_eq!(h.rec.closed("c1").unwrap(), "Process exited with code 3");
}
