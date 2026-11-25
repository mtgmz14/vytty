//! Session export for other tools: an OpenSSH client config, CSV (Excel, CMDB)
//! and an Ansible INI inventory. Passwords are never written to these files.
use crate::util::{num, s};
use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

pub struct Exporter {
    pub id: &'static str,
    pub label: &'static str,
    pub default_name: &'static str,
    pub filter: (&'static str, &'static [&'static str]),
    pub run: fn(&Value) -> String,
}

pub const EXPORTERS: &[Exporter] = &[
    Exporter { id: "sshconfig", label: "OpenSSH config", default_name: "ssh_config", filter: ("SSH config", &["*"]), run: to_ssh_config },
    Exporter { id: "csv", label: "CSV", default_name: "vytty-sessions.csv", filter: ("CSV", &["csv"]), run: to_csv },
    Exporter { id: "ansible", label: "Ansible inventory", default_name: "inventory.ini", filter: ("Ansible inventory", &["ini", "txt"]), run: to_ansible_inventory },
];

pub fn exporter(id: &str) -> Option<&'static Exporter> {
    EXPORTERS.iter().find(|e| e.id == id)
}

fn list<'a>(tree: &'a Value, key: &str) -> Vec<&'a Value> {
    tree.get(key).and_then(|v| v.as_array()).map(|a| a.iter().collect()).unwrap_or_default()
}

pub fn folder_path_of(folders: &[&Value], id: Option<&str>) -> Vec<String> {
    let by_id: HashMap<String, &Value> = folders.iter().map(|f| (s(f.get("id")), *f)).collect();
    let mut parts = vec![];
    let mut seen = HashSet::new();
    let mut cur = id.and_then(|i| by_id.get(i).copied());
    while let Some(f) = cur {
        let fid = s(f.get("id"));
        if !seen.insert(fid) {
            break;
        }
        parts.insert(0, s(f.get("name")));
        cur = f.get("parentId").and_then(|p| p.as_str()).and_then(|p| by_id.get(p).copied());
    }
    parts
}

/// "core-sw01 (Lab)" -> "core-sw01-lab"; unique within the export.
struct AliasMaker(HashSet<String>);
impl AliasMaker {
    fn make(&mut self, name: &str, fallback: &str) -> String {
        static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.-]+").unwrap());
        let src = if !name.is_empty() { name } else if !fallback.is_empty() { fallback } else { "host" };
        let lowered = src.to_lowercase();
        let base = NON_WORD.replace_all(&lowered, "-");
        let base = base.trim_matches('-');
        let base = if base.is_empty() { "host".to_string() } else { base.to_string() };
        let mut a = base.clone();
        let mut i = 2;
        while self.0.contains(&a) {
            a = format!("{base}-{i}");
            i += 1;
        }
        self.0.insert(a.clone());
        a
    }
}

fn quote_ssh(v: &str) -> String {
    if v.contains(|c: char| c.is_whitespace() || c == '"') {
        format!("\"{}\"", v.replace('"', ""))
    } else {
        v.to_string()
    }
}

/// yyyy-mm-dd, local time.
pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn to_ssh_config(tree: &Value) -> String {
    let folders = list(tree, "folders");
    let ssh: Vec<&Value> = list(tree, "sessions").into_iter().filter(|x| s(x.get("protocol")) == "ssh" && !s(x.get("host")).is_empty()).collect();
    let mut maker = AliasMaker(HashSet::new());
    let aliases: HashMap<String, String> = ssh.iter().map(|x| (s(x.get("id")), maker.make(&s(x.get("name")), &s(x.get("host"))))).collect();
    let mut out = vec![format!("# Exported from Vytty on {} ({} SSH sessions)", today(), ssh.len()), String::new()];
    for x in &ssh {
        let id = s(x.get("id"));
        let alias = &aliases[&id];
        let folder = folder_path_of(&folders, x.get("folderId").and_then(|v| v.as_str())).join(" / ");
        let name = s(x.get("name"));
        if !folder.is_empty() || &name != alias {
            let label: Vec<String> = [folder.clone(), name.clone()].into_iter().filter(|p| !p.is_empty()).collect();
            out.push(format!("# {}", label.join(" / ")));
        }
        out.push(format!("Host {alias}"));
        out.push(format!("    HostName {}", s(x.get("host"))));
        let user = s(x.get("username"));
        if !user.is_empty() {
            out.push(format!("    User {}", quote_ssh(&user)));
        }
        let port = num(x.get("port"));
        if port != 0.0 && port != 22.0 {
            out.push(format!("    Port {}", s(x.get("port"))));
        }
        let key = s(x.get("keyPath"));
        if !key.is_empty() {
            out.push(format!("    IdentityFile {}", quote_ssh(&key)));
        }
        if let Some(j) = x.get("jumpId").and_then(|v| v.as_str()).and_then(|j| aliases.get(j)) {
            out.push(format!("    ProxyJump {j}"));
        }
        for f in x.get("forwards").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            let lh = s(f.get("listenHost"));
            let prefix = if !lh.is_empty() && lh != "127.0.0.1" { format!("{lh}:") } else { String::new() };
            if s(f.get("type")) == "D" {
                out.push(format!("    DynamicForward {prefix}{}", s(f.get("listenPort"))));
            } else if !s(f.get("destHost")).is_empty() {
                out.push(format!("    LocalForward {prefix}{} {}:{}", s(f.get("listenPort")), s(f.get("destHost")), s(f.get("destPort"))));
            }
        }
        if crate::util::truthy(x.get("legacyAlgorithms")) {
            out.push("    KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group1-sha1".into());
            out.push("    HostKeyAlgorithms +ssh-rsa".into());
            out.push("    PubkeyAcceptedAlgorithms +ssh-rsa".into());
        }
        out.push(String::new());
    }
    out.join("\n")
}

const CSV_COLUMNS: [&str; 11] = ["name", "folder", "protocol", "host", "port", "username", "keyPath", "serialPath", "baudRate", "highlight", "notes"];

fn csv_field(v: &str) -> String {
    // A leading = + - @ would be run as a formula by Excel.
    let safe = if v.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{v}") } else { v.to_string() };
    if safe.contains(['"', ',', '\n', '\r', ';']) {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

pub fn to_csv(tree: &Value) -> String {
    let folders = list(tree, "folders");
    let mut rows = vec![CSV_COLUMNS.join(",")];
    for x in list(tree, "sessions") {
        let folder = folder_path_of(&folders, x.get("folderId").and_then(|v| v.as_str())).join("/");
        let row: Vec<String> = CSV_COLUMNS.iter().map(|c| csv_field(&if *c == "folder" { folder.clone() } else { s(x.get(*c)) })).collect();
        rows.push(row.join(","));
    }
    format!("\u{feff}{}\r\n", rows.join("\r\n"))
}

fn network_os(highlight: &str) -> Option<&'static str> {
    match highlight {
        "cisco-ios" => Some("cisco.ios.ios"),
        "cisco-nxos" => Some("cisco.nxos.nxos"),
        _ => None,
    }
}

pub fn to_ansible_inventory(tree: &Value) -> String {
    static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_]+").unwrap());
    static LEAD_DIGIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9])").unwrap());
    let folders = list(tree, "folders");
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut maker = AliasMaker(HashSet::new());
    let group_name = |parts: Vec<String>| {
        let joined = if parts.is_empty() { "ungrouped".to_string() } else { parts.join("_") }.to_lowercase();
        let g = NON_WORD.replace_all(&joined, "_");
        let g = g.trim_matches('_');
        let g = LEAD_DIGIT.replace(g, "g_$1").to_string();
        if g.is_empty() {
            "ungrouped".to_string()
        } else {
            g
        }
    };
    for x in list(tree, "sessions") {
        let proto = s(x.get("protocol"));
        if s(x.get("host")).is_empty() || (proto != "ssh" && proto != "telnet") {
            continue;
        }
        let g = group_name(folder_path_of(&folders, x.get("folderId").and_then(|v| v.as_str())));
        let mut vars = vec![format!("ansible_host={}", s(x.get("host")))];
        let port = num(x.get("port"));
        if port != 0.0 && port != if proto == "ssh" { 22.0 } else { 23.0 } {
            vars.push(format!("ansible_port={}", s(x.get("port"))));
        }
        let user = s(x.get("username"));
        if !user.is_empty() {
            vars.push(format!("ansible_user={user}"));
        }
        if let Some(os) = network_os(&s(x.get("highlight"))) {
            vars.push("ansible_connection=ansible.netcommon.network_cli".into());
            vars.push(format!("ansible_network_os={os}"));
        }
        if proto == "telnet" {
            vars.push("# telnet session in Vytty".into());
        }
        let alias = maker.make(&s(x.get("name")), &s(x.get("host")));
        groups.entry(g).or_default().push(format!("{alias} {}", vars.join(" ")));
    }
    let mut out = vec![
        format!("# Ansible inventory exported from Vytty on {}", today()),
        "# Groups follow the Vytty folders. Passwords are not exported: use --ask-pass or ansible-vault.".to_string(),
        String::new(),
    ];
    for (g, hosts) in groups {
        out.push(format!("[{g}]"));
        out.extend(hosts);
        out.push(String::new());
    }
    out.join("\n")
}
