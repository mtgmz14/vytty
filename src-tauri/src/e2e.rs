//! End-to-end test mode (debug builds only): VYTTY_E2E=<driver.js> runs the
//! driver inside the page once the UI is ready; it reports back through the
//! "e2e" call (log lines, screenshots of the X display, the exit code).
use crate::App;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager as _};

pub fn start(app: &AppHandle, _st: &Arc<App>, script: &Path) {
    let code = match std::fs::read_to_string(script) {
        Ok(c) => c,
        Err(e) => {
            println!("[e2e] cannot read {}: {e}", script.display());
            std::process::exit(1);
        }
    };
    let config = std::env::var("VYTTY_E2E_CONFIG").unwrap_or_else(|_| "{}".into());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.__E2E = {config};\n{code}"));
    }
}

pub fn report(app: &AppHandle, st: &Arc<App>, kind: &str, value: &Value) -> Value {
    match kind {
        "log" => println!("[e2e] {}", value.as_str().map(String::from).unwrap_or_else(|| value.to_string())),
        "shot" => {
            let name = value.as_str().unwrap_or("shot");
            if let Ok(out) = std::env::var("VYTTY_E2E_OUT") {
                let file = Path::new(&out).join(format!("{name}.png"));
                let ok = std::process::Command::new("import").args(["-window", "root"]).arg(&file).status().map(|s| s.success()).unwrap_or(false);
                println!("[e2e] screenshot {} {}", file.display(), if ok { "ok" } else { "FAILED" });
            }
        }
        "done" => {
            let code = value.as_i64().unwrap_or(1) as i32;
            println!("[e2e] done, exit {code}");
            st.mgr.close_all();
            st.logger.flush();
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                h.exit(code);
                std::thread::sleep(std::time::Duration::from_secs(3));
                std::process::exit(code);
            });
        }
        _ => {}
    }
    Value::Null
}
