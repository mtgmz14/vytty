'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Every invoke returns { ok, value | error }; unwrap into a normal promise.
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
};

const on = (channel, fn) => {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('vytty', {
  appInfo: () => call('app:info'),
  settings: {
    get: () => call('settings:get'),
    save: (s) => call('settings:save', s),
  },
  sessions: {
    get: () => call('sessions:get'),
    save: (tree) => call('sessions:save', tree),
    export: (tree, pw) => call('sessions:export', tree, pw),
    importRead: () => call('sessions:importRead'),
    importSecrets: (blob, pw, idMap) => call('sessions:importSecrets', blob, pw, idMap),
    importMobaXterm: () => call('sessions:importMobaXterm'),
  },
  vault: {
    status: () => call('vault:status'),
    create: (pw) => call('vault:create', pw),
    unlock: (pw) => call('vault:unlock', pw),
    lock: () => call('vault:lock'),
    reset: () => call('vault:reset'),
    get: (id) => call('vault:get', id),
    set: (id, secret) => call('vault:set', id, secret),
    remove: (id) => call('vault:remove', id),
    change: (oldPw, newPw) => call('vault:change', oldPw, newPw),
  },
  conn: {
    open: (id, spec) => call('conn:open', id, spec),
    write: (id, data) => ipcRenderer.send('conn:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('conn:resize', id, cols, rows),
    close: (id) => call('conn:close', id),
    onData: (fn) => on('conn:data', fn),
    onStatus: (fn) => on('conn:status', fn),
    onClosed: (fn) => on('conn:closed', fn),
  },
  serialList: () => call('serial:list'),
  sftp: {
    op: (id, op, args) => call('sftp', id, op, args),
    download: (id, remote, name) => call('sftp:download', id, remote, name),
    pickUpload: (folders) => call('sftp:uploadPick', !!folders),
    downloadTo: (id, items) => call('sftp:downloadTo', id, items),
    prepareDrag: (id, items) => call('sftp:prepareDrag', id, items),
    startDrag: (id, items, deferred) => ipcRenderer.send('sftp:startDrag', id, items, !!deferred),
    onDragResult: (fn) => on('sftp:dragResult', fn),
    onError: (fn) => on('sftp:error', fn),
    onProgress: (fn) => on('sftp:progress', fn),
  },
  clipboard: {
    read: () => call('clipboard:read'),
    write: (t) => call('clipboard:write', t),
  },
  dialog: {
    openFile: (opts) => call('dialog:openFile', opts),
    openDir: () => call('dialog:openDir'),
  },
  logs: {
    open: () => call('logs:open'),
    today: () => call('logs:today'),
  },
  openPath: (p) => call('shell:openPath', p),
  openExternal: (u) => call('shell:openExternal', u),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onPrompt: (fn) => on('prompt', fn),
  replyPrompt: (reqId, answer) => ipcRenderer.send('prompt:reply', reqId, answer),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    forceClose: () => ipcRenderer.send('win:forceClose'),
    onCloseRequest: (fn) => on('app:close-request', fn),
    fullscreen: () => ipcRenderer.send('win:fullscreen'),
    devtools: () => ipcRenderer.send('win:devtools'),
    onState: (fn) => on('win:state', fn),
  },
});
