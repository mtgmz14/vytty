//! mRemoteNG connection file (confCons.xml).
//! Containers become folders; SSH1/SSH2 and Telnet connections are imported,
//! other protocols (RDP, VNC, HTTP...) are counted as skipped.
//!
//! Passwords: mRemoteNG encrypts them with AES-GCM (or AES-CBC in old files)
//! using a key derived from its master password. Files saved without a master
//! password use the built-in one ("mR3m"), so their passwords can be moved into
//! Vytty's vault during the import. For a protected file the user is asked for
//! the master password. Nothing is decrypted unless the user imports the file.
use super::common::{decode_text, TreeBuilder};
use super::xml::{parse_xml, Node};
use crate::util::{jnum, Obj};
use aes_gcm::aead::consts::U16;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use md5::{Digest, Md5};
use serde_json::{json, Value};

pub const DEFAULT_PASSWORD: &str = "mR3m";

type Aes256Gcm16 = aes_gcm::AesGcm<aes::Aes256, U16>;

fn derive(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), salt, iterations.max(1), &mut key);
    key
}

/// AES-GCM: base64(salt[16] | nonce[16] | ciphertext | tag[16]),
/// key = PBKDF2-HMAC-SHA1(password, salt, iterations, 32), AAD = salt.
pub fn decrypt_gcm(b64: &str, password: &str, iterations: u32) -> Result<String> {
    let buf = B64.decode(b64.trim())?;
    if buf.len() < 48 {
        bail!("too short");
    }
    let (salt, rest) = buf.split_at(16);
    let (nonce, data) = rest.split_at(16);
    let key = derive(password, salt, iterations);
    let cipher = Aes256Gcm16::new_from_slice(&key).map_err(|_| anyhow!("key"))?;
    let plain = cipher
        .decrypt(aes_gcm::Nonce::<U16>::from_slice(nonce), Payload { msg: data, aad: salt })
        .map_err(|_| anyhow!("decryption failed"))?;
    Ok(String::from_utf8_lossy(&plain).into_owned())
}

pub fn encrypt_gcm(text: &str, password: &str, iterations: u32) -> String {
    let salt: [u8; 16] = crate::util::random_bytes();
    let nonce: [u8; 16] = crate::util::random_bytes();
    let key = derive(password, &salt, iterations);
    let cipher = Aes256Gcm16::new_from_slice(&key).expect("key length");
    let enc = cipher
        .encrypt(aes_gcm::Nonce::<U16>::from_slice(&nonce), Payload { msg: text.as_bytes(), aad: &salt })
        .expect("encryption");
    let mut out = salt.to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&enc);
    B64.encode(out)
}

/// Old files: base64(iv[16] | AES-128-CBC(md5(password))).
pub fn decrypt_cbc(b64: &str, password: &str) -> Result<String> {
    let buf = B64.decode(b64.trim())?;
    if buf.len() < 32 {
        bail!("too short");
    }
    let key = Md5::digest(password.as_bytes());
    let dec = cbc::Decryptor::<aes::Aes128>::new_from_slices(&key, &buf[..16]).map_err(|_| anyhow!("key"))?;
    let plain = dec.decrypt_padded_vec_mut::<Pkcs7>(&buf[16..]).map_err(|_| anyhow!("decryption failed"))?;
    Ok(String::from_utf8_lossy(&plain).into_owned())
}

struct Decryptor {
    gcm: bool,
    iterations: u32,
    password: String,
}

impl Decryptor {
    fn new(root: &Node, password: &str) -> Self {
        let gcm = root.attr_or_empty("BlockCipherMode").to_lowercase().contains("gcm")
            || root.attr_or_empty("EncryptionEngine").to_lowercase().contains("aes");
        let it = root.attr_or_empty("KdfIterations").trim().parse::<u32>().unwrap_or(0);
        Decryptor { gcm, iterations: if it == 0 { 1000 } else { it }, password: password.to_string() }
    }
    fn dec(&self, b64: &str) -> Option<String> {
        if b64.is_empty() {
            return Some(String::new());
        }
        let gcm = || decrypt_gcm(b64, &self.password, self.iterations);
        let cbc = || decrypt_cbc(b64, &self.password);
        if self.gcm { gcm().or_else(|_| cbc()) } else { cbc().or_else(|_| gcm()) }.ok()
    }
}

fn is_true(v: &str) -> bool {
    v.eq_ignore_ascii_case("true")
}

/// password: the mRemoteNG master password, if the user gave one.
pub fn parse(input: &[u8], password: Option<&str>) -> Result<Obj> {
    let doc = parse_xml(&decode_text(input));
    let Some(root) = doc.children.iter().find(|n| n.local_name() == "Connections").cloned() else {
        bail!("Not an mRemoteNG connection file (no <Connections> element)");
    };
    let mut root = root;
    let mut tree = TreeBuilder::new(Some("mRemoteNG"));
    let given = password.filter(|p| !p.is_empty());

    // Which password opens this file? "Protected" holds an encrypted marker.
    let mut pw: Option<String> = Some(given.unwrap_or(DEFAULT_PASSWORD).to_string());
    let dec = Decryptor::new(&root, pw.as_deref().unwrap());
    let marker = match root.attr("Protected") {
        Some(p) if !p.is_empty() => dec.dec(p),
        _ => Some("ThisIsNotProtected".into()),
    };
    let can_decrypt = matches!(marker.as_deref(), Some("ThisIsNotProtected" | "ThisIsProtected"));
    if !can_decrypt && given.is_none() {
        // Protected with a master password we were not given: import without passwords.
        tree.notes.push("protected".into());
        pw = None;
    } else if !can_decrypt {
        bail!("Wrong mRemoteNG master password");
    }
    // Whole-file encryption: the element's text is the encrypted XML.
    if is_true(root.attr_or_empty("FullFileEncryption")) {
        if pw.is_none() {
            bail!("This mRemoteNG file is fully encrypted - enter its master password");
        }
        let inner = dec.dec(root.text.trim()).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("Could not decrypt the mRemoteNG file"))?;
        let inner_doc = parse_xml(&format!("<Connections>{inner}</Connections>"));
        root.children = inner_doc.children.into_iter().next().map(|n| n.children).unwrap_or_default();
    }

    let mut passwords = 0u64;
    struct Inherit {
        username: String,
        password: String,
    }
    #[allow(clippy::too_many_arguments)]
    fn walk(tree: &mut TreeBuilder, node: &Node, segments: &[String], inh: &Inherit, dec: &Decryptor, use_pw: bool, passwords: &mut u64) {
        for n in node.children.iter().filter(|c| c.local_name() == "Node") {
            let a = |k: &str| n.attr_or_empty(k).to_string();
            let user = if is_true(&a("InheritUsername")) { inh.username.clone() } else { a("Username") };
            let enc_pw = if is_true(&a("InheritPassword")) { inh.password.clone() } else { a("Password") };
            if a("Type").eq_ignore_ascii_case("container") {
                let mut next = segments.to_vec();
                let name = a("Name");
                next.push(if name.is_empty() { "Folder".into() } else { name });
                walk(tree, n, &next, &Inherit { username: user, password: enc_pw }, dec, use_pw, passwords);
                continue;
            }
            if !a("Type").eq_ignore_ascii_case("connection") {
                continue;
            }
            let label = a("Protocol");
            let proto = match label.to_lowercase().as_str() {
                "ssh1" | "ssh2" => "ssh",
                "telnet" => "telnet",
                _ => {
                    tree.skip(if label.is_empty() { "unknown" } else { &label });
                    continue;
                }
            };
            let host = a("Hostname").trim().to_string();
            if host.is_empty() {
                tree.skip(&label);
                continue;
            }
            let port = crate::util::parse_js_number(&a("Port"));
            let folder = tree.folder(segments);
            let mut s = Obj::new();
            s.insert("name".into(), json!(if a("Name").is_empty() { host.clone() } else { a("Name") }));
            s.insert("protocol".into(), json!(proto));
            s.insert("host".into(), json!(host));
            s.insert("port".into(), jnum(if port == 0.0 { if proto == "ssh" { 22.0 } else { 23.0 } } else { port }));
            s.insert("username".into(), json!(user));
            s.insert("notes".into(), json!(a("Descr")));
            s.insert("folderId".into(), folder.map(Value::String).unwrap_or(Value::Null));
            if proto == "telnet" {
                s.insert("autoLogin".into(), json!(true));
            }
            let id = tree.add(s, &label);
            if use_pw && !enc_pw.is_empty() {
                if let Some(plain) = dec.dec(&enc_pw).filter(|p| !p.is_empty()) {
                    tree.secrets.insert(id, json!({ "password": plain }));
                    *passwords += 1;
                }
            }
        }
    }
    walk(&mut tree, &root, &[], &Inherit { username: String::new(), password: String::new() }, &dec, pw.is_some(), &mut passwords);
    let protected = tree.notes.iter().any(|n| n == "protected");
    let mut res = tree.result();
    if let Some(Value::Object(stats)) = res.get_mut("stats") {
        stats.insert("passwords".into(), json!(passwords));
    }
    res.insert("protected".into(), json!(protected));
    Ok(res)
}
