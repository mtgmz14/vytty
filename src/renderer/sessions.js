'use strict';
// Session tree (sidebar), session editor and quick connect.
(() => {
  const { el, $, icon, modal, confirmBox, inputBox, contextMenu, toast, uid } = UI;

  const PROTOCOLS = {
    ssh: { label: 'SSH', icon: 'server', port: 22 },
    telnet: { label: 'Telnet', icon: 'plug', port: 23 },
    serial: { label: 'Serial', icon: 'cable' },
    local: { label: 'Local shell', icon: 'terminal' },
  };
  const COLORS = ['', '#ff6b7a', '#f5a35b', '#f5c46b', '#4fd18b', '#5fd4e8', '#6c8cff', '#c792ea', '#ff79c6', '#9aa3b5'];
  const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  // Multi-selection: click selects one, Ctrl+click toggles, Shift+click selects a range.
  const selected = new Set();
  let anchorId = null;
  let filter = '';
  const selectedSessions = () => App.tree.sessions.filter((s) => selected.has(s.id));
  const visibleSessionIds = () => [...document.querySelectorAll('#panel-sessions .tree-row[data-session]')].map((r) => r.dataset.session);
  function selectRow(id, e) {
    if (e && e.shiftKey && anchorId) {
      const ids = visibleSessionIds();
      const [a, b] = [ids.indexOf(anchorId), ids.indexOf(id)].sort((x, y) => x - y);
      if (a !== -1 && b !== -1) {
        if (!e.ctrlKey && !e.metaKey) selected.clear();
        ids.slice(a, b + 1).forEach((x) => selected.add(x));
      }
    } else if (e && (e.ctrlKey || e.metaKey)) {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      anchorId = id;
    } else {
      selected.clear();
      selected.add(id);
      anchorId = id;
    }
    paintSelection();
  }
  function paintSelection() {
    for (const r of document.querySelectorAll('#panel-sessions .tree-row[data-session]')) r.classList.toggle('selected', selected.has(r.dataset.session));
  }
  const collapsed = new Set(JSON.parse(localStorage.getItem('vytty.collapsed') || '[]'));
  const saveCollapsed = () => { try { localStorage.setItem('vytty.collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ } };

  const subtitle = (s) => {
    if (s.protocol === 'serial') return `${s.serialPath || ''} ${s.baudRate || ''}`;
    if (s.protocol === 'local') return s.shell || 'shell';
    return `${s.username ? `${s.username}@` : ''}${s.host || ''}${s.port && s.port !== PROTOCOLS[s.protocol].port ? `:${s.port}` : ''}`;
  };

  // ------------------------------------------------------------- tree
  function renderTree() {
    const panel = $('#panel-sessions');
    const scroll = panel.querySelector('.panel-scroll');
    const { folders, sessions } = App.tree;
    scroll.replaceChildren();

    if (!sessions.length && !folders.length) {
      scroll.append(el('div.panel-empty', 'No saved sessions yet.', el('br'), el('button.btn.small.primary', { on: { click: () => App.emit('new-session') } }, icon('plus', 14), 'New session')));
      return;
    }

    if (filter) {
      const q = filter.toLowerCase();
      const hits = sessions.filter((s) => [s.name, s.host, s.username, s.serialPath, App.folderPath(s.folderId), s.notes].some((v) => v && String(v).toLowerCase().includes(q)));
      if (!hits.length) scroll.append(el('div.panel-empty', { text: 'No matches.' }));
      for (const s of hits) scroll.append(sessionRow(s, App.folderPath(s.folderId)));
      return;
    }

    const build = (parentId) => {
      const frag = [];
      const fs = folders.filter((f) => (f.parentId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name));
      for (const f of fs) {
        const open = !collapsed.has(f.id);
        const count = sessions.filter((s) => s.folderId === f.id).length;
        const row = el('div.tree-row.folder', {
          draggable: true,
          dataset: { folder: f.id },
          on: {
            click: () => { if (open) collapsed.add(f.id); else collapsed.delete(f.id); saveCollapsed(); renderTree(); },
            contextmenu: (e) => { e.preventDefault(); folderMenu(e.clientX, e.clientY, f); },
            dragstart: (e) => e.dataTransfer.setData('text/vytty-folder', f.id),
          },
        }, el(`span.caret${open ? '.open' : ''}`, icon('chevron', 12)), icon(open ? 'folderOpen' : 'folder', 15), el('span.name', { text: f.name }), el('span.count', { text: count || '' }));
        dropTarget(row, f.id);
        frag.push(row);
        if (open) {
          const kids = build(f.id);
          if (kids.length) frag.push(el('div.tree-children', kids));
        }
      }
      const ss = sessions.filter((s) => (s.folderId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name));
      for (const s of ss) frag.push(sessionRow(s));
      return frag;
    };
    scroll.append(...build(null));
  }

  function sessionRow(s, sub) {
    const row = el(`div.tree-row${selected.has(s.id) ? '.selected' : ''}`, {
      draggable: true,
      title: `${s.name}\n${PROTOCOLS[s.protocol].label} ${subtitle(s)}${s.notes ? `\n\n${s.notes}` : ''}`,
      dataset: { session: s.id },
      on: {
        click: (e) => selectRow(s.id, e),
        dblclick: (e) => { if (!e.ctrlKey && !e.shiftKey) App.emit('open-session', s); },
        contextmenu: (e) => {
          e.preventDefault();
          if (!selected.has(s.id)) selectRow(s.id);
          if (selected.size > 1) multiMenu(e.clientX, e.clientY, selectedSessions());
          else sessionMenu(e.clientX, e.clientY, s);
        },
        dragstart: (e) => {
          const ids = selected.has(s.id) ? [...selected] : [s.id];
          e.dataTransfer.setData('text/vytty-session', ids.join(','));
        },
      },
    },
    el('span.color-dot', { style: { background: s.color || 'transparent' } }),
    el('span.proto', icon(PROTOCOLS[s.protocol].icon, 14)),
    el('span.name', { text: s.name }),
    el('span.sub', { text: sub || subtitle(s) }));
    return row;
  }

  function dropTarget(node, folderId) {
    node.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/vytty-session') || e.dataTransfer.types.includes('text/vytty-folder')) {
        e.preventDefault();
        e.stopPropagation();
        node.classList.add('drop-target');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('drop-target');
      const sid = e.dataTransfer.getData('text/vytty-session');
      const fid = e.dataTransfer.getData('text/vytty-folder');
      if (sid) for (const id of sid.split(',')) { const s = App.session(id); if (s) s.folderId = folderId; }
      if (fid && fid !== folderId) {
        // refuse to move a folder into its own descendant
        let p = App.folder(folderId);
        while (p) { if (p.id === fid) return; p = App.folder(p.parentId); }
        App.folder(fid).parentId = folderId;
      }
      App.saveTree();
    });
  }

  function sessionMenu(x, y, s) {
    contextMenu(x, y, [
      { label: 'Connect', icon: 'play', action: () => App.emit('open-session', s) },
      s.protocol === 'ssh' ? { label: 'Connect and open SFTP', icon: 'folder', action: () => { App.emit('open-session', s); App.emit('show-panel', 'sftp'); } } : null,
      '-',
      { label: 'Edit…', icon: 'edit', action: () => editSession(s) },
      { label: 'Duplicate', icon: 'copy', action: () => duplicateSession(s) },
      { label: 'Rename', action: () => renameSession(s) },
      { label: 'Move to', icon: 'folder', submenu: [{ label: '(root)', action: () => { s.folderId = null; App.saveTree(); } }, ...App.tree.folders.map((f) => ({ label: App.folderPath(f.id), checked: s.folderId === f.id, action: () => { s.folderId = f.id; App.saveTree(); } }))] },
      '-',
      s.host ? { label: 'Copy host', action: () => vytty.clipboard.write(s.host) } : null,
      '-',
      { label: 'Delete', icon: 'trash', danger: true, action: () => deleteSession(s) },
    ]);
  }

  function multiMenu(x, y, list) {
    const folders = App.tree.folders.slice().sort((a, b) => App.folderPath(a.id).localeCompare(App.folderPath(b.id)));
    contextMenu(x, y, [
      { header: `${list.length} sessions selected` },
      { label: `Connect all (${list.length})`, icon: 'play', action: () => list.forEach((s) => App.emit('open-session', s)) },
      '-',
      { label: 'Move to', icon: 'folder', submenu: [
        { label: '(root)', action: () => { for (const s of list) s.folderId = null; App.saveTree(); } },
        ...folders.map((f) => ({ label: App.folderPath(f.id), action: () => { for (const s of list) s.folderId = f.id; App.saveTree(); } })),
      ] },
      { label: 'Set credential', icon: 'key', submenu: credentialSubmenu(list) },
      '-',
      { label: `Delete ${list.length} sessions`, icon: 'trash', danger: true, shortcut: 'Del', action: () => deleteSessions(list) },
    ]);
  }

  function credentialSubmenu(list) {
    const creds = App.tree.credentials || [];
    return [
      { label: 'Auto (match by username)', action: () => { for (const s of list) s.credentialId = null; App.saveTree(); } },
      { label: 'None', action: () => { for (const s of list) s.credentialId = 'none'; App.saveTree(); } },
      ...(creds.length ? ['-', ...creds.map((c) => ({ label: `${c.name} (${c.username})`, action: () => setCredential(list, c) }))] : []),
    ];
  }

  // Assign a credential to several sessions and adopt its username, so a
  // password already saved for that user is reused.
  async function setCredential(list, cred) {
    for (const s of list) { s.credentialId = cred.id; s.username = cred.username; }
    await App.saveTree();
    toast(`${list.length} session${list.length > 1 ? 's' : ''} → ${cred.name}`, 'ok');
  }

  async function deleteSessions(list) {
    if (list.length === 1) return deleteSession(list[0]);
    if (!(await confirmBox('Delete sessions', `Delete ${list.length} sessions and their stored passwords?`, { okLabel: `Delete ${list.length}`, danger: true }))) return;
    const ids = new Set(list.map((s) => s.id));
    App.tree.sessions = App.tree.sessions.filter((x) => !ids.has(x.id));
    for (const id of ids) { selected.delete(id); try { await vytty.vault.remove(id); } catch { /* ignore */ } }
    await App.saveTree();
    toast(`Deleted ${list.length} sessions`, 'ok');
  }

  function folderMenu(x, y, f) {
    const inFolder = App.tree.sessions.filter((s) => s.folderId === f.id);
    contextMenu(x, y, [
      { label: `Open all (${inFolder.length})`, icon: 'play', disabled: !inFolder.length, action: () => inFolder.forEach((s) => App.emit('open-session', s)) },
      '-',
      { label: 'New session here…', icon: 'plus', action: () => editSession(null, { folderId: f.id }) },
      { label: 'New subfolder…', icon: 'folderPlus', action: () => newFolder(f.id) },
      { label: 'Rename…', icon: 'edit', action: async () => {
        const r = await inputBox('Rename folder', 'Name', { value: f.name });
        if (r && r.value.trim()) { f.name = r.value.trim(); App.saveTree(); }
      } },
      '-',
      { label: 'Delete folder', icon: 'trash', danger: true, action: async () => {
        if (!(await confirmBox('Delete folder', `Delete "${f.name}"? Sessions and subfolders inside are moved to the parent folder.`, { okLabel: 'Delete', danger: true }))) return;
        for (const s of App.tree.sessions) if (s.folderId === f.id) s.folderId = f.parentId || null;
        for (const c of App.tree.folders) if (c.parentId === f.id) c.parentId = f.parentId || null;
        App.tree.folders = App.tree.folders.filter((x) => x.id !== f.id);
        App.saveTree();
      } },
    ]);
  }

  async function newFolder(parentId = null) {
    const r = await inputBox('New folder', 'Folder name', { placeholder: 'e.g. Core switches' });
    if (!r || !r.value.trim()) return;
    App.tree.folders.push({ id: uid(), name: r.value.trim(), parentId });
    collapsed.delete(parentId);
    App.saveTree();
  }

  async function renameSession(s) {
    const r = await inputBox('Rename session', 'Name', { value: s.name });
    if (r && r.value.trim()) { s.name = r.value.trim(); App.saveTree(); }
  }

  async function duplicateSession(s) {
    const copy = { ...JSON.parse(JSON.stringify(s)), id: uid(), name: `${s.name} (copy)`, lastUsed: 0 };
    App.tree.sessions.push(copy);
    if (App.vault.unlocked) {
      try { const sec = await vytty.vault.get(s.id); if (Object.keys(sec).length) await vytty.vault.set(copy.id, sec); } catch { /* ignore */ }
    }
    selected.clear(); selected.add(copy.id); anchorId = copy.id;
    App.saveTree();
  }

  async function deleteSession(s) {
    if (!(await confirmBox('Delete session', `Delete "${s.name}" and its stored credentials?`, { okLabel: 'Delete', danger: true }))) return;
    App.tree.sessions = App.tree.sessions.filter((x) => x.id !== s.id);
    try { await vytty.vault.remove(s.id); } catch { /* ignore */ }
    App.saveTree();
  }

  // ----------------------------------------------------------- editor
  async function editSession(existing, defaults = {}) {
    const isNew = !existing;
    const s = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: uid(), name: '', protocol: 'ssh', host: '', port: 22, username: '', folderId: null,
      highlight: 'auto', color: '', logging: true, forwards: [], baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none',
      ...defaults,
    };
    let secret = {};
    if (!isNew && App.vault.unlocked) { try { secret = await vytty.vault.get(s.id); } catch { /* ignore */ } }

    const f = {};
    const input = (key, props = {}) => (f[key] = el('input.input', { type: 'text', value: s[key] ?? '', spellcheck: false, ...props }));
    const field = (label, control, hint, cls = '') => el(`label.field${cls}`, el('span', { text: label }), control, hint ? el('span.hint', { text: hint }) : null);
    const check = (key, label, hint) => el('label.check', (f[key] = el('input', { type: 'checkbox', checked: !!s[key] })), el('span', { text: label }), hint ? el('span.hint', { text: hint }) : null);
    const select = (key, options, value) => {
      const sel = el('select.input', options.map(([v, l]) => el('option', { value: v, text: l })));
      sel.value = String(value ?? s[key] ?? '');
      return (f[key] = sel);
    };

    // protocol picker
    const picker = el('div.proto-picker');
    const setProto = (p) => {
      const prevDefault = PROTOCOLS[s.protocol].port;
      s.protocol = p;
      if (f.port && (!f.port.value || Number(f.port.value) === prevDefault)) f.port.value = PROTOCOLS[p].port || '';
      for (const opt of picker.children) opt.classList.toggle('active', opt.dataset.p === p);
      for (const node of body.querySelectorAll('[data-only]')) node.classList.toggle('hidden', !node.dataset.only.split(' ').includes(p));
    };
    for (const [p, def] of Object.entries(PROTOCOLS)) {
      picker.append(el('div.proto-opt', { dataset: { p }, on: { click: () => setProto(p) } }, icon(def.icon, 18), def.label));
    }

    const folderOptions = [['', '(root)'], ...App.tree.folders.map((fo) => [fo.id, App.folderPath(fo.id)]).sort((a, b) => a[1].localeCompare(b[1]))];
    const vaultLocked = !App.vault.unlocked;
    const pw = el('input.input', { type: 'password', value: secret.password || '', placeholder: vaultLocked ? 'Vault locked' : 'Stored encrypted in the vault', disabled: vaultLocked, autocomplete: 'new-password' });
    const pwToggle = el('button.icon-btn', { type: 'button', title: 'Show / hide', on: { click: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; } } }, icon('key', 14));
    const passphrase = el('input.input', { type: 'password', value: secret.passphrase || '', placeholder: 'Only if the key is encrypted', disabled: vaultLocked, autocomplete: 'new-password' });

    // Credential profile: auto (match by username), none, or a specific one.
    const credSel = el('select.input');
    const credHint = el('div.cred-hint');
    const fillCreds = (value) => {
      credSel.replaceChildren(
        el('option', { value: '', text: 'Auto - match by username' }),
        el('option', { value: 'none', text: 'None - use only this session\'s password' }),
        ...(App.tree.credentials || []).map((c) => el('option', { value: c.id, text: `${c.name} (${c.username})` })),
        el('option', { value: '__new', text: 'New credential…' }));
      credSel.value = value || '';
    };
    fillCreds(s.credentialId);
    const syncCred = () => {
      const v = credSel.value;
      const picked = v && v !== 'none' ? App.credential(v) : null;
      f.username.disabled = !!picked;
      if (picked) f.username.value = picked.username;
      const match = v === '' ? App.credentialFor({ ...s, credentialId: null, protocol: s.protocol, username: f.username.value }) : picked;
      credHint.replaceChildren();
      if (match) credHint.append('Password comes from credential ', el('b', { text: match.name }), pw.value ? ' (the password below overrides it)' : '');
      else if (v === '' && f.username.value.trim()) credHint.append('No credential for this username - the session password is used.');
      pw.placeholder = match ? `From credential "${match.name}"` : (vaultLocked ? 'Vault locked' : 'Stored encrypted in the vault');
    };
    credSel.addEventListener('change', async () => {
      if (credSel.value === '__new') {
        const created = await App.Credentials.edit(null, { username: f.username.value.trim(), name: f.username.value.trim() });
        fillCreds(created ? created.id : '');
      }
      syncCred();
    });
    pw.addEventListener('input', syncCred);

    const keyInput = input('keyPath', { placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519' });
    const browseKey = el('button.btn', { type: 'button', on: { click: async () => { const p = await vytty.dialog.openFile({ title: 'Select private key' }); if (p) keyInput.value = p; } } }, 'Browse');

    // serial ports
    const serialSel = el('input.input', { type: 'text', value: s.serialPath || '', list: 'serial-ports', placeholder: 'COM3' });
    f.serialPath = serialSel;
    const serialList = el('datalist#serial-ports');
    const refreshPorts = async () => {
      const ports = await vytty.serialList();
      serialList.replaceChildren(...ports.map((p) => el('option', { value: p.path, text: p.label })));
      if (!serialSel.value && ports[0]) serialSel.value = ports[0].path;
    };
    refreshPorts();
    const baud = el('input.input', { type: 'text', value: s.baudRate || 9600, list: 'bauds' });
    f.baudRate = baud;
    const baudList = el('datalist#bauds', BAUDS.map((b) => el('option', { value: b })));

    // jump host
    const jumpOptions = [['', 'None (direct)'], ...App.tree.sessions.filter((x) => x.protocol === 'ssh' && x.id !== s.id).map((x) => [x.id, `${x.name} (${subtitle(x)})`])];

    // color
    let color = s.color || '';
    const colors = el('div.colors', COLORS.map((c) => el(`div.color-swatch${c ? '' : '.none'}${c === color ? '.sel' : ''}`, {
      style: c ? { background: c } : {},
      title: c || 'No color',
      on: { click: (e) => { color = c; for (const n of colors.children) n.classList.remove('sel'); e.currentTarget.classList.add('sel'); } },
    })));

    // port forwards
    const fwdBox = el('div');
    const addFwd = (fw = { type: 'L', listenPort: '', destHost: '', destPort: '' }) => {
      const type = el('select.input', [el('option', { value: 'L', text: 'Local' }), el('option', { value: 'D', text: 'SOCKS' })]);
      type.value = fw.type;
      const lp = el('input.input', { type: 'text', value: fw.listenPort, placeholder: 'Local port' });
      const dh = el('input.input', { type: 'text', value: fw.destHost || '', placeholder: 'Remote host' });
      const dp = el('input.input', { type: 'text', value: fw.destPort || '', placeholder: 'Port', style: { width: '80px' } });
      const sync = () => { dh.disabled = dp.disabled = type.value === 'D'; };
      type.addEventListener('change', sync);
      sync();
      const row = el('div.fwd-row', type, lp, dh, dp, el('button.icon-btn', { type: 'button', title: 'Remove', on: { click: () => row.remove() } }, icon('x', 14)));
      row._get = () => ({ type: type.value, listenPort: Number(lp.value) || 0, destHost: dh.value.trim(), destPort: Number(dp.value) || 0 });
      fwdBox.append(row);
    };
    (s.forwards || []).forEach(addFwd);

    const hlSel = select('highlight', Object.entries(VyttyHighlight.PROFILES), s.highlight || 'auto');

    const tabs = ['General', 'Terminal', 'Advanced'];
    const panes = {};
    const tabBar = el('div.mtabs', tabs.map((t, i) => el(`button.mtab${i === 0 ? '.active' : ''}`, {
      type: 'button',
      on: { click: (e) => {
        for (const b of tabBar.children) b.classList.remove('active');
        e.currentTarget.classList.add('active');
        for (const [k, p] of Object.entries(panes)) p.classList.toggle('active', k === t);
      } },
      text: t,
    })));

    panes.General = el('div.mpane.active',
      picker,
      el('div.field-row', field('Name', input('name', { placeholder: 'e.g. core-sw01', autofocus: true })), field('Folder', select('folderId', folderOptions, s.folderId || ''))),
      el('div.field-row', { dataset: { only: 'ssh telnet' } }, field('Host', input('host', { placeholder: 'hostname or IP' })), field('Port', input('port'), null, '.narrow')),
      el('div', { dataset: { only: 'ssh telnet serial' } }, field('Credential', credSel), credHint),
      el('div.field-row', { dataset: { only: 'ssh telnet serial' } },
        field('Username', input('username', { placeholder: 'optional' })),
        field('Password', el('div.with-btn', pw, pwToggle))),
      vaultLocked ? el('div.notice', { dataset: { only: 'ssh telnet serial' } }, 'The vault is locked. Unlock it (status bar) to store passwords.') : null,
      el('div', { dataset: { only: 'ssh' } },
        field('Private key (optional)', el('div.with-btn', keyInput, browseKey), 'OpenSSH / PEM / PuTTY .ppk key'),
        field('Key passphrase', passphrase),
        check('useAgent', 'Use SSH agent (Pageant / OpenSSH agent)')),
      el('div', { dataset: { only: 'telnet serial' } }, check('autoLogin', 'Auto-login: answer Username/Password prompts', '(first minute)')),
      el('div', { dataset: { only: 'serial' } },
        el('div.field-row', field('Port', el('div.with-btn', serialSel, el('button.btn', { type: 'button', on: { click: refreshPorts } }, 'Refresh'))), field('Baud rate', baud, null, '.narrow')),
        el('div.field-row',
          field('Data bits', select('dataBits', [['8', '8'], ['7', '7'], ['6', '6'], ['5', '5']], s.dataBits || 8)),
          field('Parity', select('parity', [['none', 'None'], ['even', 'Even'], ['odd', 'Odd'], ['mark', 'Mark'], ['space', 'Space']], s.parity || 'none')),
          field('Stop bits', select('stopBits', [['1', '1'], ['1.5', '1.5'], ['2', '2']], s.stopBits || 1)),
          field('Flow control', select('flowControl', [['none', 'None'], ['hardware', 'RTS/CTS'], ['software', 'XON/XOFF']], s.flowControl || 'none'))),
        serialList, baudList),
      el('div', { dataset: { only: 'local' } },
        field('Shell', input('shell', { placeholder: App.info.platform === 'win32' ? 'powershell.exe, cmd.exe, wsl.exe…' : '/bin/bash' })),
        el('div.field-row', field('Arguments', input('shellArgs', { placeholder: 'optional' })), field('Start directory', input('cwd', { placeholder: 'home directory' })))));

    panes.Terminal = el('div.mpane',
      el('div.field-row', field('Syntax highlighting', hlSel), field('Logging', select('logging', [['true', 'Log to the daily file'], ['false', 'Do not log this session']], String(s.logging !== false)))),
      field('Tab color', colors),
      field('Startup commands', (f.startupCommands = el('textarea.input', { rows: 4, placeholder: 'One command per line, sent after login.\ne.g. terminal length 0', value: s.startupCommands || '' }))),
      field('Notes', (f.notes = el('textarea.input', { rows: 3, placeholder: 'Anything worth remembering about this device', value: s.notes || '' }))));
    f.startupCommands.value = s.startupCommands || '';
    f.notes.value = s.notes || '';

    panes.Advanced = el('div.mpane',
      el('div', { dataset: { only: 'ssh' } },
        field('Jump host (bastion)', select('jumpId', jumpOptions, s.jumpId || ''), 'Connect through another saved SSH session'),
        el('div.field-row', field('Keepalive interval (s)', input('keepalive', { value: s.keepalive ?? '', placeholder: `default ${App.settings.ssh.keepaliveInterval}` }))),
        check('legacyAlgorithms', 'Allow legacy algorithms', '(old Cisco IOS: diffie-hellman-group1, ssh-rsa, aes-cbc)'),
        el('h4', { text: 'Port forwarding', style: { margin: '14px 0 8px', fontSize: '12px', color: 'var(--muted)' } }),
        fwdBox,
        el('button.btn.small', { type: 'button', on: { click: () => addFwd() } }, icon('plus', 12), 'Add forward')),
      el('div', { dataset: { only: 'telnet serial local' } }, el('p.muted', { text: 'No advanced options for this protocol.' })));
    if (s.legacyAlgorithms === undefined && isNew) f.legacyAlgorithms.checked = App.settings.ssh.legacyAlgorithms;
    if (s.autoLogin === undefined) f.autoLogin.checked = true;

    const body = el('div', tabBar, ...Object.values(panes));
    setProto(s.protocol);
    f.username.addEventListener('input', syncCred);
    syncCred();

    const collect = () => {
      const out = { ...s };
      for (const k of ['name', 'host', 'username', 'keyPath', 'shell', 'shellArgs', 'cwd', 'serialPath']) out[k] = f[k].value.trim();
      out.port = Number(f.port.value) || PROTOCOLS[out.protocol].port || '';
      out.folderId = f.folderId.value || null;
      out.useAgent = f.useAgent.checked;
      out.autoLogin = f.autoLogin.checked;
      out.legacyAlgorithms = f.legacyAlgorithms.checked;
      out.baudRate = Number(f.baudRate.value) || 9600;
      out.dataBits = Number(f.dataBits.value);
      out.parity = f.parity.value;
      out.stopBits = Number(f.stopBits.value);
      out.flowControl = f.flowControl.value;
      out.highlight = f.highlight.value;
      out.logging = f.logging.value === 'true';
      out.color = color;
      out.startupCommands = f.startupCommands.value;
      out.notes = f.notes.value;
      out.jumpId = f.jumpId.value || null;
      out.credentialId = credSel.value || null;
      out.keepalive = f.keepalive.value === '' ? undefined : Number(f.keepalive.value);
      out.forwards = [...fwdBox.children].map((r) => r._get()).filter((x) => x.listenPort);
      if (!out.name) out.name = out.protocol === 'serial' ? out.serialPath : out.protocol === 'local' ? (out.shell || 'Local shell') : out.host;
      return out;
    };

    const validate = () => {
      const p = s.protocol;
      if ((p === 'ssh' || p === 'telnet') && !f.host.value.trim()) { toast('Host is required', 'error'); f.host.focus(); return false; }
      if (p === 'serial' && !f.serialPath.value.trim()) { toast('Serial port is required', 'error'); return false; }
      return true;
    };

    const save = async (connect) => {
      const out = collect();
      const idx = App.tree.sessions.findIndex((x) => x.id === out.id);
      if (idx >= 0) App.tree.sessions[idx] = out; else App.tree.sessions.push(out);
      if (App.vault.unlocked) {
        try { await vytty.vault.set(out.id, { ...secret, password: pw.value, passphrase: passphrase.value }); } catch (e) { toast(`Vault: ${e.message}`, 'error'); }
      }
      selected.clear(); selected.add(out.id); anchorId = out.id;
      await App.saveTree();
      if (connect) App.emit('open-session', out);
    };

    const res = await modal({
      title: isNew ? 'New session' : `Edit session: ${s.name}`,
      width: 620,
      className: 'tall',
      body,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', validate },
        { label: isNew ? 'Save & connect' : 'Save & connect', value: 'connect', primary: true, validate },
      ],
    });
    if (res === 'save') await save(false);
    if (res === 'connect') await save(true);
  }

  // ---------------------------------------------------- quick connect
  function parseQuick(str) {
    const s = str.trim();
    if (!s) return null;
    let m;
    if ((m = /^(powershell|pwsh|cmd|wsl|bash|zsh|sh|fish|local)(\.exe)?(?:\s+(.*))?$/i.exec(s))) {
      const shell = m[1].toLowerCase() === 'local' ? '' : `${m[1]}${m[2] || (App.info.platform === 'win32' && !/^(bash|zsh|sh|fish)$/i.test(m[1]) ? '.exe' : '')}`;
      return { protocol: 'local', name: m[1], shell, shellArgs: m[3] || '' };
    }
    if ((m = /^(?:serial\s+)?(COM\d+|\/dev\/\S+)(?:[\s:@,]+(\d+))?$/i.exec(s))) {
      return { protocol: 'serial', name: m[1].toUpperCase(), serialPath: m[1].toUpperCase().startsWith('COM') ? m[1].toUpperCase() : m[1], baudRate: Number(m[2]) || 9600 };
    }
    if ((m = /^telnet\s+(?:([^@\s]+)@)?(\[[^\]]+\]|[^\s:]+)(?::(\d+))?(?:\s+(\d+))?$/i.exec(s))) {
      return { protocol: 'telnet', name: m[2], username: m[1] || '', host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3] || m[4]) || 23 };
    }
    if ((m = /^(?:ssh\s+)?(?:-p\s*(\d+)\s+)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^\s:@]+)(?::(\d+))?(?:\s+(?:-p\s*)?(\d+))?$/i.exec(s))) {
      const host = m[3].replace(/^\[|\]$/g, '');
      return { protocol: 'ssh', name: `${m[2] ? `${m[2]}@` : ''}${host}`, username: m[2] || '', host, port: Number(m[1] || m[4] || m[5]) || 22 };
    }
    return null;
  }

  function initQuickConnect() {
    const qc = $('#qc-input');
    const list = el('datalist#qc-history');
    document.body.append(list);
    qc.setAttribute('list', 'qc-history');
    const refresh = () => list.replaceChildren(...(App.settings.qcHistory || []).map((h) => el('option', { value: h })));
    refresh();
    qc.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { qc.value = ''; qc.blur(); App.emit('focus-terminal'); }
      if (e.key !== 'Enter') return;
      const spec = parseQuick(qc.value);
      if (!spec) { toast('Could not parse. Try user@host, telnet host 23, COM3 9600 or powershell', 'error'); return; }
      const hist = [qc.value.trim(), ...(App.settings.qcHistory || []).filter((h) => h !== qc.value.trim())].slice(0, 25);
      App.settings.qcHistory = hist;
      App.saveSettings();
      refresh();
      qc.value = '';
      App.emit('open-session', { id: null, highlight: 'auto', logging: true, autoLogin: true, ...spec });
    });
  }

  // Save a quick-connect tab as a real session.
  async function saveAsSession(spec) {
    const s = { ...spec, id: uid() };
    delete s.jump;
    App.tree.sessions.push(s);
    await App.saveTree();
    return editSession(s);
  }

  // ------------------------------------------------------------- init
  function initSessionsPanel() {
    const panel = $('#panel-sessions');
    const search = el('input', { type: 'text', placeholder: 'Search sessions', spellcheck: false });
    search.addEventListener('input', () => { filter = search.value.trim(); renderTree(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { search.value = ''; filter = ''; renderTree(); }
      if (e.key === 'Enter') {
        const first = panel.querySelector('.tree-row[data-session]');
        if (first) App.emit('open-session', App.session(first.dataset.session));
      }
    });
    const scroll = el('div.panel-scroll', { tabIndex: 0 });
    panel.append(
      el('div.panel-head',
        el('div.search-box', icon('search', 13), search),
        el('button.icon-btn', { title: 'New session', on: { click: () => editSession() } }, icon('plus')),
        el('button.icon-btn', { title: 'New folder', on: { click: () => newFolder() } }, icon('folderPlus'))),
      scroll);
    dropTarget(scroll, null);
    scroll.addEventListener('contextmenu', (e) => {
      if (e.target !== scroll && !e.target.classList.contains('panel-empty')) return;
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'New session…', icon: 'plus', action: () => editSession() },
        { label: 'New folder…', icon: 'folderPlus', action: () => newFolder() },
      ]);
    });
    scroll.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !filter) {
        e.preventDefault();
        for (const id of visibleSessionIds()) selected.add(id);
        paintSelection();
        return;
      }
      const list = selectedSessions();
      if (!list.length) return;
      if (e.key === 'Delete') { e.preventDefault(); deleteSessions(list); }
      else if (e.key === 'Enter') { e.preventDefault(); list.forEach((s) => App.emit('open-session', s)); }
      else if (e.key === 'F2' && list.length === 1) { e.preventDefault(); renameSession(list[0]); }
      else if (e.key === 'Escape') { selected.clear(); paintSelection(); }
    });
    App.on('tree', () => {
      const alive = new Set(App.tree.sessions.map((s) => s.id));
      for (const id of [...selected]) if (!alive.has(id)) selected.delete(id);
      renderTree();
    });
    App.on('new-session', () => editSession());
    App.on('edit-session', (s) => editSession(s));
    App.on('focus-session-search', () => { App.emit('show-panel', 'sessions'); search.focus(); search.select(); });
    renderTree();
    initQuickConnect();
  }

  App.Sessions = { init: initSessionsPanel, edit: editSession, parseQuick, saveAsSession, subtitle, PROTOCOLS };
})();
