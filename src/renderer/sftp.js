'use strict';
// SFTP browser in the sidebar, bound to the active SSH tab.
// Directory listings are cached per tab, so switching folders or tabs shows
// the last known content instantly while a fresh listing loads in the
// background. Hovering a folder prefetches it. Files can be dragged out to
// Explorer (downloaded to a temp folder first) and dropped in from the OS.
(() => {
  const { el, $, icon, confirmBox, inputBox, contextMenu, toast, fmtSize, fmtDate } = UI;

  const CACHE_FRESH_MS = 4000; // a listing younger than this is not re-fetched on navigation
  let listEl;
  let pathInput;
  let refreshBtn;
  let tab = null; // tab currently shown in the panel
  const inflight = new Map(); // `${connId}|${path}` -> Promise<entries>

  const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
  const parent = (dir) => {
    if (!dir || dir === '/') return '/';
    const p = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    return p || '/';
  };
  const usable = (t) => t && t.source.protocol === 'ssh' && t.state === 'connected' && t.connId;
  const stateOf = (t) => {
    if (!t.sftp) t.sftp = { cwd: null, cache: new Map(), selected: new Set(), anchor: null, shown: [] };
    return t.sftp;
  };
  const isVisible = () => $('#panel-sftp').classList.contains('active');

  // ------------------------------------------------------------ loading
  function fetchDir(t, dir) {
    const key = `${t.connId}|${dir}`;
    if (inflight.has(key)) return inflight.get(key);
    const p = vytty.sftp.op(t.connId, 'list', { path: dir })
      .then((entries) => {
        stateOf(t).cache.set(dir, { entries, ts: Date.now() });
        return entries;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function setBusy(on) {
    if (refreshBtn) refreshBtn.classList.toggle('spin', on);
  }

  // Navigate to `dir` (or the tab's current dir). Cached content is shown
  // immediately; the network result replaces it when it arrives.
  async function open(dir, { force = false } = {}) {
    const t = App.active;
    if (!usable(t)) { tab = t; render(); return; }
    tab = t;
    const st = stateOf(t);
    try {
      if (!dir) dir = st.cwd || await vytty.sftp.op(t.connId, 'realpath', { path: '.' });
    } catch (e) { toast(`SFTP: ${e.message}`, 'error'); return; }
    if (st.cwd !== dir) { st.selected.clear(); st.anchor = null; }
    st.cwd = dir;
    const cached = st.cache.get(dir);
    render();
    if (cached && !force && Date.now() - cached.ts < CACHE_FRESH_MS) return;
    setBusy(true);
    try {
      await fetchDir(t, dir);
      if (tab === t && st.cwd === dir) render();
    } catch (e) {
      if (tab === t && st.cwd === dir) {
        toast(`SFTP: ${e.message}`, 'error');
        if (!cached && dir !== '/') { st.cwd = parent(dir); open(st.cwd); }
      }
    } finally {
      setBusy(false);
    }
  }

  function prefetch(dir) {
    const t = tab;
    if (!usable(t) || stateOf(t).cache.has(dir)) return;
    fetchDir(t, dir).catch(() => {});
  }

  const invalidate = (t, dir) => { if (t && t.sftp) t.sftp.cache.delete(dir); };

  // ------------------------------------------------------------ render
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
    const st = stateOf(t);
    pathInput.disabled = false;
    if (document.activeElement !== pathInput) pathInput.value = st.cwd || '';
    const cached = st.cache.get(st.cwd);
    if (!cached) { st.shown = []; listEl.replaceChildren(el('div.panel-empty', { text: 'Loading…' })); return; }
    st.shown = cached.entries;

    const frag = document.createDocumentFragment();
    if (st.cwd !== '/') {
      frag.append(el('div.file-row.dir.up', { dataset: { up: '1' }, title: 'Parent directory (Backspace)' }, icon('folder', 14), el('span.name', { text: '..' })));
    }
    for (const e of cached.entries) {
      const row = el(`div.file-row${e.isDir ? '.dir' : ''}${st.selected.has(e.name) ? '.selected' : ''}`, {
        draggable: true,
        dataset: { name: e.name },
        title: `${e.name}\n${e.isDir ? 'Directory' : fmtSize(e.size)} · ${fmtDate(e.mtime)} · ${(e.mode & 0o7777).toString(8)}`,
      }, icon(e.isDir ? 'folder' : e.isLink ? 'link' : 'file', 14), el('span.name', { text: e.name }), el('span.size', { text: e.isDir ? '' : fmtSize(e.size) }));
      frag.append(row);
    }
    if (!cached.entries.length) frag.append(el('div.panel-empty', { text: 'Empty directory - drop files here to upload' }));
    listEl.replaceChildren(frag);
  }

  // Toggle selection classes without rebuilding the list.
  function paintSelection() {
    const st = tab && tab.sftp;
    if (!st) return;
    for (const row of listEl.querySelectorAll('.file-row[data-name]')) row.classList.toggle('selected', st.selected.has(row.dataset.name));
  }

  // Entries currently on screen (independent of cache invalidation).
  const entriesOf = (t) => (t.sftp ? t.sftp.shown : []);
  const entryByName = (t, name) => entriesOf(t).find((e) => e.name === name);
  const selectedEntries = (t) => entriesOf(t).filter((e) => t.sftp.selected.has(e.name));
  const itemsFor = (t, entries) => entries.map((e) => ({ path: join(t.sftp.cwd, e.name), isDir: e.isDir, size: e.size, mtime: e.mtime }));

  function select(name, e) {
    const st = stateOf(tab);
    const names = entriesOf(tab).map((x) => x.name);
    if (e && e.shiftKey && st.anchor) {
      const [a, b] = [names.indexOf(st.anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (!e.ctrlKey) st.selected.clear();
      names.slice(a, b + 1).forEach((n) => st.selected.add(n));
    } else if (e && (e.ctrlKey || e.metaKey)) {
      if (st.selected.has(name)) st.selected.delete(name); else st.selected.add(name);
      st.anchor = name;
    } else {
      st.selected.clear();
      st.selected.add(name);
      st.anchor = name;
    }
    paintSelection();
  }

  // --------------------------------------------------------- transfers
  async function download(entries) {
    const t = tab;
    try {
      if (entries.length === 1 && !entries[0].isDir) {
        const saved = await vytty.sftp.download(t.connId, join(t.sftp.cwd, entries[0].name), entries[0].name);
        if (saved) toast(`Downloaded ${entries[0].name}`, 'ok');
      } else {
        const dir = await vytty.sftp.downloadTo(t.connId, itemsFor(t, entries));
        if (dir) toast(`Downloaded ${entries.length} item${entries.length > 1 ? 's' : ''} to ${dir}`, 'ok');
      }
    } catch (err) { toast(`Download failed: ${err.message}`, 'error'); }
    App.setTransfer(null);
  }

  async function upload(locals, t = tab, remoteDir) {
    if (!usable(t)) { toast('SFTP needs a connected SSH tab', 'error'); return; }
    if (!locals.length) return;
    const st = stateOf(t);
    if (!st.cwd) st.cwd = await vytty.sftp.op(t.connId, 'realpath', { path: '.' });
    const target = remoteDir || st.cwd;
    try {
      const n = await vytty.sftp.op(t.connId, 'uploadPaths', { locals, remoteDir: target });
      toast(`Uploaded ${n} file${n === 1 ? '' : 's'} → ${target}`, 'ok');
    } catch (err) { toast(`Upload failed: ${err.message}`, 'error'); }
    App.setTransfer(null);
    invalidate(t, target);
    if (t === App.active && isVisible()) open(st.cwd, { force: true });
  }

  async function removeEntries(entries) {
    const t = tab;
    const dirs = entries.filter((e) => e.isDir).length;
    const what = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
    if (!(await confirmBox('Delete', `Delete ${what}?${dirs ? '\nFolders are deleted with everything inside.' : ''}`, { okLabel: 'Delete', danger: true }))) return;
    try { await vytty.sftp.op(t.connId, 'remove', { items: itemsFor(t, entries) }); } catch (err) { toast(err.message, 'error'); }
    open(t.sftp.cwd, { force: true });
  }

  async function mkdir() {
    if (!usable(tab)) return;
    const r = await inputBox('New folder', 'Name');
    if (!r || !r.value.trim()) return;
    try { await vytty.sftp.op(tab.connId, 'mkdir', { path: join(tab.sftp.cwd, r.value.trim()) }); } catch (err) { toast(err.message, 'error'); }
    open(tab.sftp.cwd, { force: true });
  }

  async function rename(e) {
    const r = await inputBox('Rename', 'New name', { value: e.name });
    if (!r || !r.value.trim() || r.value === e.name) return;
    try { await vytty.sftp.op(tab.connId, 'rename', { from: join(tab.sftp.cwd, e.name), to: join(tab.sftp.cwd, r.value.trim()) }); } catch (err) { toast(err.message, 'error'); }
    open(tab.sftp.cwd, { force: true });
  }

  async function activate(e) {
    const p = join(tab.sftp.cwd, e.name);
    if (e.isDir) return open(p);
    if (e.isLink) {
      try {
        const st = await vytty.sftp.op(tab.connId, 'stat', { path: p });
        if (st.isDir) return open(p);
      } catch (err) { toast(err.message, 'error'); return; }
    }
    return download([e]);
  }

  function rowMenu(x, y, e) {
    const t = tab;
    const sel = e ? selectedEntries(t) : [];
    const many = sel.length > 1;
    const p = e ? join(t.sftp.cwd, e.name) : t.sftp.cwd;
    contextMenu(x, y, [
      e && !many && e.isDir ? { label: 'Open', icon: 'folderOpen', action: () => open(p) } : null,
      e ? { label: many ? `Download ${sel.length} items…` : 'Download…', icon: 'download', action: () => download(many ? sel : [e]) } : null,
      e && !many && !e.isDir ? { label: 'Download to folder…', action: async () => {
        try { const d = await vytty.sftp.downloadTo(t.connId, itemsFor(t, [e])); if (d) toast(`Downloaded ${e.name} to ${d}`, 'ok'); } catch (err) { toast(err.message, 'error'); }
        App.setTransfer(null);
      } } : null,
      e ? '-' : null,
      { label: 'Upload files…', icon: 'upload', action: async () => upload(await vytty.sftp.pickUpload(false), t, e && e.isDir && !many ? p : undefined) },
      { label: 'Upload folder…', icon: 'folderPlus', action: async () => upload(await vytty.sftp.pickUpload(true), t, e && e.isDir && !many ? p : undefined) },
      { label: 'New folder…', icon: 'folderPlus', action: mkdir },
      { label: 'Refresh', icon: 'refresh', action: () => open(t.sftp.cwd, { force: true }) },
      '-',
      { label: 'Copy path', icon: 'copy', action: () => vytty.clipboard.write(many ? sel.map((x) => join(t.sftp.cwd, x.name)).join('\n') : p) },
      { label: 'cd here in terminal', icon: 'terminal', action: () => { t.send(`cd '${(e && e.isDir ? p : t.sftp.cwd).replace(/'/g, "'\\''")}'\r`); t.focus(); } },
      e && !many ? { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => rename(e) } : null,
      e ? { label: many ? `Delete ${sel.length} items` : 'Delete', icon: 'trash', danger: true, shortcut: 'Del', action: () => removeEntries(many ? sel : [e]) } : null,
    ]);
  }

  // ------------------------------------------------------------- events
  function bindList() {
    const rowOf = (ev) => ev.target.closest('.file-row');

    listEl.addEventListener('click', (ev) => {
      const row = rowOf(ev);
      if (!row || row.dataset.up) return;
      select(row.dataset.name, ev);
    });
    listEl.addEventListener('dblclick', (ev) => {
      const row = rowOf(ev);
      if (!row) return;
      if (row.dataset.up) { open(parent(tab.sftp.cwd)); return; }
      const e = entryByName(tab, row.dataset.name);
      if (e) activate(e);
    });
    listEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!usable(tab)) return;
      const row = rowOf(ev);
      const e = row && !row.dataset.up ? entryByName(tab, row.dataset.name) : null;
      if (e && !tab.sftp.selected.has(e.name)) select(e.name);
      rowMenu(ev.clientX, ev.clientY, e);
    });
    // Prefetch folders the pointer rests on, so opening them is instant.
    let hoverTimer = null;
    listEl.addEventListener('mouseover', (ev) => {
      const row = rowOf(ev);
      clearTimeout(hoverTimer);
      if (!row || !tab || !tab.sftp) return;
      const dir = row.dataset.up ? parent(tab.sftp.cwd) : (row.classList.contains('dir') ? join(tab.sftp.cwd, row.dataset.name) : null);
      if (dir) hoverTimer = setTimeout(() => prefetch(dir), 120);
    });

    // Drag out to Explorer / desktop. Fetching starts on mousedown so the file
    // is usually ready by the time the drag begins.
    const dragItems = (row) => {
      const st = tab.sftp;
      const names = st.selected.has(row.dataset.name) ? [...st.selected] : [row.dataset.name];
      return itemsFor(tab, names.map((n) => entryByName(tab, n)).filter(Boolean));
    };
    listEl.addEventListener('mousedown', (ev) => {
      const row = rowOf(ev);
      if (ev.button !== 0 || !row || row.dataset.up || !usable(tab)) return;
      const items = dragItems(row);
      if (items.length && items.every((i) => !i.isDir && i.size < 64 * 1024 * 1024)) vytty.sftp.prepareDrag(tab.connId, items).catch(() => {});
    });
    // Two drag modes:
    //  - small files already fetched on mousedown are dragged as real files,
    //    so they can be dropped into any app (mail, chat, editor...);
    //  - big files and folders are dragged as placeholders: drop them on the
    //    desktop or an Explorer folder and the download runs there in the
    //    background (progress in the status bar).
    // The native drag may only start while the button is still held.
    let buttonDown = false;
    window.addEventListener('mousedown', (ev) => { if (ev.button === 0) buttonDown = true; }, true);
    window.addEventListener('mouseup', (ev) => { if (ev.button === 0) buttonDown = false; }, true);
    const SMALL = 64 * 1024 * 1024;
    listEl.addEventListener('dragstart', async (ev) => {
      ev.preventDefault();
      const row = rowOf(ev);
      if (!row || row.dataset.up || !usable(tab)) return;
      const t = tab;
      const items = dragItems(row);
      if (!items.length) return;
      const small = items.every((i) => !i.isDir && i.size < SMALL);
      if (small) {
        // Use the real files if they are ready in a moment, else fall back to deferred.
        const prep = vytty.sftp.prepareDrag(t.connId, items).then(() => true, () => false);
        const ready = await Promise.race([prep, new Promise((r) => setTimeout(() => r(false), 400))]);
        App.setTransfer(null);
        if (!buttonDown) return;
        vytty.sftp.startDrag(t.connId, items, !ready);
      } else {
        vytty.sftp.startDrag(t.connId, items, true);
      }
    });

    vytty.sftp.onDragResult(async (r) => {
      const where = r.dest ? r.dest.replace(/^.*[\\/](Desktop|Pulpit)$/i, 'Desktop') : '';
      if (r.started) { toast(`Downloading ${r.count > 1 ? `${r.count} items` : 'file'} to ${where}…`, 'info', 2500); return; }
      App.setTransfer(null);
      if (r.ok) { toast(`Downloaded to ${r.dest}`, 'ok', 4000); return; }
      if (r.error) { toast(`Download failed: ${r.error}`, 'error', 5000); return; }
      if (r.unknown) {
        // Dropped somewhere we can't see (another app, a network folder...).
        const pick = await confirmBox('Where to save?', 'Vytty could not tell where the file was dropped. Choose a folder to download it to?', { okLabel: 'Choose folder…' });
        if (!pick || !usable(tab)) return;
        try {
          const dir = await vytty.sftp.downloadTo(tab.connId, r.items);
          if (dir) toast(`Downloaded to ${dir}`, 'ok');
        } catch (err) { toast(`Download failed: ${err.message}`, 'error'); }
        App.setTransfer(null);
      }
    });

    // Drop from the OS: onto a folder row -> into that folder, elsewhere -> current folder.
    const panel = $('#panel-sftp');
    let dropRow = null;
    const clearDrop = () => { if (dropRow) dropRow.classList.remove('drop-target'); dropRow = null; };
    panel.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer.types.includes('Files') || !usable(App.active)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      panel.classList.add('drop-hover');
      const row = rowOf(ev);
      const target = row && row.classList.contains('dir') && !row.dataset.up ? row : null;
      if (target !== dropRow) { clearDrop(); dropRow = target; if (dropRow) dropRow.classList.add('drop-target'); }
    });
    panel.addEventListener('dragleave', (ev) => {
      if (!panel.contains(ev.relatedTarget)) { panel.classList.remove('drop-hover'); clearDrop(); }
    });
    panel.addEventListener('drop', (ev) => {
      panel.classList.remove('drop-hover');
      const target = dropRow ? join(tab.sftp.cwd, dropRow.dataset.name) : undefined;
      clearDrop();
      if (!ev.dataTransfer.files.length) return;
      ev.preventDefault();
      const locals = [...ev.dataTransfer.files].map((f) => vytty.pathForFile(f)).filter(Boolean);
      // Ignore drops of our own temp files (a drag that started in this panel).
      if (locals.every((l) => /[\\/]vytty-drag[\\/]/.test(l))) return;
      upload(locals, App.active, target);
    });

    // Keyboard
    listEl.tabIndex = 0;
    listEl.addEventListener('keydown', (ev) => {
      if (!usable(tab)) return;
      const sel = selectedEntries(tab);
      if (ev.key === 'Enter' && sel.length === 1) activate(sel[0]);
      else if (ev.key === 'Backspace') open(parent(tab.sftp.cwd));
      else if (ev.key === 'Delete' && sel.length) removeEntries(sel);
      else if (ev.key === 'F2' && sel.length === 1) rename(sel[0]);
      else if (ev.key === 'F5') open(tab.sftp.cwd, { force: true });
      else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
        entriesOf(tab).forEach((e) => tab.sftp.selected.add(e.name));
        paintSelection();
      } else return;
      ev.preventDefault();
    });
  }

  function init() {
    const panel = $('#panel-sftp');
    pathInput = el('input', { type: 'text', spellcheck: false, placeholder: '/path' });
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { open(pathInput.value.trim() || '/', { force: true }); listEl.focus(); }
      if (e.key === 'Escape') { pathInput.value = (tab && tab.sftp && tab.sftp.cwd) || ''; listEl.focus(); }
    });
    const b = (ic, title, fn) => el('button.icon-btn', { title, on: { click: fn } }, icon(ic, 15));
    refreshBtn = b('refresh', 'Refresh (F5)', () => tab && tab.sftp && open(tab.sftp.cwd, { force: true }));
    listEl = el('div.panel-scroll.sftp-list');
    panel.append(
      el('div.panel-head',
        b('up', 'Parent directory (Backspace)', () => tab && tab.sftp && open(parent(tab.sftp.cwd))),
        b('home', 'Home directory', () => { if (usable(App.active)) { stateOf(App.active).cwd = null; open(); } }),
        refreshBtn,
        el('span', { style: { flex: 1 } }),
        b('upload', 'Upload files…', async () => upload(await vytty.sftp.pickUpload(false))),
        b('folderPlus', 'New folder', mkdir)),
      el('div.sftp-path', pathInput),
      listEl,
      el('div.sftp-hint', { text: 'Drag files in to upload, drag out to download' }));
    bindList();

    vytty.sftp.onProgress((_id, p) => App.setTransfer(p));
    vytty.sftp.onError((msg) => toast(`SFTP: ${msg}`, 'error'));

    // Only react to real transitions, not every tab status update.
    const lastState = new WeakMap();
    App.on('tab-changed', () => { if (isVisible()) open(); });
    App.on('tab-state', (t) => {
      const prev = lastState.get(t);
      lastState.set(t, t.state);
      if (prev === t.state) return;
      if (t.state !== 'connected' && t.sftp) { t.sftp.cache.clear(); }
      if (t === App.active && isVisible()) open();
    });
    App.on('panel-shown', (name) => { if (name === 'sftp') open(); });
    App.on('sftp-upload', (t, files) => upload(files, t));
    render();
  }

  App.Sftp = { init };
})();
