'use strict';
// End-to-end test: starts the real app (the Rust build in test mode) with a
// throw-away data folder and drives the UI from inside the page (driver.js):
// vault setup, sessions, a local shell, an SSH login through the host key and
// password dialogs against a test SSH server, NetBox sync against a fake API,
// ssh:// links, interface styles, settings - and checks that every icon is
// vertically centred on the text next to it. Screenshots go to test/e2e/out.
//
// Usage: npm run test:e2e   (builds target/debug/vytty first when missing)
// Linux needs a display: in CI it runs under xvfb-run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { Server, utils } = require('ssh2');

const root = path.join(__dirname, '..', '..');
const exe = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'vytty.exe' : 'vytty');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

function sshServer() {
  const srv = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'admin' && ctx.password === 'e2e-pass' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (ok) => ok && ok());
      s.on('window-change', (ok) => ok && ok());
      s.on('shell', (ok) => {
        const st = ok();
        st.write('\r\nGigabitEthernet1/0/1   10.10.0.1   YES manual up   up\r\nE2E-SW1#');
        st.on('data', (d) => st.write(d));
      });
    }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// A fake NetBox API: two devices, the second one gone on the second sync.
function netboxServer() {
  let calls = 0;
  const dev = (id, site) => ({ id, name: `nb-sw${id}`, display_url: `http://nb/dcim/devices/${id}/`, primary_ip: { address: `10.9.0.${id}/24` }, site: { name: site }, role: { name: 'Access' }, platform: { name: 'Cisco IOS', slug: 'ios' } });
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Token e2e-token') { res.writeHead(403); res.end('{}'); return; }
    calls++;
    const results = calls === 1 ? [dev(1, 'WAW1'), dev(2, 'KRK1')] : [dev(1, 'WAW2')];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: results.length, next: null, results }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  if (!fs.existsSync(exe)) {
    const b = spawnSync('cargo', ['build', '-p', 'vytty'], { cwd: root, stdio: 'inherit' });
    if (b.status !== 0) process.exit(1);
  }
  const ssh = await sshServer();
  const nb = await netboxServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-e2e-'));
  const env = {
    ...process.env,
    VYTTY_DATA_DIR: path.join(work, 'data'),
    VYTTY_E2E: path.join(__dirname, 'driver.js'),
    VYTTY_E2E_OUT: out,
    VYTTY_E2E_CONFIG: JSON.stringify({ sshPort: ssh.address().port, netboxPort: nb.address().port, platform: process.platform }),
  };
  const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pageErrors = [];
  const onLine = (line) => {
    if (!line.trim()) return;
    process.stdout.write(`${line}\n`);
    if (/\[e2e\] (page error|page rejection|console\.error)/.test(line)) pageErrors.push(line);
  };
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(onLine); });
  child.stderr.on('data', (d) => process.stderr.write(d));
  const timer = setTimeout(() => { console.error('[e2e] timed out'); child.kill('SIGKILL'); }, 240000);
  const code = await new Promise((r) => child.on('exit', (c, sig) => { console.log(`[e2e] app exited with ${c === null ? sig : c}`); r(c === null ? 1 : c); }));
  clearTimeout(timer);
  ssh.close();
  nb.close();
  // WebView2 helper processes may still hold their profile for a moment (Windows).
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (err) { console.log(`[e2e] could not remove ${work}: ${err.code}`); }
  if (pageErrors.length) {
    console.error(`[e2e] ${pageErrors.length} error(s) in the page`);
    process.exit(1);
  }
  process.exit(code);
})();
