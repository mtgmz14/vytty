//! Settings, sessions and known host keys: JSON files in the data folder,
//! written atomically. The formats are the ones Vytty 0.x always used.
use crate::paths::Paths;
use crate::util::{read_json, write_json};
use anyhow::Result;
use serde_json::{json, Map, Value};
use std::sync::{LazyLock, Mutex};

pub static DEFAULT_SETTINGS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "theme": "graphite",
        "uiStyle": "minimal",
        "fontFamily": "'Cascadia Mono', 'JetBrains Mono', Consolas, 'Courier New', monospace",
        "fontSize": 14,
        "lineHeight": 1.1,
        "cursorStyle": "block",
        "cursorBlink": true,
        "scrollback": 20000,
        "bell": "visual",
        "copyOnSelect": true,
        "trimSelection": true,
        "rightClick": "paste",
        "middleClick": "paste",
        "confirmMultilinePaste": true,
        "wordSeparator": " ()[]{}'\"`,;<>|",
        "logging": { "enabled": true, "dir": "", "timestamps": true, "sessionTag": true },
        "highlight": { "enabled": true, "defaultProfile": "auto", "customRules": [] },
        "ssh": { "keepaliveInterval": 30, "legacyAlgorithms": false, "readyTimeout": 20000 },
        "telnet": { "autoLogin": true },
        "updates": { "autoCheck": true, "install": "ask", "skipVersion": "" },
        "integrations": {
            "urlHandler": false,
            "netbox": {
                "url": "", "deviceFilter": "status=active", "includeVMs": false, "vmFilter": "status=active",
                "hostFrom": "ip", "domain": "", "groupBy": "site/role", "protocol": "ssh", "username": "", "lastSync": ""
            }
        },
        "externalTools": [],
        "reconnectKey": true,
        "confirmCloseConnected": true,
        "sidebarWidth": 260,
        "sidebarVisible": true,
        "snippets": []
    })
});

/// 0.1.0 shipped example snippets; they are dropped unless the user edited them.
const LEGACY_SNIPPETS: [(&str, &str); 4] = [
    ("sn1", "Cisco: show ip int brief|show ip interface brief\\n"),
    ("sn2", "Cisco: terminal length 0|terminal length 0\\n"),
    ("sn3", "Nexus: show int status|show interface status\\n"),
    ("sn4", "Linux: system info|uname -a && uptime && df -h\\n"),
];

fn same_kind(a: &Value, b: &Value) -> bool {
    matches!(
        (a, b),
        (Value::Bool(_), Value::Bool(_)) | (Value::Number(_), Value::Number(_)) | (Value::String(_), Value::String(_)) | (Value::Object(_), Value::Object(_))
    )
}

/// Saved values over the defaults. A saved value of the wrong type (a hand
/// edited or damaged file) falls back to the default instead of breaking the UI.
pub fn deep_merge(base: &Value, over: &Value) -> Value {
    match base {
        Value::Array(_) => {
            if over.is_array() {
                over.clone()
            } else {
                base.clone()
            }
        }
        Value::Object(b) => {
            let mut out = b.clone();
            if let Value::Object(o) = over {
                for (k, v) in o {
                    if k == "__proto__" || k == "constructor" || k == "prototype" {
                        continue;
                    }
                    let merged = match b.get(k) {
                        Some(bv) => deep_merge(bv, v),
                        None => v.clone(),
                    };
                    out.insert(k.clone(), merged);
                }
            }
            Value::Object(out)
        }
        _ => {
            if over.is_null() || !same_kind(base, over) {
                base.clone()
            } else {
                over.clone()
            }
        }
    }
}

pub struct Store {
    pub paths: Paths,
    known_hosts_lock: Mutex<()>,
}

impl Store {
    pub fn new(paths: Paths) -> Self {
        Store { paths, known_hosts_lock: Mutex::new(()) }
    }

    pub fn get_settings(&self) -> Value {
        let saved = read_json(&self.paths.settings).unwrap_or_else(|| json!({}));
        let mut s = deep_merge(&DEFAULT_SETTINGS, &saved);
        if let Some(Value::Array(snippets)) = s.get_mut("snippets") {
            snippets.retain(|sn| {
                let id = sn.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let joined = format!("{}|{}", crate::util::s(sn.get("name")), crate::util::s(sn.get("text")));
                !LEGACY_SNIPPETS.iter().any(|(lid, text)| *lid == id && *text == joined)
            });
        }
        s
    }

    pub fn save_settings(&self, settings: &Value) -> Result<Value> {
        write_json(&self.paths.settings, settings)?;
        Ok(self.get_settings())
    }

    /// { folders, sessions, credentials } - passwords live in the vault.
    pub fn get_sessions(&self) -> Value {
        match read_json(&self.paths.sessions) {
            Some(v) if v.get("sessions").map(|s| s.is_array()).unwrap_or(false) => json!({
                "folders": v.get("folders").filter(|f| f.is_array()).cloned().unwrap_or(json!([])),
                "sessions": v["sessions"].clone(),
                "credentials": v.get("credentials").filter(|f| f.is_array()).cloned().unwrap_or(json!([])),
            }),
            _ => json!({ "folders": [], "sessions": [], "credentials": [] }),
        }
    }

    pub fn save_sessions(&self, tree: &Value) -> Result<()> {
        let pick = |k: &str| tree.get(k).filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
        write_json(&self.paths.sessions, &json!({ "folders": pick("folders"), "sessions": pick("sessions"), "credentials": pick("credentials") }))?;
        Ok(())
    }

    /// "[host]:port" -> "SHA256:..."
    pub fn known_host(&self, host_id: &str) -> Option<String> {
        read_json(&self.paths.known_hosts)?.get(host_id)?.as_str().map(String::from)
    }

    pub fn save_known_host(&self, host_id: &str, fingerprint: &str) -> Result<()> {
        let _g = self.known_hosts_lock.lock().unwrap();
        let mut all = match read_json(&self.paths.known_hosts) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        all.insert(host_id.to_string(), json!(fingerprint));
        write_json(&self.paths.known_hosts, &Value::Object(all))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_wrong_types_and_unsafe_keys() {
        let dir = std::env::temp_dir().join(format!("vytty-store-{}", crate::util::uid()));
        let store = Store::new(Paths::new(dir.clone()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &store.paths.settings,
            r#"{"fontSize":"big","theme":"nord","ssh":{"keepaliveInterval":10,"legacyAlgorithms":"yes"},"__proto__":{"polluted":1},"extra":1,
               "snippets":[{"id":"sn1","name":"Cisco: show ip int brief","text":"show ip interface brief\\n"},{"id":"x","name":"mine","text":"ls"}]}"#,
        )
        .unwrap();
        let s = store.get_settings();
        assert_eq!(s["fontSize"], json!(14), "wrong type -> default");
        assert_eq!(s["theme"], json!("nord"));
        assert_eq!(s["ssh"]["keepaliveInterval"], json!(10));
        assert_eq!(s["ssh"]["legacyAlgorithms"], json!(false));
        assert_eq!(s["uiStyle"], json!("minimal"));
        assert_eq!(s["updates"]["install"], json!("ask"));
        assert_eq!(s["extra"], json!(1));
        assert!(s.get("__proto__").is_none());
        assert_eq!(s["snippets"].as_array().unwrap().len(), 1, "legacy example snippet dropped");
        assert_eq!(deep_merge(&json!({"a": [1]}), &json!({"a": [2, 3]})), json!({"a": [2, 3]}));

        assert_eq!(store.get_sessions(), json!({"folders": [], "sessions": [], "credentials": []}));
        store.save_sessions(&json!({"sessions": [{"id": "a"}]})).unwrap();
        assert_eq!(store.get_sessions()["sessions"][0]["id"], json!("a"));
        store.save_known_host("[h]:22", "SHA256:x").unwrap();
        assert_eq!(store.known_host("[h]:22").as_deref(), Some("SHA256:x"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
