//! Encrypted credential vault (vault.json, compatible with every 0.x version).
//! Every secret is sealed with AES-256-GCM using a key derived with scrypt
//! (N=2^15, r=8, p=1) from the master password. The master password itself is
//! never stored: a known plaintext ("check") sealed with the key verifies it.
//! "none" mode derives the key from a built-in constant so the vault stays
//! portable without a master password - that is obfuscation, not security,
//! and the UI says so.
use crate::util::{random_bytes, read_json, write_json};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use zeroize::Zeroizing;

const NO_MASTER_SECRET: &str = "vytty:portable:no-master-password";
const CHECK_PLAINTEXT: &str = "vytty-vault-ok";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Sealed {
    pub iv: String,
    pub tag: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultFile {
    pub version: u32,
    pub kdf: String,
    pub mode: String,
    pub salt: String,
    pub check: Sealed,
    pub entries: Map<String, Value>,
}

type Key = Zeroizing<[u8; 32]>;

pub fn derive_key(password: &str, salt_b64: &str) -> Result<Key> {
    let salt = B64.decode(salt_b64)?;
    let params = scrypt::Params::new(15, 8, 1, 32).map_err(|e| anyhow!("{e}"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(password.as_bytes(), &salt, &params, key.as_mut()).map_err(|e| anyhow!("{e}"))?;
    Ok(key)
}

pub fn seal(key: &[u8; 32], plaintext: &str) -> Sealed {
    let iv: [u8; 12] = random_bytes();
    let cipher = Aes256Gcm::new_from_slice(key).expect("key length");
    let mut out = cipher.encrypt(Nonce::from_slice(&iv), plaintext.as_bytes()).expect("encryption");
    let tag = out.split_off(out.len() - 16);
    Sealed { iv: B64.encode(iv), tag: B64.encode(tag), data: B64.encode(out) }
}

pub fn open(key: &[u8; 32], b: &Sealed) -> Result<String> {
    let iv = B64.decode(&b.iv)?;
    if iv.len() != 12 {
        bail!("bad iv");
    }
    let mut data = B64.decode(&b.data)?;
    data.extend(B64.decode(&b.tag)?);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("key"))?;
    let plain = cipher.decrypt(Nonce::from_slice(&iv), data.as_ref()).map_err(|_| anyhow!("decryption failed"))?;
    Ok(String::from_utf8(plain)?)
}

fn sealed_of(v: &Value) -> Option<Sealed> {
    serde_json::from_value(v.clone()).ok()
}

struct Inner {
    key: Option<Key>,
    data: Option<VaultFile>,
    loaded: bool,
}

pub struct Vault {
    file: PathBuf,
    inner: Mutex<Inner>,
}

fn new_salt() -> String {
    B64.encode(random_bytes::<16>())
}

impl Vault {
    pub fn new(file: PathBuf) -> Self {
        Vault { file, inner: Mutex::new(Inner { key: None, data: None, loaded: false }) }
    }

    fn load(&self, g: &mut Inner) {
        if !g.loaded || g.data.is_none() {
            g.data = read_json(&self.file).and_then(|v| serde_json::from_value(v).ok());
            g.loaded = true;
        }
    }

    fn persist(&self, data: &VaultFile) -> Result<()> {
        write_json(&self.file, &serde_json::to_value(data)?)?;
        Ok(())
    }

    fn status_of(g: &Inner) -> Value {
        json!({
            "exists": g.data.is_some(),
            "mode": g.data.as_ref().map(|d| json!(d.mode)).unwrap_or(Value::Null),
            "unlocked": g.key.is_some(),
            "count": g.data.as_ref().map(|d| d.entries.len()).unwrap_or(0),
        })
    }

    pub fn status(&self) -> Value {
        let mut g = self.inner.lock().unwrap();
        self.load(&mut g);
        Self::status_of(&g)
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().unwrap().key.is_some()
    }

    fn fresh(password: &str, entries: Map<String, Value>) -> Result<(VaultFile, Key)> {
        let mode = if password.is_empty() { "none" } else { "master" };
        let salt = new_salt();
        let key = derive_key(if password.is_empty() { NO_MASTER_SECRET } else { password }, &salt)?;
        let check = seal(&key, CHECK_PLAINTEXT);
        Ok((VaultFile { version: 1, kdf: "scrypt".into(), mode: mode.into(), salt, check, entries }, key))
    }

    pub fn create(&self, password: &str) -> Result<Value> {
        let mut g = self.inner.lock().unwrap();
        let (data, key) = Self::fresh(password, Map::new())?;
        self.persist(&data)?;
        g.data = Some(data);
        g.loaded = true;
        g.key = Some(key);
        Ok(Self::status_of(&g))
    }

    fn unlock_inner(&self, g: &mut Inner, password: &str) -> Result<()> {
        self.load(g);
        let d = g.data.as_ref().ok_or_else(|| anyhow!("Vault does not exist"))?;
        let key = derive_key(if d.mode == "none" { NO_MASTER_SECRET } else { password }, &d.salt)?;
        match open(&key, &d.check) {
            Ok(t) if t == CHECK_PLAINTEXT => {
                g.key = Some(key);
                Ok(())
            }
            _ => bail!("Wrong master password"),
        }
    }

    pub fn unlock(&self, password: &str) -> Result<Value> {
        let mut g = self.inner.lock().unwrap();
        self.unlock_inner(&mut g, password)?;
        Ok(Self::status_of(&g))
    }

    pub fn lock(&self) -> Value {
        let mut g = self.inner.lock().unwrap();
        g.key = None;
        Self::status_of(&g)
    }

    /// The secret stored for `id` ({} when there is none). Fails while locked.
    pub fn get(&self, id: &str) -> Result<Map<String, Value>> {
        let mut g = self.inner.lock().unwrap();
        self.load(&mut g);
        let key = g.key.clone().ok_or_else(|| anyhow!("Vault is locked"))?;
        let Some(b) = g.data.as_ref().and_then(|d| d.entries.get(id)).and_then(sealed_of) else {
            return Ok(Map::new());
        };
        match serde_json::from_str::<Value>(&open(&key, &b)?)? {
            Value::Object(m) => Ok(m),
            _ => Ok(Map::new()),
        }
    }

    /// Stores `secret` for `id`; empty values are dropped, an empty secret removes the entry.
    pub fn set(&self, id: &str, secret: &Map<String, Value>) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        self.load(&mut g);
        let key = g.key.clone().ok_or_else(|| anyhow!("Vault is locked"))?;
        let mut clean = Map::new();
        for (k, v) in secret {
            if crate::util::truthy(Some(v)) {
                clean.insert(k.clone(), v.clone());
            }
        }
        let data = g.data.as_mut().ok_or_else(|| anyhow!("Vault does not exist"))?;
        if clean.is_empty() {
            data.entries.remove(id);
        } else {
            data.entries.insert(id.to_string(), serde_json::to_value(seal(&key, &Value::Object(clean).to_string()))?);
        }
        let snapshot = data.clone();
        self.persist(&snapshot)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        self.load(&mut g);
        let Some(data) = g.data.as_mut() else { return Ok(()) };
        if data.entries.remove(id).is_some() {
            let snapshot = data.clone();
            self.persist(&snapshot)?;
        }
        Ok(())
    }

    /// Re-encrypts every entry under a new key. An empty new password switches to "none" mode.
    pub fn change_master(&self, old_password: &str, new_password: &str) -> Result<Value> {
        {
            let mut g = self.inner.lock().unwrap();
            self.load(&mut g);
            if g.data.is_none() {
                drop(g);
                return self.create(new_password);
            }
        }
        let mut g = self.inner.lock().unwrap();
        self.unlock_inner(&mut g, old_password)?;
        let key = g.key.clone().unwrap();
        let old = g.data.clone().unwrap();
        let mut plain: Vec<(String, String)> = vec![];
        for (id, b) in &old.entries {
            if let Some(b) = sealed_of(b) {
                plain.push((id.clone(), open(&key, &b)?));
            }
        }
        let (mut data, new_key) = Self::fresh(new_password, Map::new())?;
        for (id, text) in plain {
            data.entries.insert(id, serde_json::to_value(seal(&new_key, &text))?);
        }
        self.persist(&data)?;
        g.data = Some(data);
        g.key = Some(new_key);
        Ok(Self::status_of(&g))
    }

    /// Drops the vault entirely (forgotten master password).
    pub fn reset(&self) -> Value {
        let mut g = self.inner.lock().unwrap();
        let _ = std::fs::remove_file(&self.file);
        g.data = None;
        g.key = None;
        g.loaded = true;
        Self::status_of(&g)
    }

    /// Secrets of `ids`, encrypted with an export password: { salt, box }.
    pub fn export_secrets(&self, ids: &[String], export_password: &str) -> Result<Value> {
        let mut out = Map::new();
        for id in ids {
            let s = self.get(id)?;
            if !s.is_empty() {
                out.insert(id.clone(), Value::Object(s));
            }
        }
        let salt = new_salt();
        let key = derive_key(export_password, &salt)?;
        Ok(json!({ "salt": salt, "box": seal(&key, &Value::Object(out).to_string()) }))
    }

    /// Imports an export blob; `id_map` maps the exported ids to the new ones.
    pub fn import_secrets(&self, blob: &Value, export_password: &str, id_map: &Map<String, Value>) -> Result<()> {
        if !self.is_unlocked() {
            bail!("Vault is locked");
        }
        let salt = blob.get("salt").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("Wrong export password"))?;
        let key = derive_key(export_password, salt)?;
        let b = blob.get("box").and_then(sealed_of).ok_or_else(|| anyhow!("Wrong export password"))?;
        let parsed: Map<String, Value> = open(&key, &b).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or_else(|| anyhow!("Wrong export password"))?;
        for (old_id, secret) in parsed {
            if let (Some(new_id), Value::Object(sec)) = (id_map.get(&old_id).and_then(|v| v.as_str()), secret) {
                self.set(new_id, &sec)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault() -> (Vault, PathBuf) {
        let dir = std::env::temp_dir().join(format!("vytty-vault-{}", crate::util::uid()));
        std::fs::create_dir_all(&dir).unwrap();
        (Vault::new(dir.join("vault.json")), dir)
    }

    fn sec(pairs: &[(&str, &str)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
    }

    #[test]
    fn lifecycle_change_master_export_import() {
        let (v, dir) = tmp_vault();
        assert_eq!(v.status()["exists"], json!(false));
        v.create("correct horse").unwrap();
        v.set("s1", &sec(&[("password", "p1"), ("passphrase", "")])).unwrap();
        assert_eq!(v.get("s1").unwrap(), sec(&[("password", "p1")]), "empty values are not stored");
        let raw = std::fs::read_to_string(dir.join("vault.json")).unwrap();
        assert!(!raw.contains("p1") && !raw.contains("correct horse"));
        v.lock();
        assert!(v.get("s1").unwrap_err().to_string().contains("locked"));
        assert!(v.unlock("nope").unwrap_err().to_string().contains("Wrong master password"));
        v.unlock("correct horse").unwrap();
        v.change_master("correct horse", "battery staple").unwrap();
        v.lock();
        v.unlock("battery staple").unwrap();
        assert_eq!(v.get("s1").unwrap()["password"], json!("p1"));
        let blob = v.export_secrets(&["s1".into(), "missing".into()], "export-pw").unwrap();
        v.remove("s1").unwrap();
        assert!(v.get("s1").unwrap().is_empty());
        let map: Map<String, Value> = [("s1".to_string(), json!("s2"))].into_iter().collect();
        assert!(v.import_secrets(&blob, "bad", &map).unwrap_err().to_string().contains("Wrong export password"));
        v.import_secrets(&blob, "export-pw", &map).unwrap();
        assert_eq!(v.get("s2").unwrap()["password"], json!("p1"));
        v.change_master("battery staple", "").unwrap();
        assert_eq!(v.status()["mode"], json!("none"));
        // A fresh instance (next start) opens the file written above.
        let again = Vault::new(dir.join("vault.json"));
        again.unlock("").unwrap();
        assert_eq!(again.get("s2").unwrap()["password"], json!("p1"));
        v.reset();
        assert_eq!(v.status()["exists"], json!(false));
        let _ = std::fs::remove_dir_all(dir);
    }
}
