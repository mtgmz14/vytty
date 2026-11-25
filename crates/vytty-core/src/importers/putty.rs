//! PuTTY / KiTTY sessions from a registry export (.reg):
//!   reg export HKCU\Software\SimonTatham\PuTTY\Sessions putty.reg
//!   reg export HKCU\Software\9bis.com\KiTTY\Sessions kitty.reg
//! Regedit writes UTF-16 ("Windows Registry Editor Version 5.00") or ANSI
//! ("REGEDIT4"). Session names are URL-encoded (%20 = space). PuTTY never
//! stores passwords, so there are none to import.
use super::common::{decode_text, split_user_host, TreeBuilder};
use crate::util::{jnum, Obj};
use anyhow::{bail, Result};
use regex::Regex;
use serde_json::json;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone)]
pub enum RegVal {
    Str(String),
    Num(i64),
}

impl RegVal {
    fn text(&self) -> String {
        match self {
            RegVal::Str(s) => s.clone(),
            RegVal::Num(n) => n.to_string(),
        }
    }
    fn number(&self) -> f64 {
        match self {
            RegVal::Str(s) => crate::util::parse_js_number(s),
            RegVal::Num(n) => *n as f64,
        }
    }
}

pub struct RegKey {
    pub path: String,
    pub values: HashMap<String, RegVal>,
}

static SESSION_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\\(?:SimonTatham\\PuTTY|9bis\.com\\KiTTY|[^\\]+)\\Sessions\\(.+)$").unwrap());
static HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\[(-?)([^\]]+)\]\s*$").unwrap());
static VALUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$"#).unwrap());
static UNQUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\\(["\\])"#).unwrap());
static REG_HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(Windows Registry Editor|REGEDIT4)").unwrap());
static CONTINUED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\\s*$").unwrap());

fn unquote(s: &str) -> String {
    UNQUOTE.replace_all(s, "$1").into_owned()
}

pub fn parse_reg(text: &str) -> Vec<RegKey> {
    let lines: Vec<&str> = text.split("\r\n").flat_map(|l| l.split(['\r', '\n'])).collect();
    let mut keys: Vec<RegKey> = vec![];
    let mut cur: Option<usize> = None;
    let mut i = 0;
    while i < lines.len() {
        let mut line = lines[i].to_string();
        // Hex values continue on the next line after a trailing backslash.
        while CONTINUED.is_match(&line) && i + 1 < lines.len() && !lines[i + 1].trim_start().starts_with('"') {
            line = format!("{}{}", CONTINUED.replace(&line, ""), lines[i + 1].trim());
            i += 1;
        }
        i += 1;
        if let Some(h) = HEADER.captures(&line) {
            if &h[1] == "-" {
                cur = None;
            } else {
                keys.push(RegKey { path: h[2].to_string(), values: HashMap::new() });
                cur = Some(keys.len() - 1);
            }
            continue;
        }
        let Some(k) = cur else { continue };
        let Some(v) = VALUE.captures(&line) else { continue };
        let name = unquote(&v[1]);
        let raw = v[2].trim();
        if let Some(q) = raw.strip_prefix('"') {
            keys[k].values.insert(name, RegVal::Str(unquote(q.strip_suffix('"').unwrap_or(q))));
        } else if raw.len() >= 6 && raw[..6].eq_ignore_ascii_case("dword:") {
            if let Ok(n) = i64::from_str_radix(raw[6..].trim(), 16) {
                keys[k].values.insert(name, RegVal::Num(n));
            }
        }
    }
    keys
}

fn decode_uri_component(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8().map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

const PARITY: [&str; 5] = ["none", "odd", "even", "mark", "space"];

pub fn parse(input: &[u8]) -> Result<Obj> {
    let text = decode_text(input);
    if !REG_HEAD.is_match(&text) {
        bail!("Not a registry export (.reg) file");
    }
    let lower = text.to_lowercase();
    let root = if lower.contains("kitty") && !lower.contains("simontatham") { "KiTTY" } else { "PuTTY" };
    let mut tree = TreeBuilder::new(Some(root));
    for key in parse_reg(&text) {
        let Some(m) = SESSION_KEY.captures(&key.path) else { continue };
        let raw_name = &m[1];
        if raw_name.contains('\\') {
            continue;
        }
        let name = decode_uri_component(raw_name);
        if name.eq_ignore_ascii_case("Default Settings") {
            continue;
        }
        let v = &key.values;
        let get = |k: &str| v.get(k);
        let text_of = |k: &str| get(k).map(|x| x.text()).unwrap_or_default();
        let num_of = |k: &str| get(k).map(|x| x.number()).unwrap_or(0.0);
        let proto = get("Protocol").map(|x| x.text()).unwrap_or_else(|| "ssh".into()).to_lowercase();
        // KiTTY can group sessions in folders.
        let folder_id = match get("Folder") {
            Some(f) if !f.text().is_empty() => {
                let segs: Vec<String> = f.text().split(['\\', '/']).map(String::from).collect();
                tree.folder(&segs)
            }
            _ => None,
        };
        let mut base = Obj::new();
        base.insert("name".into(), json!(name));
        if let Some(f) = &folder_id {
            base.insert("folderId".into(), json!(f));
        }
        if proto == "ssh" || proto == "telnet" {
            let (mut user, host) = split_user_host(&text_of("HostName"));
            if user.is_empty() {
                user = text_of("UserName");
            }
            if host.is_empty() {
                tree.skip(&proto.to_uppercase());
                continue;
            }
            let port = num_of("PortNumber");
            let mut s = base;
            s.insert("protocol".into(), json!(proto));
            s.insert("host".into(), json!(host));
            s.insert("port".into(), jnum(if port == 0.0 { if proto == "ssh" { 22.0 } else { 23.0 } } else { port }));
            s.insert("username".into(), json!(user));
            if proto == "ssh" && !text_of("PublicKeyFile").is_empty() {
                s.insert("keyPath".into(), json!(text_of("PublicKeyFile")));
            }
            if proto == "telnet" {
                s.insert("autoLogin".into(), json!(true));
            }
            if !text_of("ProxyHost").is_empty() && num_of("ProxyMethod") > 0.0 {
                s.insert("notes".into(), json!(format!("Proxy in PuTTY: {}:{}", text_of("ProxyHost"), text_of("ProxyPort"))));
            }
            tree.add(s, if proto == "ssh" { "SSH" } else { "Telnet" });
        } else if proto == "serial" {
            let line = text_of("SerialLine");
            if line.is_empty() {
                tree.skip("Serial");
                continue;
            }
            let flow = num_of("SerialFlowControl");
            let stop = match num_of("SerialStopHalfbits") as i64 {
                2 => 1.0,
                3 => 1.5,
                4 => 2.0,
                _ => 1.0,
            };
            let mut s = base;
            s.insert("protocol".into(), json!("serial"));
            s.insert("serialPath".into(), json!(line));
            s.insert("baudRate".into(), jnum(if num_of("SerialSpeed") == 0.0 { 9600.0 } else { num_of("SerialSpeed") }));
            s.insert("dataBits".into(), jnum(if num_of("SerialDataBits") == 0.0 { 8.0 } else { num_of("SerialDataBits") }));
            s.insert("parity".into(), json!(PARITY.get(num_of("SerialParity") as usize).copied().unwrap_or("none")));
            s.insert("stopBits".into(), jnum(stop));
            s.insert(
                "flowControl".into(),
                json!(if flow == 2.0 { "hardware" } else if flow == 1.0 { "software" } else { "none" }),
            );
            tree.add(s, "Serial");
        } else {
            let label = match proto.as_str() {
                "raw" => "Raw".to_string(),
                "rlogin" => "Rlogin".to_string(),
                p => p.to_string(),
            };
            tree.skip(&label);
        }
    }
    Ok(tree.result())
}
