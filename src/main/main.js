'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, nativeImage } = require('electron');
const { paths, ensureDirs } = require('./paths');

ensureDirs();
// Fully portable: keep Chromium's profile inside the data folder too.
app.setPath('userData', paths.chromium);
app.setPath('sessionData', paths.chromium);

const { store } = require('./store');
const { vault } = require('./vault');
const logger = require('./logger');
const { ConnectionManager, capabilities } = require('./connections');
const mobaxterm = require('./mobaxterm');
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

// ----------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    backgroundColor: '#11131a',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    createWindow();
    // Remove what the last update set aside, once startup is done.
    setTimeout(() => updater.cleanup(), 5000);
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

handle('app:info', () => ({
  version: app.getVersion(),
  dataDir: paths.dataDir,
  logDir: logger.logDir(),
  platform: process.platform,
  capabilities,
  install: updater.info(),
  systemDark: nativeTheme.shouldUseDarkColors,
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
  e.sender.startDrag({ file: ph.files[0], files: ph.files, icon: getDragIcon() });
  const dest = await dragout.locateDrop(items[0], since);
  try { fs.rmSync(ph.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!dest) {
    send('sftp:dragResult', { ok: false, unknown: true, items });
    return;
  }
  send('sftp:dragResult', { started: true, dest, count: items.length });
  try {
    await connections.sftpOp(id, 'downloadPaths', { items, localDir: dest });
    send('sftp:dragResult', { ok: true, dest, count: items.length });
  } catch (err) {
    send('sftp:dragResult', { ok: false, dest, error: err.message });
  }
});

handle('clipboard:read', () => clipboard.readText());
handle('clipboard:write', (text) => clipboard.writeText(text));

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
handle('shell:openPath', (p) => shell.openPath(p));
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

// Import a MobaXterm session file: pick, read as CP1252, parse to Vytty sessions.
handle('sessions:importMobaXterm', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import MobaXterm sessions',
    properties: ['openFile'],
    filters: [
      { name: 'MobaXterm sessions', extensions: ['mxtsessions', 'mobaxterm', 'moba', 'ini', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const parsed = mobaxterm.parseFile(fs.readFileSync(res.filePaths[0]));
  return { file: res.filePaths[0], ...parsed };
});

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
