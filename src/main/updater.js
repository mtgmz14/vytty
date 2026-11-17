'use strict';
// Updates from GitHub releases.
//
// Install modes:
//   portable - Windows, Vytty-x.y.z-portable.exe (our launcher, build/portable.nsi)
//   folder   - Windows, unpacked Vytty-x.y.z-win-x64.zip
//   appimage - Linux AppImage
//   winget / store - updated by winget / the Microsoft Store: notify only
//
// What changed in 0.10 (see docs/AUDYT-0.10.0.md):
//   * every download is checked against SHA256SUMS.txt, whose Ed25519
//     signature must match a key built into the app (update-keys.js);
//   * no helper processes at all (the zip is unpacked in-process, not by tar.exe);
//   * the portable build is not replaced in place: the new version is saved
//     next to the old one and started; the old file is removed only after the
//     new version has started successfully. If endpoint protection blocks the
//     new file, the old one still works;
//   * "Notify only" mode (Settings -> About) never downloads anything.
// VyttyData is never touched.
const crypto = require('crypto');
const path = require('path');
const { app, net } = require('electron');
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const { paths, portableExe } = require('./paths');
const V = require('./update-verify');
const KEYS = require('./update-keys');
const { extractZip } = require('./unzip');

const REPO = 'mtgmz14/vytty';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const OLD = '.vytty-old';
const STAGING = '.vytty-update';
const CLEANUP_MARK = '.vytty-cleanup';
const SELF_UPDATING = new Set(['portable', 'folder', 'appimage']);

const UA = () => `Vytty/${app.getVersion()}`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(from, to, tries = 12) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (err) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(Math.min(25 * (i + 1), 200));
    }
  }
}

function installMode() {
  if (!app.isPackaged) return null;
  if (process.windowsStore) return 'store';
  if (process.platform === 'win32') {
    const exe = portableExe() || process.execPath;
    if (/[\\/]Microsoft[\\/]WinGet[\\/]Packages[\\/]/i.test(exe)) return 'winget';
    return portableExe() ? 'portable' : 'folder';
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage';
  return null;
}

const appDir = () => path.dirname(process.execPath);
// The file the user starts: the portable launcher or the AppImage.
const userFile = (mode) => (mode === 'portable' ? portableExe() : mode === 'appimage' ? process.env.APPIMAGE : process.execPath);

function info() {
  const mode = installMode();
  return { mode, selfUpdate: SELF_UPDATING.has(mode), signingKeys: KEYS.length };
}

// Why this copy cannot install an update itself (shown in the update dialog).
function manualReason(mode) {
  if (mode === 'winget') return 'This copy was installed with winget. Update it with: winget upgrade mtgmz14.Vytty';
  if (mode === 'store') return 'This copy is updated by the Microsoft Store.';
  if (!mode) return 'This copy cannot update itself (it is not a packaged release build).';
  return '';
}

let latest = null;
let prepared = null;
let abort = null;

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA() } });
  return res;
}

async function fetchText(url, signal) {
  const res = await net.fetch(url, { signal, headers: { 'User-Agent': UA() } });
  if (!res.ok) throw new Error(`Download of ${url.split('/').pop()} failed (${res.status})`);
  return res.text();
}

// The GitHub API allows 60 unauthenticated requests per hour per IP, which a
// whole office behind one NAT can use up. The release page redirect has no
// such limit; asset URLs follow the fixed naming scheme.
async function releaseFromRedirect() {
  const res = await net.fetch(`${RELEASES_URL}/latest`, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA() } });
  const m = /\/releases\/tag\/([^/?#]+)\/?$/.exec(res.url || '');
  if (!m) throw new Error(`Could not determine the latest release (${res.status})`);
  const tag = decodeURIComponent(m[1]);
  const v = tag.replace(/^v/i, '');
  const asset = (name) => ({ name, browser_download_url: `${RELEASES_URL}/download/${encodeURIComponent(tag)}/${name}`, size: 0 });
  return {
    tag_name: tag,
    html_url: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
    body: '',
    assets: [...['portable', 'folder', 'appimage'].map((mode) => asset(V.assetNameFor(mode, v))), asset(V.SUMS_NAME), asset(V.SIG_NAME)],
  };
}

async function check() {
  let rel;
  const res = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (res.ok) rel = await res.json();
  else if (res.status === 403 || res.status === 429) rel = await releaseFromRedirect();
  else throw new Error(`GitHub returned ${res.status}`);

  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const mode = installMode();
  const assets = rel.assets || [];
  const asset = V.pickAsset(assets, mode);
  const find = (name) => assets.find((a) => a.name === name);
  const sums = find(V.SUMS_NAME);
  const sig = find(V.SIG_NAME);
  latest = {
    available: V.newer(version, app.getVersion()),
    current: app.getVersion(),
    version,
    notes: rel.body || '',
    page: rel.html_url || RELEASES_URL,
    mode,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 } : null,
    sums: sums ? sums.browser_download_url : null,
    sig: sig ? sig.browser_download_url : null,
  };
  let reason = manualReason(mode);
  if (!reason && !latest.asset) reason = 'The release has no download for this kind of installation.';
  if (!reason && !KEYS.length) reason = 'This build cannot verify updates.';
  if (!reason && (!latest.sums || !latest.sig)) reason = 'The release is not signed for automatic updates. Download it from GitHub instead.';
  latest.canInstall = !reason;
  latest.reason = reason;
  return latest;
}

// The folder that holds Vytty.exe inside an extracted zip.
function findAppRoot(dir) {
  const exe = process.platform === 'win32' ? 'Vytty.exe' : 'vytty';
  if (fs.existsSync(path.join(dir, exe))) return dir;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, exe))) return path.join(dir, d.name);
  }
  throw new Error(`${exe} not found in the downloaded archive`);
}

async function download(onProgress) {
  if (!latest || !latest.canInstall) throw new Error('No update to download');
  const { mode, version } = latest;
  const ctrl = new AbortController();
  abort = () => ctrl.abort();
  let out = null;
  let part = null;
  try {
    // 1. The signed checksum list decides what we accept.
    const [sumsText, signature] = await Promise.all([fetchText(latest.sums, ctrl.signal), fetchText(latest.sig, ctrl.signal)]);
    const expected = V.expectedHash({ sumsText, signature, keys: KEYS, assetName: latest.asset.name, version });

    // 2. Download next to the target (same volume, so the final step is a rename).
    const target = userFile(mode);
    const dir = mode === 'folder' ? path.join(appDir(), STAGING) : path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    part = path.join(dir, `${latest.asset.name}.download`);
    const res = await net.fetch(latest.asset.url, { signal: ctrl.signal, headers: { 'User-Agent': UA() } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || latest.asset.size || 0;
    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(part);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      got += buf.length;
      hash.update(buf);
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      onProgress(got, total, 'download');
    }
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
    out = null;

    // 3. Must be exactly the file the release signed.
    onProgress(got, total, 'verify');
    if (hash.digest('hex') !== expected) throw new Error('The downloaded file does not match the signed checksum - not installed');

    if (mode === 'folder') {
      // Unpack now, so nothing can fail after the swap starts.
      onProgress(0, 0, 'extract');
      const staging = path.join(dir, version);
      fs.rmSync(staging, { recursive: true, force: true });
      await extractZip(part, staging);
      fs.rmSync(part, { force: true });
      prepared = { mode, version, root: findAppRoot(staging), staging: dir };
      return version;
    }
    if (mode === 'appimage') fs.chmodSync(part, 0o755);
    // A versioned name (Vytty-0.9.1-portable.exe) gets the new version's name
    // next to it; a renamed copy ("Vytty.exe" used by shortcuts) keeps its name.
    const sideBySide = V.OLD_BUILD.test(path.basename(target));
    const dest = sideBySide ? path.join(dir, latest.asset.name) : `${target}.new`;
    fs.rmSync(dest, { force: true });
    renameRetry(part, dest);
    prepared = { mode, version, file: dest, target, sideBySide };
    return version;
  } catch (err) {
    if (out) out.destroy();
    if (part) { try { fs.rmSync(part, { force: true }); } catch { /* ignore */ } }
    if (ctrl.signal.aborted) throw new Error('Download cancelled');
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) throw new Error(`No write access to ${path.dirname(part || userFile(mode) || '')}`);
    throw err;
  } finally {
    abort = null;
  }
}

function cancel() {
  if (abort) abort();
}

function writeState(state) {
  try { fs.writeFileSync(paths.updateState, JSON.stringify({ ...state, from_version: app.getVersion(), at: new Date().toISOString() }, null, 2)); } catch { /* best effort */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(paths.updateState, 'utf8')); } catch { return null; }
}

// Move `dst` aside (renaming works even while it is running) and move `src`
// into its place. Returns an undo function.
function replaceFile(dst, src) {
  const old = dst + OLD;
  let moved = false;
  if (fs.existsSync(dst)) {
    fs.rmSync(old, { force: true });
    renameRetry(dst, old);
    moved = true;
  }
  renameRetry(src, dst);
  return () => {
    try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    if (moved) renameRetry(old, dst);
  };
}

function listFiles(root, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, d.name);
    if (!d.isDirectory()) out.push(r);
    else if (r !== 'VyttyData' && r !== STAGING) out.push(...listFiles(root, r)); // user data: never listed
  }
  return out;
}

// Arrange the switch to the new version; the caller then quits the app.
function install() {
  if (!prepared) throw new Error('Nothing prepared');
  const p = prepared;
  if (p.mode === 'portable' || p.mode === 'appimage') {
    if (p.sideBySide) {
      writeState({ mode: p.mode, from: p.target, to: p.file, version: p.version });
      app.relaunch({ execPath: p.file, args: [] });
      return true;
    }
    const old = p.target + OLD;
    fs.rmSync(old, { force: true });
    renameRetry(p.target, old);
    try {
      renameRetry(p.file, p.target);
    } catch (err) {
      try { renameRetry(old, p.target); } catch { /* ignore */ }
      throw new Error(`Could not replace ${p.target}: ${err.message}`);
    }
    writeState({ mode: p.mode, from: old, to: p.target, version: p.version });
    app.relaunch({ execPath: p.target, args: [] });
    return true;
  }

  // Folder version: files in use can be renamed but not overwritten, so each
  // one is moved aside and the new one moved in from the staging folder.
  const dir = appDir();
  const undo = [];
  try {
    for (const rel of listFiles(p.root)) {
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      undo.push(replaceFile(dst, path.join(p.root, rel)));
    }
    fs.writeFileSync(path.join(dir, CLEANUP_MARK), p.version);
  } catch (err) {
    for (const u of undo.reverse()) { try { u(); } catch { /* ignore */ } }
    throw new Error(`Could not update the files in ${dir}: ${err.message}`);
  }
  writeState({ mode: 'folder', folder: dir, version: p.version });
  app.relaunch({ execPath: path.join(dir, path.basename(process.execPath)), args: [] });
  return true;
}

const DAY = 24 * 60 * 60 * 1000;

// Called a few seconds after a successful start: remove what the previous
// version left behind. Only files that look like ours are ever deleted.
function cleanup() {
  const mode = installMode();
  try {
    const state = readState();
    if (state && (mode === 'portable' || mode === 'appimage')) {
      const current = userFile(mode);
      const from = state.from ? path.resolve(state.from) : null;
      const sameDir = from && current && path.dirname(from).toLowerCase() === path.dirname(path.resolve(current)).toLowerCase();
      const ours = from && (V.OLD_BUILD.test(path.basename(from)) || from.endsWith(OLD));
      // Started as the new version: the old file is no longer needed.
      if (from && sameDir && ours && from.toLowerCase() !== path.resolve(current).toLowerCase() && state.version === app.getVersion()) {
        fs.rmSync(from, { force: true });
      }
      fs.rmSync(paths.updateState, { force: true });
    } else if (state && mode === 'folder' && state.version === app.getVersion()) {
      fs.rmSync(paths.updateState, { force: true });
    }

    if (mode === 'portable' || mode === 'appimage') {
      const dir = path.dirname(userFile(mode));
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name.endsWith(OLD)) fs.rmSync(full, { force: true });
        // An abandoned download (not one running right now: those are younger).
        else if (name.endsWith('.download') && /^Vytty-/i.test(name)) {
          try { if (Date.now() - fs.statSync(full).mtimeMs > DAY) fs.rmSync(full, { force: true }); } catch { /* ignore */ }
        }
      }
    } else if (mode === 'folder') {
      const dir = appDir();
      const mark = path.join(dir, CLEANUP_MARK);
      if (fs.existsSync(mark)) {
        for (const rel of listFiles(dir)) if (rel.endsWith(OLD)) fs.rmSync(path.join(dir, rel), { force: true });
        fs.rmSync(path.join(dir, STAGING), { recursive: true, force: true });
        fs.rmSync(mark, { force: true });
      } else if (fs.existsSync(path.join(dir, STAGING)) && !abort) {
        fs.rmSync(path.join(dir, STAGING), { recursive: true, force: true });
      }
    }
  } catch { /* try again next time */ }
}

module.exports = { check, download, cancel, install, info, cleanup, installMode, RELEASES_URL, _test: { findAppRoot, listFiles, manualReason } };
