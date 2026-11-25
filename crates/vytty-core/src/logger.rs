//! Session logs, one file per device and day: <logDir>/<hostname>#YYYY-MM-DD.log.
//! Every session to the same device that day appends to the same file.
//! The hostname is read from the device prompt ("SW1#", "SW1(config)#",
//! "user@host:~$", "[user@host ~]$"), so a device reached by IP or by name
//! ends up in one file; output before the first prompt (banner, login) is held
//! until it is known. Without a recognisable prompt the session's host is used.
//! Output is turned into plain text with a tiny line emulator (handles \r, \b,
//! erase-line and cursor left/right) so "--More--" prompts and progress bars do
//! not leave garbage.
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

fn day_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
fn time_stamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

#[derive(Clone, Debug)]
pub struct LogSettings {
    pub enabled: bool,
    pub dir: String,
    pub timestamps: bool,
    pub session_tag: bool,
}

impl Default for LogSettings {
    fn default() -> Self {
        LogSettings { enabled: true, dir: String::new(), timestamps: true, session_tag: true }
    }
}

#[derive(Default)]
struct Queue {
    files: HashMap<PathBuf, String>,
    bytes: usize,
}

/// Writes are batched per file: syncing on every line made busy terminals lag.
pub struct Logger {
    settings: RwLock<LogSettings>,
    default_dir: PathBuf,
    queue: Mutex<Queue>,
}

impl Logger {
    pub fn new(default_dir: PathBuf) -> Arc<Self> {
        let logger = Arc::new(Logger { settings: RwLock::new(LogSettings::default()), default_dir, queue: Mutex::new(Queue::default()) });
        let weak: Weak<Logger> = Arc::downgrade(&logger);
        std::thread::Builder::new()
            .name("vytty-log-flush".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                match weak.upgrade() {
                    Some(l) => l.flush(),
                    None => break,
                }
            })
            .ok();
        logger
    }

    /// Applies the "logging" part of the settings.
    pub fn configure(&self, v: &Value) {
        self.flush();
        let mut s = self.settings.write().unwrap();
        let b = |k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
        *s = LogSettings {
            enabled: b("enabled", s.enabled),
            dir: v.get("dir").and_then(|x| x.as_str()).map(String::from).unwrap_or(s.dir.clone()),
            timestamps: b("timestamps", s.timestamps),
            session_tag: b("sessionTag", s.session_tag),
        };
    }

    pub fn settings(&self) -> LogSettings {
        self.settings.read().unwrap().clone()
    }

    pub fn log_dir(&self) -> PathBuf {
        let s = self.settings.read().unwrap();
        if s.dir.trim().is_empty() {
            self.default_dir.clone()
        } else {
            PathBuf::from(s.dir.trim())
        }
    }

    fn file_for(&self, host: &str) -> PathBuf {
        self.log_dir().join(format!("{}#{}.log", safe_name(host), day_stamp()))
    }

    fn append(&self, file: PathBuf, text: &str) {
        let flush_now = {
            let mut q = self.queue.lock().unwrap();
            q.files.entry(file).or_default().push_str(text);
            q.bytes += text.len();
            q.bytes > 256 * 1024
        };
        if flush_now {
            self.flush();
        }
    }

    pub fn flush(&self) {
        let files = {
            let mut q = self.queue.lock().unwrap();
            q.bytes = 0;
            std::mem::take(&mut q.files)
        };
        for (file, text) in files {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::OpenOptions::new().create(true).append(true).open(&file).and_then(|mut f| f.write_all(text.as_bytes())) {
                Ok(()) => {}
                Err(e) => eprintln!("[vytty] log write failed: {e}"),
            }
        }
    }
}

pub fn safe_name(s: &str) -> String {
    static BAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).unwrap());
    let replaced = BAD.replace_all(s, "_");
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    let out: String = trimmed.chars().take(100).collect();
    if out.is_empty() {
        "unknown".into()
    } else {
        out
    }
}

// Prompt patterns; the first capture group is the hostname.
static PROMPTS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        // Linux / Juniper / MikroTik: user@host:~$, [user@host dir]$, user@host>, [admin@host] >
        Regex::new(r"^\[?[A-Za-z0-9_.-]+@([A-Za-z0-9][A-Za-z0-9_.-]*)(?::\S*?|\s[^\]\s]*)?\]?\s?[$#>%](?:\s|$)").unwrap(),
        // Cisco IOS / NX-OS / ASA: host#, host(config-if)#, host>
        Regex::new(r"^([A-Za-z0-9][A-Za-z0-9_.-]{0,62})(?:\([A-Za-z0-9_./:-]*\))?[#>]").unwrap(),
    ]
});
static PROMPT_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[#>$%\]]\s?$").unwrap());

pub fn host_from_prompt(text: &str, partial: bool) -> Option<String> {
    if partial && !PROMPT_END.is_match(text) {
        return None;
    }
    for re in PROMPTS.iter() {
        if let Some(c) = re.captures(text) {
            let h = &c[1];
            if !h.chars().all(|c| c.is_ascii_digit()) && h.chars().count() > 1 {
                return Some(h.to_string());
            }
        }
    }
    None
}

const HOLD: Duration = Duration::from_secs(30);
const HOLD_BYTES: usize = 512 * 1024;

pub struct SessionLog {
    logger: Arc<Logger>,
    name: String,
    enabled: bool,
    fallback: String,
    host: Option<String>,
    held: Vec<String>,
    held_bytes: usize,
    started: Instant,
    line: Vec<char>,
    cursor: usize,
    esc: String,
}

impl SessionLog {
    /// fallback: used when no prompt is recognised (session host, serial port...).
    pub fn new(logger: Arc<Logger>, name: &str, descriptor: &str, enabled: bool, fallback: &str) -> Self {
        let mut log = SessionLog {
            logger,
            name: name.to_string(),
            enabled,
            fallback: if fallback.is_empty() { name.to_string() } else { fallback.to_string() },
            host: None,
            held: vec![],
            held_bytes: 0,
            started: Instant::now(),
            line: vec![],
            cursor: 0,
            esc: String::new(),
        };
        if log.enabled {
            let open = format!("\n===== [{} {}] OPEN  \"{}\" ({}) =====\n", day_stamp(), time_stamp(), name, descriptor);
            log.out(&open);
        }
        log
    }

    fn out(&mut self, text: &str) {
        if let Some(h) = &self.host {
            let f = self.logger.file_for(h);
            self.logger.append(f, text);
            return;
        }
        self.held.push(text.to_string());
        self.held_bytes += text.len();
        if self.held_bytes > HOLD_BYTES {
            let fb = self.fallback.clone();
            self.set_host(&fb);
        }
    }

    /// Starts writing to the file of `host`. A later prompt with another
    /// hostname (ssh/telnet from a jump box to the next device) moves on.
    fn set_host(&mut self, host: &str) {
        if host.is_empty() || self.host.as_deref() == Some(host) {
            return;
        }
        let stamp = format!("[{} {}]", day_stamp(), time_stamp());
        if let Some(prev) = &self.host {
            let (a, b) = (self.logger.file_for(prev), self.logger.file_for(host));
            self.logger.append(a, &format!("----- {stamp} \"{}\" continues on {host} -----\n", self.name));
            self.logger.append(b, &format!("\n----- {stamp} \"{}\" continued from {prev} -----\n", self.name));
        }
        self.host = Some(host.to_string());
        if !self.held.is_empty() {
            let f = self.logger.file_for(host);
            let text = std::mem::take(&mut self.held).join("");
            self.held_bytes = 0;
            self.logger.append(f, &text);
        }
    }

    /// Called about once a second: after 30 s without a prompt, use the fallback name.
    pub fn tick(&mut self) {
        if self.enabled && self.host.is_none() && self.started.elapsed() >= HOLD {
            let fb = self.fallback.clone();
            self.set_host(&fb);
        }
    }

    fn prefix(&self) -> String {
        let s = self.logger.settings();
        let mut p = String::new();
        if s.timestamps {
            p.push_str(&format!("[{}] ", time_stamp()));
        }
        if s.session_tag {
            p.push_str(&format!("[{}] ", self.name));
        }
        p
    }

    fn emit_line(&mut self) {
        let text: String = self.line.iter().collect::<String>().trim_end().to_string();
        self.line.clear();
        self.cursor = 0;
        if let Some(h) = host_from_prompt(&text, false) {
            self.set_host(&h);
        }
        let line = format!("{}{}\n", self.prefix(), text);
        self.out(&line);
    }

    fn put_char(&mut self, ch: char) {
        if self.cursor < self.line.len() {
            self.line[self.cursor] = ch;
        } else {
            while self.line.len() < self.cursor {
                self.line.push(' ');
            }
            self.line.push(ch);
        }
        self.cursor += 1;
    }

    fn handle_csi(&mut self, seq: &str) {
        let final_ch = seq.chars().last().unwrap_or(' ');
        let params: String = seq.chars().skip(2).take(seq.chars().count().saturating_sub(3)).collect();
        let digits: String = params.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
        let n: Option<usize> = digits.parse().ok();
        let count = n.unwrap_or(1);
        match final_ch {
            'K' => match n.unwrap_or(0) {
                0 => {
                    let keep = self.line.len().min(self.cursor);
                    self.line.truncate(keep);
                }
                2 => self.line.clear(),
                _ => {}
            },
            'D' => self.cursor = self.cursor.saturating_sub(count),
            'C' => self.cursor += count,
            'G' => self.cursor = count.saturating_sub(1),
            _ => {}
        }
    }

    pub fn write(&mut self, text: &str) {
        if !self.enabled || !self.logger.settings().enabled {
            return;
        }
        for ch in text.chars() {
            if !self.esc.is_empty() {
                self.esc.push(ch);
                let s: Vec<char> = self.esc.chars().collect();
                let second = s.get(1).copied().unwrap_or(' ');
                if s.len() == 2 && !matches!(second, '[' | ']' | '(' | ')') {
                    self.esc.clear();
                } else if second == '[' && s.len() > 2 && ('@'..='~').contains(&ch) {
                    let seq = std::mem::take(&mut self.esc);
                    self.handle_csi(&seq);
                } else if second == ']' && (ch == '\x07' || self.esc.ends_with("\x1b\\")) {
                    self.esc.clear();
                } else if matches!(second, '(' | ')') && s.len() == 3 {
                    self.esc.clear();
                } else if s.len() > 256 {
                    self.esc.clear();
                }
                continue;
            }
            match ch {
                '\x1b' => self.esc.push(ch),
                '\n' => self.emit_line(),
                '\r' => self.cursor = 0,
                '\x08' => self.cursor = self.cursor.saturating_sub(1),
                '\t' => self.put_char('\t'),
                c if c < ' ' || c == '\x7f' => {}
                c => self.put_char(c),
            }
        }
        // A prompt waiting for input is the last, unterminated line.
        if self.host.is_none() && !self.line.is_empty() && self.line.len() < 200 {
            let joined: String = self.line.iter().collect();
            let t = joined.trim_end();
            let candidate = if t.len() < joined.len() { format!("{t} ") } else { joined.clone() };
            if let Some(h) = host_from_prompt(&candidate, true) {
                self.set_host(&h);
            }
        }
    }

    pub fn close(&mut self, reason: &str) {
        if !self.enabled {
            return;
        }
        if !self.line.is_empty() {
            self.emit_line();
        }
        if self.host.is_none() {
            let fb = self.fallback.clone();
            self.set_host(&fb);
        }
        let text = format!(
            "===== [{} {}] CLOSE \"{}\"{} =====\n",
            day_stamp(),
            time_stamp(),
            self.name,
            if reason.is_empty() { String::new() } else { format!(" ({reason})") }
        );
        self.out(&text);
        self.logger.flush();
        self.enabled = false;
    }
}

/// Default file name for a session that has not shown a prompt yet.
pub fn fallback_host(session: &Value) -> String {
    let s = |k: &str| crate::util::s(session.get(k));
    match s("protocol").as_str() {
        "local" => gethostname::gethostname().to_string_lossy().to_string(),
        "serial" => {
            let p = s("serialPath");
            let base = p.rsplit(['/', '\\']).next().unwrap_or("").to_string();
            if base.is_empty() {
                "serial".into()
            } else {
                base
            }
        }
        _ => [s("host"), s("name")].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "session".into()),
    }
}

pub fn read_dir_file_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompts() {
        assert_eq!(host_from_prompt("core-sw01#", true).as_deref(), Some("core-sw01"));
        assert_eq!(host_from_prompt("core-sw01(config-if)#", true).as_deref(), Some("core-sw01"));
        assert_eq!(host_from_prompt("admin@web01:~$ ", true).as_deref(), Some("web01"));
        assert_eq!(host_from_prompt("[root@db1 tmp]# ", true).as_deref(), Some("db1"));
        assert_eq!(host_from_prompt("Password:", true), None);
        assert_eq!(host_from_prompt("12345#", true), None);
        assert_eq!(safe_name("a/b:c. "), "a_b_c");
    }

    #[test]
    fn one_file_per_device_and_day_with_line_editing() {
        let dir = std::env::temp_dir().join(format!("vytty-log-{}", crate::util::uid()));
        let logger = Logger::new(dir.clone());
        logger.configure(&json!({ "timestamps": false, "sessionTag": true }));
        let mut log = SessionLog::new(logger.clone(), "core", "ssh admin@10.0.0.1:22", true, "10.0.0.1");
        log.write("banner\r\nUsername: admin\r\nSW1#show ver\x08\x08\x08\x08\x08\x08\x08\x08show run\r\n --More-- \r          \r interface Gi1\r\nSW1#");
        log.close("Closed by user");
        let names = read_dir_file_names(&dir);
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(names[0].starts_with("SW1#"));
        let text = std::fs::read_to_string(dir.join(&names[0])).unwrap();
        assert!(text.contains("OPEN  \"core\""));
        assert!(text.contains("[core] banner\n"));
        assert!(text.contains("[core] SW1#show run\n"), "{text}");
        assert!(text.contains("[core]  interface Gi1\n"), "{text}");
        assert!(text.contains("CLOSE \"core\" (Closed by user)"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fallbacks() {
        assert_eq!(fallback_host(&json!({"protocol": "serial", "serialPath": "/dev/ttyUSB0"})), "ttyUSB0");
        assert_eq!(fallback_host(&json!({"protocol": "ssh", "host": "", "name": "x"})), "x");
    }
}
