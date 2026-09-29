'use strict';
// Self-update from GitHub releases, plus the one-time switch from the
// single-file portable .exe to the folder version on Windows.
//
// Why the folder version: the portable .exe unpacks the whole app (~275 MB) to
// %TEMP% on every start and deletes it on exit, so every launch takes 10+ s.
// The folder version (Vytty-x.y.z-win-x64.zip) starts in ~2 s.
//
// Install modes:
//   folder   - Windows, unpacked folder with Vytty.exe (+ VyttyData inside it)
//   portable - Windows, single-file portable .exe (updates convert it to a folder)
//   appimage - Linux AppImage
// The VyttyData folder is never modified, only moved (portable -> folder).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, net, shell } = require('electron');

const REPO = 'mtgmz14/vytty';
const RELEASES_URL = `https://github.com/${REPO}/releases`;

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

// Where the folder version goes when converting from the portable .exe.
function folderTarget() {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.env.PORTABLE_EXECUTABLE_FILE || '');
  return path.join(exeDir, 'Vytty');
}

function info() {
  const mode = installMode();
  return { mode, folderTarget: mode === 'portable' ? folderTarget() : null };
}

const assetPattern = (mode) => (mode === 'appimage' ? /\.AppImage$/i : mode ? /-win-x64\.zip$/i : null);

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
  const re = assetPattern(mode);
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

// Run a process, resolve with its exit code.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', resolve);
  });
}

// robocopy exit codes below 8 mean success.
async function copyTree(src, dst) {
  const code = await run('robocopy.exe', [src, dst, '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);
  if (code >= 8) throw new Error(`Copying files failed (robocopy ${code})`);
}

// The folder that holds Vytty.exe inside an extracted zip.
function findAppRoot(dir) {
  if (fs.existsSync(path.join(dir, 'Vytty.exe'))) return dir;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'Vytty.exe'))) return path.join(dir, d.name);
  }
  throw new Error('Vytty.exe not found in the downloaded archive');
}

// Portable -> folder: fill the target folder while this instance still runs
// (it is a new folder, nothing in it is locked).
async function fillFolder(sourceRoot) {
  const target = folderTarget();
  if (fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, 'Vytty.exe'))) {
    throw new Error(`${target} already exists and is not a Vytty folder`);
  }
  fs.mkdirSync(target, { recursive: true });
  await copyTree(sourceRoot, target);
  return target;
}

async function download(onProgress) {
  if (!latest || !latest.canInstall) throw new Error('No update to download');
  const mode = latest.mode;
  const work = mode === 'appimage' ? path.dirname(process.env.APPIMAGE) : path.join(os.tmpdir(), `vytty-update-${latest.version}`);
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, mode === 'appimage' ? `${latest.asset.name}.download` : latest.asset.name);
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

  if (mode === 'appimage') {
    fs.chmodSync(file, 0o755);
    const target = process.env.APPIMAGE;
    const versioned = /^Vytty-\d+\.\d+\.\d+\.AppImage$/i.test(path.basename(target));
    prepared = { mode, file, target, dest: versioned ? path.join(path.dirname(target), latest.asset.name) : target };
    return latest.version;
  }

  // Windows: unpack the zip now, so nothing can fail after Vytty has quit.
  onProgress(0, 0, 'extract');
  const staging = path.join(work, 'files');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const code = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', staging]);
  if (code !== 0) throw new Error(`Unpacking the update failed (tar ${code})`);
  const root = findAppRoot(staging);
  if (mode === 'portable') {
    onProgress(0, 0, 'copy');
    prepared = { mode, target: await fillFolder(root), work };
  } else {
    prepared = { mode, root, work };
  }
  return latest.version;
}

function cancel() {
  if (abort) abort();
}

// Convert the running portable version to the folder version (no download:
// the portable launcher has already unpacked this very version to %TEMP%).
async function convertToFolder({ shortcut } = {}) {
  if (installMode() !== 'portable') throw new Error('Not running the portable version');
  const target = await fillFolder(path.dirname(process.execPath));
  prepared = { mode: 'portable', target, work: null };
  if (shortcut) makeShortcut(target);
  return target;
}

function makeShortcut(target) {
  try {
    shell.writeShortcutLink(path.join(app.getPath('desktop'), 'Vytty.lnk'), 'replace', {
      target: path.join(target, 'Vytty.exe'),
      cwd: target,
      description: 'Vytty terminal',
    });
  } catch { /* ignore */ }
}

// Windows batch file run detached after Vytty quits.
function runScript(lines) {
  const script = path.join(os.tmpdir(), `vytty-update-${Date.now()}.cmd`);
  fs.writeFileSync(script, ['@echo off', 'chcp 65001 >nul', ...lines, '(goto) 2>nul & del "%~f0"', ''].join('\r\n'), 'utf8');
  spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const q = (p) => p.replace(/%/g, '%%');
// "timeout" needs a console stdin, which a hidden detached script lacks.
const SLEEP = 'ping -n 2 127.0.0.1 >nul';
// Jump to `label` once this process has exited. No pipe ("tasklist | find"):
// without a console the reading side never sees end of input and hangs.
const WAIT_EXIT = (label) => {
  const tmp = q(path.join(os.tmpdir(), `vytty-wait-${process.pid}.txt`));
  return [
    'set /a tries=0',
    ':wait',
    SLEEP,
    `tasklist /fi "PID eq ${process.pid}" /nh > "${tmp}" 2>nul`,
    `findstr /c:" ${process.pid} " "${tmp}" >nul || goto ${label}`,
    'set /a tries+=1',
    `if %tries% lss 60 goto wait`,
    `:${label}`,
    `del /f /q "${tmp}" >nul 2>&1`,
  ];
};

// Arrange the swap; the caller then quits the app.
function install({ shortcut } = {}) {
  if (!prepared) throw new Error('Nothing prepared');
  const p = prepared;
  if (p.mode === 'appimage') {
    // A running AppImage can be replaced on Linux.
    fs.renameSync(p.file, p.dest);
    if (p.dest !== p.target) { try { fs.rmSync(p.target, { force: true }); } catch { /* ignore */ } }
    app.relaunch({ execPath: p.dest, args: [] });
    return true;
  }
  const cleanup = p.work ? [`rd /s /q "${q(p.work)}" >nul 2>&1`] : [];

  if (p.mode === 'folder') {
    // Wait for this process to exit, then copy the new files over the old
    // ones (robocopy retries files still held by exiting child processes).
    const appDir = path.dirname(process.execPath);
    runScript([
      ...WAIT_EXIT('swap'),
      SLEEP,
      `robocopy "${q(p.root)}" "${q(appDir)}" /E /R:30 /W:1 /NFL /NDL /NJH /NJS /NP >nul`,
      `start "" "${q(path.join(appDir, 'Vytty.exe'))}"`,
      ...cleanup,
    ]);
    return true;
  }

  // portable -> folder: once Vytty has exited, move VyttyData into the new
  // folder (retried while files are still held), remove the portable .exe and
  // start the folder version. If the data cannot be moved nothing is removed
  // and the new version is not started with empty data.
  if (shortcut) makeShortcut(p.target);
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  const oldData = path.join(path.dirname(exe), 'VyttyData');
  const newData = path.join(p.target, 'VyttyData');
  runScript([
    ...WAIT_EXIT('data'),
    'set /a tries=0',
    ':movedata',
    `if not exist "${q(oldData)}" goto delexe`,
    `if exist "${q(newData)}" goto delexe`,
    `move "${q(oldData)}" "${q(newData)}" >nul 2>&1`,
    `if exist "${q(newData)}" goto delexe`,
    SLEEP,
    'set /a tries+=1',
    'if %tries% lss 120 goto movedata',
    'goto end',
    ':delexe',
    'set /a tries=0',
    ':delloop',
    `del /f /q "${q(exe)}" >nul 2>&1`,
    `if not exist "${q(exe)}" goto start`,
    SLEEP,
    'set /a tries+=1',
    'if %tries% lss 30 goto delloop',
    ':start',
    `start "" "${q(path.join(p.target, 'Vytty.exe'))}"`,
    ':end',
    ...cleanup,
  ]);
  return true;
}

module.exports = { check, download, cancel, install, info, convertToFolder, RELEASES_URL };
