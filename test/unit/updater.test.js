'use strict';
const { electronStub, dataDir } = require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../../src/main/update-verify');
const KEYS = require('../../src/main/update-keys');
const { extractZip } = require('../../src/main/unzip');
const { makeZip } = require('./_zip');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-upd-'));

test('extractZip unpacks stored and deflated entries', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'a.zip');
  fs.writeFileSync(zip, makeZip([
    { name: 'Vytty.exe', data: 'MZ fake exe' },
    { name: 'resources/', data: '' },
    { name: 'resources/app.asar', data: 'x'.repeat(5000), deflate: true },
    { name: 'locales/pl.pak', data: 'pl' },
  ]));
  const out = path.join(dir, 'out');
  const n = await extractZip(zip, out);
  assert.strictEqual(n, 3);
  assert.strictEqual(fs.readFileSync(path.join(out, 'resources', 'app.asar'), 'utf8'), 'x'.repeat(5000));
  assert.strictEqual(fs.readFileSync(path.join(out, 'Vytty.exe'), 'utf8'), 'MZ fake exe');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractZip refuses entries that escape the target folder', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'evil.zip');
  fs.writeFileSync(zip, makeZip([{ name: 'ok.txt', data: '1' }, { name: '../evil.txt', data: 'pwned' }]));
  await assert.rejects(extractZip(zip, path.join(dir, 'out')));
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Full AppImage update with a fake GitHub: signed checksums, side-by-side
// download, cleanup of the old build after the "restart".
test('AppImage update: verify, install side by side, clean up', async (t) => {
  if (process.platform !== 'linux') { t.skip('linux only'); return; }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  KEYS.push(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  const dir = tmp();
  const oldFile = path.join(dir, 'Vytty-0.9.1.AppImage');
  fs.writeFileSync(oldFile, 'old build');
  const newBody = Buffer.from('new build '.repeat(1000));
  const assetName = 'Vytty-0.11.0.AppImage';
  let sums = V.formatSums([[assetName, crypto.createHash('sha256').update(newBody).digest('hex')]]);
  let sig = V.sign(sums, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const base = 'https://github.com/mtgmz14/vytty/releases/download/v0.11.0/';
  electronStub.net.fetch = async (url) => {
    const ok = (body, extra = {}) => ({ ok: true, status: 200, url, headers: { get: (h) => (h === 'content-length' ? String(Buffer.byteLength(body)) : null) }, json: async () => JSON.parse(body), text: async () => String(body), body: { getReader() { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(Buffer.from(body)) })) }; } }, ...extra });
    if (url.includes('api.github.com')) {
      return ok(JSON.stringify({ tag_name: 'v0.11.0', html_url: 'https://github.com/mtgmz14/vytty/releases/tag/v0.11.0', body: 'notes',
        assets: [assetName, 'SHA256SUMS.txt', 'SHA256SUMS.txt.sig'].map((name) => ({ name, browser_download_url: base + name, size: name === assetName ? newBody.length : 10 })) }));
    }
    if (url.endsWith('SHA256SUMS.txt')) return ok(sums);
    if (url.endsWith('SHA256SUMS.txt.sig')) return ok(sig);
    if (url.endsWith(assetName)) return ok(newBody);
    return { ok: false, status: 404, url, headers: { get: () => null } };
  };
  electronStub.app.isPackaged = true;
  process.env.APPIMAGE = oldFile;
  let relaunched = null;
  electronStub.app.relaunch = (o) => { relaunched = o; };
  const updater = require('../../src/main/updater');
  try {
    const info = await updater.check();
    assert.strictEqual(info.mode, 'appimage');
    assert.ok(info.available);
    assert.ok(info.canInstall, info.reason);
    const phases = new Set();
    await updater.download((_g, _t, phase) => phases.add(phase));
    assert.ok(phases.has('verify'));
    const newFile = path.join(dir, assetName);
    assert.strictEqual(fs.readFileSync(newFile, 'utf8'), newBody.toString());
    updater.install();
    assert.strictEqual(relaunched.execPath, newFile);
    assert.ok(fs.existsSync(oldFile), 'old build is kept until the new one has started');

    // "Restart" as the new version: cleanup removes the old build.
    electronStub.app.getVersion = () => '0.11.0';
    process.env.APPIMAGE = newFile;
    updater.cleanup();
    assert.ok(!fs.existsSync(oldFile), 'old build removed after a successful start');
    assert.ok(fs.existsSync(newFile));

    // A tampered download is refused.
    electronStub.app.getVersion = () => '0.10.0';
    sums = V.formatSums([[assetName, '0'.repeat(64)]]);
    sig = V.sign(sums, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.rmSync(newFile);
    process.env.APPIMAGE = oldFile;
    fs.writeFileSync(oldFile, 'old build');
    await updater.check();
    await assert.rejects(updater.download(() => {}), /does not match the signed checksum/);
    assert.ok(!fs.existsSync(newFile));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.download')), 'partial download removed');

    // A forged signature is refused before anything is downloaded.
    sig = V.sign(sums, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await updater.check();
    await assert.rejects(updater.download(() => {}), /signature is not valid/);
  } finally {
    electronStub.app.isPackaged = false;
    electronStub.app.getVersion = () => '0.10.0';
    delete process.env.APPIMAGE;
    KEYS.pop();
    fs.rmSync(dir, { recursive: true, force: true });
    void dataDir;
  }
});

test('a release without signed checksums is offered as a manual download', async () => {
  electronStub.net.fetch = async (url) => ({ ok: true, status: 200, url, headers: { get: () => null }, json: async () => ({ tag_name: 'v9.0.0', assets: [{ name: 'Vytty-9.0.0.AppImage', browser_download_url: 'x', size: 1 }] }) });
  electronStub.app.isPackaged = true;
  process.env.APPIMAGE = '/tmp/Vytty-0.10.0.AppImage';
  const updater = require('../../src/main/updater');
  try {
    const info = await updater.check();
    assert.ok(info.available);
    assert.strictEqual(info.canInstall, false);
    assert.match(info.reason, /not signed/);
  } finally {
    electronStub.app.isPackaged = false;
    delete process.env.APPIMAGE;
  }
});
