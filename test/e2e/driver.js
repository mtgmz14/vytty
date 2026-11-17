'use strict';
// Runs inside the Electron main process before Vytty's main.js.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { app } = require('electron');
const { Server, utils } = require('ssh2');

const OUT = process.env.VYTTY_E2E_OUT;
const errors = [];
let step = 'start';
const log = (m) => process.stdout.write(`[e2e] ${m}\n`);

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

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (ev) => {
    const level = ev.level !== undefined ? ev.level : '';
    if (level === 'error' || level === 3) errors.push(`${step}: ${ev.message}`);
  });
  win.webContents.once('did-finish-load', async () => {
    const ev = (code) => win.webContents.executeJavaScript(code, true);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, what, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await ev(code)) return; await wait(100); }
      throw new Error(`timed out waiting for ${what}`);
    };
    const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    const srv = await sshServer();
    let code = 0;
    try {
      win.setSize(1280, 800);
      step = 'vault setup';
      await until(`!!document.querySelector('.modal input[type=password]')`, 'the vault dialog');
      await ev(`(() => { const [a, b] = document.querySelectorAll('.modal input[type=password]'); a.value = 'master-pw-1'; b.value = 'master-pw-1'; document.querySelector('.modal .btn.primary').click(); })()`);
      await until(`App.vault.unlocked && App.vault.mode === 'master'`, 'an unlocked vault');

      step = 'sessions';
      await ev(`(async () => {
        App.tree.folders.push({ id: 'f1', name: 'Lab', parentId: null });
        App.tree.sessions.push({ id: 's-ssh', name: 'e2e-switch', protocol: 'ssh', host: '127.0.0.1', port: ${srv.address().port}, username: 'admin', folderId: 'f1', highlight: 'auto', logging: true });
        await App.saveTree();
      })()`);
      await until(`document.querySelectorAll('#panel-sessions .tree-row[data-session]').length === 1`, 'the session in the tree');
      const q = await ev(`JSON.stringify(App.Sessions.parseQuick('ssh -p 2222 admin@10.0.0.1'))`);
      assert.deepStrictEqual(JSON.parse(q), { protocol: 'ssh', name: 'admin@10.0.0.1', username: 'admin', host: '10.0.0.1', port: 2222 });
      await shot('01-welcome');

      step = 'local shell';
      if (process.platform !== 'win32') {
        await ev(`App.emit('open-session', { id: null, name: 'sh', protocol: 'local', shell: '/bin/sh', shellArgs: '' })`);
        await until(`App.active && App.active.state === 'connected'`, 'the local shell');
        await ev(`App.active.send('echo vytty-e2e-$((40+2))\\r')`);
        await until(`(() => { const b = App.active.term.buffer.active; for (let i = 0; i < b.length; i++) if ((b.getLine(i) || { translateToString: () => '' }).translateToString().includes('vytty-e2e-42')) return true; return false; })()`, 'shell output');
      }

      step = 'ssh login';
      await ev(`App.emit('open-session', App.session('s-ssh'))`);
      await until(`!!document.querySelector('.modal') && /host key/i.test(document.querySelector('.modal h2').textContent)`, 'the host key dialog');
      await shot('02-hostkey');
      await ev(`document.querySelector('.modal .btn.primary').click()`);
      await until(`!!document.querySelector('.modal input[type=password]')`, 'the password dialog');
      await ev(`(() => { document.querySelector('.modal input[type=password]').value = 'e2e-pass'; document.querySelector('.modal .btn.primary').click(); })()`);
      await until(`App.active && App.active.state === 'connected'`, 'the SSH connection');
      await until(`(() => { const b = App.active.term.buffer.active; for (let i = 0; i < b.length; i++) if ((b.getLine(i) || { translateToString: () => '' }).translateToString().includes('E2E-SW1#')) return true; return false; })()`, 'the device prompt');
      const saved = await ev(`vytty.vault.get('s-ssh').then((s) => s.password)`);
      assert.strictEqual(saved, 'e2e-pass', 'password saved in the vault');
      await wait(300);
      await shot('03-ssh');

      step = 'styles';
      for (const [style, theme] of [['compact', 'paper'], ['rounded', 'vytty-dark'], ['minimal', 'graphite']]) {
        await ev(`(async () => { App.settings.theme = '${theme}'; await App.setStyle('${style}'); })()`);
        assert.strictEqual(await ev('document.documentElement.dataset.ui'), style);
        await wait(200);
        await shot(`04-${style}-${theme}`);
      }

      step = 'settings';
      for (const section of ['Appearance', 'Integrations', 'Import / export', 'About']) {
        await ev(`(() => { const m = document.querySelector('.modal'); if (m) m._close(null); App.emit('open-settings', ${JSON.stringify(section)}); })()`);
        await until(`!!document.querySelector('.settings-content h3')`, `settings ${section}`);
        await wait(300);
        await shot(`05-settings-${section.replace(/\W+/g, '-').toLowerCase()}`);
      }
      await ev(`document.querySelector('.modal')._close(null)`);

      step = 'reconnect / close';
      await ev(`App.active.close(true)`);
      await until(`App.tabs.every((t) => t.source.protocol !== 'ssh')`, 'the SSH tab to close');
      if (errors.length) throw new Error(`errors in the renderer:\n${errors.join('\n')}`);
      log(`OK - screenshots in ${OUT}`);
    } catch (err) {
      code = 1;
      log(`FAILED at "${step}": ${err.message}`);
      try { await shot('failure'); } catch { /* ignore */ }
    }
    srv.close();
    app.exit(code);
  });
});
