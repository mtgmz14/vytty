//! OpenSSH client configuration (~/.ssh/config).
//! Every "Host" entry with a concrete name becomes an SSH session; "Host *"
//! blocks supply defaults (User, Port, IdentityFile) like ssh does. ProxyJump to
//! another imported host becomes Vytty's jump host; LocalForward and
//! DynamicForward become port forwards. Match blocks and Include are skipped.
use super::common::{decode_text, TreeBuilder};
use crate::util::{jnum, Obj};
use anyhow::Result;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

fn tokens(line: &str) -> Vec<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]*)"|(\S+)"#).unwrap());
    RE.captures_iter(line).map(|c| c.get(1).or_else(|| c.get(2)).unwrap().as_str().to_string()).collect()
}

fn home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

fn expand_home(p: &str) -> String {
    static TILDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^~($|[\\/])").unwrap());
    let h = home();
    let t = TILDE.replace(p, |c: &regex::Captures| format!("{h}{}", &c[1]));
    t.replace("%d", &h)
}

#[derive(Default, Clone)]
struct Opts {
    single: HashMap<String, String>,
    order: Vec<String>,
    local: Vec<Vec<String>>,
    dynamic: Vec<Vec<String>>,
}

impl Opts {
    fn get(&self, k: &str) -> Option<&str> {
        self.single.get(k).map(|s| s.as_str())
    }
    fn set_first(&mut self, k: &str, v: String) {
        if !self.single.contains_key(k) {
            self.single.insert(k.to_string(), v);
            self.order.push(k.to_string());
        }
    }
}

struct Block {
    patterns: Vec<String>,
    opts: Opts,
}

fn parse_blocks(text: &str) -> (Vec<Block>, u64, u64) {
    static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#.*$").unwrap());
    static KV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\S+?)(?:\s*=\s*|\s+)(.*)$").unwrap());
    let mut blocks: Vec<Block> = vec![];
    let mut cur: Option<usize> = None;
    let (mut matches, mut includes) = (0, 0);
    for raw in text.lines() {
        let line = COMMENT.replace(raw, "");
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(m) = KV.captures(line) else { continue };
        let key = m[1].to_lowercase();
        let args = tokens(&m[2]);
        match key.as_str() {
            "host" => {
                blocks.push(Block { patterns: args, opts: Opts::default() });
                cur = Some(blocks.len() - 1);
            }
            "match" => {
                cur = None;
                matches += 1;
            }
            "include" => includes += 1,
            _ => {
                let Some(b) = cur else { continue };
                let o = &mut blocks[b].opts;
                match key.as_str() {
                    "localforward" => o.local.push(args),
                    "dynamicforward" => o.dynamic.push(args),
                    "identityfile" => {
                        if let Some(first) = args.first() {
                            o.set_first("identityfile", first.clone());
                        }
                    }
                    // first value wins, like ssh
                    _ => o.set_first(&key, args.join(" ")),
                }
            }
        }
    }
    (blocks, matches, includes)
}

fn is_pattern(p: &str) -> bool {
    p.contains(['*', '?', '!'])
}

fn forwards_of(o: &Opts) -> Vec<Value> {
    static LISTEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:(.*):)?([0-9]+)$").unwrap());
    static DEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[?([^\]]+?)\]?:([0-9]+)$").unwrap());
    let mut out = vec![];
    for a in &o.local {
        let listen = a.first().cloned().unwrap_or_default();
        let dest = a.get(1).cloned().unwrap_or_default();
        if let (Some(lm), Some(dm)) = (LISTEN.captures(&listen), DEST.captures(&dest)) {
            let lh = lm.get(1).map(|m| m.as_str()).filter(|s| !s.is_empty()).unwrap_or("127.0.0.1");
            out.push(json!({
                "type": "L", "listenHost": lh, "listenPort": lm[2].parse::<u64>().unwrap_or(0),
                "destHost": &dm[1], "destPort": dm[2].parse::<u64>().unwrap_or(0),
            }));
        }
    }
    for a in &o.dynamic {
        let listen = a.first().cloned().unwrap_or_default();
        if let Some(lm) = LISTEN.captures(&listen) {
            let lh = lm.get(1).map(|m| m.as_str()).filter(|s| !s.is_empty()).unwrap_or("127.0.0.1");
            out.push(json!({ "type": "D", "listenHost": lh, "listenPort": lm[2].parse::<u64>().unwrap_or(0) }));
        }
    }
    out
}

pub fn parse(input: &[u8]) -> Result<Obj> {
    let (blocks, matches, includes) = parse_blocks(&decode_text(input));
    let mut tree = TreeBuilder::new(Some("SSH config"));
    let mut defaults = Opts::default();
    for b in &blocks {
        if b.patterns.iter().all(|p| is_pattern(p)) && b.patterns.iter().any(|p| p == "*") {
            for k in &b.opts.order {
                defaults.set_first(k, b.opts.single[k].clone());
            }
        }
    }
    let mut by_alias: HashMap<String, String> = HashMap::new();
    let mut pending: Vec<(String, String)> = vec![];
    for b in &blocks {
        let Some(alias) = b.patterns.iter().find(|p| !is_pattern(p)) else { continue };
        let pick = |k: &str| b.opts.get(k).or_else(|| defaults.get(k)).map(String::from);
        let host = pick("hostname").unwrap_or_else(|| alias.clone()).replace("%h", alias);
        let port = crate::util::parse_js_number(&pick("port").unwrap_or_default());
        let mut s = Obj::new();
        s.insert("name".into(), json!(alias));
        s.insert("protocol".into(), json!("ssh"));
        s.insert("host".into(), json!(host));
        s.insert("port".into(), jnum(if port == 0.0 { 22.0 } else { port }));
        s.insert("username".into(), json!(pick("user").unwrap_or_default()));
        if let Some(k) = pick("identityfile").filter(|k| !k.is_empty()) {
            s.insert("keyPath".into(), json!(expand_home(&k)));
        }
        let fw = forwards_of(&b.opts);
        if !fw.is_empty() {
            s.insert("forwards".into(), Value::Array(fw));
        }
        if pick("forwardagent").map(|v| v.eq_ignore_ascii_case("yes")).unwrap_or(false) || pick("identityagent").map(|v| !v.is_empty()).unwrap_or(false) {
            s.insert("useAgent".into(), json!(true));
        }
        let id = tree.add(s, "SSH");
        for p in b.patterns.iter().filter(|p| !is_pattern(p)) {
            by_alias.insert(p.to_lowercase(), id.clone());
        }
        if let Some(pj) = pick("proxyjump").filter(|v| !v.eq_ignore_ascii_case("none")) {
            pending.push((id, pj));
        }
    }
    // ProxyJump: first hop only; an alias of another imported host becomes its jump host.
    static USER_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^@]*@").unwrap());
    static PORT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":[0-9]+$").unwrap());
    for (sid, pj) in pending {
        let first = pj.split(',').next().unwrap_or("").trim().to_string();
        let alias = PORT_SUFFIX.replace(&USER_PREFIX.replace(&first, ""), "").to_lowercase();
        let jump = by_alias.get(&alias).cloned();
        let s = tree.session_mut(&sid).expect("session");
        let mut notes = String::new();
        match jump {
            Some(j) if j != sid => {
                s.insert("jumpId".into(), json!(j));
            }
            _ => notes = format!("ProxyJump {pj} (not an imported host - set the jump host in the session)"),
        }
        if pj.contains(',') {
            notes = format!("{}Multi-hop ProxyJump {pj}: only the first hop is used", if notes.is_empty() { String::new() } else { format!("{notes}\n") });
        }
        if !notes.is_empty() {
            s.insert("notes".into(), json!(notes));
        }
    }
    let mut res = tree.result();
    if let Some(Value::Object(stats)) = res.get_mut("stats") {
        stats.insert("skippedBlocks".into(), json!({ "match": matches, "include": includes }));
    }
    Ok(res)
}

pub fn default_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh").join("config")
}
