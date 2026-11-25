//! All terminal backends: SSH (with jump host, port forwarding and SFTP),
//! Telnet (with a small option negotiator and auto-login), Serial and local
//! shells. Each connection has a backend task that talks to the device and a
//! "pump" task that turns its output into text for the window (logging,
//! auto-login and startup commands on the way).
pub mod local;
pub mod serial;
pub mod sftp;
pub mod ssh;
pub mod telnet;

use crate::events::{Event, Ui};
use crate::logger::{fallback_host, Logger, SessionLog};
use crate::store::Store;
use crate::util::{s, Obj};
use crate::vault::Vault;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// From the window to the backend.
#[derive(Debug)]
pub enum Cmd {
    Write(Vec<u8>),
    Resize(u16, u16),
}

/// From the backend to the pump.
pub enum Out {
    Data(Vec<u8>),
    /// Our own messages, shown in the terminal (and logged).
    Note(String),
    Status(&'static str, String),
    /// Connected: start auto-login (Telnet / Serial) and the startup commands.
    Connected { auto_login: bool },
    End(String),
}

pub struct Conn {
    pub id: String,
    pub session: Value,
    pub secret: Obj,
    size: Mutex<(u16, u16)>,
    tx: UnboundedSender<Cmd>,
    pub out: UnboundedSender<Out>,
    closed: AtomicBool,
    /// SSH: the client, for SFTP and port forwards.
    pub ssh: Mutex<Option<ssh::Client>>,
    pub sftp: tokio::sync::Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    kill: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl Conn {
    pub fn size(&self) -> (u16, u16) {
        *self.size.lock().unwrap()
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    pub fn note(&self, text: impl Into<String>) {
        let _ = self.out.send(Out::Note(text.into()));
    }
    pub fn add_task(&self, h: tokio::task::AbortHandle) {
        if self.is_closed() {
            h.abort();
        } else {
            self.tasks.lock().unwrap().push(h);
        }
    }
    pub fn on_close(&self, f: Box<dyn FnOnce() + Send>) {
        if self.is_closed() {
            f();
        } else {
            self.kill.lock().unwrap().push(f);
        }
    }
    pub fn proto(&self) -> String {
        s(self.session.get("protocol"))
    }
}

pub fn describe(sess: &Value) -> String {
    let g = |k: &str| s(sess.get(k));
    let port = |d: &str| {
        let p = g("port");
        if p.is_empty() || p == "0" {
            d.to_string()
        } else {
            p
        }
    };
    match g("protocol").as_str() {
        "ssh" => format!("ssh {}{}:{}", if g("username").is_empty() { String::new() } else { format!("{}@", g("username")) }, g("host"), port("22")),
        "telnet" => format!("telnet {}:{}", g("host"), port("23")),
        "serial" => format!("serial {} {}", g("serialPath"), if g("baudRate").is_empty() { "9600".into() } else { g("baudRate") }),
        "local" => format!("local {}", if g("shell").is_empty() { local::default_shell() } else { g("shell") }),
        p => p.to_string(),
    }
}

pub fn split_args(s: &str) -> Vec<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]*)"|'([^']*)'|(\S+)"#).unwrap());
    RE.captures_iter(s).map(|c| c.get(1).or(c.get(2)).or(c.get(3)).unwrap().as_str().to_string()).collect()
}

/// Shared state of all connections.
pub struct Manager {
    pub ui: Arc<Ui>,
    pub store: Arc<Store>,
    pub vault: Arc<Vault>,
    pub settings: Arc<RwLock<Value>>,
    pub logger: Arc<Logger>,
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    pub(crate) drag_cache: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Result<Vec<String>, String>>>>>,
}

impl Manager {
    pub fn new(ui: Arc<Ui>, store: Arc<Store>, vault: Arc<Vault>, settings: Arc<RwLock<Value>>, logger: Arc<Logger>) -> Arc<Self> {
        Arc::new(Manager { ui, store, vault, settings, logger, conns: Mutex::new(HashMap::new()), drag_cache: Mutex::new(HashMap::new()) })
    }

    pub fn setting(&self, path: &[&str]) -> Value {
        let s = self.settings.read().unwrap();
        let mut v = &*s;
        for p in path {
            match v.get(*p) {
                Some(x) => v = x,
                None => return Value::Null,
            }
        }
        v.clone()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Conn>> {
        self.conns.lock().unwrap().get(id).cloned()
    }

    /// The stored secret of a session, falling back to its credential profile.
    pub fn secret_for(&self, session: &Value, overrides: Option<&Value>) -> Obj {
        let mut secret = Obj::new();
        let id = s(session.get("id"));
        if !id.is_empty() {
            if let Ok(v) = self.vault.get(&id) {
                secret = v;
            }
        }
        let cred = s(session.get("credentialId"));
        if !crate::util::truthy(secret.get("password")) && !cred.is_empty() {
            if let Ok(c) = self.vault.get(&format!("cred:{cred}")) {
                if let Some(pw) = c.get("password").filter(|p| crate::util::truthy(Some(p))) {
                    secret.insert("password".into(), pw.clone());
                }
            }
        }
        if let Some(Value::Object(o)) = overrides {
            for (k, v) in o {
                secret.insert(k.clone(), v.clone());
            }
        }
        secret
    }

    /// Merges `patch` into the stored secret of `id` (ignored while the vault is locked).
    pub fn save_secret(&self, id: &str, patch: Obj) {
        if let Ok(mut cur) = self.vault.get(id) {
            for (k, v) in patch {
                cur.insert(k, v);
            }
            let _ = self.vault.set(id, &cur);
        }
    }

    pub fn status(&self, id: &str, state: &str, message: &str) {
        self.ui.emit(Event::Status { id: id.into(), state: state.into(), message: message.into() });
    }

    /// conn:open - returns at once; progress and output arrive as events.
    pub fn open(self: &Arc<Self>, id: String, spec: Value) {
        let session = spec.get("session").cloned().unwrap_or(json!({}));
        let secret = self.secret_for(&session, spec.get("secret"));
        let cols = spec.get("cols").and_then(|v| v.as_u64()).unwrap_or(80).clamp(1, 1000) as u16;
        let rows = spec.get("rows").and_then(|v| v.as_u64()).unwrap_or(24).clamp(1, 1000) as u16;
        let log_enabled = spec.get("logEnabled").and_then(|v| v.as_bool()) != Some(false);
        let log_name = [s(spec.get("logName")), s(session.get("name")), s(session.get("host"))].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "session".into());
        let (tx, cmd_rx) = unbounded_channel();
        let (out, out_rx) = unbounded_channel();
        let conn = Arc::new(Conn {
            id: id.clone(),
            session: session.clone(),
            secret,
            size: Mutex::new((cols, rows)),
            tx,
            out,
            closed: AtomicBool::new(false),
            ssh: Mutex::new(None),
            sftp: tokio::sync::Mutex::new(None),
            tasks: Mutex::new(vec![]),
            kill: Mutex::new(vec![]),
        });
        if let Some(old) = self.conns.lock().unwrap().insert(id.clone(), conn.clone()) {
            let _ = old.out.send(Out::End("Replaced".into()));
        }
        let desc = describe(&session);
        self.status(&id, "connecting", &format!("Connecting: {desc}"));
        let log = SessionLog::new(self.logger.clone(), &log_name, &desc, log_enabled, &fallback_host(&session));
        let me = self.clone();
        let c2 = conn.clone();
        tokio::spawn(async move { me.pump(c2, out_rx, log).await });

        let me = self.clone();
        let c2 = conn.clone();
        let backend = tokio::spawn(async move {
            let res = match c2.proto().as_str() {
                "ssh" => ssh::run(me.clone(), c2.clone(), cmd_rx).await,
                "telnet" => telnet::run(me.clone(), c2.clone(), cmd_rx).await,
                "serial" => serial::run(me.clone(), c2.clone(), cmd_rx).await,
                "local" => local::run(me.clone(), c2.clone(), cmd_rx).await,
                p => Err(anyhow::anyhow!("Unknown protocol {p}")),
            };
            if let Err(e) = res {
                let _ = c2.out.send(Out::End(format!("Error: {}", ssh::error_text(&e))));
            }
        });
        conn.add_task(backend.abort_handle());
    }

    pub fn write(&self, id: &str, data: &str) {
        if let Some(c) = self.get(id) {
            if !c.is_closed() {
                let _ = c.tx.send(Cmd::Write(data.as_bytes().to_vec()));
            }
        }
    }

    pub fn write_bytes(&self, conn: &Conn, data: Vec<u8>) {
        if !conn.is_closed() {
            let _ = conn.tx.send(Cmd::Write(data));
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(c) = self.get(id) {
            if c.is_closed() || cols == 0 || rows == 0 {
                return;
            }
            *c.size.lock().unwrap() = (cols, rows);
            let _ = c.tx.send(Cmd::Resize(cols, rows));
        }
    }

    pub fn close(&self, id: &str) {
        if let Some(c) = self.get(id) {
            let _ = c.out.send(Out::End("Closed by user".into()));
        }
    }

    pub fn close_all(&self) {
        let all: Vec<Arc<Conn>> = self.conns.lock().unwrap().values().cloned().collect();
        for c in all {
            let _ = c.out.send(Out::End("Application closed".into()));
        }
    }

    /// Ends a connection for good: aborts its tasks, closes ports, removes its
    /// drag copies and tells the window. Idempotent.
    fn finish(&self, conn: &Arc<Conn>, reason: &str) {
        if conn.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        for t in conn.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        for k in conn.kill.lock().unwrap().drain(..) {
            k();
        }
        if let Some(c) = conn.ssh.lock().unwrap().take() {
            tokio::spawn(async move { c.close().await });
        }
        {
            let mut map = self.conns.lock().unwrap();
            if map.get(&conn.id).map(|c| Arc::ptr_eq(c, conn)).unwrap_or(false) {
                map.remove(&conn.id);
            }
        }
        self.drop_drag_cache(&conn.id);
        self.ui.emit(Event::Closed { id: conn.id.clone(), reason: if reason.is_empty() { "Connection closed".into() } else { reason.into() } });
    }

    async fn pump(self: Arc<Self>, conn: Arc<Conn>, mut rx: UnboundedReceiver<Out>, mut log: SessionLog) {
        let mut dec = Utf8Stream::default();
        let mut auto: Option<AutoLogin> = None;
        let mut startup: Option<Startup> = None;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut pending: Option<Out> = None;
        loop {
            let deadline = startup.as_ref().map(|s| s.deadline);
            let msg = if let Some(m) = pending.take() {
                Some(m)
            } else {
                tokio::select! {
                    m = rx.recv() => m,
                    _ = sleep_until_opt(deadline) => {
                        if let Some(st) = startup.take() {
                            self.fire_startup(&conn, st.lines);
                        }
                        continue;
                    }
                    _ = tick.tick() => { log.tick(); continue; }
                }
            };
            let Some(msg) = msg else {
                log.close("Connection closed");
                self.finish(&conn, "Connection closed");
                return;
            };
            match msg {
                Out::Data(bytes) => {
                    let mut text = dec.push(&bytes);
                    // Output that arrives in one burst goes to the window as one message.
                    loop {
                        match rx.try_recv() {
                            Ok(Out::Data(more)) => text.push_str(&dec.push(&more)),
                            Ok(other) => {
                                pending = Some(other);
                                break;
                            }
                            Err(_) => break,
                        }
                        if text.len() > 512 * 1024 {
                            break;
                        }
                    }
                    if text.is_empty() || conn.is_closed() {
                        continue;
                    }
                    log.write(&text);
                    if let Some(a) = auto.as_mut() {
                        if let Some(reply) = a.step(&text) {
                            self.write_bytes(&conn, reply.into_bytes());
                        }
                    }
                    if let Some(st) = startup.as_mut() {
                        if auto.as_ref().map(|a| a.done).unwrap_or(true) {
                            st.deadline = Instant::now() + Duration::from_millis(800);
                        }
                    }
                    self.ui.emit(Event::Data { id: conn.id.clone(), data: text });
                }
                Out::Note(text) => {
                    log.write(&text);
                    self.ui.emit(Event::Data { id: conn.id.clone(), data: text });
                }
                Out::Status(state, message) => self.status(&conn.id, state, &message),
                Out::Connected { auto_login } => {
                    if auto_login {
                        auto = AutoLogin::arm(&conn, &self);
                    }
                    let text = s(conn.session.get("startupCommands"));
                    let lines: Vec<String> = text.trim().lines().map(|l| l.trim_end_matches('\r').to_string()).collect();
                    if !text.trim().is_empty() {
                        startup = Some(Startup { lines, deadline: Instant::now() + Duration::from_millis(800) });
                    }
                }
                Out::End(reason) => {
                    log.close(&reason);
                    self.finish(&conn, &reason);
                    return;
                }
            }
        }
    }

    /// Startup commands: sent line by line once the output has been quiet for a moment.
    fn fire_startup(self: &Arc<Self>, conn: &Arc<Conn>, lines: Vec<String>) {
        let me = self.clone();
        let c = conn.clone();
        let h = tokio::spawn(async move {
            for line in lines {
                me.write_bytes(&c, format!("{line}\r").into_bytes());
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        });
        conn.add_task(h.abort_handle());
    }
}

async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(tokio::time::Instant::from_std(d)).await,
        None => std::future::pending().await,
    }
}

struct Startup {
    lines: Vec<String>,
    deadline: Instant,
}

/// Auto-login for Telnet / Serial: answers Username:/Password: prompts once.
struct AutoLogin {
    tail: String,
    username: String,
    password: String,
    user_sent: bool,
    pass_sent: bool,
    done: bool,
    started: Instant,
}

impl AutoLogin {
    fn arm(conn: &Conn, mgr: &Manager) -> Option<Self> {
        let username = s(conn.session.get("username"));
        let password = s(conn.secret.get("password"));
        let _ = mgr;
        if conn.session.get("autoLogin") == Some(&json!(false)) || (username.is_empty() && password.is_empty()) {
            return None;
        }
        Some(AutoLogin { tail: String::new(), user_sent: username.is_empty(), pass_sent: password.is_empty(), username, password, done: false, started: Instant::now() })
    }

    fn step(&mut self, text: &str) -> Option<String> {
        static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap());
        static USER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(user ?name|login)\s*:\s*$").unwrap());
        static PASS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)pass(word|code)?\s*:\s*$").unwrap());
        if self.done {
            return None;
        }
        if self.started.elapsed() > Duration::from_secs(60) {
            self.done = true;
            return None;
        }
        self.tail.push_str(&CSI.replace_all(text, ""));
        let n = self.tail.chars().count();
        if n > 200 {
            self.tail = self.tail.chars().skip(n - 200).collect();
        }
        let mut reply = None;
        if !self.user_sent && USER.is_match(&self.tail) {
            self.user_sent = true;
            self.tail.clear();
            reply = Some(format!("{}\r", self.username));
        } else if !self.pass_sent && PASS.is_match(&self.tail) {
            self.pass_sent = true;
            self.tail.clear();
            reply = Some(format!("{}\r", self.password));
        }
        if self.user_sent && self.pass_sent {
            self.done = true;
        }
        reply
    }
}

/// Incremental UTF-8 decoding: a character split across two reads is kept
/// until its last byte arrives; invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    rest: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.rest);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut i = 0;
        while i < buf.len() {
            match std::str::from_utf8(&buf[i..]) {
                Ok(t) => {
                    out.push_str(t);
                    break;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&buf[i..i + good]).unwrap());
                    i += good;
                    match e.error_len() {
                        Some(bad) => {
                            out.push('\u{fffd}');
                            i += bad;
                        }
                        None => {
                            self.rest = buf[i..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_reads() {
        let mut d = Utf8Stream::default();
        let bytes = "zażółć".as_bytes();
        let a = d.push(&bytes[..3]);
        let b = d.push(&bytes[3..]);
        assert_eq!(format!("{a}{b}"), "zażółć");
        assert_eq!(d.push(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    #[test]
    fn args_and_descriptions() {
        assert_eq!(split_args(r#"-NoLogo "C:\My Dir" 'x y' z"#), vec!["-NoLogo", r"C:\My Dir", "x y", "z"]);
        assert_eq!(describe(&json!({"protocol": "ssh", "host": "h", "username": "u", "port": 2222})), "ssh u@h:2222");
        assert_eq!(describe(&json!({"protocol": "telnet", "host": "h"})), "telnet h:23");
    }
}
