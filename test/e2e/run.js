'use strict';
// End-to-end test: starts the real app (Electron, no window on screen) with a
// throw-away data folder and drives the UI: vault setup, sessions, a local
// shell, an SSH login through the host key / password dialogs (against a test
// SSH server), interface styles and settings. Screenshots go to test/e2e/out.
// Usage: npm run test:e2e   (Linux needs no display: --ozone-platform=headless)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-e2e-'));
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

// A tiny app folder whose entry installs the test driver, then loads Vytty.
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'vytty', productName: 'Vytty', version: pkg.version, main: 'entry.js' }));
fs.writeFileSync(path.join(work, 'entry.js'), `require(${JSON.stringify(path.join(__dirname, 'driver.js'))});\nrequire(${JSON.stringify(path.join(root, 'src', 'main', 'main.js'))});\n`);

const electron = require(path.join(root, 'node_modules', 'electron'));
const args = [work, '--no-sandbox', '--force-device-scale-factor=1'];
if (process.platform === 'linux') args.push('--ozone-platform=headless', '--disable-gpu');
const res = spawnSync(electron, args, {
  stdio: 'inherit',
  env: { ...process.env, VYTTY_DATA_DIR: path.join(work, 'data'), VYTTY_E2E_OUT: out, ELECTRON_ENABLE_LOGGING: '' },
  timeout: 180000,
});
fs.rmSync(work, { recursive: true, force: true });
if (res.error) { console.error(res.error); process.exit(1); }
process.exit(res.status === null ? 1 : res.status);
