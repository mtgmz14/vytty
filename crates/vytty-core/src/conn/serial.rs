//! Serial consoles (COM ports, USB-serial adapters).
use super::{describe, Cmd, Conn, Manager, Out};
use crate::util::{num, s};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

pub fn list_ports() -> Value {
    let ports = serialport::available_ports().unwrap_or_default();
    Value::Array(
        ports
            .into_iter()
            .map(|p| {
                let extra = match &p.port_type {
                    serialport::SerialPortType::UsbPort(u) => u.product.clone().or_else(|| u.manufacturer.clone()),
                    _ => None,
                };
                let label = match extra {
                    Some(e) if !e.is_empty() => format!("{} - {e}", p.port_name),
                    _ => p.port_name.clone(),
                };
                json!({ "path": p.port_name, "label": label })
            })
            .collect(),
    )
}

pub async fn run(_mgr: Arc<Manager>, conn: Arc<Conn>, mut cmds: UnboundedReceiver<Cmd>) -> Result<()> {
    let sess = &conn.session;
    let path = s(sess.get("serialPath"));
    if path.is_empty() {
        return Err(anyhow!("No serial port set"));
    }
    let n = |k: &str, d: f64| {
        let v = num(sess.get(k));
        if v == 0.0 {
            d
        } else {
            v
        }
    };
    let data_bits = match n("dataBits", 8.0) as u8 {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    };
    let parity = match s(sess.get("parity")).as_str() {
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    };
    let stop = if n("stopBits", 1.0) >= 1.5 { serialport::StopBits::Two } else { serialport::StopBits::One };
    let flow = match s(sess.get("flowControl")).as_str() {
        "hardware" => serialport::FlowControl::Hardware,
        "software" => serialport::FlowControl::Software,
        _ => serialport::FlowControl::None,
    };
    let baud = n("baudRate", 9600.0) as u32;
    let open_path = path.clone();
    let port = tokio::task::spawn_blocking(move || {
        serialport::new(open_path, baud).data_bits(data_bits).parity(parity).stop_bits(stop).flow_control(flow).timeout(Duration::from_millis(100)).open()
    })
    .await?
    .map_err(|e| anyhow!("{path}: {e}"))?;
    let mut reader = port.try_clone().map_err(|e| anyhow!("{path}: {e}"))?;
    let mut writer = port;
    let stop_flag = Arc::new(AtomicBool::new(false));
    let flag = stop_flag.clone();
    conn.on_close(Box::new(move || flag.store(true, Ordering::SeqCst)));

    let out = conn.out.clone();
    let flag = stop_flag.clone();
    std::thread::Builder::new().name("vytty-serial-read".into()).spawn(move || {
        let mut buf = vec![0u8; 8192];
        while !flag.load(Ordering::SeqCst) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    let _ = out.send(Out::Data(buf[..n].to_vec()));
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    if !flag.load(Ordering::SeqCst) {
                        let _ = out.send(Out::End(format!("Serial port closed ({e})")));
                    }
                    break;
                }
            }
        }
    })?;

    let _ = conn.out.send(Out::Status("connected", describe(sess)));
    let _ = conn.out.send(Out::Connected { auto_login: true });
    // Wake the console so the prompt shows up.
    let wake = conn.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if !wake.is_closed() {
            let _ = wake.tx.send(Cmd::Write(b"\r".to_vec()));
        }
    });
    let flag = stop_flag.clone();
    tokio::task::spawn_blocking(move || {
        while let Some(c) = cmds.blocking_recv() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            if let Cmd::Write(b) = c {
                let _ = writer.write_all(&b).and_then(|_| writer.flush());
            }
        }
    })
    .await?;
    Ok(())
}
