'use strict';
// Self-update from GitHub releases. electron-updater does not support the
// "portable" Windows target, so this does it by hand:
//   1. check  - read the latest release and pick the asset for this platform
//   2. download - stream it next to the running executable (same volume)
//   3. install - once Vytty exits, swap the files and start the new version
// The VyttyData folder next to the executable is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, net } = require('electron');

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

// The file that has to be replaced: the portable .exe the user started (the
// app itself runs from a temp extraction) or the AppImage.
function currentTarget() {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE || null;
  if (process.platform === 'linux') return process.env.APPIMAGE || null;
  return null;
}

const assetPattern = () => (process.platform === 'win32' ? /-portable\.exe$/i : process.platform === 'linux' ? /\.AppImage$/i : null);

let latest = null;
let downloaded = null;
let abort = null;

async function check() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Vytty/${app.getVersion()}` },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const re = assetPattern();
  const asset = re && (rel.assets || []).find((a) => re.test(a.name));
  latest = {
    available: newer(version, app.getVersion()),
    current: app.getVersion(),
    version,
    notes: rel.body || '',
    page: rel.html_url || RELEASES_URL,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
  };
  latest.canInstall = !!(latest.asset && currentTarget());
  return latest;
}

// New file keeps the release's name when the current one still carries its
// original versioned name; a renamed executable (e.g. "Vytty.exe", used by
// shortcuts) is replaced in place.
function destinationFor(target, assetName) {
  const base = path.basename(target);
  const versioned = /^Vytty-\d+\.\d+\.\d+(-portable\.exe|\.AppImage)$/i.test(base);
  return versioned ? path.join(path.dirname(target), assetName) : target;
}

async function download(onProgress) {
  if (!latest || !latest.canInstall) throw new Error('No update to download');
  const target = currentTarget();
  const temp = path.join(path.dirname(target), `${latest.asset.name}.download`);
  const ctrl = new AbortController();
  abort = () => ctrl.abort();
  let out = null;
  try {
    const res = await net.fetch(latest.asset.url, { signal: ctrl.signal, headers: { 'User-Agent': `Vytty/${app.getVersion()}` } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || latest.asset.size || 0;
    out = fs.createWriteStream(temp);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      onProgress(got, total);
    }
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
    out = null;
    if (latest.asset.size && fs.statSync(temp).size !== latest.asset.size) throw new Error('Downloaded file is incomplete');
    if (process.platform === 'linux') fs.chmodSync(temp, 0o755);
    downloaded = { temp, target, dest: destinationFor(target, latest.asset.name), version: latest.version };
    return latest.version;
  } catch (err) {
    if (out) out.destroy();
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    if (ctrl.signal.aborted) throw new Error('Download cancelled');
    if (err && err.code === 'EPERM') throw new Error(`No write access to ${path.dirname(target)}`);
    throw err;
  } finally {
    abort = null;
  }
}

function cancel() {
  if (abort) abort();
}

// Arrange the swap; the caller then quits the app.
function install() {
  if (!downloaded) throw new Error('Nothing downloaded');
  const { temp, target, dest } = downloaded;
  if (process.platform === 'linux') {
    // A running AppImage can be replaced on Linux.
    fs.renameSync(temp, dest);
    if (dest !== target) { try { fs.rmSync(target, { force: true }); } catch { /* ignore */ } }
    app.relaunch({ execPath: dest, args: [] });
    return true;
  }
  // Windows: the portable launcher keeps its .exe locked until Vytty has fully
  // exited, so a detached script waits for that, swaps the files and starts
  // the new version.
  const q = (p) => p.replace(/%/g, '%%');
  const script = path.join(os.tmpdir(), `vytty-update-${Date.now()}.cmd`);
  fs.writeFileSync(script, [
    '@echo off',
    'chcp 65001 >nul',
    'set /a tries=0',
    ':wait',
    // "timeout" needs a console stdin, which a hidden detached script lacks.
    'ping -n 2 127.0.0.1 >nul',
    `del /f /q "${q(target)}" >nul 2>&1`,
    `if not exist "${q(target)}" goto swap`,
    'set /a tries+=1',
    'if %tries% lss 120 goto wait',
    'goto end',
    ':swap',
    `move /y "${q(temp)}" "${q(dest)}" >nul`,
    `start "" "${q(dest)}"`,
    ':end',
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n'), 'utf8');
  spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

module.exports = { check, download, cancel, install, RELEASES_URL };
