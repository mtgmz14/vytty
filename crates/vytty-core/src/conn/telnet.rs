//! Telnet with a small option negotiator: answers ECHO / SGA, reports the
//! window size (NAWS) and the terminal type, escapes IAC in user data.
use super::{describe, Cmd, Conn, Manager, Out};
use crate::util::{num, s};
use anyhow::{anyhow, Result};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedReceiver;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

/// The protocol state between reads.
#[derive(Default)]
pub struct Negotiator {
    state: u8, // 0 data, 1 IAC, 2 option verb, 3 SB, 4 SB-IAC
    verb: u8,
    sb: Vec<u8>,
    pub naws: bool,
}

impl Negotiator {
    /// Splits received bytes into terminal data and replies for the server.
    pub fn feed(&mut self, buf: &[u8], size: (u16, u16)) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::with_capacity(buf.len());
        let mut reply = vec![];
        for &b in buf {
            match self.state {
                0 => {
                    if b == IAC {
                        self.state = 1
                    } else {
                        out.push(b)
                    }
                }
                1 => {
                    if b == IAC {
                        out.push(IAC);
                        self.state = 0;
                    } else if (WILL..=DONT).contains(&b) {
                        self.verb = b;
                        self.state = 2;
                    } else if b == SB {
                        self.sb.clear();
                        self.state = 3;
                    } else {
                        self.state = 0;
                    }
                }
                2 => {
                    let opt = b;
                    if self.verb == DO {
                        match opt {
                            NAWS => {
                                reply.extend([IAC, WILL, NAWS]);
                                self.naws = true;
                                reply.extend(naws_bytes(size));
                            }
                            TTYPE => reply.extend([IAC, WILL, TTYPE]),
                            SGA => reply.extend([IAC, WILL, SGA]),
                            _ => reply.extend([IAC, WONT, opt]),
                        }
                    } else if self.verb == WILL {
                        if opt == ECHO || opt == SGA {
                            reply.extend([IAC, DO, opt]);
                        } else {
                            reply.extend([IAC, DONT, opt]);
                        }
                    }
                    self.state = 0;
                }
                3 => {
                    if b == IAC {
                        self.state = 4
                    } else {
                        self.sb.push(b)
                    }
                }
                _ => {
                    if b == SE {
                        if self.sb.first() == Some(&TTYPE) && self.sb.get(1) == Some(&1) {
                            reply.extend([IAC, SB, TTYPE, 0]);
                            reply.extend(b"XTERM-256COLOR");
                            reply.extend([IAC, SE]);
                        }
                        self.state = 0;
                    } else {
                        self.sb.push(b);
                        self.state = 3;
                    }
                }
            }
        }
        (out, reply)
    }
}

pub fn naws_bytes((cols, rows): (u16, u16)) -> Vec<u8> {
    vec![IAC, SB, NAWS, (cols >> 8) as u8, (cols & 255) as u8, (rows >> 8) as u8, (rows & 255) as u8, IAC, SE]
}

pub fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
    out
}

pub async fn run(mgr: Arc<Manager>, conn: Arc<Conn>, mut cmds: UnboundedReceiver<Cmd>) -> Result<()> {
    let host = s(conn.session.get("host"));
    let p = num(conn.session.get("port"));
    let port = if (1.0..=65535.0).contains(&p) { p as u16 } else { 23 };
    // Without a timeout an unreachable device keeps the tab "connecting" for
    // the OS TCP timeout (21 s on Windows, minutes on Linux).
    let t = num(Some(&mgr.setting(&["ssh", "readyTimeout"])));
    let timeout = Duration::from_millis(if t > 0.0 { t as u64 } else { 20000 });
    let mut sock = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| anyhow!("Timed out connecting to {host}:{port}"))??;
    let _ = sock.set_nodelay(true);
    let _ = conn.out.send(Out::Status("connected", describe(&conn.session)));
    let _ = conn.out.send(Out::Connected { auto_login: true });
    let mut neg = Negotiator::default();
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        tokio::select! {
            r = sock.read(&mut buf) => {
                let n = r?;
                if n == 0 {
                    let _ = conn.out.send(Out::End("Connection closed by remote host".into()));
                    return Ok(());
                }
                let (data, reply) = neg.feed(&buf[..n], conn.size());
                if !reply.is_empty() {
                    sock.write_all(&reply).await?;
                }
                if !data.is_empty() {
                    let _ = conn.out.send(Out::Data(data));
                }
            }
            c = cmds.recv() => match c {
                Some(Cmd::Write(b)) => sock.write_all(&escape_iac(&b)).await?,
                Some(Cmd::Resize(c, r)) => if neg.naws { sock.write_all(&naws_bytes((c, r))).await? },
                None => return Ok(()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation() {
        let mut n = Negotiator::default();
        let (data, reply) = n.feed(&[b'h', IAC, DO, NAWS, IAC, WILL, ECHO, IAC, DO, 99, IAC, IAC, b'i'], (100, 30));
        assert_eq!(data, vec![b'h', IAC, b'i']);
        let mut want = vec![IAC, WILL, NAWS];
        want.extend(naws_bytes((100, 30)));
        want.extend([IAC, DO, ECHO, IAC, WONT, 99]);
        assert_eq!(reply, want);
        assert!(n.naws);
        // TTYPE SEND split across two reads.
        let (_, r1) = n.feed(&[IAC, SB, TTYPE], (80, 24));
        let (_, r2) = n.feed(&[1, IAC, SE], (80, 24));
        assert!(r1.is_empty());
        assert!(r2.windows(14).any(|w| w == b"XTERM-256COLOR"));
        assert_eq!(escape_iac(&[1, IAC, 2]), vec![1, IAC, IAC, 2]);
    }
}
