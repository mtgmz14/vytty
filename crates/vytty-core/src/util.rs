//! Small helpers shared by the modules: JSON access in the loose style of the
//! JavaScript code this crate replaces (sessions and settings are plain JSON
//! owned by the UI), random ids and atomic file writes.
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

pub type Obj = Map<String, Value>;

pub fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("system random number generator");
    b
}

/// `String(v || '')` for a JSON value: strings as they are, numbers and
/// booleans in their JavaScript form, everything else empty.
pub fn s(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

pub fn js_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// `Number(v)` of JavaScript, NaN as 0 (callers use `|| default`).
pub fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(x)) => parse_js_number(x),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

pub fn parse_js_number(x: &str) -> f64 {
    let t = x.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(h, 16).map(|v| v as f64).unwrap_or(0.0);
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite()).unwrap_or(0.0)
}

/// A number as JSON: integers stay integers (22, not 22.0).
pub fn jnum(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::from(0))
    }
}

/// `Number(x) || default` as JSON.
pub fn num_or(v: Option<&Value>, default: f64) -> Value {
    let n = num(v);
    jnum(if n == 0.0 { default } else { n })
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(x)) => !x.is_empty(),
        Some(_) => true,
    }
}

pub fn obj(v: Value) -> Obj {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Writes to a temp file, flushes it to disk and renames it over the target,
/// so a crash or a power cut never leaves half written JSON behind.
pub fn write_atomic(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp_name = file.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp_name);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        let _ = f.sync_all();
    }
    rename_retry(&tmp, file)
}

pub fn write_json(file: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    write_atomic(file, text.as_bytes())
}

pub fn read_json(file: &Path) -> Option<Value> {
    let text = fs::read_to_string(file).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// Antivirus / EDR scanners (Defender, CrowdStrike...) briefly open files that
/// were just written; on Windows a rename over such a file then fails with a
/// sharing violation. Retry for a moment instead of losing the save.
pub fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut i = 0u64;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = e.kind() == std::io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33));
                if i >= 12 || !transient {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis((25 * (i + 1)).min(200)));
                i += 1;
            }
        }
    }
}

/// Error text for the UI: the message of the error chain's head.
pub fn err_text(e: &anyhow::Error) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_like_conversions() {
        assert_eq!(s(Some(&json!(22))), "22");
        assert_eq!(s(Some(&json!(1.5))), "1.5");
        assert_eq!(s(Some(&json!(null))), "");
        assert_eq!(num(Some(&json!("2222"))), 2222.0);
        assert_eq!(num(Some(&json!("abc"))), 0.0);
        assert_eq!(num_or(Some(&json!("")), 22.0), json!(22));
        assert_eq!(jnum(1.5), json!(1.5));
        assert!(truthy(Some(&json!("x"))) && !truthy(Some(&json!(""))) && !truthy(Some(&json!(0))));
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("vytty-util-{}", uid()));
        let f = dir.join("x.json");
        write_json(&f, &json!({"a": 1})).unwrap();
        write_json(&f, &json!({"a": 2})).unwrap();
        assert_eq!(read_json(&f).unwrap(), json!({"a": 2}));
        assert!(!dir.join("x.json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
