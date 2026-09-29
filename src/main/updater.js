'use strict';
// Self-update from GitHub releases.
//
// Install modes:
//   portable - Windows, Vytty-x.y.z-portable.exe (our launcher, build/portable.nsi,
//              which starts a cached copy of the app and exits)
//   folder   - Windows, unpacked Vytty-x.y.z-win-x64.zip
//   appimage - Linux AppImage
//
// No helper scripts: Windows lets a file that is in use be renamed, so the
// running files are renamed to "*.vytty-old", the new ones put in their place,
// and Vytty restarts through app.relaunch (which waits for this process to
// exit). The leftovers are removed on the next start. VyttyData is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, net } = require('electron');

const REPO = 'mtgmz14/vytty';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const OLD = '.vytty-old';
const CLEANUP_MARK = '.vytty-cleanup';

// Numeric compare of "1.2.3" style versions (a leading "v" is ignored).
function newer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function installMode() {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'folder';
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage';
  return null;
}

function info() {
  return { mode: installMode() };
}

const ASSETS = { portable: /-portable\.exe$/i, folder: /-win-x64\.zip$/i, appimage: /\.AppImage$/i };

let latest = null;
let prepared = null;
let abort = null;

async function check() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Vytty/${app.getVersion()}` },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const mode = installMode();
  const re = ASSETS[mode];
  const asset = re && (rel.assets || []).find((a) => re.test(a.name));
  latest = {
    available: newer(version, app.getVersion()),
    current: app.getVersion(),
    version,
    notes: rel.body || '',
    page: rel.html_url || RELEASES_URL,
    mode,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
  };
  latest.canInstall = !!(latest.asset && mode);
  return latest;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', resolve);
  });
}

// The folder that holds Vytty.exe inside an extracted zip.
function findAppRoot(dir) {
  if (fs.existsSync(path.join(dir, 'Vytty.exe'))) return dir;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'Vytty.exe'))) return path.join(dir, d.name);
  }
  throw new Error('Vytty.exe not found in the downloaded archive');
}

// Versioned file names follow the release; a renamed file (e.g. "Vytty.exe"
// used by shortcuts) is replaced in place.
function destinationFor(target, assetName) {
  const versioned = /^Vytty-\d+\.\d+\.\d+(-portable\.exe|\.AppImage)$/i.test(path.basename(target));
  return versioned ? path.join(path.dirname(target), assetName) : target;
}

async function download(onProgress) {
  if (!latest || !latest.canInstall) throw new Error('No update to download');
  const { mode } = latest;
  const target = mode === 'portable' ? process.env.PORTABLE_EXECUTABLE_FILE : mode === 'appimage' ? process.env.APPIMAGE : null;
  const work = target ? path.dirname(target) : path.join(os.tmpdir(), `vytty-update-${latest.version}`);
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, `${latest.asset.name}.download`);
  const ctrl = new AbortController();
  abort = () => ctrl.abort();
  let out = null;
  try {
    const res = await net.fetch(latest.asset.url, { signal: ctrl.signal, headers: { 'User-Agent': `Vytty/${app.getVersion()}` } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || latest.asset.size || 0;
    out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      onProgress(got, total, 'download');
    }
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
    out = null;
    if (latest.asset.size && fs.statSync(file).size !== latest.asset.size) throw new Error('Downloaded file is incomplete');
  } catch (err) {
    if (out) out.destroy();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    if (ctrl.signal.aborted) throw new Error('Download cancelled');
    if (err && err.code === 'EPERM') throw new Error(`No write access to ${work}`);
    throw err;
  } finally {
    abort = null;
  }

  if (mode !== 'folder') {
    if (mode === 'appimage') fs.chmodSync(file, 0o755);
    prepared = { mode, file, target, dest: destinationFor(target, latest.asset.name) };
    return latest.version;
  }
  // Folder version: unpack the zip now, so nothing can fail after the swap starts.
  onProgress(0, 0, 'extract');
  const staging = path.join(work, 'files');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const code = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', staging]);
  if (code !== 0) throw new Error(`Unpacking the update failed (tar ${code})`);
  prepared = { mode, root: findAppRoot(staging), work };
  return latest.version;
}

function cancel() {
  if (abort) abort();
}

// Move `from` aside (renaming works even while it is running) and put `src`
// there. Returns an undo function.
function replaceFile(dst, src, copy) {
  const old = dst + OLD;
  let moved = false;
  if (fs.existsSync(dst)) {
    fs.rmSync(old, { force: true });
    fs.renameSync(dst, old);
    moved = true;
  }
  if (copy) fs.copyFileSync(src, dst); else fs.renameSync(src, dst);
  return () => {
    try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    if (moved) fs.renameSync(old, dst);
  };
}

function listFiles(root, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, d.name);
    if (!d.isDirectory()) out.push(r);
    else if (r !== 'VyttyData') out.push(...listFiles(root, r)); // user data: never listed
  }
  return out;
}

// Swap the files and arrange the restart; the caller then quits the app.
function install() {
  if (!prepared) throw new Error('Nothing prepared');
  const p = prepared;
  if (p.mode === 'portable' || p.mode === 'appimage') {
    const undo = [];
    try {
      if (p.dest !== p.target && fs.existsSync(p.target)) {
        // New versioned name: the old file goes aside, removed on next start.
        const old = p.target + OLD;
        fs.rmSync(old, { force: true });
        fs.renameSync(p.target, old);
        undo.push(() => fs.renameSync(old, p.target));
      }
      undo.push(replaceFile(p.dest, p.file, false));
    } catch (err) {
      for (const u of undo.reverse()) { try { u(); } catch { /* ignore */ } }
      throw new Error(`Could not replace ${p.target}: ${err.message}`);
    }
    app.relaunch({ execPath: p.dest, args: [] });
    return true;
  }

  // Folder version. process.noAsar: Electron would otherwise treat app.asar
  // as a folder and refuse to rename or copy it as a file.
  const appDir = path.dirname(process.execPath);
  const noAsar = process.noAsar;
  process.noAsar = true;
  const undo = [];
  try {
    for (const rel of listFiles(p.root)) {
      const dst = path.join(appDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      undo.push(replaceFile(dst, path.join(p.root, rel), true));
    }
    fs.writeFileSync(path.join(appDir, CLEANUP_MARK), '');
  } catch (err) {
    for (const u of undo.reverse()) { try { u(); } catch { /* ignore */ } }
    throw new Error(`Could not update the files in ${appDir}: ${err.message}`);
  } finally {
    process.noAsar = noAsar;
  }
  try { fs.rmSync(p.work, { recursive: true, force: true }); } catch { /* ignore */ }
  app.relaunch({ execPath: path.join(appDir, 'Vytty.exe'), args: [] });
  return true;
}

// On start: remove what the last update set aside.
function cleanup() {
  const mode = installMode();
  try {
    if (mode === 'portable' || mode === 'appimage') {
      const file = mode === 'portable' ? process.env.PORTABLE_EXECUTABLE_FILE : process.env.APPIMAGE;
      const dir = path.dirname(file);
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(OLD) || /^Vytty-.*\.download$/i.test(name)) fs.rmSync(path.join(dir, name), { force: true });
      }
    } else if (mode === 'folder') {
      const appDir = path.dirname(process.execPath);
      const mark = path.join(appDir, CLEANUP_MARK);
      if (!fs.existsSync(mark)) return;
      const noAsar = process.noAsar;
      process.noAsar = true;
      try {
        for (const rel of listFiles(appDir)) {
          if (rel.endsWith(OLD)) fs.rmSync(path.join(appDir, rel), { force: true });
        }
      } finally {
        process.noAsar = noAsar;
      }
      fs.rmSync(mark, { force: true });
    }
  } catch { /* try again next time */ }
}

module.exports = { check, download, cancel, install, info, cleanup, RELEASES_URL };
