//! NetBox (source of truth for network devices) -> Vytty sessions.
//! Reads devices (dcim) and optionally virtual machines through the REST API
//! with a read-only API token and turns them into sessions grouped by site /
//! role / tenant. Re-syncing updates the sessions created earlier (matched by
//! NetBox object id) instead of duplicating them (the UI does the merge).
use crate::util::s;
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use url::Url;

fn ip_only(addr: &str) -> String {
    static CIDR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/[0-9]+$").unwrap());
    CIDR.replace(addr, "").trim().to_string()
}

pub fn auth_header(token: &str) -> Result<String> {
    let t = token.trim();
    if t.is_empty() {
        bail!("No NetBox API token");
    }
    if t.contains(char::is_whitespace) {
        return Ok(t.to_string()); // "Token abc" / "Bearer nbt_..." typed in full
    }
    Ok(if t.starts_with("nbt_") { format!("Bearer {t}") } else { format!("Token {t}") })
}

pub fn api_url(base: &str, path: &str, query: &str) -> Result<Url> {
    static API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)/api$").unwrap());
    let root = base.trim().trim_end_matches('/');
    let root = API.replace(root, "").to_string();
    let lower = root.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        bail!("The NetBox URL must start with https:// (or http://)");
    }
    let mut u = Url::parse(&format!("{root}{path}")).map_err(|e| anyhow!("Bad NetBox URL: {e}"))?;
    {
        let q = query.trim().trim_start_matches('?');
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(q.as_bytes()).into_owned().collect();
        let mut qp = u.query_pairs_mut();
        for (k, v) in pairs {
            qp.append_pair(&k, &v);
        }
    }
    if u.query() == Some("") {
        u.set_query(None);
    }
    Ok(u)
}

async fn get_json(url: &str, token: &str) -> Result<(u16, Value)> {
    let res = crate::http::client()
        .get(url)
        .header("Authorization", auth_header(token)?)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| anyhow!("NetBox: {e}"))?;
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

/// Follows NetBox pagination ("next"), keeping requests on the configured host
/// (NetBox behind a proxy sometimes reports its internal address in "next").
pub async fn fetch_all(base: &str, path: &str, query: &str, token: &str) -> Result<Vec<Value>> {
    let mut first = api_url(base, path, query)?;
    if !first.query_pairs().any(|(k, _)| k == "limit") {
        first.query_pairs_mut().append_pair("limit", "500");
    }
    let origin = first.origin().ascii_serialization();
    let mut results = vec![];
    let mut next = Some(first.to_string());
    while let Some(url) = next.take() {
        if results.len() >= 20000 {
            break;
        }
        let (status, data) = get_json(&url, token).await?;
        match status {
            401 | 403 => bail!("NetBox rejected the API token ({status})"),
            404 => bail!("NetBox API not found at {origin}{path} - check the URL"),
            200..=299 => {}
            _ => bail!("NetBox returned {status}"),
        }
        let Some(list) = data.get("results").and_then(|r| r.as_array()) else {
            bail!("Unexpected answer from NetBox (is this the API URL?)");
        };
        results.extend(list.iter().cloned());
        if let Some(n) = data.get("next").and_then(|n| n.as_str()) {
            let nu = Url::parse(n)?;
            next = Some(format!("{origin}{}{}", nu.path(), nu.query().map(|q| format!("?{q}")).unwrap_or_default()));
        }
    }
    Ok(results)
}

pub fn highlight_for(platform: &str) -> &'static str {
    static NX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"nx-?os|nexus").unwrap());
    static IOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ios|catalyst|cisco").unwrap());
    static LINUX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"linux|ubuntu|debian|centos|rhel|rocky|alma|suse|fedora").unwrap());
    let t = platform.to_lowercase();
    if NX.is_match(&t) {
        "cisco-nxos"
    } else if IOS.is_match(&t) {
        "cisco-ios"
    } else if LINUX.is_match(&t) {
        "linux"
    } else {
        "auto"
    }
}

fn name_of(x: Option<&Value>) -> String {
    let Some(x) = x.filter(|v| v.is_object()) else { return String::new() };
    [s(x.get("name")), s(x.get("display")), s(x.get("slug"))].into_iter().find(|v| !v.is_empty()).unwrap_or_default()
}

/// One NetBox object -> a session description (no ids yet).
pub fn map_object(obj: &Value, kind: &str, opts: &Value) -> Option<Value> {
    let ip = ["primary_ip", "primary_ip4", "primary_ip6"].iter().find_map(|k| obj.get(*k).filter(|v| v.is_object()));
    let ip_addr = ip.map(|i| ip_only(&s(i.get("address")))).unwrap_or_default();
    let oname = s(obj.get("name"));
    let name = if !oname.is_empty() { oname.clone() } else if !ip_addr.is_empty() { ip_addr.clone() } else { format!("{kind} {}", s(obj.get("id"))) };
    let host_from = s(opts.get("hostFrom"));
    let domain = s(opts.get("domain"));
    let mut host = String::new();
    if host_from == "name" {
        if !oname.is_empty() {
            host = if domain.is_empty() { oname.clone() } else { format!("{oname}.{}", domain.trim_start_matches('.')) };
        }
    } else if host_from == "dns" {
        if let Some(dns) = ip.map(|i| s(i.get("dns_name"))).filter(|d| !d.is_empty()) {
            host = dns;
        }
    }
    if host.is_empty() && ip.is_some() {
        host = ip_addr.clone();
    }
    if host.is_empty() && !oname.is_empty() && host_from != "ip" {
        host = oname.clone();
    }
    if host.is_empty() {
        return None;
    }
    let site = {
        let st = name_of(obj.get("site"));
        if st.is_empty() && kind == "vm" {
            name_of(obj.get("cluster"))
        } else {
            st
        }
    };
    let role = {
        let r = name_of(obj.get("role"));
        if r.is_empty() {
            name_of(obj.get("device_role"))
        } else {
            r
        }
    };
    let tenant = name_of(obj.get("tenant"));
    let group = s(opts.get("groupBy"));
    let group = if group.is_empty() { "site/role".to_string() } else { group };
    let mut folder = vec!["NetBox".to_string()];
    for g in group.split('/') {
        let v = match g {
            "site" => site.clone(),
            "role" => role.clone(),
            "tenant" => tenant.clone(),
            "none" => continue,
            _ => String::new(),
        };
        folder.push(if v.is_empty() { "Unassigned".into() } else { v });
    }
    let platform = name_of(obj.get("platform"));
    let display_url = s(obj.get("display_url"));
    let notes: Vec<String> = [
        s(obj.get("description")),
        if platform.is_empty() { String::new() } else { format!("Platform: {platform}") },
        if s(obj.get("serial")).is_empty() { String::new() } else { format!("Serial: {}", s(obj.get("serial"))) },
        if display_url.is_empty() { String::new() } else { format!("NetBox: {display_url}") },
    ]
    .into_iter()
    .filter(|x| !x.is_empty())
    .collect();
    let slug = obj.get("platform").and_then(|p| p.get("slug")).map(|v| s(Some(v))).unwrap_or_default();
    Some(json!({
        "sourceId": format!("{}:{}", if kind == "vm" { "virtualization.vm" } else { "dcim.device" }, s(obj.get("id"))),
        "name": name,
        "host": host,
        "folder": folder,
        "highlight": highlight_for(&format!("{platform} {slug}")),
        "notes": notes.join("\n"),
        "url": display_url,
    }))
}

pub async fn fetch_sessions(opts: &Value, token: &str) -> Result<Value> {
    let url = s(opts.get("url"));
    let devices = fetch_all(&url, "/api/dcim/devices/", &s(opts.get("deviceFilter")), token).await?;
    let vms = if crate::util::truthy(opts.get("includeVMs")) {
        fetch_all(&url, "/api/virtualization/virtual-machines/", &s(opts.get("vmFilter")), token).await?
    } else {
        vec![]
    };
    let mut items = vec![];
    let mut skipped = 0;
    for d in &devices {
        match map_object(d, "device", opts) {
            Some(m) => items.push(m),
            None => skipped += 1,
        }
    }
    for v in &vms {
        match map_object(v, "vm", opts) {
            Some(m) => items.push(m),
            None => skipped += 1,
        }
    }
    Ok(json!({ "items": items, "devices": devices.len(), "vms": vms.len(), "skipped": skipped }))
}

/// Quick connectivity check for the settings dialog.
pub async fn test_connection(opts: &Value, token: &str) -> Result<Value> {
    let url = api_url(&s(opts.get("url")), "/api/status/", "")?;
    let (status, st) = get_json(url.as_str(), token).await?;
    match status {
        401 | 403 => bail!("NetBox rejected the API token"),
        200..=299 => {}
        _ => bail!("NetBox returned {status}"),
    }
    let v = [s(st.get("netbox-version")), s(st.get("netbox_version"))].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "?".into());
    Ok(json!({ "version": v }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_tokens() {
        assert_eq!(api_url("https://nb.example.com/api/", "/api/dcim/devices/", "status=active&site=waw").unwrap().as_str(), "https://nb.example.com/api/dcim/devices/?status=active&site=waw");
        assert!(api_url("nb.example.com", "/api/status/", "").is_err());
        assert_eq!(auth_header("abc").unwrap(), "Token abc");
        assert_eq!(auth_header("nbt_x").unwrap(), "Bearer nbt_x");
        assert_eq!(auth_header("Bearer y").unwrap(), "Bearer y");
    }

    #[test]
    fn mapping() {
        let dev = json!({ "id": 7, "name": "sw1", "display_url": "http://nb/dcim/devices/7/", "primary_ip": { "address": "10.0.0.7/24", "dns_name": "sw1.lab" },
            "site": { "name": "WAW1" }, "role": { "name": "Access" }, "platform": { "name": "Cisco IOS", "slug": "ios" }, "serial": "X1" });
        let m = map_object(&dev, "device", &json!({ "hostFrom": "ip", "groupBy": "site/role" })).unwrap();
        assert_eq!(m["host"], json!("10.0.0.7"));
        assert_eq!(m["folder"], json!(["NetBox", "WAW1", "Access"]));
        assert_eq!(m["highlight"], json!("cisco-ios"));
        assert_eq!(m["sourceId"], json!("dcim.device:7"));
        assert!(m["notes"].as_str().unwrap().contains("Serial: X1"));
        assert_eq!(map_object(&dev, "device", &json!({ "hostFrom": "dns" })).unwrap()["host"], json!("sw1.lab"));
        assert_eq!(map_object(&dev, "device", &json!({ "hostFrom": "name", "domain": ".corp" })).unwrap()["host"], json!("sw1.corp"));
        assert!(map_object(&json!({ "id": 1 }), "device", &json!({ "hostFrom": "ip" })).is_none());
        let vm = json!({ "id": 3, "name": "vm1", "primary_ip4": { "address": "10.1.1.1/32" }, "cluster": { "name": "C1" } });
        assert_eq!(map_object(&vm, "vm", &json!({ "groupBy": "site/tenant" })).unwrap()["folder"], json!(["NetBox", "C1", "Unassigned"]));
    }
}
