//! The one command of the UI: `call(ch, args)`, dispatched by channel name.
use crate::dialogs::{self, Opts};
use crate::App;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, WebviewWindow};
use vytty_core::events::Event;
use vytty_core::importers;
use vytty_core::util::{obj, s};

#[tauri::command]
pub async fn call(app: AppHandle, window: WebviewWindow, ch: String, args: Vec<Value>) -> Result<Value, String> {
    let st = app.state::<Arc<App>>().inner().clone();
    if cfg!(debug_assertions) && std::env::var_os("VYTTY_TRACE").is_some() {
        eprintln!("[call] {ch}");
    }
    dispatch(&app, &window, &st, &ch, args).await.map_err(|e| vytty_core::util::err_text(&e))
}

/// The window's event channel; a reload of the page subscribes again.
#[tauri::command]
pub fn subscribe(app: AppHandle, channel: Channel<Event>) {
    if cfg!(debug_assertions) && std::env::var_os("VYTTY_TRACE").is_some() {
        eprintln!("[subscribe]");
    }
    let st = app.state::<Arc<App>>().inner().clone();
    st.ui.cancel_all();
    *st.channel.lock().unwrap() = Some(channel);
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

fn arg_s(args: &[Value], i: usize) -> String {
    s(args.get(i))
}

fn filters_of(name: &str, exts: &[&str]) -> Vec<(String, Vec<String>)> {
    if name.is_empty() {
        vec![]
    } else {
        vec![(name.to_string(), exts.iter().map(|e| e.to_string()).collect())]
    }
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

async fn dispatch(app: &AppHandle, window: &WebviewWindow, st: &Arc<App>, ch: &str, args: Vec<Value>) -> Result<Value> {
    let a = |i| arg(&args, i);
    let a_s = |i| arg_s(&args, i);
    Ok(match ch {
        // ------------------------------------------------------------ app
        "app:info" => crate::app_info(st, window),
        "app:ready" => {
            crate::on_ready(app, st);
            Value::Null
        }
        "settings:get" => st.settings.read().unwrap().clone(),
        "settings:save" => {
            let saved = st.store.save_settings(&a(0))?;
            st.logger.configure(&saved["logging"]);
            *st.settings.write().unwrap() = saved.clone();
            saved
        }

        // ------------------------------------------------------- sessions
        "sessions:get" => st.store.get_sessions(),
        "sessions:save" => {
            st.store.save_sessions(&a(0))?;
            Value::Null
        }
        "sessions:export" => {
            let tree = a(0);
            let pw = a_s(1);
            let o = Opts { file_name: Some(format!("vytty-sessions-{}.json", vytty_core::exporters::today())), filters: filters_of("Vytty sessions", &["json"]), ..Default::default() };
            let Some(file) = dialogs::save_file(window, o).await else { return Ok(Value::Null) };
            let credentials = tree.get("credentials").filter(|c| c.is_array()).cloned().unwrap_or(json!([]));
            let mut out = json!({ "format": "vytty-sessions", "version": 1, "folders": tree["folders"], "sessions": tree["sessions"], "credentials": credentials });
            if !pw.is_empty() {
                let mut ids: Vec<String> = tree["sessions"].as_array().map(|a| a.iter().map(|x| s(x.get("id"))).collect()).unwrap_or_default();
                ids.extend(credentials.as_array().map(|a| a.iter().map(|c| format!("cred:{}", s(c.get("id")))).collect::<Vec<_>>()).unwrap_or_default());
                out["secrets"] = st.vault.export_secrets(&ids, &pw)?;
            }
            std::fs::write(&file, serde_json::to_string_pretty(&out)?)?;
            json!(file)
        }
        "sessions:importRead" => {
            let o = Opts { filters: filters_of("Vytty sessions", &["json"]), ..Default::default() };
            let Some(file) = dialogs::open_file(window, o).await else { return Ok(Value::Null) };
            let data: Value = serde_json::from_str(std::fs::read_to_string(&file)?.trim_start_matches('\u{feff}'))?;
            if s(data.get("format")) != "vytty-sessions" {
                bail!("Not a Vytty sessions file");
            }
            data
        }
        "sessions:importSecrets" => {
            st.vault.import_secrets(&a(0), &a_s(1), &obj(a(2)))?;
            Value::Null
        }
        "import:formats" => Value::Array(importers::FORMATS.iter().map(|f| json!({ "id": f.id, "label": f.label, "directory": f.directory })).collect()),
        "import:run" => import_run(window, st, &a_s(0), &a(1)).await?,
        "export:run" => {
            let ex = vytty_core::exporters::exporter(&a_s(0)).ok_or_else(|| anyhow!("Unknown format {}", a_s(0)))?;
            let o = Opts { title: Some(format!("Export as {}", ex.label)), file_name: Some(ex.default_name.into()), filters: filters_of(ex.filter.0, ex.filter.1), ..Default::default() };
            let Some(file) = dialogs::save_file(window, o).await else { return Ok(Value::Null) };
            std::fs::write(&file, (ex.run)(&a(1)))?;
            json!(file)
        }

        // -------------------------------------------------- integrations
        "netbox:test" | "netbox:fetch" => {
            let opts = a(0);
            let mut token = s(opts.get("token"));
            if token.is_empty() {
                token = st.vault.get("integration:netbox").map(|m| s(m.get("token"))).map_err(|_| anyhow!("Unlock the vault to use the stored NetBox token"))?;
            }
            if ch == "netbox:test" {
                vytty_core::netbox::test_connection(&opts, &token).await?
            } else {
                vytty_core::netbox::fetch_sessions(&opts, &token).await?
            }
        }
        "tools:presets" => vytty_core::tools::presets(),
        "tools:plan" => vytty_core::tools::plan(&a(0), &a(1))?,
        "tools:launch" => vytty_core::tools::launch(&a(0), &a(1))?,
        "urlhandler:status" => vytty_core::urlhandler::status(&st.link_target(), st.launch.packaged),
        "urlhandler:set" => vytty_core::urlhandler::set(a(0).as_bool().unwrap_or(false), &st.link_target(), st.launch.packaged)?,

        // ---------------------------------------------------------- vault
        "vault:status" => st.vault.status(),
        "vault:create" => st.vault.create(&a_s(0))?,
        "vault:unlock" => st.vault.unlock(&a_s(0))?,
        "vault:lock" => st.vault.lock(),
        "vault:reset" => st.vault.reset(),
        "vault:get" => Value::Object(st.vault.get(&a_s(0))?),
        "vault:set" => {
            st.vault.set(&a_s(0), &obj(a(1)))?;
            Value::Null
        }
        "vault:remove" => {
            st.vault.remove(&a_s(0))?;
            Value::Null
        }
        "vault:change" => st.vault.change_master(&a_s(0), &a_s(1))?,

        // ---------------------------------------------------- connections
        "conn:open" => {
            st.mgr.open(a_s(0), a(1));
            json!(true)
        }
        "conn:write" => {
            st.mgr.write(&a_s(0), &a_s(1));
            Value::Null
        }
        "conn:resize" => {
            let n = |i: usize| args.get(i).and_then(|v| v.as_u64()).unwrap_or(0).min(1000) as u16;
            st.mgr.resize(&a_s(0), n(1), n(2));
            Value::Null
        }
        "conn:close" => {
            st.mgr.close(&a_s(0));
            Value::Null
        }
        "serial:list" => tokio::task::spawn_blocking(vytty_core::conn::serial::list_ports).await?,
        "prompt:reply" => {
            st.ui.reply(args.first().and_then(|v| v.as_u64()).unwrap_or(0), a(1));
            Value::Null
        }

        // ----------------------------------------------------------- SFTP
        "sftp" => st.mgr.sftp_op(&a_s(0), &a_s(1), &a(2)).await?,
        "sftp:download" => {
            let o = Opts { file_name: Some(a_s(2)), ..Default::default() };
            let Some(file) = dialogs::save_file(window, o).await else { return Ok(Value::Null) };
            st.mgr.sftp_op(&a_s(0), "download", &json!({ "remote": a_s(1), "local": file })).await?;
            json!(file)
        }
        "sftp:uploadPick" => {
            let o = Opts::default();
            let list = if a(0).as_bool().unwrap_or(false) { dialogs::open_dirs(window, o).await } else { dialogs::open_files(window, o).await };
            json!(list)
        }
        "sftp:downloadTo" => {
            let o = Opts { title: Some("Download to…".into()), ..Default::default() };
            let Some(dir) = dialogs::open_dir(window, o).await else { return Ok(Value::Null) };
            st.mgr.sftp_op(&a_s(0), "downloadPaths", &json!({ "items": a(1), "localDir": dir })).await?;
            json!(dir)
        }
        "sftp:prepareDrag" => {
            st.mgr.prepare_drag(&a_s(0), a(1).as_array().map(|v| v.as_slice()).unwrap_or(&[])).await?;
            json!(true)
        }
        "sftp:startDrag" => {
            crate::dragdrop::start(app, window, st, a_s(0), a(1).as_array().cloned().unwrap_or_default(), a(2).as_bool().unwrap_or(false));
            Value::Null
        }
        // Dropped files: their paths (Windows asks WebView2, see win.rs).
        "files:paths" => Value::Null,

        // --------------------------------------------------- system stuff
        "clipboard:read" => {
            let mut g = st.clipboard.lock().unwrap();
            if g.is_none() {
                *g = arboard::Clipboard::new().ok();
            }
            json!(g.as_mut().and_then(|c| c.get_text().ok()).unwrap_or_default())
        }
        "clipboard:write" => {
            let mut g = st.clipboard.lock().unwrap();
            if g.is_none() {
                *g = arboard::Clipboard::new().ok();
            }
            let c = g.as_mut().ok_or_else(|| anyhow!("The clipboard is not available"))?;
            c.set_text(a_s(0)).map_err(|e| anyhow!("{e}"))?;
            Value::Null
        }
        "dialog:openFile" => {
            let o = Opts { title: a(0).get("title").map(|t| s(Some(t))), ..Default::default() };
            json!(dialogs::open_file(window, o).await)
        }
        "dialog:openDir" => json!(dialogs::open_dir(window, Opts::default()).await),
        "logs:open" => {
            st.logger.flush();
            let dir = st.logger.log_dir();
            std::fs::create_dir_all(&dir)?;
            open::that_detached(&dir)?;
            Value::Null
        }
        "logs:today" => {
            st.logger.flush();
            json!(st.logger.log_dir())
        }
        // Folders only: opening a file would run it.
        "shell:openPath" => {
            let p = PathBuf::from(a_s(0));
            if !is_dir(&p) {
                bail!("Not a folder");
            }
            open::that_detached(&p)?;
            Value::Null
        }
        "shell:openExternal" => {
            let u = a_s(0);
            let l = u.to_lowercase();
            if l.starts_with("https://") || l.starts_with("http://") {
                open::that_detached(&u)?;
            }
            Value::Null
        }

        // -------------------------------------------------------- updates
        "update:check" => st.updater.check().await?,
        "update:download" => {
            let me = st.clone();
            let v = st.updater.download(move |got, total, phase| me.emit(Event::UpdateProgress { got, total, phase: phase.into() })).await?;
            json!(v)
        }
        "update:cancel" => {
            st.updater.cancel();
            Value::Null
        }
        "update:install" => {
            let r = st.updater.install()?;
            st.mgr.close_all();
            st.logger.flush();
            std::process::Command::new(&r.exe)
                .arg(format!("--vytty-wait-pid={}", std::process::id()))
                .current_dir(r.exe.parent().unwrap_or(Path::new(".")))
                .spawn()
                .map_err(|e| anyhow!("Could not start {}: {e}", r.exe.display()))?;
            st.allow_close.store(true, Ordering::SeqCst);
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                h.exit(0);
            });
            json!(true)
        }

        // ---------------------------------------------- the window frame
        "win:minimize" => {
            window.minimize()?;
            Value::Null
        }
        "win:maximize" => {
            if window.is_maximized()? {
                window.unmaximize()?;
            } else {
                window.maximize()?;
            }
            Value::Null
        }
        "win:close" => {
            if st.ready.load(Ordering::SeqCst) && !st.allow_close.load(Ordering::SeqCst) {
                st.emit(Event::CloseRequest);
            } else {
                window.close()?;
            }
            Value::Null
        }
        "win:forceClose" => {
            st.allow_close.store(true, Ordering::SeqCst);
            st.mgr.close_all();
            st.logger.flush();
            window.close()?;
            Value::Null
        }
        "win:fullscreen" => {
            window.set_fullscreen(!window.is_fullscreen()?)?;
            Value::Null
        }
        "win:devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
            Value::Null
        }
        "win:drag" => {
            window.start_dragging()?;
            Value::Null
        }
        #[cfg(debug_assertions)]
        "e2e" => crate::e2e::report(app, st, &a_s(0), &a(1)),
        other => bail!("Unknown call {other}"),
    })
}

/// Import from other tools. The file is always picked in a dialog; a second
/// call for the same file (e.g. with the mRemoteNG master password) may pass
/// the path picked before.
async fn import_run(window: &WebviewWindow, st: &Arc<App>, format: &str, opts: &Value) -> Result<Value> {
    let f = importers::format(format).ok_or_else(|| anyhow!("Unknown format {format}"))?;
    let given = PathBuf::from(s(opts.get("file")));
    let file = if !given.as_os_str().is_empty() && st.picked_imports.lock().unwrap().contains(&given) {
        given
    } else {
        let default = importers::default_path(format);
        let o = Opts {
            title: Some(format!("Import {} sessions", f.label)),
            filters: filters_of(f.filter.0, f.filter.1),
            directory: default.as_ref().and_then(|p| p.parent().map(Path::to_path_buf)).filter(|p| p.is_dir()),
            file_name: default.as_ref().filter(|p| p.exists()).and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()),
        };
        let picked = if f.directory { dialogs::open_dir(window, o).await } else { dialogs::open_file(window, o).await };
        let Some(p) = picked else { return Ok(Value::Null) };
        st.picked_imports.lock().unwrap().insert(p.clone());
        p
    };
    let password = s(opts.get("password"));
    let mut parsed: Map<String, Value> = if f.directory {
        importers::parse_import_dir(format, &file)?
    } else {
        if std::fs::metadata(&file)?.len() > 64 * 1024 * 1024 {
            bail!("The file is too large to be a session export");
        }
        let data = std::fs::read(&file)?;
        importers::parse_import(format, &data, if password.is_empty() { None } else { Some(&password) })?
    };
    parsed.insert("file".into(), json!(file));
    parsed.insert("format".into(), json!(format));
    parsed.insert("label".into(), json!(f.label));
    Ok(Value::Object(parsed))
}
