//! SecureCRT sessions, from either
//!   * the XML file of File -> Export Settings (<VanDyke><key name="Sessions">...), or
//!   * the session folder itself (%APPDATA%\VanDyke\Config\Sessions), whose
//!     .ini files hold lines like  S:"Hostname"=10.0.0.1  and  D:"[SSH2] Port"=00000016.
//!
//! Passwords are encrypted with a SecureCRT-specific scheme and are not imported.
use super::common::{decode_text, TreeBuilder};
use super::xml::{parse_xml, Node};
use crate::util::{jnum, Obj};
use anyhow::{bail, Result};
use regex::Regex;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

#[derive(Clone, Debug)]
pub enum V {
    S(String),
    N(f64),
}

pub type Values = HashMap<String, V>;

fn text(v: &Values, k: &str) -> String {
    match v.get(k) {
        Some(V::S(s)) => s.clone(),
        Some(V::N(n)) => crate::util::js_number(&serde_json::Number::from_f64(*n).unwrap_or(0.into())),
        None => String::new(),
    }
}

fn number(v: &Values, k: &str) -> f64 {
    match v.get(k) {
        Some(V::S(s)) => crate::util::parse_js_number(s),
        Some(V::N(n)) if n.is_finite() => *n,
        _ => 0.0,
    }
}

fn truthy(v: &Values, k: &str) -> bool {
    match v.get(k) {
        Some(V::S(s)) => !s.is_empty(),
        Some(V::N(n)) => *n != 0.0 && !n.is_nan(),
        None => false,
    }
}

const PARITY: [&str; 5] = ["none", "odd", "even", "mark", "space"];
const STOP: [f64; 3] = [1.0, 1.5, 2.0];

static NONE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^none$").unwrap());
static SESSION_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Session:").unwrap());
static KEY_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"::.*$").unwrap());

enum Mapped {
    Session(Obj, &'static str),
    Skip(String),
}

fn to_session(name: &str, v: &Values) -> Mapped {
    let proto = text(v, "Protocol Name").to_lowercase();
    let mut notes: Vec<String> = vec![];
    if truthy(v, "Description") {
        notes.push(text(v, "Description"));
    }
    let fw = text(v, "Firewall Name");
    if !fw.is_empty() && !NONE_RE.is_match(&fw) {
        notes.push(format!("Firewall / jump in SecureCRT: {}", SESSION_PREFIX.replace(&fw, "")));
    }
    let mut s = Obj::new();
    s.insert("name".into(), json!(name));
    if proto.starts_with("ssh") {
        let host = text(v, "Hostname").trim().to_string();
        if host.is_empty() {
            return Mapped::Skip("SSH".into());
        }
        let p = if number(v, "[SSH2] Port") != 0.0 { number(v, "[SSH2] Port") } else { number(v, "Port") };
        s.insert("protocol".into(), json!("ssh"));
        s.insert("host".into(), json!(host));
        s.insert("port".into(), jnum(if p == 0.0 { 22.0 } else { p }));
        s.insert("username".into(), json!(text(v, "Username")));
        // "Identity Filename V2" may carry a suffix such as "::rawkey".
        let key = if truthy(v, "Identity Filename V2") { text(v, "Identity Filename V2") } else { text(v, "Identity Filename") };
        if !key.trim().is_empty() {
            s.insert("keyPath".into(), json!(KEY_SUFFIX.replace(&key, "").trim()));
        }
        if !notes.is_empty() {
            s.insert("notes".into(), json!(notes.join("\n")));
        }
        return Mapped::Session(s, "SSH");
    }
    if proto.starts_with("telnet") {
        let host = text(v, "Hostname").trim().to_string();
        if host.is_empty() {
            return Mapped::Skip("Telnet".into());
        }
        let p = number(v, "Port");
        s.insert("protocol".into(), json!("telnet"));
        s.insert("host".into(), json!(host));
        s.insert("port".into(), jnum(if p == 0.0 { 23.0 } else { p }));
        s.insert("username".into(), json!(text(v, "Username")));
        s.insert("autoLogin".into(), json!(true));
        s.insert("notes".into(), json!(notes.join("\n")));
        return Mapped::Session(s, "Telnet");
    }
    if proto == "serial" {
        let port = text(v, "Com Port").trim().to_string();
        if port.is_empty() {
            return Mapped::Skip("Serial".into());
        }
        let baud = number(v, "Baud Rate");
        let bits = number(v, "Data Bits");
        s.insert("protocol".into(), json!("serial"));
        s.insert("serialPath".into(), json!(port));
        s.insert("baudRate".into(), jnum(if baud == 0.0 { 9600.0 } else { baud }));
        s.insert("dataBits".into(), jnum(if bits == 0.0 { 8.0 } else { bits }));
        s.insert("parity".into(), json!(PARITY.get(number(v, "Parity") as usize).copied().unwrap_or("none")));
        s.insert("stopBits".into(), jnum(STOP.get(number(v, "Stop Bits") as usize).copied().unwrap_or(1.0)));
        let flow = if number(v, "CTS Flow") != 0.0 {
            "hardware"
        } else if number(v, "XON Flow") != 0.0 {
            "software"
        } else {
            "none"
        };
        s.insert("flowControl".into(), json!(flow));
        s.insert("notes".into(), json!(notes.join("\n")));
        return Mapped::Session(s, "Serial");
    }
    let label = text(v, "Protocol Name");
    Mapped::Skip(if label.is_empty() { "unknown".into() } else { label })
}

fn add_one(tree: &mut TreeBuilder, folder: &[String], name: &str, values: &Values) {
    if name.eq_ignore_ascii_case("default") && folder.is_empty() {
        return;
    }
    match to_session(name, values) {
        Mapped::Skip(label) => tree.skip(&label),
        Mapped::Session(mut s, label) => {
            let f = tree.folder(folder);
            s.insert("folderId".into(), f.map(|x| json!(x)).unwrap_or(serde_json::Value::Null));
            tree.add(s, label);
        }
    }
}

fn is_session(v: &Values) -> bool {
    truthy(v, "Protocol Name") || truthy(v, "Hostname")
}

/// The XML file of File -> Export Settings.
pub fn parse_xml_export(input: &[u8]) -> Result<Obj> {
    let doc = parse_xml(&decode_text(input));
    let sessions_key = doc
        .children
        .iter()
        .find(|n| n.local_name() == "VanDyke")
        .and_then(|vd| vd.children.iter().find(|n| n.name == "key" && n.attr("name") == Some("Sessions")));
    let Some(sessions_key) = sessions_key else {
        bail!("Not a SecureCRT settings export (no <key name=\"Sessions\">)");
    };
    let mut tree = TreeBuilder::new(Some("SecureCRT"));
    fn walk(tree: &mut TreeBuilder, node: &Node, segments: &[String]) {
        for child in node.children.iter().filter(|c| c.name == "key") {
            let mut values = Values::new();
            for v in &child.children {
                let name = v.attr_or_empty("name").to_string();
                if v.name == "string" {
                    values.insert(name, V::S(v.text.clone()));
                } else if v.name == "dword" {
                    values.insert(name, V::N(v.text.trim().parse::<f64>().unwrap_or(f64::NAN)));
                }
            }
            let name = child.attr_or_empty("name");
            if is_session(&values) {
                add_one(tree, segments, name, &values);
            } else {
                let mut next = segments.to_vec();
                next.push(name.to_string());
                walk(tree, child, &next);
            }
        }
    }
    walk(&mut tree, sessions_key, &[]);
    Ok(tree.result())
}

static INI_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^([SD]):"([^"]+)"=(.*)$"#).unwrap());

pub fn parse_ini(text: &str) -> Values {
    let mut v = Values::new();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(m) = INI_LINE.captures(line) else { continue };
        let val = if &m[1] == "D" {
            V::N(i64::from_str_radix(m[3].trim(), 16).map(|n| n as f64).unwrap_or(f64::NAN))
        } else {
            V::S(m[3].to_string())
        };
        v.insert(m[2].to_string(), val);
    }
    v
}

/// The session folder (%APPDATA%\VanDyke\Config\Sessions).
pub fn parse_session_dir(dir: &Path) -> Result<Obj> {
    let mut tree = TreeBuilder::new(Some("SecureCRT"));
    fn walk(tree: &mut TreeBuilder, abs: &Path, segments: &[String]) -> Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(abs)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let ft = e.file_type()?;
            if ft.is_dir() {
                let mut next = segments.to_vec();
                next.push(name.clone());
                walk(tree, &e.path(), &next)?;
            } else if name.to_lowercase().ends_with(".ini") && !name.eq_ignore_ascii_case("__FolderData__.ini") {
                let values = parse_ini(&decode_text(&std::fs::read(e.path())?));
                if is_session(&values) {
                    add_one(tree, segments, &name[..name.len() - 4], &values);
                }
            }
        }
        Ok(())
    }
    walk(&mut tree, dir, &[])?;
    Ok(tree.result())
}
