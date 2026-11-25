// Runs inside the Vytty page (test builds evaluate it once the UI is ready,
// see src-tauri/src/e2e.rs); window.__E2E holds the ports from run.js.
(async () => {
  const E = window.__E2E || {};
  const report = (kind, value) => vytty.e2e(kind, value);
  const log = (m) => report('log', m);
  const shot = (name) => report('shot', name);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let step = 'start';
  const until = async (fn, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      try { if (await fn()) return; } catch { /* not yet */ }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await wait(100);
    }
  };
  const eq = (a, b, msg) => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja !== jb) throw new Error(`${msg || 'not equal'}: ${ja} !== ${jb}`);
  };
  const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
  const termHas = (text) => {
    const b = App.active && App.active.term && App.active.term.buffer.active;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i) || { translateToString: () => '' }).translateToString().includes(text)) return true;
    return false;
  };

  // Every visible icon must be vertically centred on the text (or input) next
  // to it: icon centre vs. the centre of the text's line box, in CSS pixels.
  const describe = (n) => {
    const parts = [];
    for (let e = n; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      parts.unshift(e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}${e.classList.length ? `.${[...e.classList].join('.')}` : ''}`);
    }
    return parts.join(' > ');
  };
  const textBox = (node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(t);
      const rects = [...r.getClientRects()].filter((x) => x.height > 0);
      if (rects.length) return rects[0];
    }
    return null;
  };
  const neighbourBox = (icon) => {
    let branch = icon;
    for (let p = icon.parentElement; p && p !== document.body; branch = p, p = p.parentElement) {
      for (const n of p.childNodes) {
        if (n === branch) continue;
        if (n.nodeType === 3 && n.textContent.trim()) {
          const r = document.createRange();
          r.selectNodeContents(n);
          const b = [...r.getClientRects()].find((x) => x.height > 0);
          if (b) return { box: b, what: 'text' };
        } else if (n.nodeType === 1) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || n.classList.contains('icon')) continue;
          if (n.matches('input[type=text], input:not([type]), input[type=search], input[type=password]')) return { box: n.getBoundingClientRect(), what: 'input' };
          const b = textBox(n);
          if (b) return { box: b, what: 'text' };
        }
      }
      // Stop at the row the icon sits in (a flex item one level up at most).
      if (branch !== icon && getComputedStyle(p).display.includes('flex')) break;
    }
    return null;
  };
  const misaligned = () => {
    const bad = [];
    for (const ic of document.querySelectorAll('.icon, .qc-icon')) {
      const svg = ic.querySelector('svg');
      if (!svg) continue;
      const r = svg.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
      const n = neighbourBox(ic);
      if (!n) continue;
      // Only neighbours on the same row.
      if (n.box.bottom < r.top || n.box.top > r.bottom) continue;
      const d = (r.top + r.height / 2) - (n.box.top + n.box.height / 2);
      if (Math.abs(d) > 1) bad.push(`${describe(ic)} (${n.what}): ${d > 0 ? '+' : ''}${d.toFixed(1)}px`);
    }
    return [...new Set(bad)];
  };
  const alignment = [];
  const checkAlignment = (where) => {
    const bad = misaligned();
    if (bad.length) alignment.push(`${where} [${document.documentElement.dataset.ui}]:\n    ${bad.join('\n    ')}`);
  };

  let code = 0;
  try {
    step = 'vault setup';
    await until(() => document.querySelector('.modal input[type=password]'), 'the vault dialog');
    const [pa, pb] = document.querySelectorAll('.modal input[type=password]');
    pa.value = 'master-pw-1';
    pb.value = 'master-pw-1';
    document.querySelector('.modal .btn.primary').click();
    await until(() => App.vault.unlocked && App.vault.mode === 'master', 'an unlocked vault');

    step = 'sessions';
    App.tree.folders.push({ id: 'f1', name: 'Lab', parentId: null });
    App.tree.sessions.push({ id: 's-ssh', name: 'e2e-switch', protocol: 'ssh', host: '127.0.0.1', port: E.sshPort, username: 'admin', folderId: 'f1', highlight: 'auto', logging: true });
    App.tree.sessions.push({ id: 's-tel', name: 'old-router', protocol: 'telnet', host: '10.0.0.9', port: 23, folderId: 'f1', highlight: 'cisco-ios', logging: true });
    await App.saveTree();
    await until(() => document.querySelectorAll('#panel-sessions .tree-row[data-session]').length === 2, 'the sessions in the tree');
    eq(App.Sessions.parseQuick('ssh -p 2222 admin@10.0.0.1'), { protocol: 'ssh', name: 'admin@10.0.0.1', username: 'admin', host: '10.0.0.1', port: 2222 }, 'quick connect parsing');
    eq((await vytty.sessions.get()).sessions.length, 2, 'sessions saved by the Rust backend');
    await wait(200);
    checkAlignment('welcome + session tree');
    await shot('01-welcome');

    step = 'local shell';
    if (E.platform !== 'win32') {
      App.emit('open-session', { id: null, name: 'sh', protocol: 'local', shell: '/bin/sh', shellArgs: '' });
      await until(() => App.active && App.active.state === 'connected', 'the local shell');
      App.active.send('echo vytty-e2e-$((40+2))\r');
      await until(() => termHas('vytty-e2e-42'), 'shell output');
    }

    step = 'ssh login';
    App.emit('open-session', App.session('s-ssh'));
    await until(() => document.querySelector('.modal') && /host key/i.test(document.querySelector('.modal h2').textContent), 'the host key dialog');
    checkAlignment('host key dialog');
    await shot('02-hostkey');
    document.querySelector('.modal .btn.primary').click();
    await until(() => document.querySelector('.modal input[type=password]'), 'the password dialog');
    document.querySelector('.modal input[type=password]').value = 'e2e-pass';
    document.querySelector('.modal .btn.primary').click();
    await until(() => App.active && App.active.state === 'connected', 'the SSH connection');
    await until(() => termHas('E2E-SW1#'), 'the device prompt');
    eq((await vytty.vault.get('s-ssh')).password, 'e2e-pass', 'password saved in the vault');
    App.active.send('show ver\r');
    await until(() => termHas('show ver'), 'the echo');
    await wait(300);
    checkAlignment('ssh tab + status bar');
    await shot('03-ssh');

    step = 'find bar and menus';
    App.emit('find');
    await wait(200);
    if (!document.querySelector('#findbar:not(.hidden)')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
    await wait(200);
    checkAlignment('find bar');
    const row = document.querySelector('#panel-sessions .tree-row[data-session]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }));
    await until(() => document.querySelector('.menu'), 'the context menu', 3000).catch(() => {});
    checkAlignment('context menu');
    await shot('04-menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();

    step = 'import merge';
    const folders = [{ id: 'a', name: 'Imported', parentId: null }, { id: 'b', name: 'Core', parentId: 'a' }];
    const imp = [{ id: 'j1', name: 'jump', protocol: 'ssh', host: '10.1.0.1', port: 22, folderId: 'a' }, { id: 'x1', name: 'imp-sw1', protocol: 'ssh', host: '10.1.0.2', port: 22, folderId: 'b', jumpId: 'j1' }];
    const first = App.Integrations.mergeIntoTree(folders, imp);
    const second = App.Integrations.mergeIntoTree(folders, imp);
    const sw = App.tree.sessions.find((x) => x.name === 'imp-sw1');
    const jump = App.tree.sessions.find((x) => x.name === 'jump');
    eq({ a1: first.added, a2: second.added, s2: second.skipped, jumpOk: sw.jumpId === jump.id, path: App.folderPath(sw.folderId) }, { a1: 2, a2: 0, s2: 2, jumpOk: true, path: 'Imported / Core' }, 'import merge');
    ok(App.Tools.menuItems(App.session('s-ssh'))[0].submenu.some((x) => x && x.label === 'Ping'), 'tools menu');
    const formats = await vytty.sessions.importFormats();
    ok(formats.length === 7 && formats.some((f) => f.id === 'mremoteng'), 'import formats from Rust');

    step = 'netbox';
    await vytty.vault.set('integration:netbox', { token: 'e2e-token' });
    Object.assign(App.settings.integrations.netbox, { url: `http://127.0.0.1:${E.netboxPort}`, username: 'admin' });
    await App.saveSettings();
    const nb1 = await App.Integrations.netboxSync();
    eq(nb1, { added: 2, updated: 0, missing: 0 }, 'first NetBox sync');
    eq(App.tree.sessions.filter((x) => x.source && x.source.type === 'netbox').map((x) => [x.name, x.host, App.folderPath(x.folderId), x.highlight, x.username]),
      [['nb-sw1', '10.9.0.1', 'NetBox / WAW1 / Access', 'cisco-ios', 'admin'], ['nb-sw2', '10.9.0.2', 'NetBox / KRK1 / Access', 'cisco-ios', 'admin']], 'NetBox sessions');
    // Second sync: sw1 moved to another site, sw2 deleted in NetBox -> asked, keep it.
    const p2 = App.Integrations.netboxSync();
    await until(() => document.querySelector('.modal'), 'the "missing in NetBox" question');
    document.querySelector('.modal .btn:not(.danger):not(.primary)').click();
    eq(await p2, { added: 0, updated: 1, missing: 1 }, 'second NetBox sync');
    eq(App.folderPath(App.tree.sessions.find((x) => x.name === 'nb-sw1').folderId), 'NetBox / WAW2 / Access', 'moved device');

    step = 'links';
    const before = App.tabs.length;
    App.Integrations.openUrls([{ protocol: 'ssh', host: '127.0.0.1', port: E.sshPort, username: 'admin', name: 'x' }]);
    await until(() => App.tabs.length === before + 1 && App.active.source.id === 's-ssh', 'the link to open the saved session');
    App.active.close(true);

    step = 'export';
    const csv = await vytty.tools.plan({ type: 'url', args: 'https://{host}/' }, App.session('s-ssh'));
    eq(csv, { type: 'url', url: 'https://127.0.0.1/' }, 'tool plan');

    step = 'styles';
    for (const [style, theme] of [['compact', 'paper'], ['rounded', 'vytty-dark'], ['minimal', 'graphite']]) {
      App.settings.theme = theme;
      await App.setStyle(style);
      eq(document.documentElement.dataset.ui, style, 'interface style');
      await wait(250);
      checkAlignment(`style ${style}`);
      await shot(`05-${style}-${theme}`);
    }

    step = 'settings';
    for (const section of ['Appearance', 'Integrations', 'Import / export', 'About']) {
      const m = document.querySelector('.modal');
      if (m) m._close(null);
      App.emit('open-settings', section);
      await until(() => document.querySelector('.settings-content h3'), `settings ${section}`);
      await wait(300);
      checkAlignment(`settings ${section}`);
      await shot(`06-settings-${section.replace(/\W+/g, '-').toLowerCase()}`);
    }
    document.querySelector('.modal')._close(null);

    step = 'icon alignment';
    if (alignment.length) throw new Error(`icons not centred on their text:\n  ${alignment.join('\n  ')}`);

    step = 'close';
    for (const t of [...App.tabs]) t.close(true);
    await until(() => App.tabs.length === 0, 'the tabs to close');
    log(`OK (${E.platform})`);
  } catch (err) {
    code = 1;
    await log(`FAILED at "${step}": ${err.message}`);
    try { await shot('failure'); } catch { /* ignore */ }
  }
  report('done', code);
})();
