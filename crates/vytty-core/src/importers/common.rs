//! Shared pieces of the session importers: a folder/session tree builder with
//! import statistics, text decoding and small mapping helpers.
use crate::util::{uid, Obj};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Bytes 0x80-0x9F of Windows-1252 that differ from Latin-1 (undefined ones are dropped).
fn cp1252_char(b: u8) -> Option<char> {
    Some(match b {
        0x80 => '€', 0x82 => '‚', 0x83 => 'ƒ', 0x84 => '„', 0x85 => '…', 0x86 => '†', 0x87 => '‡', 0x88 => 'ˆ',
        0x89 => '‰', 0x8a => 'Š', 0x8b => '‹', 0x8c => 'Œ', 0x8e => 'Ž', 0x91 => '‘', 0x92 => '’', 0x93 => '“',
        0x94 => '”', 0x95 => '•', 0x96 => '–', 0x97 => '—', 0x98 => '˜', 0x99 => '™', 0x9a => 'š', 0x9b => '›',
        0x9c => 'œ', 0x9e => 'ž', 0x9f => 'Ÿ',
        0x80..=0x9f => return None,
        _ => b as char,
    })
}

pub fn decode_cp1252(buf: &[u8]) -> String {
    buf.iter().filter_map(|&b| cp1252_char(b)).collect()
}

fn utf16(buf: &[u8], le: bool) -> String {
    let units: Vec<u16> = buf
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// UTF-16 (with BOM), UTF-8 (with or without BOM) or, failing that, Windows-1252.
pub fn decode_text(buf: &[u8]) -> String {
    if buf.starts_with(&[0xff, 0xfe]) {
        return utf16(&buf[2..], true);
    }
    if buf.starts_with(&[0xfe, 0xff]) {
        return utf16(&buf[2..], false);
    }
    if buf.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(&buf[3..]).into_owned();
    }
    match std::str::from_utf8(buf) {
        Ok(t) => t.to_string(),
        Err(_) => decode_cp1252(buf),
    }
}

static HL_NXOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"nx-?os|nexus").unwrap());
static HL_IOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ios|catalyst|cisco|asa\b").unwrap());
static HL_LINUX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"linux|ubuntu|debian|centos|rhel|red ?hat|rocky|alma|suse|fedora|unix|bsd").unwrap());

/// Highlight profile from a platform / OS / device type description.
pub fn guess_highlight(text: &str) -> &'static str {
    let t = text.to_lowercase();
    if HL_NXOS.is_match(&t) {
        "cisco-nxos"
    } else if HL_IOS.is_match(&t) {
        "cisco-ios"
    } else if HL_LINUX.is_match(&t) {
        "linux"
    } else {
        "auto"
    }
}

static USER_HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^@\s/]+)@(.+)$").unwrap());

/// "user@host" -> ("user", "host")
pub fn split_user_host(v: &str) -> (String, String) {
    let t = v.trim();
    match USER_HOST.captures(t) {
        Some(c) => (c[1].to_string(), c[2].trim().to_string()),
        None => (String::new(), t.to_string()),
    }
}

/// Builds the folders and sessions of one import, with statistics.
pub struct TreeBuilder {
    pub folders: Vec<Obj>,
    pub sessions: Vec<Obj>,
    pub secrets: Obj,
    pub notes: Vec<String>,
    by_path: HashMap<String, String>,
    pub total: u64,
    pub imported: u64,
    pub by_type: Obj,
    pub skipped: Obj,
    pub root_id: Option<String>,
}

fn bump(m: &mut Obj, key: &str) {
    let n = m.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    m.insert(key.to_string(), json!(n + 1));
}

impl TreeBuilder {
    /// root_name: put everything into one top folder (for flat sources like PuTTY).
    pub fn new(root_name: Option<&str>) -> Self {
        let mut t = TreeBuilder {
            folders: vec![],
            sessions: vec![],
            secrets: Map::new(),
            notes: vec![],
            by_path: HashMap::new(),
            total: 0,
            imported: 0,
            by_type: Map::new(),
            skipped: Map::new(),
            root_id: None,
        };
        if let Some(name) = root_name {
            t.root_id = t.folder_from(&[name.to_string()], None);
        }
        t
    }

    /// Folder for a list of names below the root; returns its id (or the root's).
    pub fn folder<S: AsRef<str>>(&mut self, segments: &[S]) -> Option<String> {
        let base = self.root_id.clone();
        self.folder_from(segments, base)
    }

    pub fn folder_from<S: AsRef<str>>(&mut self, segments: &[S], base: Option<String>) -> Option<String> {
        let mut parent = base;
        for raw in segments {
            let name = raw.as_ref().trim();
            if name.is_empty() {
                continue;
            }
            let key = format!("{}\u{0}{}", parent.as_deref().unwrap_or(""), name.to_lowercase());
            let id = match self.by_path.get(&key) {
                Some(id) => id.clone(),
                None => {
                    let id = uid();
                    let mut f = Map::new();
                    f.insert("id".into(), json!(id));
                    f.insert("name".into(), json!(name));
                    f.insert("parentId".into(), parent.as_ref().map(|p| json!(p)).unwrap_or(Value::Null));
                    self.folders.push(f);
                    self.by_path.insert(key, id.clone());
                    id
                }
            };
            parent = Some(id);
        }
        parent
    }

    /// Adds a session (defaults: highlight auto, logging on, the root folder).
    /// Returns its id.
    pub fn add(&mut self, session: Obj, type_label: &str) -> String {
        self.total += 1;
        self.imported += 1;
        bump(&mut self.by_type, type_label);
        let id = uid();
        let mut s = Map::new();
        s.insert("id".into(), json!(id));
        s.insert("highlight".into(), json!("auto"));
        s.insert("logging".into(), json!(true));
        s.insert("notes".into(), json!(""));
        s.insert("folderId".into(), self.root_id.as_ref().map(|r| json!(r)).unwrap_or(Value::Null));
        for (k, v) in session {
            s.insert(k, v);
        }
        let empty = match s.get("folderId") {
            Some(Value::String(x)) => x.is_empty(),
            _ => true,
        };
        if empty {
            s.insert("folderId".into(), Value::Null);
        }
        self.sessions.push(s);
        id
    }

    pub fn session_mut(&mut self, id: &str) -> Option<&mut Obj> {
        self.sessions.iter_mut().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id))
    }

    pub fn skip(&mut self, type_label: &str) {
        self.total += 1;
        bump(&mut self.skipped, type_label);
    }

    /// Drops folders left without sessions (e.g. only skipped types inside).
    pub fn result(self) -> Obj {
        let parent_of: HashMap<String, Option<String>> = self
            .folders
            .iter()
            .map(|f| (crate::util::s(f.get("id")), f.get("parentId").and_then(|v| v.as_str()).map(String::from)))
            .collect();
        let mut used: HashSet<String> = HashSet::new();
        for s in &self.sessions {
            let mut id = s.get("folderId").and_then(|v| v.as_str()).map(String::from);
            while let Some(cur) = id {
                if used.contains(&cur) {
                    break;
                }
                used.insert(cur.clone());
                id = parent_of.get(&cur).cloned().flatten();
            }
        }
        let folders: Vec<Value> = self
            .folders
            .into_iter()
            .filter(|f| used.contains(&crate::util::s(f.get("id"))))
            .map(Value::Object)
            .collect();
        let mut out = Map::new();
        out.insert("folders".into(), Value::Array(folders));
        out.insert("sessions".into(), Value::Array(self.sessions.into_iter().map(Value::Object).collect()));
        out.insert(
            "stats".into(),
            json!({ "total": self.total, "imported": self.imported, "byType": self.by_type, "skipped": self.skipped }),
        );
        out.insert("secrets".into(), Value::Object(self.secrets));
        out.insert("notes".into(), json!(self.notes));
        out
    }
}

/// Builds a JSON object from key/value pairs (skips `None`).
#[macro_export]
macro_rules! jobj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        let mut m = serde_json::Map::new();
        $( m.insert(($k).to_string(), serde_json::json!($v)); )*
        m
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_boms_utf8_and_cp1252() {
        assert_eq!(decode_text(&[0xff, 0xfe, b'a', 0, b'b', 0]), "ab");
        assert_eq!(decode_text(&[0xfe, 0xff, 0, b'a']), "a");
        assert_eq!(decode_text("zażółć".as_bytes()), "zażółć");
        assert_eq!(decode_text(&[0xef, 0xbb, 0xbf, b'x']), "x");
        assert_eq!(decode_text(&[b'a', 0x80, 0xe9]), "a€é");
    }

    #[test]
    fn tree_builder_drops_unused_folders() {
        let mut t = TreeBuilder::new(Some("Root"));
        let a = t.folder(&["A", "B"]);
        let _unused = t.folder(&["Empty"]);
        let mut s = Map::new();
        s.insert("name".into(), json!("x"));
        s.insert("folderId".into(), json!(a));
        t.add(s, "SSH");
        t.skip("RDP");
        let r = t.result();
        let names: Vec<String> = r["folders"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["Root", "A", "B"]);
        assert_eq!(r["stats"]["total"], json!(2));
        assert_eq!(r["stats"]["skipped"]["RDP"], json!(1));
        assert_eq!(guess_highlight("Cisco NX-OS"), "cisco-nxos");
        assert_eq!(split_user_host(" admin@10.0.0.1 "), ("admin".into(), "10.0.0.1".into()));
    }
}
