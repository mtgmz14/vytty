//! External tools: open a session's host in another program (WinSCP,
//! FileZilla, PuTTY, Remote Desktop, a browser...). Programs are started
//! directly with an argument list - never through a shell - so values such as
//! a host name cannot inject commands. Nothing runs unless the user picks the
//! tool from a menu.
use crate::conn::split_args;
use crate::util::s;
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::LazyLock;

/// The characters `encodeURIComponent` leaves alone.
const URI_COMPONENT: &percent_encoding::AsciiSet =
    &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');

fn vars(session: &Value) -> Vec<(&'static str, String)> {
    let g = |k: &str| s(session.get(k));
    let user = g("username");
    let port = {
        let p = g("port");
        if p.is_empty() || p == "0" {
            if g("protocol") == "telnet" { "23".to_string() } else { "22".to_string() }
        } else {
            p
        }
    };
    let user_at = if user.is_empty() { String::new() } else { format!("{}@", percent_encoding::utf8_percent_encode(&user, URI_COMPONENT)) };
    vec![("host", g("host")), ("port", port), ("user", user), ("name", g("name")), ("protocol", g("protocol")), ("keyPath", g("keyPath")), ("userAt", user_at)]
}

pub fn expand(template: &str, session: &Value) -> String {
    static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{(host|port|user|name|protocol|keyPath|userAt)\}").unwrap());
    let v = vars(session);
    VAR.replace_all(template, |c: &regex::Captures| v.iter().find(|(k, _)| *k == &c[1]).map(|(_, x)| x.clone()).unwrap_or_default()).into_owned()
}

struct Preset {
    id: &'static str,
    name: &'static str,
    platforms: &'static [&'static str],
    protocols: &'static [&'static str],
    kind: &'static str,
    args: &'static str,
    user_args: &'static str,
    paths: fn() -> Vec<PathBuf>,
}

fn env_dir(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(fallback))
}
fn pf() -> PathBuf {
    env_dir("ProgramFiles", r"C:\Program Files")
}
fn pf86() -> PathBuf {
    env_dir("ProgramFiles(x86)", r"C:\Program Files (x86)")
}
fn lad() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("AppData").join("Local"))
}

const PRESETS: &[Preset] = &[
    Preset { id: "winscp", name: "WinSCP (SFTP)", platforms: &["windows"], protocols: &["ssh"], kind: "program", args: "sftp://{userAt}{host}:{port}/", user_args: "",
        paths: || vec![pf86().join(r"WinSCP\WinSCP.exe"), pf().join(r"WinSCP\WinSCP.exe"), lad().join(r"Programs\WinSCP\WinSCP.exe")] },
    Preset { id: "filezilla", name: "FileZilla (SFTP)", platforms: &["windows", "linux", "macos"], protocols: &["ssh"], kind: "program", args: "sftp://{userAt}{host}:{port}", user_args: "",
        paths: || vec![pf().join(r"FileZilla FTP Client\filezilla.exe"), pf86().join(r"FileZilla FTP Client\filezilla.exe"), "/usr/bin/filezilla".into()] },
    Preset { id: "putty", name: "PuTTY", platforms: &["windows", "linux"], protocols: &["ssh", "telnet"], kind: "program", args: "-{protocol} {host} -P {port}", user_args: "-l {user}",
        paths: || vec![pf().join(r"PuTTY\putty.exe"), pf86().join(r"PuTTY\putty.exe"), "/usr/bin/putty".into()] },
    Preset { id: "wt", name: "Windows Terminal (OpenSSH)", platforms: &["windows"], protocols: &["ssh"], kind: "program", args: "ssh -p {port} {userAt}{host}", user_args: "",
        paths: || vec![lad().join(r"Microsoft\WindowsApps\wt.exe")] },
    Preset { id: "rdp", name: "Remote Desktop (RDP)", platforms: &["windows"], protocols: &["ssh", "telnet"], kind: "program", args: "/v:{host}", user_args: "",
        paths: || vec![env_dir("SystemRoot", r"C:\Windows").join(r"System32\mstsc.exe")] },
    Preset { id: "vnc", name: "VNC Viewer", platforms: &["windows", "linux"], protocols: &["ssh", "telnet"], kind: "program", args: "{host}", user_args: "",
        paths: || vec![pf().join(r"RealVNC\VNC Viewer\vncviewer.exe"), pf().join(r"TightVNC\tvnviewer.exe"), pf().join(r"uvnc bvba\UltraVNC\vncviewer.exe"), "/usr/bin/vncviewer".into()] },
    Preset { id: "web-https", name: "Web UI (https)", platforms: &["windows", "linux", "macos"], protocols: &["ssh", "telnet"], kind: "url", args: "https://{host}/", user_args: "", paths: Vec::new },
    Preset { id: "web-http", name: "Web UI (http)", platforms: &["windows", "linux", "macos"], protocols: &["ssh", "telnet"], kind: "url", args: "http://{host}/", user_args: "", paths: Vec::new },
];

pub fn presets() -> Value {
    let os = std::env::consts::OS;
    Value::Array(
        PRESETS
            .iter()
            .filter(|p| p.platforms.contains(&os))
            .map(|p| {
                let paths = (p.paths)();
                let found = paths.iter().find(|x| x.is_file());
                let path = found.or(paths.first()).map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
                json!({ "id": p.id, "name": p.name, "type": p.kind, "path": path, "args": p.args, "userArgs": p.user_args, "protocols": p.protocols, "installed": p.kind == "url" || found.is_some() })
            })
            .collect(),
    )
}

/// What would be run, for the settings preview and for `launch`.
pub fn plan(tool: &Value, session: &Value) -> Result<Value> {
    static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://\S+$").unwrap());
    if s(tool.get("type")) == "url" {
        let url = expand(&s(tool.get("args")), session);
        if !URL.is_match(&url) {
            bail!("Web tools need an http:// or https:// address");
        }
        return Ok(json!({ "type": "url", "url": url }));
    }
    let path = s(tool.get("path"));
    if path.is_empty() {
        bail!("No program set for \"{}\"", s(tool.get("name")));
    }
    let mut args: Vec<String> = split_args(&s(tool.get("args"))).iter().map(|a| expand(a, session)).collect();
    if !s(session.get("username")).is_empty() && !s(tool.get("userArgs")).is_empty() {
        args.extend(split_args(&s(tool.get("userArgs"))).iter().map(|a| expand(a, session)));
    }
    Ok(json!({ "type": "program", "path": path, "args": args }))
}

pub fn launch(tool: &Value, session: &Value) -> Result<Value> {
    let p = plan(tool, session)?;
    if p["type"] == "url" {
        open::that_detached(s(p.get("url"))).map_err(|e| anyhow!("{e}"))?;
        return Ok(p);
    }
    let path = s(p.get("path"));
    let args: Vec<String> = p["args"].as_array().map(|a| a.iter().map(|x| s(Some(x))).collect()).unwrap_or_default();
    let mut cmd = std::process::Command::new(&path);
    cmd.args(&args).current_dir(dirs::home_dir().unwrap_or_else(std::env::temp_dir)).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match cmd.spawn() {
        Ok(_child) => Ok(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => bail!("Program not found: {path}"),
        Err(e) => bail!("{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_never_use_a_shell() {
        let session = json!({ "host": "10.0.0.1; rm -rf /", "port": 2222, "username": "a b", "protocol": "ssh" });
        let tool = json!({ "type": "program", "name": "PuTTY", "path": "/usr/bin/putty", "args": "-{protocol} {host} -P {port}", "userArgs": "-l {user}" });
        let p = plan(&tool, &session).unwrap();
        assert_eq!(p["args"], json!(["-ssh", "10.0.0.1; rm -rf /", "-P", "2222", "-l", "a b"]));
        let web = json!({ "type": "url", "args": "https://{host}/" });
        assert_eq!(plan(&web, &json!({ "host": "sw1" })).unwrap()["url"], json!("https://sw1/"));
        assert!(plan(&json!({ "type": "url", "args": "file:///etc/passwd" }), &json!({})).is_err());
        assert_eq!(expand("sftp://{userAt}{host}:{port}", &json!({ "host": "h", "username": "u@x", "protocol": "ssh" })), "sftp://u%40x@h:22");
    }
}
