//! Verifying updates (pure functions, unit tested).
//!
//! Every release carries SHA256SUMS.txt (plain `sha256sum` format, so it can
//! also be checked by hand) and SHA256SUMS.txt.sig: an Ed25519 signature of the
//! exact bytes of SHA256SUMS.txt, made with the release key - kept offline by
//! the maintainer (scripts/sign-release.js) or as the release workflow's secret.
//! The public half is built into Vytty (update-keys.json). An update is
//! installed only when the signature is valid AND the downloaded file has the
//! hash listed for its name - a file swapped on the download server, a
//! corrupted download or a tampering proxy is refused.
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

pub const SUMS_NAME: &str = "SHA256SUMS.txt";
pub const SIG_NAME: &str = "SHA256SUMS.txt.sig";

/// Public keys trusted to sign releases (base64 DER / SPKI), shared with the
/// release scripts. Several may be listed for key rotation.
pub fn trusted_keys() -> Vec<String> {
    serde_json::from_str(include_str!("../../../update-keys.json")).expect("update-keys.json")
}

/// "1.2.3", "v1.2.3", "1.2.3-beta.1" -> ([1,2,3], "beta.1")
pub fn parse_version(v: &str) -> (Vec<u64>, String) {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^v?([0-9]+(?:\.[0-9]+)*)(?:-([0-9A-Za-z.-]+))?").unwrap());
    match RE.captures(v.trim()) {
        Some(c) => (c[1].split('.').map(|x| x.parse().unwrap_or(0)).collect(), c.get(2).map(|m| m.as_str().to_string()).unwrap_or_default()),
        None => (vec![0], String::new()),
    }
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    // localeCompare(..., { numeric: true }) for the pre-release labels we use.
    static TOK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]+|[^0-9]+").unwrap());
    let ta: Vec<&str> = TOK.find_iter(a).map(|m| m.as_str()).collect();
    let tb: Vec<&str> = TOK.find_iter(b).map(|m| m.as_str()).collect();
    for (x, y) in ta.iter().zip(tb.iter()) {
        let o = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(p), Ok(q)) => p.cmp(&q),
            _ => x.to_lowercase().cmp(&y.to_lowercase()),
        };
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    ta.len().cmp(&tb.len())
}

/// Is version `a` newer than `b`? A release beats its own pre-releases.
pub fn newer(a: &str, b: &str) -> bool {
    let (na, pa) = parse_version(a);
    let (nb, pb) = parse_version(b);
    for i in 0..na.len().max(nb.len()) {
        let x = na.get(i).copied().unwrap_or(0);
        let y = nb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    if pa == pb {
        return false;
    }
    if pa.is_empty() {
        return true;
    }
    if pb.is_empty() {
        return false;
    }
    natural_cmp(&pa, &pb) == std::cmp::Ordering::Greater
}

/// `sha256sum` output: "<64 hex>  <name>" (or " *<name>"); # comments ignored.
pub fn parse_sums(text: &str) -> Result<BTreeMap<String, String>> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9a-fA-F]{64})\s+\*?(.+)$").unwrap());
    let mut out = BTreeMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let c = LINE.captures(line).ok_or_else(|| anyhow!("Malformed checksum line: {}", line.chars().take(80).collect::<String>()))?;
        out.insert(c[2].trim().to_string(), c[1].to_lowercase());
    }
    Ok(out)
}

pub fn format_sums(entries: &[(String, String)]) -> String {
    entries.iter().map(|(name, hash)| format!("{hash}  {name}\n")).collect()
}

const ED25519_SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

fn key_from_spki(b64: &str) -> Option<VerifyingKey> {
    let der = B64.decode(b64.trim()).ok()?;
    if der.len() != 44 || der[..12] != ED25519_SPKI_PREFIX {
        return None;
    }
    VerifyingKey::from_bytes(der[12..].try_into().ok()?).ok()
}

pub fn verify_signature(data: &[u8], signature_b64: &str, keys: &[String]) -> bool {
    let Ok(sig) = B64.decode(signature_b64.trim()) else { return false };
    let Ok(sig) = <[u8; 64]>::try_from(sig.as_slice()) else { return false };
    let sig = Signature::from_bytes(&sig);
    keys.iter().filter_map(|k| key_from_spki(k)).any(|k| k.verify_strict(data, &sig).is_ok())
}

pub fn sha256_file(file: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(file)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Checks a signed checksum list and returns the expected hash of `asset_name`.
/// Fails with a message meant for the user when anything does not add up.
pub fn expected_hash(sums_text: &str, signature: &str, keys: &[String], asset_name: &str, version: &str) -> Result<String> {
    if keys.is_empty() {
        bail!("This build has no update signing key");
    }
    if signature.trim().is_empty() {
        bail!("The release has no signature (SHA256SUMS.txt.sig)");
    }
    if !verify_signature(sums_text.as_bytes(), signature, keys) {
        bail!("The release signature is not valid");
    }
    let sums = parse_sums(sums_text)?;
    let hash = sums.get(asset_name).ok_or_else(|| anyhow!("{asset_name} is not listed in the signed checksums"))?;
    // The version is part of every asset name, so an old (validly signed)
    // checksum list cannot be replayed to push an older build.
    let v = version.trim_start_matches(['v', 'V']);
    if !v.is_empty() && !asset_name.contains(v) {
        bail!("{asset_name} does not belong to version {version}");
    }
    Ok(hash.clone())
}

/// The release asset for an install mode ("portable", "folder", "appimage").
pub fn asset_name_for(mode: &str, version: &str) -> Option<String> {
    let v = version.trim_start_matches(['v', 'V']);
    match mode {
        "portable" => Some(format!("Vytty-{v}-portable.exe")),
        "folder" => Some(format!("Vytty-{v}-win-x64.zip")),
        "appimage" => Some(format!("Vytty-{v}.AppImage")),
        _ => None,
    }
}

/// Names a previous version left behind, safe to delete after an update.
pub fn is_old_build_name(name: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Vytty-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9_.]+)?(?:-portable\.exe|\.AppImage)$").unwrap());
    RE.is_match(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn keypair() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&crate::util::random_bytes::<32>());
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(sk.verifying_key().as_bytes());
        (sk, B64.encode(der))
    }

    #[test]
    fn versions() {
        assert!(newer("0.11.0", "0.10.0"));
        assert!(newer("v1.0.0", "0.99.9"));
        assert!(!newer("0.10.0", "0.10.0"));
        assert!(newer("1.0.0", "1.0.0-beta.2"));
        assert!(!newer("1.0.0-beta.2", "1.0.0"));
        assert!(newer("1.0.0-beta.10", "1.0.0-beta.2"));
        assert!(!newer("0.9.9", "0.10.0"));
    }

    #[test]
    fn signed_sums() {
        let (sk, pk) = keypair();
        let sums = format_sums(&[("Vytty-1.2.3.AppImage".into(), "a".repeat(64)), ("Vytty-1.2.3-portable.exe".into(), "B".repeat(64))]);
        let sig = B64.encode(sk.sign(sums.as_bytes()).to_bytes());
        let keys = vec![pk];
        assert_eq!(expected_hash(&sums, &sig, &keys, "Vytty-1.2.3.AppImage", "1.2.3").unwrap(), "a".repeat(64));
        assert_eq!(parse_sums(&sums).unwrap()["Vytty-1.2.3-portable.exe"], "b".repeat(64));
        let tampered = sums.replace("aaaa", "aaab");
        assert!(expected_hash(&tampered, &sig, &keys, "Vytty-1.2.3.AppImage", "1.2.3").unwrap_err().to_string().contains("not valid"));
        assert!(expected_hash(&sums, "", &keys, "Vytty-1.2.3.AppImage", "1.2.3").unwrap_err().to_string().contains("no signature"));
        assert!(expected_hash(&sums, &sig, &keys, "Vytty-9.9.9.AppImage", "9.9.9").unwrap_err().to_string().contains("not listed"));
        assert!(expected_hash(&sums, &sig, &keys, "Vytty-1.2.3.AppImage", "1.2.4").unwrap_err().to_string().contains("does not belong"));
        let (_, other) = keypair();
        assert!(!verify_signature(sums.as_bytes(), &sig, &[other]));
        assert!(parse_sums("nonsense").is_err());
    }

    #[test]
    fn signature_made_by_node_verifies() {
        // SHA256SUMS.txt.sig of the published v0.10.0 release (signed with Node's crypto.sign).
        let sums = "300d4d9f73f70f303be6f2fe75869b6b4e40c0d9be7507fea196fbafe8e45c46  Vytty-0.10.0-portable.exe\n47356cc9bae3f96f5ee1e2eb95e551be23c9862fbe21a56911c85a518259564e  Vytty-0.10.0-win-x64.zip\ne16d947088b224bd0278e41e30c7034c184269a719fa15a3b8e4b159f4b970a2  Vytty-0.10.0.AppImage\n";
        let sig = include_str!("../tests/data/v0.10.0.sig");
        assert!(verify_signature(sums.as_bytes(), sig, &trusted_keys()));
    }

    #[test]
    fn names() {
        assert_eq!(asset_name_for("portable", "v0.11.0").unwrap(), "Vytty-0.11.0-portable.exe");
        assert_eq!(asset_name_for("folder", "0.11.0").unwrap(), "Vytty-0.11.0-win-x64.zip");
        assert!(is_old_build_name("Vytty-0.10.0-portable.exe"));
        assert!(is_old_build_name("Vytty-1.0.0-beta.1.AppImage"));
        assert!(!is_old_build_name("Vytty.exe"));
        assert!(!is_old_build_name("notes.txt"));
    }
}
