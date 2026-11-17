'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dragout = require('../../src/main/dragout');

const fakeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-home-'));
  for (const d of ['Desktop', 'Downloads', 'Documents', 'Projects', 'AppData', '.cache']) fs.mkdirSync(path.join(home, d));
  return home;
};

test('watch targets: profile folders, never AppData or hidden folders', () => {
  const home = fakeHome();
  const win = dragout.watchTargets(home, 'win32').map(([d, r]) => [path.basename(d), r]);
  assert.deepStrictEqual(win.find(([d]) => d === 'Projects'), ['Projects', true]);
  assert.ok(!win.some(([d]) => d === 'AppData' || d === '.cache'));
  const linux = dragout.watchTargets(home, 'linux');
  assert.ok(linux.every(([, r]) => r === false), 'no recursive watches on Linux');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a dropped placeholder is found through file system events', async () => {
  const home = fakeHome();
  const since = Date.now();
  const w = dragout.watchDrop({ path: '/srv/video.mkv', isDir: false }, since, { home, timeoutMs: 3000 });
  setTimeout(() => fs.writeFileSync(path.join(home, 'Downloads', 'video.mkv'), ''), 200);
  assert.strictEqual(await w.result(), path.join(home, 'Downloads'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('an old file or a non-empty file with the same name is not a placeholder', async () => {
  const home = fakeHome();
  // Both files exist before the drag starts (the drag starts "later").
  fs.writeFileSync(path.join(home, 'Desktop', 'report.pdf'), '');
  fs.writeFileSync(path.join(home, 'Documents', 'report.pdf'), 'real content');
  const w = dragout.watchDrop({ path: '/x/report.pdf', isDir: false }, Date.now() + 5000, { home, timeoutMs: 800 });
  assert.strictEqual(await w.result(), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('placeholders are empty files / folders named like the remote items', () => {
  const ph = dragout.makePlaceholders([{ path: '/a/b/file.txt', isDir: false }, { path: '/a/dir', isDir: true }]);
  assert.strictEqual(fs.statSync(ph.files[0]).size, 0);
  assert.ok(fs.statSync(ph.files[1]).isDirectory());
  assert.deepStrictEqual(ph.files.map((f) => path.basename(f)), ['file.txt', 'dir']);
  fs.rmSync(ph.dir, { recursive: true, force: true });
});
