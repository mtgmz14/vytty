'use strict';
// Core application state, theming, title bar, status bar and welcome screen.
(() => {
  const { el, $, icon, contextMenu, toast } = UI;
  const listeners = {};

  const App = {
    settings: null,
    info: null,
    tree: { folders: [], sessions: [] },
    tabs: [],
    active: null,
    multiExec: false,
    vault: { exists: false, unlocked: false, mode: null },

    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit(name, ...args) { for (const fn of listeners[name] || []) { try { fn(...args); } catch (e) { console.error(e); } } },

    get theme() { return VYTTY_THEMES[App.settings.theme] || VYTTY_THEMES['vytty-dark']; },

    async saveSettings() {
      // Keep the same object: dialogs hold references into it.
      await vytty.settings.save(App.settings);
      App.emit('settings');
    },

    async saveTree() {
      await vytty.sessions.save(App.tree);
      App.emit('tree');
    },

    session(id) { return App.tree.sessions.find((s) => s.id === id); },
    folder(id) { return App.tree.folders.find((f) => f.id === id); },
    folderPath(id) {
      const parts = [];
      let f = App.folder(id);
      while (f) { parts.unshift(f.name); f = App.folder(f.parentId); }
      return parts.join(' / ');
    },

    // Attach jump host session object so the main process has everything.
    credential(id) { return (App.tree.credentials || []).find((c) => c.id === id); },

    // Which credential profile a session uses: the one picked in the session,
    // none when set to 'none', otherwise the first "auto" profile whose
    // username matches the session's username (like MobaXterm credentials).
    credentialFor(s) {
      if (!s || s.credentialId === 'none' || s.protocol === 'local') return null;
      if (s.credentialId) return App.credential(s.credentialId) || null;
      const user = (s.username || '').trim().toLowerCase();
      if (!user) return null;
      return (App.tree.credentials || []).find((c) => c.auto !== false && (c.username || '').toLowerCase() === user) || null;
    },

    // Copy of a session with its jump host and credential profile attached,
    // so the main process has everything it needs to connect.
    resolveSession(s) {
      const withCred = (src) => {
        const copy = JSON.parse(JSON.stringify(src));
        const cred = App.credentialFor(src);
        copy.credentialId = cred ? cred.id : null;
        if (cred && (src.credentialId === cred.id || !copy.username)) copy.username = cred.username;
        return copy;
      };
      const copy = withCred(s);
      if (s.jumpId && s.jumpId !== s.id) {
        const j = App.session(s.jumpId);
        if (j) copy.jump = { session: withCred(j) };
      }
      return copy;
    },

    applyTheme() {
      const th = App.theme;
      const root = document.documentElement;
      const map = { bg: '--bg', panel: '--panel', surface: '--surface', border: '--border', text: '--text', muted: '--muted', accent: '--accent', accentText: '--accent-text', danger: '--danger', ok: '--ok', warn: '--warn' };
      for (const [k, v] of Object.entries(map)) root.style.setProperty(v, th.ui[k]);
      root.style.setProperty('--term-bg', th.term.background);
      root.classList.toggle('light', !th.dark);
      App.emit('theme');
    },

    async setTheme(id) {
      App.settings.theme = id;
      App.applyTheme();
      await App.saveSettings();
    },

    themeMenuItems() {
      return Object.entries(VYTTY_THEMES).map(([id, th]) => ({ label: th.name, checked: App.settings.theme === id, action: () => App.setTheme(id) }));
    },

    toggleMultiExec(force) {
      App.multiExec = typeof force === 'boolean' ? force : !App.multiExec;
      document.body.classList.toggle('multiexec', App.multiExec);
      App.emit('multiexec');
      toast(App.multiExec ? 'Multi-exec ON: input goes to every tab marked with the broadcast icon' : 'Multi-exec OFF', App.multiExec ? 'info' : 'ok');
    },

    toggleSidebar(force) {
      App.settings.sidebarVisible = typeof force === 'boolean' ? force : !App.settings.sidebarVisible;
      $('#sidebar').classList.toggle('collapsed', !App.settings.sidebarVisible);
      App.saveSettings();
      App.emit('layout');
    },
  };
  window.App = App;

  // -------------------------------------------------------- title bar
  function buildTitlebar() {
    $('.qc-icon').append(icon('zap', 14));
    const tb = $('#toolbar');
    const btn = (name, title, onClick, id) => el('button.icon-btn', { title, id, on: { click: onClick } }, icon(name));
    tb.append(
      btn('plus', 'New session (Ctrl+Shift+N)', () => App.emit('new-session')),
      btn('terminal', 'Local shell', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        contextMenu(r.left, r.bottom + 4, localShellMenu());
      }),
      btn('broadcast', 'Multi-exec: type into many tabs at once (Ctrl+Shift+M)', () => App.toggleMultiExec(), 'btn-multiexec'),
      btn('logs', 'Open log folder', () => vytty.logs.open()),
      btn('palette', 'Theme', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        contextMenu(r.left - 120, r.bottom + 4, App.themeMenuItems());
      }),
      btn('settings', 'Settings (Ctrl+,)', () => App.emit('open-settings')),
    );
    App.on('multiexec', () => $('#btn-multiexec').classList.toggle('warn-on', App.multiExec));

    const wc = $('#win-controls');
    const maxBtn = el('button', { title: 'Maximize', on: { click: () => vytty.win.maximize() } }, icon('max', 14));
    wc.append(
      el('button', { title: 'Minimize', on: { click: () => vytty.win.minimize() } }, icon('min', 14)),
      maxBtn,
      el('button.close', { title: 'Close', on: { click: () => vytty.win.close() } }, icon('x', 14)),
    );
    vytty.win.onState(({ maximized }) => { maxBtn.replaceChildren(icon(maximized ? 'restore' : 'max', 14)); });
    $('#titlebar').addEventListener('dblclick', (e) => { if (e.target.id === 'titlebar' || e.target.closest('.brand')) vytty.win.maximize(); });
  }

  function localShellMenu() {
    const win = App.info.platform === 'win32';
    const shells = win
      ? [['PowerShell', 'powershell.exe'], ['PowerShell 7', 'pwsh.exe'], ['Command Prompt', 'cmd.exe'], ['WSL', 'wsl.exe'], ['Git Bash', 'C:\\Program Files\\Git\\bin\\bash.exe']]
      : [['Default shell', ''], ['bash', '/bin/bash'], ['zsh', '/bin/zsh']];
    return shells.map(([label, shell]) => ({
      label,
      icon: 'terminal',
      action: () => App.emit('open-session', { id: null, name: label, protocol: 'local', shell, shellArgs: shell === 'wsl.exe' ? '~' : '' }),
    }));
  }
  App.localShellMenu = localShellMenu;

  // -------------------------------------------------------- status bar
  let transfer = null;
  function renderStatus() {
    const sb = $('#statusbar');
    const t = App.active;
    const item = (content, opts = {}) => el(`div.sb-item${opts.click ? '.click' : ''}${opts.grow ? '.sb-grow' : ''}`, { title: opts.title || '', on: opts.click ? { click: opts.click } : undefined }, content);
    const parts = [];
    if (t) {
      parts.push(item([el(`span.status-dot.${t.state}`), t.statusText || t.state], { grow: true, title: t.statusText }));
    } else {
      parts.push(item(`Vytty ${App.info.version} · ${App.tree.sessions.length} saved sessions`, { grow: true }));
    }
    if (transfer) {
      const pct = transfer.total ? Math.round((transfer.transferred / transfer.total) * 100) : 0;
      parts.push(item([icon(transfer.op === 'download' ? 'download' : 'upload', 12), `${transfer.name} ${pct}%`, el('div.progress', el('div', { style: { width: `${pct}%` } }))]));
    }
    if (App.multiExec) parts.push(item(el('span.badge.warn', { text: 'MULTI-EXEC' }), { click: () => App.toggleMultiExec(), title: 'Click to turn off' }));
    if (t) {
      const prof = VyttyHighlight.PROFILES[t.hlProfile] || 'None';
      parts.push(item([icon('code', 12), App.settings.highlight.enabled ? prof : 'Highlight off'], {
        click: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          contextMenu(r.left, r.top - 10 - 34 * 6, [
            { header: 'Highlighting for this tab' },
            ...Object.entries(VyttyHighlight.PROFILES).map(([k, name]) => ({ label: name, checked: t.hlProfile === k, action: () => t.setHighlight(k) })),
          ]);
        },
        title: 'Syntax highlighting profile',
      }));
      const logOn = App.settings.logging.enabled && t.logEnabled;
      parts.push(item([el(`span.badge.${logOn ? 'ok' : 'off'}`, { text: logOn ? 'LOG' : 'NO LOG' })], {
        click: () => vytty.logs.open(),
        title: logOn ? `Logging to ${App.info.todayLog}\nClick to open the log folder` : 'Logging disabled',
      }));
      if (t.term) parts.push(item(`${t.term.cols}×${t.term.rows}`));
    }
    parts.push(item([icon(App.vault.unlocked ? 'unlock' : 'lock', 12), App.vault.unlocked ? (App.vault.mode === 'none' ? 'Vault (no master)' : 'Vault unlocked') : 'Vault locked'], {
      click: () => App.emit('vault-click'),
      title: 'Credential vault',
    }));
    sb.replaceChildren(...parts);
  }
  App.renderStatus = renderStatus;
  const statusSoon = UI.debounce(renderStatus, 50);
  for (const ev of ['tab-changed', 'tab-state', 'multiexec', 'settings', 'vault', 'tree', 'resize']) App.on(ev, statusSoon);
  App.setTransfer = (p) => {
    transfer = p && p.transferred < p.total ? p : null;
    statusSoon();
  };

  // --------------------------------------------------------- welcome
  function renderWelcome() {
    const w = $('#welcome');
    const card = (ic, title, desc, fn) => el('button.welcome-card', { type: 'button', on: { click: fn } }, icon(ic, 20), el('b', { text: title }), el('span.d', { text: desc }));
    const recent = [...App.tree.sessions].filter((s) => s.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 6);
    const K = (keys, label) => el('div', ...keys.split(' ').map((k) => [el('kbd', { text: k }), ' ']), label);
    w.replaceChildren(el('div.welcome-inner',
      el('div.welcome-title', el('span.brand-mark'), el('h1', { text: 'Vytty' })),
      el('p.welcome-sub', { text: 'Portable SSH, Telnet, Serial and local terminal for network & Linux work.' }),
      el('div.welcome-grid',
        card('plus', 'New session', 'SSH, Telnet, Serial or local shell', () => App.emit('new-session')),
        card('zap', 'Quick connect', 'user@host, telnet host, COM3', () => $('#qc-input').focus()),
        card('terminal', 'Local shell', App.info.platform === 'win32' ? 'PowerShell, CMD, WSL' : 'Your default shell', (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          contextMenu(r.left, r.bottom + 4, localShellMenu());
        }),
        card('logs', 'Session logs', 'Daily log files', () => vytty.logs.open())),
      recent.length ? [el('h3', { text: 'Recent sessions' }), el('div.recent-list', recent.map((s) => el('div.recent-item', { on: { click: () => App.emit('open-session', s) } },
        el('span.color-dot', { style: { width: '8px', height: '8px', borderRadius: '50%', background: s.color || 'var(--muted)' } }),
        el('span.name', { text: s.name }),
        el('span.sub', { text: `${s.protocol.toUpperCase()} · ${s.host || s.serialPath || s.shell || ''}` }))))] : null,
      el('h3', { text: 'Shortcuts' }),
      el('div.kbd-grid',
        K('Ctrl+Shift+N', 'New session'), K('Ctrl+Shift+K', 'Quick connect'), K('Ctrl+Shift+T', 'Duplicate tab'),
        K('Ctrl+Shift+W', 'Close tab'), K('Ctrl+Tab', 'Next tab'), K('Alt+1…9', 'Go to tab'),
        K('Ctrl+Shift+F', 'Find in terminal'), K('Ctrl+Shift+M', 'Multi-exec'), K('Ctrl+Shift+R', 'Reconnect'),
        K('Ctrl+Shift+C', 'Copy'), K('Ctrl+Shift+V', 'Paste'), K('Ctrl+Wheel', 'Zoom'),
        K('Ctrl+Shift+B', 'Toggle sidebar'), K('Ctrl+Shift+L', 'Clear scrollback'), K('F11', 'Full screen'))));
  }
  App.renderWelcome = renderWelcome;
  App.on('tree', () => { if (!App.tabs.length) renderWelcome(); });
  App.on('tab-changed', () => { $('#welcome').classList.toggle('hidden', App.tabs.length > 0); });

  // ------------------------------------------------------ sidebar resize
  function initResizer() {
    const r = $('#resizer');
    const root = document.documentElement;
    root.style.setProperty('--sidebar-w', `${App.settings.sidebarWidth || 260}px`);
    $('#sidebar').classList.toggle('collapsed', !App.settings.sidebarVisible);
    r.addEventListener('mousedown', (e) => {
      e.preventDefault();
      r.classList.add('drag');
      const move = (ev) => {
        const w = Math.max(180, Math.min(560, ev.clientX));
        root.style.setProperty('--sidebar-w', `${w}px`);
        App.settings.sidebarWidth = w;
        App.emit('layout');
      };
      const up = () => {
        r.classList.remove('drag');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        App.saveSettings();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  App.initCore = () => {
    buildTitlebar();
    initResizer();
    renderWelcome();
    renderStatus();
  };
})();
