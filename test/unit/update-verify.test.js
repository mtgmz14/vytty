'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../../src/main/update-verify');
const KEYS = require('../../src/main/update-keys');

const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};

test('version comparison', () => {
  assert.ok(V.newer('0.10.0', '0.9.1'));
  assert.ok(V.newer('v1.0.0', '0.99.9'));
  assert.ok(!V.newer('0.9.1', '0.10.0'));
  assert.ok(!V.newer('0.10.0', '0.10.0'));
  assert.ok(V.newer('0.10.0', '0.10.0-beta.2'), 'release beats its pre-release');
  assert.ok(!V.newer('0.10.0-beta.2', '0.10.0'));
  assert.ok(V.newer('0.10.0-beta.10', '0.10.0-beta.2'));
});

test('checksum list parsing and formatting round-trip', () => {
  const h = 'a'.repeat(64);
  const text = V.formatSums([['Vytty-1.0.0-portable.exe', h], ['Vytty-1.0.0-win-x64.zip', 'B'.repeat(64)]]);
  const m = V.parseSums(`# comment\n\n${text}`);
  assert.strictEqual(m.get('Vytty-1.0.0-portable.exe'), h);
  assert.strictEqual(m.get('Vytty-1.0.0-win-x64.zip'), 'b'.repeat(64));
  assert.throws(() => V.parseSums('nonsense line'), /Malformed/);
  assert.strictEqual(V.parseSums(`${h} *bin.exe`).get('bin.exe'), h);
});

test('signature: valid, tampered, wrong key, rotation list', () => {
  const k1 = pair();
  const k2 = pair();
  const text = V.formatSums([['Vytty-2.0.0-portable.exe', 'c'.repeat(64)]]);
  const sig = V.sign(text, k1.pem);
  assert.ok(V.verifySignature(text, sig, [k1.pub]));
  assert.ok(V.verifySignature(text, sig, [k2.pub, k1.pub]), 'any listed key may match');
  assert.ok(!V.verifySignature(text.replace('c', 'd'), sig, [k1.pub]), 'tampered list');
  assert.ok(!V.verifySignature(text, sig, [k2.pub]), 'wrong key');
  assert.ok(!V.verifySignature(text, 'not-base64!!', [k1.pub]));
  assert.ok(!V.verifySignature(text, '', [k1.pub]));
});

test('expectedHash enforces signature, listing and version', () => {
  const k = pair();
  const name = 'Vytty-2.0.0-portable.exe';
  const sumsText = V.formatSums([[name, 'e'.repeat(64)]]);
  const signature = V.sign(sumsText, k.pem);
  assert.strictEqual(V.expectedHash({ sumsText, signature, keys: [k.pub], assetName: name, version: '2.0.0' }), 'e'.repeat(64));
  assert.throws(() => V.expectedHash({ sumsText, signature: '', keys: [k.pub], assetName: name, version: '2.0.0' }), /no signature/);
  assert.throws(() => V.expectedHash({ sumsText, signature, keys: [], assetName: name, version: '2.0.0' }), /no update signing key/);
  assert.throws(() => V.expectedHash({ sumsText: sumsText + 'f'.repeat(64) + '  x.exe\n', signature, keys: [k.pub], assetName: name, version: '2.0.0' }), /not valid/);
  assert.throws(() => V.expectedHash({ sumsText, signature, keys: [k.pub], assetName: 'Vytty-2.0.0-win-x64.zip', version: '2.0.0' }), /not listed/);
  // An old, validly signed list cannot be replayed for a newer version number.
  assert.throws(() => V.expectedHash({ sumsText, signature, keys: [k.pub], assetName: name, version: '3.0.0' }), /does not belong/);
});

test('asset selection per install mode', () => {
  const assets = ['Vytty-1.2.3-portable.exe', 'Vytty-1.2.3-win-x64.zip', 'Vytty-1.2.3.AppImage', 'SHA256SUMS.txt'].map((name) => ({ name }));
  assert.strictEqual(V.pickAsset(assets, 'portable').name, 'Vytty-1.2.3-portable.exe');
  assert.strictEqual(V.pickAsset(assets, 'folder').name, 'Vytty-1.2.3-win-x64.zip');
  assert.strictEqual(V.pickAsset(assets, 'appimage').name, 'Vytty-1.2.3.AppImage');
  assert.strictEqual(V.pickAsset(assets, 'winget'), null);
  assert.strictEqual(V.assetNameFor('folder', 'v1.2.3'), 'Vytty-1.2.3-win-x64.zip');
  assert.ok(V.OLD_BUILD.test('Vytty-0.9.1-portable.exe'));
  assert.ok(!V.OLD_BUILD.test('Vytty.exe'));
  assert.ok(!V.OLD_BUILD.test('Vytty-0.9.1-portable.exe.download'));
});

test('sha256File', async () => {
  const f = path.join(os.tmpdir(), `vytty-hash-${process.pid}`);
  fs.writeFileSync(f, 'hello');
  assert.strictEqual(await V.sha256File(f), crypto.createHash('sha256').update('hello').digest('hex'));
  fs.rmSync(f);
});

test('the built-in update key is a valid Ed25519 public key', () => {
  assert.ok(KEYS.length >= 1);
  for (const k of KEYS) {
    const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
    assert.strictEqual(key.asymmetricKeyType, 'ed25519');
  }
});
