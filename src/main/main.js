'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, nativeImage, net, session } = require('electron');
const { paths, ensureDirs, portableExe } = require('./paths');

// --smoke-test: CI starts the packaged build with a throw-away data folder
// (see paths.js), waits for the UI to come up and exits with 0, or non-zero.
const SMOKE = process.argv.includes('--smoke-test');

ensureDirs();
// Fully portable: keep Chromium's profile inside the data folder too.
app.setPath('userData', paths.chromium);
app.setPath('sessionData', paths.chromium);

const { store } = require('./store');
const { vault } = require('./vault');
const logger = require('./logger');
const { ConnectionManager, capabilities } = require('./connections');
const { FORMATS: IMPORT_FORMATS, parseImport } = require('./importers');
const { EXPORTERS } = require('./exporters');
const netbox = require('./integrations/netbox');
const tools = require('./tools');
const urlhandler = require('./urlhandler');
const dragout = require('./dragout');
const updater = require('./updater');

let win = null;
let settings = store.getSettings();
logger.configure(settings.logging);

// ------------------------------------------------------ renderer prompts
// The main process asks the UI (host key confirmation, passwords...) and waits.
let promptSeq = 0;
const pendingPrompts = new Map();
function prompt(kind, payload) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  const reqId = ++promptSeq;
  return new Promise((resolve) => {
    pendingPrompts.set(reqId, resolve);
    win.webContents.send('prompt', reqId, kind, payload);
  });
}
ipcMain.on('prompt:reply', (_e, reqId, answer) => {
  const resolve = pendingPrompts.get(reqId);
  if (resolve) { pendingPrompts.delete(reqId); resolve(answer); }
});

const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

const connections = new ConnectionManager({ send, prompt, getSettings: () => settings, vault, store });

// ------------------------------------------------------- ssh:// links
// Links arrive on the command line, either at start or in a second instance;
// they are handed to the UI once it is ready.
let rendererReady = false;
let pendingUrls = urlhandler.urlsFromArgv(process.argv);
function openUrls(list) {
  if (!list.length) return;
  if (rendererReady) send('app:open-url', list);
  else pendingUrls = pendingUrls.concat(list);
}

function urlHandlerTarget() {
  // The portable launcher path survives updates of the unpacked app.
  return portableExe() || process.execPath;
}
function setUrlHandler(on) {
  if (!app.isPackaged) throw new Error('Link handling is available in the release builds only');
  const exe = urlHandlerTarget();
  const results = urlhandler.PROTOCOLS.map((p) => {
    if (on) return app.setAsDefaultProtocolClient(p, exe, []);
    if (app.isDefaultProtocolClient(p, exe, [])) return app.removeAsDefaultProtocolClient(p, exe, []);
    return true;
  });
  if (on && results.some((r) => !r)) throw new Error('Windows did not accept the link registration');
  return urlHandlerStatus();
}
function urlHandlerStatus() {
  if (!app.isPackaged) return { available: false, registered: false };
  const exe = urlHandlerTarget();
  return { available: process.platform === 'win32', registered: urlhandler.PROTOCOLS.every((p) => app.isDefaultProtocolClient(p, exe, [])), exe };
}

// ----------------------------------------------------------------- window

function harden() {
  // The UI needs no web permissions (camera, notifications, geolocation...).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.on('will-navigate', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    backgroundColor: '#16171a',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    send('app:close-request');
  });
  ipcMain.removeAllListeners('win:forceClose');
  ipcMain.on('win:forceClose', () => { allowClose = true; win.close(); });
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  if (SMOKE) {
    const fail = (code, why) => { process.stderr.write(`SMOKE FAIL: ${why}\n`); app.exit(code); };
    win.webContents.on('render-process-gone', (_e, d) => fail(4, `renderer gone (${d.reason})`));
    win.webContents.on('did-fail-load', (_e, code, desc) => fail(5, `load failed ${code} ${desc}`));
    win.webContents.on('console-message', (ev) => {
      const level = ev.level !== undefined ? ev.level : '';
      if (level === 'error' || level === 3) process.stderr.write(`renderer: ${ev.message}\n`);
    });
    setTimeout(() => fail(3, 'timed out waiting for the UI'), 60000).unref();
  }
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    openUrls(urlhandler.urlsFromArgv(argv));
  });
  app.whenReady().then(() => {
    harden();
    createWindow();
    // Keep the link registration pointing at the current executable.
    if (settings.integrations && settings.integrations.urlHandler && !SMOKE) { try { setUrlHandler(true); } catch { /* ignore */ } }
  });
}

app.on('window-all-closed', () => {
  connections.closeAll();
  ConnectionManager.cleanupDragTemp();
  app.quit();
});

// -------------------------------------------------------------------- IPC

const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// The UI is up: deliver queued links, then tidy up after an update.
ipcMain.on('app:ready', () => {
  if (SMOKE) {
    process.stdout.write(`SMOKE OK ${app.getVersion()} ${updater.installMode() || 'dev'}\n`);
    try { fs.rmSync(paths.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(0);
    return;
  }
  if (rendererReady) return;
  rendererReady = true;
  const queued = pendingUrls;
  pendingUrls = [];
  openUrls(queued);
  setTimeout(() => updater.cleanup(), 8000);
});

handle('app:info', () => ({
  version: app.getVersion(),
  dataDir: paths.dataDir,
  logDir: logger.logDir(),
  platform: process.platform,
  capabilities,
  install: updater.info(),
  systemDark: nativeTheme.shouldUseDarkColors,
  electron: process.versions.electron,
}));

handle('settings:get', () => settings);
handle('settings:save', (next) => {
  settings = store.saveSettings(next);
  logger.configure(settings.logging);
  return settings;
});

handle('sessions:get', () => store.getSessions());
handle('sessions:save', (tree) => store.saveSessions(tree));

handle('vault:status', () => vault.status());
handle('vault:create', (password) => vault.create(password));
handle('vault:unlock', (password) => vault.unlock(password));
handle('vault:lock', () => vault.lock());
handle('vault:reset', () => vault.reset());
handle('vault:get', (id) => vault.get(id));
handle('vault:set', (id, secret) => vault.set(id, secret));
handle('vault:remove', (id) => vault.remove(id));
handle('vault:change', (oldPw, newPw) => vault.changeMaster(oldPw, newPw));

handle('conn:open', (id, spec) => { connections.open(id, spec); return true; });
ipcMain.on('conn:write', (_e, id, data) => connections.write(id, data));
ipcMain.on('conn:resize', (_e, id, cols, rows) => connections.resize(id, cols, rows));
handle('conn:close', (id) => connections.close(id));
handle('serial:list', () => ConnectionManager.listSerialPorts());

handle('sftp', (id, op, args) => connections.sftpOp(id, op, args));
handle('sftp:download', async (id, remote, suggestedName) => {
  const res = await dialog.showSaveDialog(win, { defaultPath: suggestedName });
  if (res.canceled || !res.filePath) return null;
  await connections.sftpOp(id, 'download', { remote, local: res.filePath });
  return res.filePath;
});
handle('sftp:uploadPick', async (folders) => {
  const res = await dialog.showOpenDialog(win, { properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections'] });
  return res.canceled ? [] : res.filePaths;
});
// Download files/folders into a folder picked by the user.
handle('sftp:downloadTo', async (id, items) => {
  const res = await dialog.showOpenDialog(win, { title: 'Download to…', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  await connections.sftpOp(id, 'downloadPaths', { items, localDir: res.filePaths[0] });
  return res.filePaths[0];
});

// Drag out of the SFTP panel: the renderer starts fetching on mousedown
// (prepare) and asks for the native drag on dragstart.
let dragIcon = null;
const getDragIcon = () => {
  if (!dragIcon) {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
    dragIcon = img.isEmpty() ? img : img.resize({ width: 32, height: 32 });
  }
  return dragIcon;
};
handle('sftp:prepareDrag', async (id, items) => { await connections.prepareDrag(id, items); return true; });
// deferred = false: drag the already downloaded temp copies (small files).
// deferred = true: drag empty placeholders, find where they were dropped and
// download the real content there, with progress in the status bar.
ipcMain.on('sftp:startDrag', async (e, id, items, deferred) => {
  if (!deferred) {
    try {
      const files = await connections.prepareDrag(id, items);
      e.sender.startDrag({ file: files[0], files, icon: getDragIcon() });
    } catch (err) {
      send('sftp:error', err.message);
    }
    return;
  }
  let ph;
  try {
    ph = dragout.makePlaceholders(items);
  } catch (err) {
    send('sftp:error', err.message);
    return;
  }
  const since = Date.now();
  // Watch the user's folders before the drag starts, so the drop is seen.
  const watch = dragout.watchDrop(items[0], since);
  e.sender.startDrag({ file: ph.files[0], files: ph.files, icon: getDragIcon() });
  const dest = await watch.result();
  try { fs.rmSync(ph.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!dest) {
    send('sftp:dragResult', { ok: false, unknown: true, items, id });
    return;
  }
  send('sftp:dragResult', { started: true, dest, count: items.length, id });
  try {
    await connections.sftpOp(id, 'downloadPaths', { items, localDir: dest });
    send('sftp:dragResult', { ok: true, dest, count: items.length, id });
  } catch (err) {
    send('sftp:dragResult', { ok: false, dest, error: err.message, id });
  }
});

handle('clipboard:read', () => clipboard.readText());
handle('clipboard:write', (text) => clipboard.writeText(String(text)));

handle('dialog:openFile', async (opts) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], ...(opts || {}) });
  return res.canceled ? null : res.filePaths[0];
});
handle('dialog:openDir', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

handle('logs:open', () => {
  logger.flush();
  fs.mkdirSync(logger.logDir(), { recursive: true });
  return shell.openPath(logger.logDir());
});
handle('logs:today', () => { logger.flush(); return logger.logDir(); });
// Folders only: shell.openPath on a file would run it.
handle('shell:openPath', (p) => {
  if (typeof p !== 'string' || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('Not a folder');
  return shell.openPath(p);
});
handle('shell:openExternal', (url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  return null;
});

// Export sessions (+ optional secrets encrypted with an export password).
handle('sessions:export', async (tree, exportPassword) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `vytty-sessions-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Vytty sessions', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const credentials = tree.credentials || [];
  const out = { format: 'vytty-sessions', version: 1, folders: tree.folders, sessions: tree.sessions, credentials };
  if (exportPassword) out.secrets = vault.exportSecrets([...tree.sessions.map((s) => s.id), ...credentials.map((c) => `cred:${c.id}`)], exportPassword);
  fs.writeFileSync(res.filePath, JSON.stringify(out, null, 2), 'utf8');
  return res.filePath;
});
handle('sessions:importRead', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Vytty sessions', extensions: ['json'] }] });
  if (res.canceled) return null;
  const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  if (data.format !== 'vytty-sessions') throw new Error('Not a Vytty sessions file');
  return data;
});
handle('sessions:importSecrets', (blob, password, idMap) => vault.importSecrets(blob, password, idMap));

// Import from other tools (MobaXterm, PuTTY, SecureCRT, mRemoteNG, OpenSSH, CSV).
// The file is always picked in a dialog; a second call for the same file (e.g.
// with the mRemoteNG master password) may pass the path picked before.
const pickedImports = new Set();
handle('import:formats', () => Object.entries(IMPORT_FORMATS).map(([id, f]) => ({ id, label: f.label, directory: !!f.directory })));
handle('import:run', async (format, opts = {}) => {
  const f = IMPORT_FORMATS[format];
  if (!f) throw new Error(`Unknown format ${format}`);
  let file = opts.file && pickedImports.has(opts.file) ? opts.file : null;
  if (!file) {
    const defaultPath = f.defaultPath ? f.defaultPath() : undefined;
    const res = await dialog.showOpenDialog(win, {
      title: `Import ${f.label} sessions`,
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: f.directory ? ['openDirectory'] : ['openFile', 'showHiddenFiles'],
      filters: f.directory ? undefined : [...f.filters, { name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    file = res.filePaths[0];
    pickedImports.add(file);
  }
  if (!f.directory && fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('The file is too large to be a session export');
  const parsed = parseImport(format, f.directory ? file : fs.readFileSync(file), { password: opts.password });
  return { file, format, label: f.label, ...parsed };
});
handle('export:run', async (format, tree) => {
  const ex = EXPORTERS[format];
  if (!ex) throw new Error(`Unknown format ${format}`);
  const res = await dialog.showSaveDialog(win, { title: `Export as ${ex.label}`, defaultPath: ex.defaultName, filters: ex.filters });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, ex.run(tree), 'utf8');
  return res.filePath;
});

// NetBox: the API token is kept in the vault ("integration:netbox").
const netboxOpts = (opts) => {
  let token = opts && opts.token;
  if (!token) {
    try { token = vault.get('integration:netbox').token; } catch { throw new Error('Unlock the vault to use the stored NetBox token'); }
  }
  return { ...opts, token };
};
const fetchViaChromium = (url, init) => net.fetch(url, init); // system proxy + Windows certificate store
handle('netbox:test', (opts) => netbox.testConnection(fetchViaChromium, netboxOpts(opts)));
handle('netbox:fetch', (opts) => netbox.fetchSessions(fetchViaChromium, netboxOpts(opts)));

// External tools
handle('tools:presets', () => tools.presets());
handle('tools:plan', (tool, s) => tools.plan(tool, s));
handle('tools:launch', (tool, s) => tools.launch(tool, s, (url) => shell.openExternal(url)));

// ssh:// telnet:// link handling
handle('urlhandler:status', () => urlHandlerStatus());
handle('urlhandler:set', (on) => setUrlHandler(!!on));

// Updates from GitHub releases
handle('update:check', () => updater.check());
handle('update:download', () => updater.download((got, total, phase) => send('update:progress', got, total, phase)));
handle('update:cancel', () => updater.cancel());
handle('update:install', () => updater.install());

// Custom title bar controls
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('win:fullscreen', () => win && win.setFullScreen(!win.isFullScreen()));
ipcMain.on('win:devtools', () => win && win.webContents.toggleDevTools());
