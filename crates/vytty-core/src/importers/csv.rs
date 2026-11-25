//! Sessions from a CSV file - from Excel, a CMDB / IPAM export, LibreNMS,
//! Zabbix, phpIPAM... The first row names the columns (any order, common
//! aliases accepted); the delimiter (comma, semicolon or tab) is detected.
//!   name, host, port, protocol, username, folder, notes, key, serial, baud, platform
use super::common::{decode_text, guess_highlight, split_user_host, TreeBuilder};
use crate::util::{jnum, Obj};
use anyhow::{bail, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

const ALIASES: &[(&str, &[&str])] = &[
    ("name", &["name", "session", "session name", "label", "device", "device name", "sysname", "display name"]),
    (
        "host",
        &["host", "hostname", "address", "ip", "ip address", "ip_address", "ipaddress", "primary ip", "mgmt ip", "management ip", "fqdn", "dns name"],
    ),
    ("port", &["port", "ssh port"]),
    ("protocol", &["protocol", "proto", "type", "connection type", "method"]),
    ("username", &["username", "user", "login", "user name"]),
    ("folder", &["folder", "group", "path", "site", "location", "category"]),
    ("notes", &["notes", "note", "description", "descr", "comment", "comments"]),
    ("keyPath", &["key", "keyfile", "keypath", "key file", "private key", "identityfile", "identity file"]),
    ("serialPath", &["serial", "serialpath", "serial port", "com", "com port", "comport", "line"]),
    ("baudRate", &["baud", "baudrate", "baud rate", "speed"]),
    ("platform", &["platform", "os", "device type", "vendor", "model", "highlight"]),
    ("color", &["color", "colour"]),
];

pub fn detect_delimiter(line: &str) -> char {
    let mut counts = [(',', 0usize), (';', 0), ('\t', 0)];
    let mut q = false;
    for c in line.chars() {
        if c == '"' {
            q = !q;
        } else if !q {
            if let Some(e) = counts.iter_mut().find(|(d, _)| *d == c) {
                e.1 += 1;
            }
        }
    }
    // Stable: on a tie the earlier delimiter wins, like Array.prototype.sort.
    let mut best = counts[0];
    for e in counts.iter().skip(1) {
        if e.1 > best.1 {
            best = *e;
        }
    }
    best.0
}

/// RFC 4180: quoted fields, doubled quotes, line breaks inside quotes.
pub fn parse_rows(text: &str, delim: char) -> Vec<Vec<String>> {
    let chars: Vec<char> = text.chars().collect();
    let mut rows = vec![];
    let mut row: Vec<String> = vec![];
    let mut field = String::new();
    let mut q = false;
    let mut i = 0;
    let keep = |r: &Vec<String>| r.iter().any(|f| !f.trim().is_empty());
    while i < chars.len() {
        let c = chars[i];
        if q {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 1;
                } else {
                    q = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' {
            q = true;
        } else if c == delim {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut field));
            if keep(&row) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else {
            field.push(c);
        }
        i += 1;
    }
    row.push(field);
    if keep(&row) {
        rows.push(row);
    }
    rows
}

fn protocol_of(value: &str, port: &str, serial: bool) -> &'static str {
    let v = value.to_lowercase();
    if v.contains("ssh") {
        "ssh"
    } else if v.contains("telnet") {
        "telnet"
    } else if v.contains("serial") || v.contains("com") || v.contains("console") {
        "serial"
    } else if v.contains("local") || v.contains("shell") || v.contains("powershell") || v.contains("cmd") {
        "local"
    } else if serial {
        "serial"
    } else if crate::util::parse_js_number(port) == 23.0 {
        "telnet"
    } else {
        "ssh"
    }
}

pub fn parse(input: &[u8]) -> Result<Obj> {
    static CIDR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/[0-9]+$").unwrap());
    static FOLDER_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[\\/>]\s*").unwrap());
    static COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^#[0-9a-f]{6}$").unwrap());
    let text = decode_text(input);
    let first_line = text.split('\n').next().unwrap_or("").trim_end_matches('\r');
    let rows = parse_rows(&text, detect_delimiter(first_line));
    if rows.len() < 2 {
        bail!("The CSV file needs a header row and at least one session");
    }
    let header: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase().trim_start_matches('\u{feff}').to_string()).collect();
    let mut col: HashMap<&str, usize> = HashMap::new();
    for (key, names) in ALIASES {
        if let Some(i) = header.iter().position(|h| names.contains(&h.as_str())) {
            col.insert(key, i);
        }
    }
    if !col.contains_key("host") && !col.contains_key("serialPath") {
        bail!("No host (or serial port) column found. Name it \"host\", \"hostname\" or \"ip\".");
    }
    let mut tree = TreeBuilder::new(None);
    for r in rows.iter().skip(1) {
        let get = |k: &str| col.get(k).and_then(|&i| r.get(i)).map(|v| v.trim().to_string()).unwrap_or_default();
        let (user, host) = split_user_host(&get("host"));
        let host = CIDR.replace(&host, "").to_string(); // "10.0.0.1/24" from IPAM exports
        let serial_path = get("serialPath");
        let port = get("port");
        let protocol = protocol_of(&get("protocol"), &port, !serial_path.is_empty() && host.is_empty());
        let missing = if protocol == "serial" { serial_path.is_empty() } else { protocol != "local" && host.is_empty() };
        if missing {
            tree.skip(protocol);
            continue;
        }
        let folder = get("folder");
        let folder_id = if folder.is_empty() {
            None
        } else {
            let segs: Vec<String> = FOLDER_SPLIT.split(&folder).map(String::from).collect();
            tree.folder(&segs)
        };
        let name = [get("name"), host.clone(), serial_path.clone()].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
        let mut s = Obj::new();
        s.insert("name".into(), json!(name));
        s.insert("protocol".into(), json!(protocol));
        s.insert("folderId".into(), folder_id.map(Value::String).unwrap_or(Value::Null));
        s.insert("notes".into(), json!(get("notes")));
        s.insert("highlight".into(), json!(guess_highlight(&get("platform"))));
        match protocol {
            "serial" => {
                let baud = crate::util::parse_js_number(&get("baudRate"));
                s.insert("serialPath".into(), json!(serial_path));
                s.insert("baudRate".into(), jnum(if baud == 0.0 { 9600.0 } else { baud }));
                s.insert("dataBits".into(), json!(8));
                s.insert("parity".into(), json!("none"));
                s.insert("stopBits".into(), json!(1));
                s.insert("flowControl".into(), json!("none"));
            }
            "local" => {
                s.insert("shell".into(), json!(host));
                s.insert("shellArgs".into(), json!(""));
            }
            _ => {
                let p = crate::util::parse_js_number(&port);
                let username = if get("username").is_empty() { user.clone() } else { get("username") };
                s.insert("host".into(), json!(host));
                s.insert("port".into(), jnum(if p == 0.0 { if protocol == "ssh" { 22.0 } else { 23.0 } } else { p }));
                s.insert("username".into(), json!(username));
            }
        }
        if !get("keyPath").is_empty() && protocol == "ssh" {
            s.insert("keyPath".into(), json!(get("keyPath")));
        }
        if protocol == "telnet" {
            s.insert("autoLogin".into(), json!(true));
        }
        if COLOR.is_match(&get("color")) {
            s.insert("color".into(), json!(get("color")));
        }
        tree.add(s, &protocol.to_uppercase());
    }
    Ok(tree.result())
}
