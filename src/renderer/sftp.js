'use strict';
// SFTP browser in the sidebar, bound to the active SSH tab.
(() => {
  const { el, $, icon, confirmBox, inputBox, contextMenu, toast, fmtSize, fmtDate } = UI;

  let tab = null;
  let entries = [];
  let selected = null;
  let loading = false;
  let pathInput;
  let listEl;

  const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
  const parent = (dir) => {
    if (!dir || dir === '/') return '/';
    const p = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    return p || '/';
  };
  const usable = (t) => t && t.source.protocol === 'ssh' && t.state === 'connected' && t.connId;

  async function load(dir) {
    const t = App.active;
    if (!usable(t)) { tab = null; render(); return; }
    tab = t;
    loading = true;
    render();
    try {
      if (!dir) dir = t.sftpCwd || await vytty.sftp.op(t.connId, 'realpath', { path: '.' });
      entries = await vytty.sftp.op(t.connId, 'list', { path: dir });
      t.sftpCwd = dir;
      selected = null;
    } catch (e) {
      toast(`SFTP: ${e.message}`, 'error');
      entries = entries || [];
    }
    loading = false;
    render();
  }

  function render() {
    if (!listEl) return;
    const t = App.active;
    if (!usable(t)) {
      pathInput.value = '';
      pathInput.disabled = true;
      listEl.replaceChildren(el('div.panel-empty', t && t.source.protocol === 'ssh'
        ? 'Waiting for the SSH connection…'
        : 'Open an SSH session to browse its files here.'));
      return;
    }
    pathInput.disabled = false;
    pathInput.value = t.sftpCwd || '';
    if (loading && !entries.length) { listEl.replaceChildren(el('div.panel-empty', { text: 'Loading…' })); return; }
    const rows = [];
    if (t.sftpCwd && t.sftpCwd !== '/') rows.push(el('div.file-row.dir', { on: { dblclick: () => load(parent(t.sftpCwd)) } }, icon('folder', 14), el('span.name', { text: '..' })));
    for (const e of entries) {
      const row = el(`div.file-row${e.isDir ? '.dir' : ''}${selected === e.name ? '.selected' : ''}`, {
        title: `${e.name}\n${e.isDir ? 'Directory' : fmtSize(e.size)} · ${fmtDate(e.mtime)} · ${(e.mode & 0o7777).toString(8)}`,
        draggable: false,
        on: {
          click: () => { selected = e.name; render(); },
          dblclick: () => (e.isDir || e.isLink ? openEntry(e) : download(e)),
          contextmenu: (ev) => { ev.preventDefault(); selected = e.name; render(); entryMenu(ev.clientX, ev.clientY, e); },
        },
      }, icon(e.isDir ? 'folder' : e.isLink ? 'link' : 'file', 14), el('span.name', { text: e.name }), el('span.size', { text: e.isDir ? '' : fmtSize(e.size) }));
      rows.push(row);
    }
    if (!entries.length) rows.push(el('div.panel-empty', { text: 'Empty directory' }));
    listEl.replaceChildren(...rows);
  }

  async function openEntry(e) {
    const p = join(tab.sftpCwd, e.name);
    if (e.isLink) {
      try {
        const st = await vytty.sftp.op(tab.connId, 'stat', { path: p });
        if (!st.isDir) return download(e);
      } catch (err) { toast(err.message, 'error'); return; }
    }
    load(p);
  }

  async function download(e) {
    try {
      const saved = await vytty.sftp.download(tab.connId, join(tab.sftpCwd, e.name), e.name);
      if (saved) toast(`Downloaded ${e.name}`, 'ok');
    } catch (err) { toast(`Download failed: ${err.message}`, 'error'); }
    App.setTransfer(null);
  }

  async function upload(files, t = tab) {
    if (!usable(t)) { toast('SFTP needs a connected SSH tab', 'error'); return; }
    if (!t.sftpCwd) t.sftpCwd = await vytty.sftp.op(t.connId, 'realpath', { path: '.' });
    for (const local of files) {
      const name = local.split(/[\\/]/).pop();
      try {
        await vytty.sftp.op(t.connId, 'upload', { local, remote: join(t.sftpCwd, name) });
        toast(`Uploaded ${name} → ${t.sftpCwd}`, 'ok');
      } catch (err) { toast(`Upload of ${name} failed: ${err.message}`, 'error'); }
    }
    App.setTransfer(null);
    if (t === App.active) load(t.sftpCwd);
  }

  function entryMenu(x, y, e) {
    const p = join(tab.sftpCwd, e.name);
    contextMenu(x, y, [
      e.isDir ? { label: 'Open', icon: 'folderOpen', action: () => openEntry(e) } : { label: 'Download…', icon: 'download', action: () => download(e) },
      { label: 'Copy path', icon: 'copy', action: () => vytty.clipboard.write(p) },
      { label: 'cd here in terminal', icon: 'terminal', action: () => { tab.send(`cd '${(e.isDir ? p : tab.sftpCwd).replace(/'/g, "'\\''")}'\r`); tab.focus(); } },
      '-',
      { label: 'Rename…', icon: 'edit', action: async () => {
        const r = await inputBox('Rename', 'New name', { value: e.name });
        if (!r || !r.value.trim() || r.value === e.name) return;
        try { await vytty.sftp.op(tab.connId, 'rename', { from: p, to: join(tab.sftpCwd, r.value.trim()) }); load(tab.sftpCwd); } catch (err) { toast(err.message, 'error'); }
      } },
      { label: 'Delete', icon: 'trash', danger: true, action: async () => {
        if (!(await confirmBox('Delete', `Delete ${e.isDir ? 'directory' : 'file'} "${e.name}"?${e.isDir ? '\nThe directory must be empty.' : ''}`, { okLabel: 'Delete', danger: true }))) return;
        try { await vytty.sftp.op(tab.connId, e.isDir ? 'rmdir' : 'unlink', { path: p }); load(tab.sftpCwd); } catch (err) { toast(err.message, 'error'); }
      } },
    ]);
  }

  function init() {
    const panel = $('#panel-sftp');
    pathInput = el('input', { type: 'text', spellcheck: false, placeholder: '/path' });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathInput.value.trim() || '/'); });
    const b = (ic, title, fn) => el('button.icon-btn', { title, on: { click: fn } }, icon(ic, 15));
    listEl = el('div.panel-scroll');
    panel.append(
      el('div.panel-head',
        b('up', 'Parent directory', () => tab && load(parent(tab.sftpCwd))),
        b('home', 'Home directory', () => { if (tab) { tab.sftpCwd = null; load(); } }),
        b('refresh', 'Refresh', () => tab && load(tab.sftpCwd)),
        el('span', { style: { flex: 1 } }),
        b('upload', 'Upload files…', async () => { const files = await vytty.sftp.pickUpload(); if (files.length) upload(files); }),
        b('folderPlus', 'New directory', async () => {
          if (!tab) return;
          const r = await inputBox('New directory', 'Name');
          if (!r || !r.value.trim()) return;
          try { await vytty.sftp.op(tab.connId, 'mkdir', { path: join(tab.sftpCwd, r.value.trim()) }); load(tab.sftpCwd); } catch (err) { toast(err.message, 'error'); }
        })),
      el('div.sftp-path', pathInput),
      listEl);

    panel.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files') && usable(App.active)) { e.preventDefault(); panel.classList.add('drop-hover'); } });
    panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop-hover'); });
    panel.addEventListener('drop', (e) => {
      panel.classList.remove('drop-hover');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      upload([...e.dataTransfer.files].map((f) => vytty.pathForFile(f)).filter(Boolean), App.active);
    });

    vytty.sftp.onProgress((_id, p) => App.setTransfer(p));
    const isVisible = () => panel.classList.contains('active');
    App.on('tab-changed', () => { entries = []; if (isVisible()) load(App.active && App.active.sftpCwd); else render(); });
    App.on('tab-state', (t) => { if (t === App.active && isVisible() && (t.state === 'connected' ? tab !== t || !entries.length : true)) load(t.sftpCwd); });
    App.on('panel-shown', (name) => { if (name === 'sftp') load(App.active && App.active.sftpCwd); });
    App.on('sftp-upload', (t, files) => upload(files, t));
    render();
  }

  App.Sftp = { init };
})();
