'use strict';
// window.vytty - the backend API of the UI, on top of Tauri.
// Calls go through one command, call(ch, args), with the channel names of the
// old Electron preload; everything the backend sends (terminal output, status,
// prompts, progress...) arrives as events on one channel.
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const asError = (e) => (e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e && e.message) || String(e)));

  const listeners = new Map();
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  };
  const fire = (type, ...args) => {
    for (const fn of listeners.get(type) || []) {
      try { fn(...args); } catch (err) { console.error(err); }
    }
  };

  // Paths of files dropped on the page. Windows: WebView2 tells us the paths
  // of the File objects. Elsewhere the window reports drops with their paths
  // (see the fileDrop event below), so there is nothing to ask.
  const pathRequests = new Map();
  let pathSeq = 0;
  function pathsForFiles(files) {
    const list = [...(files || [])];
    const wv = window.chrome && window.chrome.webview;
    if (!list.length || !wv || typeof wv.postMessageWithAdditionalObjects !== 'function') return Promise.resolve([]);
    const req = `${Date.now()}-${++pathSeq}`;
    return new Promise((resolve) => {
      pathRequests.set(req, resolve);
      wv.postMessageWithAdditionalObjects(`vytty-files:${req}`, list);
      setTimeout(() => { if (pathRequests.delete(req)) resolve([]); }, 3000);
    });
  }

  const channel = new T.core.Channel();
  channel.onmessage = (ev) => {
    switch (ev.t) {
      case 'data': fire('conn:data', ev.id, ev.data); break;
      case 'status': fire('conn:status', ev.id, ev.state, ev.message); break;
      case 'closed': fire('conn:closed', ev.id, ev.reason); break;
      case 'sftpProgress': fire('sftp:progress', ev.id, ev.p); break;
      case 'sftpError': fire('sftp:error', ev.message); break;
      case 'dragResult': fire('sftp:dragResult', ev.r); break;
      case 'updateProgress': fire('update:progress', ev.got, ev.total, ev.phase); break;
      case 'prompt': fire('prompt', ev.reqId, ev.kind, ev.payload); break;
      case 'openUrl': fire('app:open-url', ev.list); break;
      case 'closeRequest': fire('app:close-request'); break;
      case 'winState': fire('win:state', { maximized: ev.maximized }); break;
      case 'fileDrop': {
        const target = document.elementFromPoint(ev.x, ev.y) || document.body;
        target.dispatchEvent(new CustomEvent('vytty-file-drop', { bubbles: true, detail: { paths: ev.paths } }));
        break;
      }
      case 'filePaths': {
        const resolve = pathRequests.get(ev.req);
        if (resolve) { pathRequests.delete(ev.req); resolve(ev.paths); }
        break;
      }
      default: break;
    }
  };
  const subscribed = invoke('subscribe', { channel });

  const call = async (ch, ...args) => {
    await subscribed;
    try { return await invoke('call', { ch, args }); } catch (e) { throw asError(e); }
  };
  // Fire and forget (keystrokes, resizes, window buttons).
  const send = (ch, ...args) => { call(ch, ...args).catch(() => {}); };

  // No browser context menu (Back, Reload...) where the UI shows none of its own;
  // text fields keep theirs (cut / copy / paste).
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
  // A reload would drop every open connection.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r' && !(e.target.closest && e.target.closest('.xterm')))) e.preventDefault();
  });

  // The custom title bar moves the window (CSS app-region is Electron-only).
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.detail > 1 || !e.target.closest) return;
    if (!e.target.closest('#titlebar')) return;
    if (e.target.closest('button, input, select, textarea, a, #quickconnect, .toolbar, .win-controls, [data-no-drag]')) return;
    send('win:drag');
  });

  window.vytty = {
    appInfo: () => call('app:info'),
    ready: () => { subscribed.then(() => send('app:ready')); },
    onOpenUrl: (fn) => on('app:open-url', fn),
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
      importFormats: () => call('import:formats'),
      importFrom: (format, opts) => call('import:run', format, opts || {}),
      exportAs: (format, tree) => call('export:run', format, tree),
    },
    netbox: {
      test: (opts) => call('netbox:test', opts),
      fetch: (opts) => call('netbox:fetch', opts),
    },
    tools: {
      presets: () => call('tools:presets'),
      plan: (tool, session) => call('tools:plan', tool, session),
      launch: (tool, session) => call('tools:launch', tool, session),
    },
    urlHandler: {
      status: () => call('urlhandler:status'),
      set: (v) => call('urlhandler:set', !!v),
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
      write: (id, data) => send('conn:write', id, data),
      resize: (id, cols, rows) => send('conn:resize', id, cols, rows),
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
      startDrag: (id, items, deferred) => send('sftp:startDrag', id, items, !!deferred),
      onDragResult: (fn) => on('sftp:dragResult', fn),
      onError: (fn) => on('sftp:error', fn),
      onProgress: (fn) => on('sftp:progress', fn),
    },
    clipboard: {
      read: () => call('clipboard:read'),
      write: (t) => call('clipboard:write', String(t)),
    },
    dialog: {
      openFile: (opts) => call('dialog:openFile', opts || {}),
      openDir: () => call('dialog:openDir'),
    },
    logs: {
      open: () => call('logs:open'),
      today: () => call('logs:today'),
    },
    update: {
      check: () => call('update:check'),
      download: () => call('update:download'),
      cancel: () => call('update:cancel'),
      install: () => call('update:install'),
      onProgress: (fn) => on('update:progress', fn),
    },
    openPath: (p) => call('shell:openPath', p),
    openExternal: (u) => call('shell:openExternal', u),
    // Dropped files -> local paths (a promise; [] when the window reports drops itself).
    pathsForFiles,
    onPrompt: (fn) => on('prompt', fn),
    replyPrompt: (reqId, answer) => send('prompt:reply', reqId, answer === undefined ? null : answer),
    win: {
      minimize: () => send('win:minimize'),
      maximize: () => send('win:maximize'),
      close: () => send('win:close'),
      forceClose: () => send('win:forceClose'),
      onCloseRequest: (fn) => on('app:close-request', fn),
      fullscreen: () => send('win:fullscreen'),
      devtools: () => send('win:devtools'),
      onState: (fn) => on('win:state', fn),
    },
    // Test builds only (the end-to-end driver).
    e2e: (kind, value) => call('e2e', kind, value === undefined ? null : value),
  };
})();
