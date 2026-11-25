//! ssh:// and telnet:// links (NetBox, Zabbix, LibreNMS, wikis...) opened in
//! Vytty. Registration is opt-in (Settings -> Integrations) and per user
//! (HKCU on Windows). A link only ever opens a connection tab - it cannot run
//! commands - and host / user names are validated.
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

pub const PROTOCOLS: [&str; 2] = ["ssh", "telnet"];

static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(ssh|telnet)://").unwrap());

pub fn parse_connect_url(raw: &str) -> Option<Value> {
    static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:-]+$").unwrap());
    static USER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._@\\-]{1,64}$").unwrap());
    let t = raw.trim();
    if !URL_RE.is_match(t) {
        return None;
    }
    let u = url::Url::parse(t).ok()?;
    let protocol = u.scheme().to_lowercase();
    let host_raw = u.host_str().unwrap_or("");
    let host = percent_encoding::percent_decode_str(host_raw).decode_utf8().ok()?.trim_start_matches('[').trim_end_matches(']').to_string();
    if host.is_empty() || host.len() > 253 || !HOST.is_match(&host) {
        return None;
    }
    let mut username = percent_encoding::percent_decode_str(u.username()).decode_utf8().map(|c| c.into_owned()).unwrap_or_default();
    username = username.split(';').next().unwrap_or("").to_string(); // ssh://user;fingerprint=...@host
    if !username.is_empty() && !USER.is_match(&username) {
        username.clear();
    }
    let port = u.port().map(|p| p as u32).unwrap_or(if protocol == "ssh" { 22 } else { 23 });
    if port == 0 {
        return None;
    }
    let name = format!("{}{}{}", if username.is_empty() { String::new() } else { format!("{username}@") }, host, if u.port().is_some() { format!(":{port}") } else { String::new() });
    Some(json!({ "protocol": protocol, "host": host, "port": port, "username": username, "name": name }))
}

/// Links passed on the command line (first start or a second instance).
pub fn urls_from_args<S: AsRef<str>>(args: &[S]) -> Vec<Value> {
    args.iter().filter(|a| URL_RE.is_match(a.as_ref())).filter_map(|a| parse_connect_url(a.as_ref())).collect()
}

#[cfg(windows)]
mod reg {
    use anyhow::Result;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    fn command_for(exe: &str) -> String {
        format!("\"{exe}\" \"%1\"")
    }

    pub fn is_registered(protocol: &str, exe: &str) -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey(format!(r"Software\Classes\{protocol}\shell\open\command"))
            .and_then(|k| k.get_value::<String, _>(""))
            .map(|v| v.eq_ignore_ascii_case(&command_for(exe)))
            .unwrap_or(false)
    }

    pub fn register(protocol: &str, exe: &str) -> Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(format!(r"Software\Classes\{protocol}"))?;
        key.set_value("", &format!("URL:{protocol}"))?;
        key.set_value("URL Protocol", &"")?;
        let (cmd, _) = key.create_subkey(r"shell\open\command")?;
        cmd.set_value("", &command_for(exe))?;
        Ok(())
    }

    pub fn unregister(protocol: &str, exe: &str) -> Result<()> {
        if is_registered(protocol, exe) {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            hkcu.delete_subkey_all(format!(r"Software\Classes\{protocol}"))?;
        }
        Ok(())
    }
}

/// { available, registered, exe } for the settings page.
pub fn status(exe: &str, packaged: bool) -> Value {
    if !packaged {
        return json!({ "available": false, "registered": false });
    }
    #[cfg(windows)]
    {
        json!({ "available": true, "registered": PROTOCOLS.iter().all(|p| reg::is_registered(p, exe)), "exe": exe })
    }
    #[cfg(not(windows))]
    {
        json!({ "available": false, "registered": false, "exe": exe })
    }
}

pub fn set(on: bool, exe: &str, packaged: bool) -> anyhow::Result<Value> {
    if !packaged {
        anyhow::bail!("Link handling is available in the release builds only");
    }
    #[cfg(windows)]
    {
        for p in PROTOCOLS {
            if on {
                reg::register(p, exe).map_err(|e| anyhow::anyhow!("Windows did not accept the link registration: {e}"))?;
            } else {
                reg::unregister(p, exe)?;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (on, exe);
        anyhow::bail!("Link handling is available on Windows only");
    }
    #[allow(unreachable_code)]
    Ok(status(exe, packaged))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        assert_eq!(parse_connect_url("ssh://admin@10.0.0.1").unwrap(), json!({ "protocol": "ssh", "host": "10.0.0.1", "port": 22, "username": "admin", "name": "admin@10.0.0.1" }));
        assert_eq!(parse_connect_url("telnet://sw1.lab:2323").unwrap()["port"], json!(2323));
        assert_eq!(parse_connect_url("ssh://user;fingerprint=abc@h").unwrap()["username"], json!("user"));
        assert_eq!(parse_connect_url("ssh://[fe80::1]:22").unwrap()["host"], json!("fe80::1"));
        assert!(parse_connect_url("http://x").is_none());
        assert!(parse_connect_url("ssh://bad host/").is_none());
        assert_eq!(parse_connect_url("ssh://a%20b@h").unwrap()["username"], json!(""));
        let args = vec!["vytty.exe".to_string(), "ssh://h".to_string(), "--flag".to_string()];
        assert_eq!(urls_from_args(&args).len(), 1);
    }
}
