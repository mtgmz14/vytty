//! MobaXterm session files (.mxtsessions, .mobaxterm, MobaXterm.ini or a
//! single .moba). These are CP1252 INI files whose [Bookmarks*] sections hold
//! folders (SubRep) and one session per line.
//!
//! A session line is:  Name= [reconnect]#icon#type%p1%p2%...#terminal%...#0#comment#-1
//! The '%' group after the icon carries the connection parameters; params[0] is
//! the session type (0 SSH, 1 Telnet, 7 SFTP, 8 Serial, 10 Shell...).
//!
//! These files never contain passwords - MobaXterm keeps those encrypted in the
//! Windows registry, tied to the Windows user.
use super::common::decode_cp1252;
use crate::util::{jnum, uid, Obj};
use anyhow::Result;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// MobaXterm escapes a few characters inside its fields.
fn unescape(s: &str) -> String {
    s.replace("__PTVIRG__", ";")
        .replace("__PIPE__", "|")
        .replace("__PERCENT__", "%")
        .replace("__APOS__", "'")
        .replace("__DQUOTE__", "\"")
}

/// Key paths may be relative to MobaXterm placeholders: "_CurrentDrive_:",
/// "_ProfileDir_" (the user's profile) and "_MyDocuments_".
fn fix_path(s: &str) -> String {
    static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_CurrentDrive_:?").unwrap());
    let home = dirs::home_dir().unwrap_or_default();
    let docs = home.join("Documents");
    let u = unescape(s);
    DRIVE
        .replace_all(&u, "C:")
        .replace("_ProfileDir_", &home.to_string_lossy())
        .replace("_MyDocuments_", &docs.to_string_lossy())
}

fn type_proto(t: i64) -> Option<&'static str> {
    match t {
        0 | 7 => Some("ssh"),
        1 => Some("telnet"),
        8 => Some("serial"),
        10 => Some("local"),
        _ => None,
    }
}

fn type_label(t: i64, raw: &str) -> String {
    match t {
        0 => "SSH", 1 => "Telnet", 2 => "RSH", 3 => "XDMCP", 4 => "RDP", 5 => "VNC", 6 => "FTP", 7 => "SFTP", 8 => "Serial",
        9 => "File", 10 => "Shell", 11 => "Browser", 12 => "Mosh", 13 => "AWS S3", 16 => "WSL",
        _ => return format!("type {raw}"),
    }
    .to_string()
}

struct Gateway {
    host: String,
    port: i64,
    username: String,
}

struct Parser {
    folders: Vec<Obj>,
    by_path: HashMap<String, String>,
    skipped: Obj,
}

impl Parser {
    /// Nested folders for a SubRep path; returns the leaf folder id.
    fn folder_for(&mut self, path: &str) -> Option<String> {
        static SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/+").unwrap());
        let clean = SLASHES.replace_all(path, "\\").trim_matches('\\').to_string();
        if clean.is_empty() {
            return None;
        }
        if let Some(id) = self.by_path.get(&clean) {
            return Some(id.clone());
        }
        let mut parent: Option<String> = None;
        let mut acc = String::new();
        for name in clean.split('\\').map(|s| unescape(s.trim())).filter(|s| !s.is_empty()) {
            acc = if acc.is_empty() { name.clone() } else { format!("{acc}\\{name}") };
            let id = match self.by_path.get(&acc) {
                Some(id) => id.clone(),
                None => {
                    let id = uid();
                    let mut f = Map::new();
                    f.insert("id".into(), json!(id));
                    f.insert("name".into(), json!(name));
                    f.insert("parentId".into(), parent.clone().map(Value::String).unwrap_or(Value::Null));
                    self.folders.push(f);
                    self.by_path.insert(acc.clone(), id.clone());
                    id
                }
            };
            parent = Some(id);
        }
        parent
    }

    fn skip(&mut self, label: &str) {
        let n = self.skipped.get(label).and_then(|v| v.as_u64()).unwrap_or(0);
        self.skipped.insert(label.to_string(), json!(n + 1));
    }

    fn parse_session(&mut self, name: &str, value: &str, folder_id: Option<&String>) -> Option<(Obj, String, Option<Gateway>)> {
        static GROUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+%").unwrap());
        static USER_HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^@\s/]+)@(.+)$").unwrap());
        static USER_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^@\s/]+)@\S+$").unwrap());
        static BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[\s*(.*?)\s*\]$").unwrap());
        let fields: Vec<&str> = value.split('#').collect();
        let gi = fields.iter().position(|f| GROUP.is_match(f)).or_else(|| fields.iter().position(|f| f.contains('%')))?;
        let params: Vec<&str> = fields[gi].split('%').collect();
        let p = |i: usize| params.get(i).copied().unwrap_or("");
        let type_id: i64 = {
            let digits: String = p(0).trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().unwrap_or(-1)
        };
        let label = type_label(type_id, p(0));
        let Some(proto) = type_proto(type_id) else {
            self.skip(&label);
            return None;
        };
        let comment = fields.get(gi + 3).map(|s| s.trim()).unwrap_or("");
        let sname = unescape(name).trim().to_string();
        let mut base = Map::new();
        base.insert("id".into(), json!(uid()));
        base.insert("name".into(), json!(if sname.is_empty() { "session".to_string() } else { sname.clone() }));
        base.insert("folderId".into(), folder_id.cloned().map(Value::String).unwrap_or(Value::Null));
        base.insert("highlight".into(), json!("auto"));
        base.insert("logging".into(), json!(true));
        let notes = if !comment.is_empty() && comment != "-1" && comment != "0" { comment.to_string() } else { String::new() };
        base.insert("notes".into(), json!(notes));

        let mut host = unescape(p(1)).trim().to_string();
        let user = p(3).trim();
        let mut username = if !user.is_empty() && user != "<default>" { unescape(user) } else { String::new() };
        // The login is sometimes kept in the host or the session name ("user@host").
        if username.is_empty() {
            if let Some(c) = USER_HOST.captures(&host.clone()) {
                username = c[1].to_string();
                host = c[2].trim().to_string();
            }
        }
        if username.is_empty() {
            if let Some(c) = USER_NAME.captures(base["name"].as_str().unwrap_or("")) {
                username = c[1].to_string();
            }
        }
        // "[root]@host": the brackets are only decoration.
        username = BRACKETS.replace(username.trim(), "$1").to_string();
        let num = |i: usize, d: f64| {
            let n = crate::util::parse_js_number(p(i));
            if n == 0.0 {
                d
            } else {
                n
            }
        };

        let mut s = base;
        match proto {
            "ssh" => {
                if host.is_empty() {
                    self.skip(&label);
                    return None;
                }
                s.insert("protocol".into(), json!("ssh"));
                s.insert("host".into(), json!(host));
                s.insert("port".into(), jnum(num(2, 22.0)));
                s.insert("username".into(), json!(username));
                let key = fix_path(p(14)).trim().to_string();
                if !key.is_empty() {
                    s.insert("keyPath".into(), json!(key));
                }
                // SSH gateway (jump host); a chain separated by "|" uses the first hop.
                let gw_host = unescape(p(8)).trim().split('|').next().unwrap_or("").trim().to_string();
                let mut gateway = None;
                let mut notes = notes.clone();
                if !gw_host.is_empty() {
                    let gw_user = unescape(p(10)).split('|').next().unwrap_or("").trim().to_string();
                    let gw_port_raw = if p(9).is_empty() { "22" } else { p(9) };
                    let gp = crate::util::parse_js_number(gw_port_raw.split('|').next().unwrap_or("22"));
                    gateway = Some(Gateway { host: gw_host, port: if gp == 0.0 { 22 } else { gp as i64 }, username: gw_user });
                    if p(8).contains('|') {
                        notes = format!("{}MobaXterm gateway chain {}: only the first hop is used", if notes.is_empty() { String::new() } else { format!("{notes}\n") }, unescape(p(8)));
                    }
                }
                if type_id == 7 {
                    notes = if notes.is_empty() { "(MobaXterm SFTP session)".into() } else { format!("{notes}\n(MobaXterm SFTP session)") };
                }
                s.insert("notes".into(), json!(notes));
                Some((s, label, gateway))
            }
            "telnet" => {
                if host.is_empty() {
                    self.skip(&label);
                    return None;
                }
                s.insert("protocol".into(), json!("telnet"));
                s.insert("host".into(), json!(host));
                s.insert("port".into(), jnum(num(2, 23.0)));
                s.insert("username".into(), json!(username));
                s.insert("autoLogin".into(), json!(true));
                Some((s, label, None))
            }
            "serial" => {
                let serial = unescape(p(1)).trim().to_string();
                if serial.is_empty() {
                    self.skip(&label);
                    return None;
                }
                s.insert("protocol".into(), json!("serial"));
                s.insert("serialPath".into(), json!(serial));
                s.insert("baudRate".into(), jnum(num(2, 9600.0)));
                s.insert("dataBits".into(), json!(8));
                s.insert("parity".into(), json!("none"));
                s.insert("stopBits".into(), json!(1));
                s.insert("flowControl".into(), json!("none"));
                Some((s, label, None))
            }
            _ => {
                s.insert("protocol".into(), json!("local"));
                s.insert("shell".into(), json!(""));
                s.insert("shellArgs".into(), json!(""));
                Some((s, label, None))
            }
        }
    }
}

pub fn parse(buf: &[u8]) -> Result<Obj> {
    static HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\[([^\]]+)\]\s*$").unwrap());
    static BOOKMARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Bookmarks(_[0-9]+)*$").unwrap());
    let text = decode_cp1252(buf);
    let mut p = Parser { folders: vec![], by_path: HashMap::new(), skipped: Map::new() };
    let mut sessions: Vec<(Obj, Option<Gateway>)> = vec![];
    let (mut total, mut imported) = (0u64, 0u64);
    let mut by_type: Obj = Map::new();
    let mut in_bookmarks = false;
    let mut current: Option<String> = None;
    let bump = |m: &mut Obj, k: &str| {
        let n = m.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        m.insert(k.to_string(), json!(n + 1));
    };
    for line in text.split("\r\n").flat_map(|l| l.split(['\r', '\n'])) {
        if let Some(h) = HEADER.captures(line) {
            in_bookmarks = BOOKMARKS.is_match(h[1].trim());
            current = None;
            continue;
        }
        if !in_bookmarks || line.trim().is_empty() {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim();
        let value = &line[eq + 1..];
        if key.eq_ignore_ascii_case("SubRep") {
            current = p.folder_for(value.trim());
            continue;
        }
        if key.eq_ignore_ascii_case("ImgNum") || !value.contains('#') {
            continue;
        }
        total += 1;
        if let Some((s, label, gw)) = p.parse_session(key, value, current.as_ref()) {
            imported += 1;
            bump(&mut by_type, &label);
            sessions.push((s, gw));
        }
    }

    // One jump session per distinct gateway, in a "Jump hosts" folder.
    let mut jumps: HashMap<String, String> = HashMap::new();
    let mut extra: Vec<Obj> = vec![];
    for (s, gw) in sessions.iter_mut() {
        let Some(gw) = gw.take() else { continue };
        let key = format!("{}@{}:{}", gw.username, gw.host, gw.port).to_lowercase();
        let jump_id = match jumps.get(&key) {
            Some(id) => id.clone(),
            None => {
                let id = uid();
                let folder = p.folder_for("Jump hosts");
                let name = format!(
                    "jump {}{}{}",
                    if gw.username.is_empty() { String::new() } else { format!("{}@", gw.username) },
                    gw.host,
                    if gw.port != 22 { format!(":{}", gw.port) } else { String::new() }
                );
                let mut j = Map::new();
                j.insert("id".into(), json!(id));
                j.insert("name".into(), json!(name));
                j.insert("folderId".into(), folder.map(Value::String).unwrap_or(Value::Null));
                j.insert("protocol".into(), json!("ssh"));
                j.insert("host".into(), json!(gw.host));
                j.insert("port".into(), json!(gw.port));
                j.insert("username".into(), json!(gw.username));
                j.insert("highlight".into(), json!("auto"));
                j.insert("logging".into(), json!(true));
                j.insert("notes".into(), json!("SSH gateway imported from MobaXterm"));
                extra.push(j);
                jumps.insert(key, id.clone());
                bump(&mut by_type, "SSH gateway");
                id
            }
        };
        s.insert("jumpId".into(), json!(jump_id));
    }
    let mut all: Vec<Obj> = sessions.into_iter().map(|(s, _)| s).collect();
    all.extend(extra);

    // Drop folders left empty because their only sessions were of a skipped type.
    let parent_of: HashMap<String, Option<String>> =
        p.folders.iter().map(|f| (crate::util::s(f.get("id")), f.get("parentId").and_then(|v| v.as_str()).map(String::from))).collect();
    let mut used: HashSet<String> = HashSet::new();
    for s in &all {
        let mut id = s.get("folderId").and_then(|v| v.as_str()).map(String::from);
        while let Some(cur) = id {
            if !used.insert(cur.clone()) {
                break;
            }
            id = parent_of.get(&cur).cloned().flatten();
        }
    }
    let folders: Vec<Value> = p.folders.into_iter().filter(|f| used.contains(&crate::util::s(f.get("id")))).map(Value::Object).collect();
    let mut out = Map::new();
    out.insert("folders".into(), Value::Array(folders));
    out.insert("sessions".into(), Value::Array(all.into_iter().map(Value::Object).collect()));
    out.insert("stats".into(), json!({ "total": total, "imported": imported, "byType": by_type, "skipped": p.skipped }));
    Ok(out)
}
