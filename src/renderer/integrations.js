'use strict';
// Integrations with other tools: session import / export, NetBox sync,
// ssh:// telnet:// links and "Open with" external programs.
(() => {
  const { el, modal, confirmBox, inputBox, toast, uid } = UI;

  // ------------------------------------------------------------ import
  const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  // Find or create a folder path (['NetBox', 'WAW1', 'Switch']) in the tree.
  function ensureFolderPath(names, parentId = null) {
    let pid = parentId;
    for (const raw of names || []) {
      const name = String(raw || '').trim();
      if (!name) continue;
      let f = App.tree.folders.find((x) => (x.parentId || null) === pid && sameText(x.name, name));
      if (!f) { f = { id: uid(), name, parentId: pid }; App.tree.folders.push(f); }
      pid = f.id;
    }
    return pid;
  }

  // Merge imported folders + sessions under fresh ids. Folders with the same
  // name and parent are reused and sessions already present (same folder,
  // name, protocol, host and port) are skipped, so importing a file twice does
  // not duplicate anything. Returns { idMap, added, skipped }.
  function mergeIntoTree(folders, sessions) {
    const folderMap = {};
    const byId = new Map((folders || []).map((f) => [f.id, f]));
    const resolve = (id) => {
      if (!id) return null;
      if (folderMap[id] !== undefined) return folderMap[id];
      const f = byId.get(id);
      if (!f) return null;
      const parent = resolve(f.parentId);
      folderMap[id] = ensureFolderPath([f.name], parent);
      return folderMap[id];
    };
    for (const f of folders || []) resolve(f.id);
    const idMap = {};
    let skipped = 0;
    const incoming = [];
    for (const s of sessions || []) {
      const folderId = resolve(s.folderId);
      const dup = App.tree.sessions.find((x) => (x.folderId || null) === folderId && sameText(x.name, s.name) && x.protocol === s.protocol
        && sameText(x.host, s.host) && Number(x.port || 0) === Number(s.port || 0) && sameText(x.serialPath, s.serialPath));
      if (dup) { idMap[s.id] = dup.id; skipped++; continue; }
      idMap[s.id] = uid();
      incoming.push({ ...s, id: idMap[s.id], folderId });
    }
    for (const s of incoming) {
      s.jumpId = s.jumpId ? idMap[s.jumpId] || null : null;
      App.tree.sessions.push(s);
    }
    return { idMap, added: incoming.length, skipped };
  }

  async function storeSecrets(secrets, idMap) {
    const entries = Object.entries(secrets || {});
    if (!entries.length) return 0;
    if (!App.vault.unlocked) { toast('The vault is locked - imported passwords were not saved', 'error', 5000); return 0; }
    let n = 0;
    for (const [oldId, secret] of entries) {
      const id = idMap[oldId];
      if (!id) continue;
      try {
        const cur = await vytty.vault.get(id);
        await vytty.vault.set(id, { ...cur, ...secret });
        n++;
      } catch { /* ignore */ }
    }
    await App.refreshVault();
    return n;
  }

  const HELP = {
    mobaxterm: 'In MobaXterm: right-click "User sessions" → "Export all sessions to file".',
    putty: 'Export the sessions from the registry: reg export HKCU\\Software\\SimonTatham\\PuTTY\\Sessions putty.reg (KiTTY: HKCU\\Software\\9bis.com\\KiTTY\\Sessions).',
    securecrt: 'In SecureCRT: File → Export Settings… → XML. Or import the session folder itself (%APPDATA%\\VanDyke\\Config\\Sessions).',
    'securecrt-dir': 'Pick SecureCRT\'s Sessions folder (usually %APPDATA%\\VanDyke\\Config\\Sessions).',
    mremoteng: 'Pick confCons.xml (usually %APPDATA%\\mRemoteNG). Passwords are imported into the vault too.',
    sshconfig: 'Your OpenSSH client configuration, usually ~/.ssh/config.',
    csv: 'A table with a header row: name, host, port, protocol, username, folder, notes, key, serial, baud, platform.',
  };

  async function importFrom(format, opts = {}) {
    let data;
    try { data = await vytty.sessions.importFrom(format, opts); } catch (e) { toast(e.message, 'error', 6000); return; }
    if (!data) return;
    if (format === 'mremoteng' && data.protected && !opts.password) {
      const r = await inputBox('mRemoteNG master password', 'This file is protected. Enter its master password to import the passwords too, or cancel to import without passwords.', { password: true, okLabel: 'Import with passwords' });
      if (r && r.value) return importFrom(format, { file: data.file, password: r.value });
    }
    if (!data.sessions.length) { toast(`No importable sessions found in that ${format === 'securecrt-dir' ? 'folder' : 'file'}`, 'error'); return; }
    const st = data.stats;
    const byType = Object.entries(st.byType || {}).sort((a, b) => b[1] - a[1]);
    const skipped = Object.entries(st.skipped || {}).filter(([, n]) => n > 0);
    const pwCount = Object.keys(data.secrets || {}).length;
    const ok = await modal({
      title: `Import from ${data.label}`,
      width: 480,
      body: [
        el('p', { text: `Found ${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}${data.folders.length ? ` in ${data.folders.length} folder${data.folders.length === 1 ? '' : 's'}` : ''}.` }),
        el('div.kv', ...byType.flatMap(([t, n]) => [el('span.k', { text: t }), el('span.v', { text: String(n) })])),
        skipped.length ? el('p.muted', { style: { marginTop: '10px' }, text: `Skipped (no matching protocol in Vytty): ${skipped.map(([t, n]) => `${n} ${t}`).join(', ')}.` }) : null,
        pwCount ? el('div.notice.info', { style: { marginTop: '10px' }, text: `${pwCount} password${pwCount === 1 ? '' : 's'} will be stored in Vytty's encrypted vault${App.vault.unlocked ? '' : ' (unlock the vault first, otherwise they are skipped)'}.` }) : null,
        el('p.muted', { text: 'Existing sessions with the same name, host and folder are left as they are.' }),
      ],
      buttons: [{ label: 'Cancel', value: false }, { label: `Import ${data.sessions.length}`, value: true, primary: true }],
    });
    if (!ok) return;
    const { idMap, added, skipped: dups } = mergeIntoTree(data.folders, data.sessions);
    await App.saveTree();
    const pw = await storeSecrets(data.secrets, idMap);
    toast(`Imported ${added} session${added === 1 ? '' : 's'} from ${data.label}${dups ? ` (${dups} already present)` : ''}${pw ? `, ${pw} password${pw === 1 ? '' : 's'}` : ''}`, 'ok', 4500);
    const newIds = new Set(Object.values(idMap));
    const users = new Set(data.sessions.filter((s) => !(data.secrets || {})[s.id]).map((s) => s.username).filter(Boolean));
    if (added && users.size && await confirmBox('Set passwords per username?', `The imported sessions use ${users.size} username${users.size > 1 ? 's' : ''} (${[...users].slice(0, 6).join(', ')}${users.size > 6 ? ', …' : ''}). Set one password for each and every session with that login will use it. You can also do it later in Settings → Credentials.`, { okLabel: 'Set passwords', cancelLabel: 'Later' })) {
      await App.Credentials.perUser(newIds);
    }
  }

  async function exportAs(format) {
    try {
      const file = await vytty.sessions.exportAs(format, { folders: App.tree.folders, sessions: App.tree.sessions });
      if (file) toast(`Exported to ${file}`, 'ok', 4000);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ------------------------------------------------------------- NetBox
  const netboxOpts = (nb, token) => ({ url: nb.url, deviceFilter: nb.deviceFilter, includeVMs: nb.includeVMs, vmFilter: nb.vmFilter, hostFrom: nb.hostFrom, domain: nb.domain, groupBy: nb.groupBy, ...(token ? { token } : {}) });

  async function netboxSync() {
    const nb = App.settings.integrations.netbox;
    if (!nb.url) { toast('Set the NetBox URL first (Settings → Integrations)', 'error'); return null; }
    let res;
    try { res = await vytty.netbox.fetch(netboxOpts(nb)); } catch (e) { toast(`NetBox: ${e.message}`, 'error', 7000); return null; }
    const bySource = new Map(App.tree.sessions.filter((s) => s.source && s.source.type === 'netbox').map((s) => [s.source.id, s]));
    let added = 0;
    let updated = 0;
    const seen = new Set();
    for (const it of res.items) {
      seen.add(it.sourceId);
      const folderId = ensureFolderPath(it.folder);
      const ex = bySource.get(it.sourceId);
      if (ex) {
        const notesUntouched = (ex.notes || '') === (ex.source.notes || '');
        const changed = ex.name !== it.name || ex.host !== it.host || ex.folderId !== folderId || (notesUntouched && ex.notes !== it.notes);
        Object.assign(ex, { name: it.name, host: it.host, folderId });
        if (notesUntouched) ex.notes = it.notes;
        ex.source = { type: 'netbox', id: it.sourceId, url: it.url, notes: it.notes };
        if (changed) updated++;
      } else {
        App.tree.sessions.push({
          id: uid(), name: it.name, protocol: nb.protocol === 'telnet' ? 'telnet' : 'ssh', host: it.host, port: nb.protocol === 'telnet' ? 23 : 22,
          username: nb.username || '', folderId, highlight: it.highlight, logging: true, color: '', notes: it.notes,
          ...(nb.protocol === 'telnet' ? { autoLogin: true } : {}),
          source: { type: 'netbox', id: it.sourceId, url: it.url, notes: it.notes },
        });
        added++;
      }
    }
    const missing = [...bySource.values()].filter((s) => !seen.has(s.source.id));
    nb.lastSync = new Date().toISOString();
    await App.saveTree();
    await App.saveSettings();
    toast(`NetBox: ${res.devices} device${res.devices === 1 ? '' : 's'}${res.vms ? `, ${res.vms} VMs` : ''} - ${added} added, ${updated} updated${res.skipped ? `, ${res.skipped} without an address` : ''}`, 'ok', 6000);
    if (missing.length && await confirmBox('Sessions no longer in NetBox', `${missing.length} session${missing.length === 1 ? ' was' : 's were'} created from NetBox objects that the sync did not return any more (deleted, or outside the filter):\n\n${missing.slice(0, 12).map((s) => s.name).join('\n')}${missing.length > 12 ? '\n…' : ''}\n\nDelete ${missing.length === 1 ? 'it' : 'them'}?`, { okLabel: `Delete ${missing.length}`, danger: true, cancelLabel: 'Keep' })) {
      const ids = new Set(missing.map((s) => s.id));
      App.tree.sessions = App.tree.sessions.filter((s) => !ids.has(s.id));
      for (const id of ids) { try { await vytty.vault.remove(id); } catch { /* ignore */ } }
      await App.saveTree();
    }
    return { added, updated, missing: missing.length };
  }

  // ------------------------------------------------- ssh:// telnet:// links
  function openUrls(list) {
    for (const spec of list || []) {
      const port = Number(spec.port);
      const saved = App.tree.sessions.find((s) => s.protocol === spec.protocol && sameText(s.host, spec.host)
        && Number(s.port || (s.protocol === 'ssh' ? 22 : 23)) === port && (!spec.username || sameText(s.username, spec.username)));
      App.emit('open-session', saved || { id: null, highlight: 'auto', logging: true, autoLogin: true, ...spec });
    }
  }
  vytty.onOpenUrl(openUrls);

  // ---------------------------------------------------- external tools
  const HOST_OK = /^[A-Za-z0-9._:-]+$/;
  function runInTab(name, win, unix, host) {
    if (!HOST_OK.test(host || '')) { toast('Not a valid host name', 'error'); return; }
    const isWin = App.info.platform === 'win32';
    const [shell, args] = isWin ? win : unix;
    App.emit('open-session', { id: null, name: `${name} ${host}`, protocol: 'local', shell, shellArgs: args.replace('{host}', host), logging: false, highlight: 'none' });
  }

  async function launchTool(tool, session) {
    try { await vytty.tools.launch(tool, session); } catch (e) { toast(e.message, 'error', 5000); }
  }

  // Menu entries for a session (session tree and tab menus).
  function menuItems(session) {
    if (!session) return [];
    const tools = (App.settings.externalTools || []).filter((t) => t && t.enabled !== false && (!t.protocols || t.protocols.includes(session.protocol)));
    const net = (session.protocol === 'ssh' || session.protocol === 'telnet') && session.host;
    const items = tools.map((t) => ({ label: t.name, action: () => launchTool(t, session) }));
    const builtins = net ? [
      { label: 'Ping', action: () => runInTab('ping', ['ping.exe', '-t {host}'], ['ping', '{host}'], session.host) },
      { label: 'Traceroute', action: () => runInTab('traceroute', ['tracert.exe', '-d {host}'], ['traceroute', '-n {host}'], session.host) },
    ] : [];
    if (session.source && session.source.type === 'netbox' && session.source.url) builtins.push({ label: 'Open in NetBox', action: () => vytty.openExternal(session.source.url) });
    if (!items.length && !builtins.length) return [];
    return [{ label: 'Open with', icon: 'more', submenu: [...items, ...(items.length && builtins.length ? ['-'] : []), ...builtins, '-', { label: 'External tools…', action: () => App.emit('open-settings', 'Integrations') }] }];
  }

  App.Integrations = { importFrom, exportAs, netboxSync, netboxOpts, mergeIntoTree, ensureFolderPath, openUrls, HELP };
  App.Tools = { menuItems, launch: launchTool };
})();
