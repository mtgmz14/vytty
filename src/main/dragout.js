'use strict';
// Deferred drag-out for large remote files (the WinSCP trick).
// Chromium can only drag files that already exist on disk, and a big file
// (a film, an image backup...) cannot be downloaded while the user holds the
// mouse. So we drag empty placeholders with the real names from a unique temp
// folder. Explorer copies them to wherever the user drops; we then find where
// they landed and download the real content straight into them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DRAG_ROOT = path.join(os.tmpdir(), 'vytty-drag');

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

// Folders the user most likely dropped into: Desktop, Downloads, Documents and
// every folder open in an Explorer window.
function candidateDirs() {
  const home = os.homedir();
  const base = [path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Desktop')];
  if (process.platform !== 'win32') return Promise.resolve(base);
  const ps = [
    '[Environment]::GetFolderPath("Desktop")',
    '[Environment]::GetFolderPath("CommonDesktopDirectory")',
    '(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { try { $_.Document.Folder.Self.Path } catch {} }',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const found = err ? [] : String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-zA-Z]:\\/.test(s));
      resolve([...new Set([...found, ...base])]);
    });
  });
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

// Look for the dropped placeholder of `first` in the candidate folders and in
// their recently changed subfolders (a drop onto a folder icon). Explorer copies
// asynchronously, so poll for a few seconds.
async function locateDrop(first, since) {
  const dirs = await candidateDirs();
  const name = path.posix.basename(first.path);
  for (let attempt = 0; attempt < 16; attempt++) {
    for (const d of dirs) {
      if (path.resolve(d).toLowerCase().startsWith(DRAG_ROOT.toLowerCase())) continue;
      if (isPlaceholder(path.join(d, name), first.isDir, since)) return d;
      let subs = [];
      try { subs = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
      for (const e of subs) {
        const sub = path.join(d, e.name);
        try { if (fs.statSync(sub).mtimeMs < since - 2000) continue; } catch { continue; }
        if (isPlaceholder(path.join(sub, name), first.isDir, since)) return sub;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

module.exports = { makePlaceholders, locateDrop, DRAG_ROOT };
