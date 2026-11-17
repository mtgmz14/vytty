'use strict';
const { dataDir } = require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { store, DEFAULT_SETTINGS, deepMerge } = require('../../src/main/store');
const { vault } = require('../../src/main/vault');

test('settings: defaults, saved values, wrong types fall back, no prototype keys', () => {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ fontSize: 'big', theme: 'nord', ssh: { keepaliveInterval: 10, legacyAlgorithms: 'yes' }, __proto__: { polluted: 1 }, extra: 1 }));
  const s = store.getSettings();
  assert.strictEqual(s.fontSize, DEFAULT_SETTINGS.fontSize, 'wrong type -> default');
  assert.strictEqual(s.theme, 'nord');
  assert.strictEqual(s.ssh.keepaliveInterval, 10);
  assert.strictEqual(s.ssh.legacyAlgorithms, false);
  assert.strictEqual(s.uiStyle, 'minimal');
  assert.strictEqual(s.updates.install, 'ask');
  assert.strictEqual(({}).polluted, undefined);
  assert.deepStrictEqual(deepMerge({ a: [1] }, { a: [2, 3] }), { a: [2, 3] });
});

test('writeJson writes atomically (no temp file left behind)', () => {
  const f = path.join(dataDir, 'x.json');
  store.writeJson(f, { a: 1 });
  store.writeJson(f, { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 2 });
  assert.ok(!fs.existsSync(`${f}.tmp`));
});

test('vault: create, lock, wrong password, change master, export / import', () => {
  vault.reset();
  assert.strictEqual(vault.status().exists, false);
  vault.create('correct horse');
  vault.set('s1', { password: 'p1', passphrase: '' });
  assert.deepStrictEqual(vault.get('s1'), { password: 'p1' }, 'empty values are not stored');
  const raw = fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8');
  assert.ok(!raw.includes('p1') && !raw.includes('correct horse'), 'nothing in clear text');
  vault.lock();
  assert.throws(() => vault.get('s1'), /locked/);
  assert.throws(() => vault.unlock('nope'), /Wrong master password/);
  vault.unlock('correct horse');
  vault.changeMaster('correct horse', 'battery staple');
  vault.lock();
  vault.unlock('battery staple');
  assert.strictEqual(vault.get('s1').password, 'p1');
  const blob = vault.exportSecrets(['s1', 'missing'], 'export-pw');
  vault.remove('s1');
  assert.deepStrictEqual(vault.get('s1'), {});
  assert.throws(() => vault.importSecrets(blob, 'bad', { s1: 's2' }), /Wrong export password/);
  vault.importSecrets(blob, 'export-pw', { s1: 's2' });
  assert.strictEqual(vault.get('s2').password, 'p1');
  vault.changeMaster('battery staple', '');
  assert.strictEqual(vault.status().mode, 'none');
  vault.reset();
});
