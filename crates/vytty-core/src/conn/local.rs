//! Local shells in a pseudo terminal (ConPTY on Windows).
use super::{describe, split_args, Cmd, Conn, Manager, Out};
use crate::util::s;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

pub fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into())
    }
}

pub async fn run(_mgr: Arc<Manager>, conn: Arc<Conn>, mut cmds: UnboundedReceiver<Cmd>) -> Result<()> {
    let sess = &conn.session;
    let shell = Some(s(sess.get("shell"))).filter(|x| !x.is_empty()).unwrap_or_else(default_shell);
    let (cols, rows) = conn.size();
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| anyhow!("{e}"))?;
    let mut cmd = CommandBuilder::new(&shell);
    for a in split_args(&s(sess.get("shellArgs"))) {
        cmd.arg(a);
    }
    let cwd = s(sess.get("cwd"));
    let cwd = if cwd.is_empty() { dirs::home_dir().unwrap_or_default() } else { cwd.into() };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| anyhow!("{shell}: {e}"))?;
    drop(pair.slave);
    let mut killer = child.clone_killer();
    conn.on_close(Box::new(move || {
        let _ = killer.kill();
    }));
    let mut reader = pair.master.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
    let mut writer = pair.master.take_writer().map_err(|e| anyhow!("{e}"))?;
    let master = Arc::new(Mutex::new(pair.master));

    let out = conn.out.clone();
    let (read_done_tx, read_done) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new().name("vytty-pty-read".into()).spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = out.send(Out::Data(buf[..n].to_vec()));
                }
            }
        }
        let _ = read_done_tx.send(());
    })?;

    let out = conn.out.clone();
    std::thread::Builder::new().name("vytty-pty-wait".into()).spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
        // Let the last output arrive before the tab says the process ended.
        let _ = read_done.recv_timeout(Duration::from_millis(500));
        let _ = out.send(Out::End(format!("Process exited with code {code}")));
    })?;

    let _ = conn.out.send(Out::Status("connected", describe(sess)));
    let _ = conn.out.send(Out::Connected { auto_login: false });
    tokio::task::spawn_blocking(move || {
        while let Some(c) = cmds.blocking_recv() {
            match c {
                Cmd::Write(b) => {
                    if writer.write_all(&b).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
                Cmd::Resize(c, r) => {
                    let _ = master.lock().unwrap().resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                }
            }
        }
    })
    .await?;
    Ok(())
}
