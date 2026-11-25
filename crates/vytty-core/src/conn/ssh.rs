//! SSH: host key check against known_hosts.json, the authentication dialogue
//! (key, agent, password, keyboard-interactive), jump host, shell channel and
//! local / dynamic (SOCKS5) port forwards.
use super::{describe, Cmd, Conn, Manager, Out};
use crate::util::{num, s, truthy, Obj};
use anyhow::{anyhow, bail, Result};
use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg};
use russh::{cipher, kex, mac, ChannelMsg, MethodKind, Preferred};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// A connected client (and its jump host), shared with SFTP and forwards.
#[derive(Clone)]
pub struct Client {
    pub handle: Arc<Handle<Handler>>,
    pub jump: Option<Arc<Handle<Handler>>>,
}

/// The handshake timeout pauses while a question is open in the window
/// (a timer that kept running during a host key or password dialog would
/// abort the connection while the user is typing).
pub struct Pause {
    count: AtomicUsize,
    last: Mutex<Instant>,
}

impl Pause {
    fn new() -> Arc<Self> {
        Arc::new(Pause { count: AtomicUsize::new(0), last: Mutex::new(Instant::now()) })
    }
    async fn ask(&self, mgr: &Manager, kind: &str, payload: Value) -> Option<Value> {
        self.count.fetch_add(1, Ordering::SeqCst);
        let r = mgr.ui.ask(kind, payload).await;
        *self.last.lock().unwrap() = Instant::now();
        self.count.fetch_sub(1, Ordering::SeqCst);
        r
    }
    async fn watchdog(&self, timeout: Duration) -> anyhow::Error {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if self.count.load(Ordering::SeqCst) > 0 {
                *self.last.lock().unwrap() = Instant::now();
            } else if self.last.lock().unwrap().elapsed() > timeout {
                return anyhow!("Timed out while waiting for handshake");
            }
        }
    }
}

pub struct Handler {
    mgr: Arc<Manager>,
    host: String,
    port: u16,
    pause: Arc<Pause>,
    banner: Option<UnboundedSender<Out>>,
}

pub fn host_id(host: &str, port: u16) -> String {
    format!("[{host}]:{port}")
}

impl russh::client::Handler for Handler {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let data = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(c) => c.public_key().clone(),
        };
        let fingerprint = data.fingerprint(HashAlg::Sha256).to_string();
        let id = host_id(&self.host, self.port);
        let previous = self.mgr.store.known_host(&id);
        if previous.as_deref() == Some(fingerprint.as_str()) {
            return Ok(true);
        }
        let payload = json!({ "host": self.host, "port": self.port, "fingerprint": fingerprint, "previous": previous });
        let accepted = self.pause.ask(&self.mgr, "hostkey", payload).await.is_some();
        if accepted {
            self.mgr.store.save_known_host(&id, &fingerprint)?;
        }
        Ok(accepted)
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut russh::client::Session) -> Result<(), Self::Error> {
        if let Some(tx) = &self.banner {
            let text = banner.replace("\r\n", "\n").replace('\n', "\r\n");
            let _ = tx.send(Out::Note(text));
        }
        Ok(())
    }
}

fn preferred(legacy: bool) -> Preferred {
    let mut p = Preferred::DEFAULT.clone();
    let ext: Vec<kex::Name> = p.kex.iter().filter(|k| k.as_ref().starts_with("ext-info") || k.as_ref().starts_with("kex-strict")).cloned().collect();
    let mut kexes: Vec<kex::Name> = p.kex.iter().filter(|k| !ext.contains(k)).cloned().collect();
    // ECDH is what many network devices (IOS-XE, NX-OS) offer.
    let pos = kexes.iter().position(|k| *k == kex::DH_GEX_SHA256).unwrap_or(kexes.len());
    for (i, k) in [kex::ECDH_SHA2_NISTP256, kex::ECDH_SHA2_NISTP384, kex::ECDH_SHA2_NISTP521].into_iter().enumerate() {
        kexes.insert(pos + i, k);
    }
    if legacy {
        kexes.extend([kex::DH_G14_SHA1, kex::DH_GEX_SHA1, kex::DH_G1_SHA1]);
    }
    kexes.extend(ext);
    p.kex = Cow::Owned(kexes);

    let mut ciphers: Vec<cipher::Name> = p.cipher.to_vec();
    ciphers.insert(2, cipher::AES_128_GCM);
    if legacy {
        ciphers.extend([cipher::AES_128_CBC, cipher::AES_192_CBC, cipher::AES_256_CBC, cipher::TRIPLE_DES_CBC]);
    }
    p.cipher = Cow::Owned(ciphers);

    let mut macs: Vec<mac::Name> = p.mac.to_vec();
    macs.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
    p.mac = Cow::Owned(macs);

    if legacy {
        let mut keys = p.key.to_vec();
        keys.push(russh::keys::Algorithm::Dsa);
        p.key = Cow::Owned(keys);
    }
    p
}

fn config(mgr: &Manager, session: &Value) -> russh::client::Config {
    let legacy = match session.get("legacyAlgorithms") {
        Some(Value::Bool(b)) => *b,
        _ => mgr.setting(&["ssh", "legacyAlgorithms"]).as_bool().unwrap_or(false),
    };
    let keepalive = match session.get("keepalive") {
        Some(v @ Value::Number(_)) => num(Some(v)),
        _ => num(Some(&mgr.setting(&["ssh", "keepaliveInterval"]))),
    };
    russh::client::Config {
        client_id: russh::SshId::Standard(format!("SSH-2.0-Vytty_{}", env!("CARGO_PKG_VERSION")).into()),
        keepalive_interval: if keepalive > 0.0 { Some(Duration::from_secs_f64(keepalive)) } else { None },
        keepalive_max: 5,
        inactivity_timeout: None,
        // Without this each keystroke waits for the ACK of the previous one
        // (network gear delays ACKs ~200 ms), so typing lags.
        nodelay: true,
        preferred: preferred(legacy),
        ..Default::default()
    }
}

fn port_of(session: &Value) -> u16 {
    let p = num(session.get("port"));
    if p >= 1.0 && p <= 65535.0 {
        p as u16
    } else {
        22
    }
}

/// The private key of a session, asking for its passphrase when needed.
async fn load_private_key(mgr: &Arc<Manager>, conn: &Conn, session: &Value, secret: &Obj) -> Result<Option<PrivateKey>> {
    let path = s(session.get("keyPath"));
    if path.is_empty() {
        return Ok(None);
    }
    // Imported sessions (e.g. from MobaXterm) may point at keys that are not on
    // this machine: skip the key and fall back to password authentication.
    if !std::path::Path::new(&path).exists() {
        conn.note(format!("\x1b[33m[Vytty] Private key not found: {path} - trying password\x1b[0m\r\n"));
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| anyhow!("Cannot load key: {e}"))?;
    let stored = s(secret.get("passphrase"));
    let first = russh::keys::decode_secret_key(&text, if stored.is_empty() { None } else { Some(stored.as_str()) });
    match first {
        Ok(k) => Ok(Some(k)),
        Err(e) if matches!(e, russh::keys::Error::KeyIsEncrypted) || !stored.is_empty() || e.to_string().to_lowercase().contains("encrypt") => {
            let id = s(session.get("id"));
            let ans = mgr
                .ui
                .ask("secret", json!({ "title": "Key passphrase", "label": format!("Passphrase for {path}"), "allowSave": !id.is_empty() }))
                .await
                .ok_or_else(|| anyhow!("Key passphrase required"))?;
            let pass = s(ans.get("value"));
            let key = russh::keys::decode_secret_key(&text, Some(&pass)).map_err(|e| anyhow!("Cannot load key: {e}"))?;
            if truthy(ans.get("save")) && !id.is_empty() {
                mgr.save_secret(&id, [("passphrase".to_string(), json!(pass))].into_iter().collect());
            }
            Ok(Some(key))
        }
        Err(e) => bail!("Cannot load key: {e}"),
    }
}

async fn connect_agent() -> Option<russh::keys::agent::client::AgentClient<Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin>>> {
    #[cfg(unix)]
    {
        russh::keys::agent::client::AgentClient::connect_env().await.ok().map(|a| a.dynamic())
    }
    #[cfg(windows)]
    {
        if let Ok(sock) = std::env::var("SSH_AUTH_SOCK") {
            if let Ok(a) = russh::keys::agent::client::AgentClient::connect_named_pipe(sock).await {
                return Some(a.dynamic());
            }
        }
        if let Ok(a) = russh::keys::agent::client::AgentClient::connect_pageant().await {
            return Some(a.dynamic());
        }
        russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await.ok().map(|a| a.dynamic())
    }
}

fn allows(methods: &[MethodKind], m: MethodKind) -> bool {
    methods.is_empty() || methods.contains(&m)
}

async fn rsa_hash(h: &Handle<Handler>, is_rsa: bool) -> Option<HashAlg> {
    if is_rsa {
        h.best_supported_rsa_hash().await.ok().flatten().flatten()
    } else {
        None
    }
}

async fn ask_password(cx: &AuthCtx<'_>, sid: &str, label: String) -> Option<String> {
    let ans = cx.pause.ask(cx.mgr, "secret", json!({ "title": "Password", "label": label, "allowSave": !sid.is_empty() })).await?;
    let value = s(ans.get("value"));
    if truthy(ans.get("save")) && !sid.is_empty() {
        cx.mgr.save_secret(sid, [("password".to_string(), json!(value))].into_iter().collect());
    }
    Some(value)
}

struct AuthCtx<'a> {
    mgr: &'a Arc<Manager>,
    pause: &'a Pause,
    session: &'a Value,
    host: &'a str,
    username: &'a str,
}

async fn authenticate(h: &mut Handle<Handler>, cx: AuthCtx<'_>, secret: &Obj, key: Option<PrivateKey>) -> Result<()> {
    let user = cx.username;
    let sid = s(cx.session.get("id"));
    // What does the server accept?
    let mut methods: Vec<MethodKind> = match h.authenticate_none(user).await? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure { remaining_methods, .. } => remaining_methods.to_vec(),
    };
    if let Some(k) = key {
        if allows(&methods, MethodKind::PublicKey) {
            let hash = rsa_hash(h, k.algorithm().is_rsa()).await;
            match h.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(k), hash)).await? {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { remaining_methods, .. } => methods = remaining_methods.to_vec(),
            }
        }
    }
    if truthy(cx.session.get("useAgent")) && allows(&methods, MethodKind::PublicKey) {
        if let Some(mut agent) = connect_agent().await {
            for ident in agent.request_identities().await.unwrap_or_default() {
                let pk = match ident {
                    russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key,
                    _ => continue,
                };
                let hash = rsa_hash(h, pk.algorithm().is_rsa()).await;
                if let Ok(r) = h.authenticate_publickey_with(user, pk, hash, &mut agent).await {
                    match r {
                        AuthResult::Success => return Ok(()),
                        AuthResult::Failure { remaining_methods, .. } => methods = remaining_methods.to_vec(),
                    }
                }
            }
        }
    }
    let mut password = s(secret.get("password"));
    let mut asked = false;
    if allows(&methods, MethodKind::Password) {
        for attempt in 0..3 {
            if password.is_empty() || attempt > 0 {
                let label = if attempt == 0 { format!("Password for {user}@{}", cx.host) } else { format!("Wrong password. Password for {user}@{}", cx.host) };
                match ask_password(&cx, &sid, label).await {
                    Some(p) => {
                        password = p;
                        asked = true;
                    }
                    None => bail!("Authentication cancelled"),
                }
            }
            match h.authenticate_password(user, &password).await? {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { remaining_methods, .. } => {
                    methods = remaining_methods.to_vec();
                    if !allows(&methods, MethodKind::Password) {
                        break;
                    }
                }
            }
        }
    }
    if allows(&methods, MethodKind::KeyboardInteractive) {
        static PW: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)password").unwrap());
        for round in 0..3 {
            let mut resp = h.authenticate_keyboard_interactive_start(user, None).await?;
            loop {
                match resp {
                    KeyboardInteractiveAuthResponse::Success => return Ok(()),
                    KeyboardInteractiveAuthResponse::Failure { .. } => break,
                    KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                        let mut answers = vec![];
                        for p in prompts {
                            if PW.is_match(&p.prompt) && !password.is_empty() && !asked && round == 0 {
                                answers.push(password.clone());
                                continue;
                            }
                            let label = if instructions.is_empty() { p.prompt.clone() } else { format!("{instructions}\n{}", p.prompt) };
                            let title = if name.is_empty() { "Authentication".to_string() } else { name.clone() };
                            let ans = cx.pause.ask(cx.mgr, "secret", json!({ "title": title, "label": label, "plain": p.echo })).await;
                            match ans {
                                Some(a) => answers.push(s(a.get("value"))),
                                None => bail!("Authentication cancelled"),
                            }
                            if PW.is_match(&p.prompt) {
                                asked = true;
                            }
                        }
                        resp = h.authenticate_keyboard_interactive_respond(answers).await?;
                    }
                }
            }
        }
    }
    bail!("All configured authentication methods failed")
}

/// Connects and authenticates; `stream` is the tunnel through a jump host.
pub async fn connect_client(mgr: &Arc<Manager>, conn: &Arc<Conn>, session: &Value, secret: &Obj, stream: Option<russh::ChannelStream<russh::client::Msg>>) -> Result<Handle<Handler>> {
    let host = s(session.get("host"));
    if host.is_empty() {
        bail!("No host");
    }
    let port = port_of(session);
    let mut username = s(session.get("username"));
    if username.is_empty() {
        let ans = mgr.ui.ask("secret", json!({ "title": "Login", "label": format!("Username for {host}"), "plain": true })).await.ok_or_else(|| anyhow!("Username required"))?;
        username = s(ans.get("value"));
    }
    let key = load_private_key(mgr, conn, session, secret).await?;
    let cfg = Arc::new(config(mgr, session));
    let pause = Pause::new();
    let handler = Handler { mgr: mgr.clone(), host: host.clone(), port, pause: pause.clone(), banner: Some(conn.out.clone()) };
    let timeout = num(Some(&mgr.setting(&["ssh", "readyTimeout"])));
    let timeout = Duration::from_millis(if timeout > 0.0 { timeout as u64 } else { 20000 });
    let work = async {
        let mut h = match stream {
            Some(st) => russh::client::connect_stream(cfg, st, handler).await?,
            None => russh::client::connect(cfg, (host.as_str(), port), handler).await?,
        };
        authenticate(&mut h, AuthCtx { mgr, pause: &pause, session, host: &host, username: &username }, secret, key).await?;
        Ok::<_, anyhow::Error>(h)
    };
    tokio::select! {
        r = work => r,
        e = pause.watchdog(timeout) => Err(e),
    }
}

pub fn error_text(e: &anyhow::Error) -> String {
    if let Some(r) = e.downcast_ref::<russh::Error>() {
        return match r {
            russh::Error::UnknownKey => "The host key was not accepted".into(),
            russh::Error::IO(io) => io.to_string(),
            russh::Error::NoCommonAlgo { kind, .. } => format!("No common {kind:?} algorithm with the server - try \"Legacy algorithms\" in the session"),
            other => other.to_string(),
        };
    }
    e.to_string()
}

pub async fn run(mgr: Arc<Manager>, conn: Arc<Conn>, mut cmds: UnboundedReceiver<Cmd>) -> Result<()> {
    let session = conn.session.clone();
    let mut jump = None;
    let tunnel = match session.get("jump").and_then(|j| j.get("session")).filter(|v| v.is_object()) {
        Some(js) => {
            conn.note(format!("\x1b[2mVia jump host {}...\x1b[0m\r\n", s(js.get("host"))));
            let jsecret = mgr.secret_for(js, None);
            let jh = connect_client(&mgr, &conn, js, &jsecret, None).await?;
            let ch = jh.channel_open_direct_tcpip(s(session.get("host")), port_of(&session) as u32, "127.0.0.1", 0).await?;
            jump = Some(Arc::new(jh));
            Some(ch.into_stream())
        }
        None => None,
    };
    let h = connect_client(&mgr, &conn, &session, &conn.secret, tunnel).await?;
    let client = Client { handle: Arc::new(h), jump };
    if conn.is_closed() {
        return Ok(());
    }
    *conn.ssh.lock().unwrap() = Some(client.clone());

    let ch = client.handle.channel_open_session().await?;
    let (cols, rows) = conn.size();
    ch.request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]).await?;
    ch.request_shell(false).await?;
    let (mut read, write) = ch.split();
    let _ = conn.out.send(Out::Status("connected", describe(&session)));
    setup_forwards(&conn, &client);
    let _ = conn.out.send(Out::Connected { auto_login: false });
    loop {
        tokio::select! {
            m = read.wait() => match m {
                Some(ChannelMsg::Data { data }) => { let _ = conn.out.send(Out::Data(data.to_vec())); }
                Some(ChannelMsg::ExtendedData { data, .. }) => { let _ = conn.out.send(Out::Data(data.to_vec())); }
                Some(ChannelMsg::Close) | None => { let _ = conn.out.send(Out::End("Session ended".into())); break; }
                _ => {}
            },
            c = cmds.recv() => match c {
                Some(Cmd::Write(b)) => write.data(&b[..]).await?,
                Some(Cmd::Resize(c, r)) => write.window_change(c as u32, r as u32, 0, 0).await?,
                None => break,
            },
        }
    }
    Ok(())
}

impl Client {
    pub async fn close(&self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        if let Some(j) = &self.jump {
            let _ = j.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
    }
}

fn setup_forwards(conn: &Arc<Conn>, client: &Client) {
    let list = conn.session.get("forwards").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for f in list {
        let lp = num(f.get("listenPort"));
        if !(1.0..=65535.0).contains(&lp) {
            continue;
        }
        let lp = lp as u16;
        let lh = s(f.get("listenHost"));
        let lh = if lh.is_empty() { "127.0.0.1".to_string() } else { lh };
        let dynamic = s(f.get("type")) == "D";
        let dest_host = s(f.get("destHost"));
        let dest_port = num(f.get("destPort")) as u32;
        let c = conn.clone();
        let handle = client.handle.clone();
        let task = tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind((lh.as_str(), lp)).await {
                Ok(l) => l,
                Err(e) => {
                    c.note(format!("\r\n\x1b[31m[forward {lp}] {e}\x1b[0m\r\n"));
                    return;
                }
            };
            let what = if dynamic { "SOCKS5 proxy".to_string() } else { format!("-> {dest_host}:{dest_port}") };
            c.note(format!("\x1b[2m[forward] {lh}:{lp} {what}\x1b[0m\r\n"));
            loop {
                let Ok((sock, peer)) = listener.accept().await else { break };
                let handle = handle.clone();
                let dest_host = dest_host.clone();
                tokio::spawn(async move {
                    let _ = sock.set_nodelay(true);
                    let _ = if dynamic { socks5(handle, sock).await } else { forward(handle, sock, peer, dest_host, dest_port).await };
                });
            }
        });
        conn.add_task(task.abort_handle());
    }
}

async fn forward(handle: Arc<Handle<Handler>>, mut sock: tokio::net::TcpStream, peer: std::net::SocketAddr, host: String, port: u32) -> Result<()> {
    let ch = handle.channel_open_direct_tcpip(host, port, peer.ip().to_string(), peer.port() as u32).await?;
    let mut st = ch.into_stream();
    tokio::io::copy_bidirectional(&mut sock, &mut st).await?;
    Ok(())
}

/// Minimal SOCKS5 (no authentication, CONNECT only) for dynamic forwarding.
async fn socks5(handle: Arc<Handle<Handler>>, mut sock: tokio::net::TcpStream) -> Result<()> {
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!("not SOCKS5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    sock.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[0] != 5 || req[1] != 1 {
        bail!("unsupported SOCKS request");
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            sock.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => bail!("bad address type"),
    };
    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port) as u32;
    match handle.channel_open_direct_tcpip(host, port, "127.0.0.1", 0).await {
        Ok(ch) => {
            sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let mut st = ch.into_stream();
            tokio::io::copy_bidirectional(&mut sock, &mut st).await?;
        }
        Err(_) => {
            sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        }
    }
    Ok(())
}
