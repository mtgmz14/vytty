//! SFTP on a connected SSH session: listing, transfers with progress (single
//! files and whole folders), rename / delete, and the temporary copies used
//! to drag files out of the window.
use super::{Conn, Manager};
use crate::events::Event;
use crate::util::{s, truthy};
use anyhow::{anyhow, bail, Result};
use russh_sftp::client::SftpSession;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

pub async fn session(conn: &Arc<Conn>) -> Result<Arc<SftpSession>> {
    let mut g = conn.sftp.lock().await;
    if let Some(s) = g.as_ref() {
        return Ok(s.clone());
    }
    let client = conn.ssh.lock().unwrap().clone().ok_or_else(|| anyhow!("SFTP is available for connected SSH sessions only"))?;
    let ch = client.handle.channel_open_session().await?;
    ch.request_subsystem(true, "sftp").await?;
    let cfg = russh_sftp::client::Config { max_concurrent_reads: 32, max_concurrent_writes: 32, request_timeout_secs: 60, ..Default::default() };
    let sftp = Arc::new(SftpSession::new_with_config(ch.into_stream(), cfg).await.map_err(|e| anyhow!("SFTP: {e}"))?);
    *g = Some(sftp.clone());
    Ok(sftp)
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn base_name(p: &str) -> String {
    p.rsplit(['/', '\\']).find(|x| !x.is_empty()).unwrap_or(p).to_string()
}

fn err(e: russh_sftp::client::error::Error) -> anyhow::Error {
    anyhow!("{e}")
}

struct Progress<'a> {
    mgr: &'a Manager,
    id: &'a str,
    name: String,
    op: &'static str,
    total: u64,
    last: Instant,
}

impl Progress<'_> {
    fn report(&mut self, done: u64, force: bool) {
        if force || self.last.elapsed() > Duration::from_millis(150) {
            self.last = Instant::now();
            self.mgr.ui.emit(Event::SftpProgress { id: self.id.into(), p: json!({ "name": self.name, "transferred": done, "total": self.total, "op": self.op }) });
        }
    }
}

async fn download(mgr: &Manager, id: &str, sftp: &SftpSession, remote: &str, local: &Path) -> Result<()> {
    let total = sftp.metadata(remote.to_string()).await.ok().and_then(|m| m.size).unwrap_or(0);
    let mut src = sftp.open(remote.to_string()).await.map_err(err)?;
    let mut dst = tokio::fs::File::create(local).await.map_err(|e| anyhow!("{}: {e}", local.display()))?;
    let mut p = Progress { mgr, id, name: base_name(remote), op: "download", total, last: Instant::now() };
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        p.report(done, false);
    }
    dst.flush().await?;
    p.total = p.total.max(done);
    p.report(done, true);
    Ok(())
}

async fn upload(mgr: &Manager, id: &str, sftp: &SftpSession, local: &Path, remote: &str) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await.map_err(|e| anyhow!("{}: {e}", local.display()))?;
    let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut dst = sftp.create(remote.to_string()).await.map_err(err)?;
    let mut p = Progress { mgr, id, name: base_name(&local.to_string_lossy()), op: "upload", total, last: Instant::now() };
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        p.report(done, false);
    }
    dst.shutdown().await?;
    p.report(done, true);
    Ok(())
}

fn is_dir_mode(mode: Option<u32>) -> bool {
    mode.map(|m| m & S_IFMT == S_IFDIR).unwrap_or(false)
}

async fn list(sftp: &SftpSession, path: &str) -> Result<Vec<Value>> {
    let mut out = vec![];
    for e in sftp.read_dir(path.to_string()).await.map_err(err)? {
        let name = e.file_name().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let m = e.metadata();
        let mode = m.permissions.unwrap_or(0);
        out.push(json!({
            "name": name,
            "size": m.size.unwrap_or(0),
            "mtime": m.mtime.map(|t| t as u64 * 1000).unwrap_or(0),
            "isDir": mode & S_IFMT == S_IFDIR,
            "isLink": mode & S_IFMT == S_IFLNK,
            "mode": mode,
        }));
    }
    out.sort_by(|a, b| {
        let (da, db) = (a["isDir"].as_bool().unwrap_or(false), b["isDir"].as_bool().unwrap_or(false));
        db.cmp(&da).then_with(|| {
            let (na, nb) = (a["name"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or(""));
            na.to_lowercase().cmp(&nb.to_lowercase()).then_with(|| na.cmp(nb))
        })
    });
    Ok(out)
}

async fn download_tree(mgr: &Manager, id: &str, sftp: &SftpSession, items: &[Value], local_dir: &Path) -> Result<Vec<String>> {
    tokio::fs::create_dir_all(local_dir).await?;
    let mut out = vec![];
    for it in items {
        let remote = s(it.get("path"));
        out.push(get_tree(mgr, id, sftp, remote, truthy(it.get("isDir")), local_dir.to_path_buf()).await?.to_string_lossy().to_string());
    }
    Ok(out)
}

fn get_tree<'a>(mgr: &'a Manager, id: &'a str, sftp: &'a SftpSession, remote: String, is_dir: bool, target: PathBuf) -> futures_util::future::BoxFuture<'a, Result<PathBuf>> {
    Box::pin(async move {
        let name = base_name(&remote);
        if name == ".." || name == "." || name.contains(['/', '\\']) {
            bail!("Unsafe file name {name}");
        }
        let local = target.join(&name);
        if is_dir {
            tokio::fs::create_dir_all(&local).await?;
            for e in sftp.read_dir(remote.clone()).await.map_err(err)? {
                let child = e.file_name().to_string();
                if child == "." || child == ".." {
                    continue;
                }
                let dir = is_dir_mode(e.metadata().permissions);
                get_tree(mgr, id, sftp, join(&remote, &child), dir, local.clone()).await?;
            }
        } else {
            download(mgr, id, sftp, &remote, &local).await?;
        }
        Ok(local)
    })
}

fn put_tree<'a>(mgr: &'a Manager, id: &'a str, sftp: &'a SftpSession, local: PathBuf, remote_dir: String, count: &'a mut u64) -> futures_util::future::BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let name = local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let remote = join(&remote_dir, &name);
        let meta = tokio::fs::metadata(&local).await.map_err(|e| anyhow!("{}: {e}", local.display()))?;
        if meta.is_dir() {
            let _ = sftp.create_dir(remote.clone()).await;
            let mut rd = tokio::fs::read_dir(&local).await?;
            let mut children = vec![];
            while let Some(e) = rd.next_entry().await? {
                children.push(e.path());
            }
            children.sort();
            for c in children {
                put_tree(mgr, id, sftp, c, remote.clone(), count).await?;
            }
        } else {
            upload(mgr, id, sftp, &local, &remote).await?;
            *count += 1;
        }
        Ok(())
    })
}

fn remove_tree<'a>(sftp: &'a SftpSession, path: String, is_dir: bool) -> futures_util::future::BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        if !is_dir {
            return sftp.remove_file(path).await.map_err(err);
        }
        for e in sftp.read_dir(path.clone()).await.map_err(err)? {
            let child = e.file_name().to_string();
            if child == "." || child == ".." {
                continue;
            }
            remove_tree(sftp, join(&path, &child), is_dir_mode(e.metadata().permissions)).await?;
        }
        sftp.remove_dir(path).await.map_err(err)
    })
}

impl Manager {
    /// The `sftp` channel of the window: one operation on connection `id`.
    pub async fn sftp_op(self: &Arc<Self>, id: &str, op: &str, args: &Value) -> Result<Value> {
        let conn = self.get(id).ok_or_else(|| anyhow!("SFTP is available for connected SSH sessions only"))?;
        let sftp = session(&conn).await?;
        let a = |k: &str| s(args.get(k));
        Ok(match op {
            "realpath" => {
                let p = a("path");
                json!(sftp.canonicalize(if p.is_empty() { ".".to_string() } else { p }).await.map_err(err)?.to_string())
            }
            "list" => Value::Array(list(&sftp, &a("path")).await?),
            "stat" => {
                let m = sftp.metadata(a("path")).await.map_err(err)?;
                json!({ "isDir": is_dir_mode(m.permissions), "size": m.size.unwrap_or(0) })
            }
            "mkdir" => {
                sftp.create_dir(a("path")).await.map_err(err)?;
                Value::Null
            }
            "rmdir" => {
                sftp.remove_dir(a("path")).await.map_err(err)?;
                Value::Null
            }
            "unlink" => {
                sftp.remove_file(a("path")).await.map_err(err)?;
                Value::Null
            }
            "rename" => {
                sftp.rename(a("from"), a("to")).await.map_err(err)?;
                Value::Null
            }
            "download" => {
                download(self, id, &sftp, &a("remote"), Path::new(&a("local"))).await?;
                Value::Null
            }
            "upload" => {
                upload(self, id, &sftp, Path::new(&a("local")), &a("remote")).await?;
                Value::Null
            }
            "uploadPaths" => {
                let mut count = 0u64;
                let dir = a("remoteDir");
                for l in args.get("locals").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                    put_tree(self, id, &sftp, PathBuf::from(s(Some(&l))), dir.clone(), &mut count).await?;
                }
                json!(count)
            }
            "downloadPaths" => {
                let items = args.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                json!(download_tree(self, id, &sftp, &items, Path::new(&a("localDir"))).await?)
            }
            "remove" => {
                for it in args.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                    remove_tree(&sftp, s(it.get("path")), truthy(it.get("isDir"))).await?;
                }
                json!(true)
            }
            other => bail!("Unknown SFTP op {other}"),
        })
    }

    /// Downloads remote items into a per-drag temp folder so they can be
    /// dragged out to the file manager. Cached by path + size + mtime, so
    /// dragging the same file again is instant.
    pub async fn prepare_drag(self: &Arc<Self>, id: &str, items: &[Value]) -> Result<Vec<String>> {
        let key = format!(
            "{id}|{}",
            items.iter().map(|i| format!("{}:{}:{}", s(i.get("path")), s(i.get("size")), s(i.get("mtime")))).collect::<Vec<_>>().join("|")
        );
        let cell = self.drag_cache.lock().unwrap().entry(key.clone()).or_default().clone();
        let me = self.clone();
        let id2 = id.to_string();
        let items2 = items.to_vec();
        let r = cell
            .get_or_init(|| async move {
                let dir = drag_root().join(format!("{}-{}", drag_prefix(&id2), hex::encode(crate::util::random_bytes::<6>())));
                let conn = me.get(&id2).ok_or_else(|| "Not connected".to_string())?;
                let sftp = session(&conn).await.map_err(|e| e.to_string())?;
                download_tree(&me, &id2, &sftp, &items2, &dir).await.map_err(|e| e.to_string())
            })
            .await
            .clone();
        if r.is_err() {
            self.drag_cache.lock().unwrap().remove(&key);
        }
        r.map_err(|e| anyhow!(e))
    }

    /// A closed connection's drag copies are no longer needed (they can be large).
    pub fn drop_drag_cache(&self, id: &str) {
        self.drag_cache.lock().unwrap().retain(|k, _| !k.starts_with(&format!("{id}|")));
        let prefix = format!("{}-", drag_prefix(id));
        if let Ok(rd) = std::fs::read_dir(drag_root()) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(&prefix) {
                    let p = e.path();
                    std::thread::spawn(move || {
                        let _ = std::fs::remove_dir_all(p);
                    });
                }
            }
        }
    }
}

pub fn drag_root() -> PathBuf {
    std::env::temp_dir().join("vytty-drag")
}

fn drag_prefix(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(40).collect()
}

pub fn cleanup_drag_temp() {
    let _ = std::fs::remove_dir_all(drag_root());
}
