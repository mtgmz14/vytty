'use strict';
// Deferred drag-out for large remote files (the WinSCP trick).
// Chromium can only drag files that already exist on disk, and a big file
// (a film, an image backup...) cannot be downloaded while the user holds the
// mouse. So we drag empty placeholders with the real names from a unique temp
// folder. Explorer copies them to wherever the user drops; we then find where
// they landed and download the real content straight into them.
//
// Finding the drop uses file system notifications only: the user's folders are
// watched while the drag is in progress. Earlier versions asked a hidden
// PowerShell (Shell.Application COM) for the folders open in Explorer, which
// endpoint protection (CrowdStrike, Defender for Endpoint...) rightly treats as
// suspicious behaviour for an unsigned app. No child processes are started here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DRAG_ROOT = path.join(os.tmpdir(), 'vytty-drag');

// Profile folders that are never a drop target and are busy enough to flood
// a recursive watcher (browser caches live in AppData).
const SKIP_DIRS = new Set(['appdata', 'application data', 'local settings', 'node_modules', 'scoop', 'go', 'miniconda3', 'anaconda3']);

// Create 0-byte files (or empty folders) named like the remote items.
function makePlaceholders(items) {
  const dir = path.join(DRAG_ROOT, `d-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = items.map((it) => {
    const p = path.join(dir, path.posix.basename(it.path));
    if (it.isDir) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, '');
    return p;
  });
  return { dir, files };
}

// The well-known folders a drop most likely lands in.
function knownDirs(home = os.homedir()) {
  const out = [path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Desktop')];
  for (const v of [process.env.OneDrive, process.env.OneDriveCommercial]) if (v) out.push(v, path.join(v, 'Desktop'));
  if (process.env.PUBLIC) out.push(path.join(process.env.PUBLIC, 'Desktop'));
  return [...new Set(out)];
}

// [dir, recursive] pairs to watch while a drag is in progress. On Windows and
// macOS recursive watching is a single kernel subscription per folder, so every
// top-level folder of the profile (except AppData & co.) is covered. On Linux
// recursive watching walks the whole tree, so only the known folders are used.
function watchTargets(home = os.homedir(), platform = process.platform) {
  const targets = [[home, false]];
  const recursive = platform === 'win32' || platform === 'darwin';
  if (recursive) {
    let entries = [];
    try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) {
      // Junctions ("My Documents", "Cookies"...) are not directories here.
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      targets.push([path.join(home, e.name), true]);
    }
  }
  for (const d of knownDirs(home)) {
    if (!targets.some(([t]) => t === d || (recursive && d.startsWith(t + path.sep)))) targets.push([d, false]);
  }
  return targets.filter(([d]) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// A dropped copy: same name, still empty, created after the drag started.
function isPlaceholder(p, isDir, since) {
  try {
    const st = fs.statSync(p);
    const fresh = Math.max(st.birthtimeMs || 0, st.mtimeMs) >= since - 2000;
    if (!fresh) return false;
    if (isDir) return st.isDirectory() && fs.readdirSync(p).length === 0;
    return st.isFile() && st.size === 0;
  } catch {
    return false;
  }
}

// Start watching before the drag begins; result() resolves with the folder
// the first item was dropped into, or null. Explorer copies asynchronously,
// so the watchers stay up for a few seconds after the drop and the known
// folders (and their recently changed subfolders) are polled as a fallback.
function watchDrop(first, since, { home, platform, timeoutMs = 4000 } = {}) {
  const name = path.posix.basename(first.path);
  const isDragTemp = (p) => path.resolve(p).toLowerCase().startsWith(DRAG_ROOT.toLowerCase());
  const watchers = [];
  let found = null;
  let settle;
  const done = new Promise((r) => { settle = r; });
  const check = (p) => {
    if (found || isDragTemp(p) || !isPlaceholder(p, first.isDir, since)) return;
    found = path.dirname(p);
    settle(found);
  };

  for (const [dir, recursive] of watchTargets(home, platform)) {
    try {
      const w = fs.watch(dir, { recursive, persistent: false }, (_ev, file) => {
        if (!file || found) return;
        const rel = String(file);
        if (path.basename(rel) !== name) return;
        const p = path.join(dir, rel);
        check(p);
        if (!found) setTimeout(() => check(p), 150);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch { /* folder not watchable: polled below */ }
  }

  const poll = async (deadline) => {
    const dirs = knownDirs(home);
    while (!found && Date.now() < deadline) {
      for (const d of dirs) {
        if (found) break;
        check(path.join(d, name));
        let subs = [];
        try { subs = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
        for (const e of subs) {
          const sub = path.join(d, e.name);
          try { if (fs.statSync(sub).mtimeMs < since - 2000) continue; } catch { continue; }
          check(path.join(sub, name));
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  return {
    async result() {
      const deadline = Date.now() + timeoutMs;
      const timer = new Promise((r) => setTimeout(r, timeoutMs));
      await Promise.race([done, Promise.all([poll(deadline), timer])]);
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
      return found;
    },
    close() { for (const w of watchers) { try { w.close(); } catch { /* ignore */ } } },
    get watching() { return watchers.length; },
  };
}

module.exports = { makePlaceholders, watchDrop, watchTargets, knownDirs, isPlaceholder, DRAG_ROOT };
