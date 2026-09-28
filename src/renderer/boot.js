'use strict';
// Startup: load state, vault unlock, main-process prompts, keyboard shortcuts.
(() => {
  const { el, $, $$, icon, modal, confirmBox, inputBox, contextMenu, toast } = UI;

  // ----------------------------------------------------------- vault
  async function refreshVault() {
    App.vault = await vytty.vault.status();
    App.emit('vault');
  }

  async function vaultSetup() {
    const pw1 = el('input.input', { type: 'password', autofocus: true, autocomplete: 'new-password' });
    const pw2 = el('input.input', { type: 'password', autocomplete: 'new-password' });
    const err = el('div.notice.danger.hidden');
    const res = await modal({
      title: 'Set up the credential vault',
      width: 480,
      body: [
        el('p', { text: 'Vytty stores session passwords in an encrypted vault inside its portable data folder. Choose a master password to protect it. You will enter it once each time Vytty starts.' }),
        err,
        el('label.field', el('span', { text: 'Master password' }), pw1),
        el('label.field', el('span', { text: 'Repeat master password' }), pw2),
        el('p.muted', { style: { fontSize: '12px' }, text: 'There is no way to recover a forgotten master password. The stored passwords would have to be entered again.' }),
      ],
      buttons: [
        { label: 'Use without master password', value: 'none', left: true },
        { label: 'Create vault', value: 'master', primary: true, validate: () => {
          const msg = !pw1.value ? 'Enter a master password' : pw1.value !== pw2.value ? 'Passwords do not match' : pw1.value.length < 6 ? 'Use at least 6 characters' : '';
          err.textContent = msg;
          err.classList.toggle('hidden', !msg);
          return !msg;
        } },
      ],
    });
    if (res === 'master') await vytty.vault.create(pw1.value);
    else if (res === 'none') {
      const ok = await confirmBox('No master password', 'Passwords will be encrypted with a built-in key only. Anyone who copies the Vytty data folder can read them.\n\nYou can set a master password later in Settings → Vault & security.', { okLabel: 'Continue' });
      if (!ok) return vaultSetup();
      await vytty.vault.create(null);
    } else return refreshVault();
    await refreshVault();
    toast('Vault ready', 'ok');
  }

  async function vaultUnlock() {
    const st = await vytty.vault.status();
    if (!st.exists) return vaultSetup();
    if (st.mode === 'none') { await vytty.vault.unlock(''); return refreshVault(); }
    const pw = el('input.input', { type: 'password', autofocus: true });
    const err = el('div.notice.danger.hidden');
    const res = await modal({
      title: 'Unlock vault',
      width: 420,
      body: [el('p.muted', { text: `${st.count} stored credential${st.count === 1 ? '' : 's'}. Enter the master password.` }), err, el('label.field', el('span', { text: 'Master password' }), pw)],
      buttons: [
        { label: 'Forgot…', value: 'reset', left: true },
        { label: 'Skip', value: null },
        { label: 'Unlock', value: 'ok', primary: true, validate: async () => {
          try { await vytty.vault.unlock(pw.value); return true; } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
            pw.select();
            return false;
          }
        } },
      ],
    });
    if (res === 'reset') {
      const ok = await confirmBox('Reset vault', 'This deletes all stored passwords. Sessions themselves are kept. Continue?', { okLabel: 'Delete passwords', danger: true });
      if (ok) { await vytty.vault.reset(); await refreshVault(); return vaultSetup(); }
      return vaultUnlock();
    }
    await refreshVault();
  }

  async function vaultLock() {
    await vytty.vault.lock();
    await refreshVault();
    toast('Vault locked', 'info');
  }

  async function vaultChangeMaster() {
    let old = '';
    if (App.vault.mode === 'master') {
      const r = await inputBox('Change master password', 'Current master password', { password: true });
      if (!r) return;
      old = r.value;
    }
    const pw1 = el('input.input', { type: 'password', autofocus: true, autocomplete: 'new-password' });
    const pw2 = el('input.input', { type: 'password', autocomplete: 'new-password' });
    const err = el('div.notice.danger.hidden');
    const res = await modal({
      title: 'New master password',
      body: [err, el('label.field', el('span', { text: 'New master password' }), pw1), el('label.field', el('span', { text: 'Repeat' }), pw2)],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true, validate: () => {
        const msg = !pw1.value ? 'Enter a password' : pw1.value !== pw2.value ? 'Passwords do not match' : '';
        err.textContent = msg;
        err.classList.toggle('hidden', !msg);
        return !msg;
      } }],
    });
    if (res !== 'ok') return;
    try {
      await vytty.vault.change(old, pw1.value);
      toast('Master password changed', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    await refreshVault();
  }

  Object.assign(App, { vaultSetup, vaultUnlock, vaultLock, vaultChangeMaster, refreshVault });
  App.on('vault-click', (e) => {
    if (!App.vault.exists) return vaultSetup();
    if (!App.vault.unlocked) return vaultUnlock();
    const r = $('#statusbar').getBoundingClientRect();
    contextMenu(r.right - 220, r.top - 110, [
      App.vault.mode === 'master' ? { label: 'Lock vault', icon: 'lock', action: vaultLock } : null,
      { label: App.vault.mode === 'master' ? 'Change master password…' : 'Set master password…', icon: 'key', action: vaultChangeMaster },
      { label: 'Vault settings…', icon: 'settings', action: () => App.emit('open-settings', 'Vault & security') },
    ]);
  });

  // -------------------------------------------- prompts from main process
  vytty.onPrompt(async (reqId, kind, p) => {
    let answer = null;
    if (kind === 'hostkey') {
      const changed = !!p.previous;
      answer = await modal({
        title: changed ? 'WARNING: host key changed' : 'Unknown host key',
        width: 540,
        body: [
          changed
            ? el('div.notice.danger', { text: `The host key for ${p.host}:${p.port} is different from the one saved earlier. This can mean the device was replaced or re-keyed, or that someone is intercepting the connection.` })
            : el('p', { text: `First connection to ${p.host}:${p.port}. Check the fingerprint before trusting it.` }),
          el('div.kv',
            changed ? [el('span.k', { text: 'Saved fingerprint' }), el('span.v.mono', { text: p.previous })] : null,
            el('span.k', { text: changed ? 'New fingerprint' : 'Fingerprint' }), el('span.v.mono', { text: p.fingerprint })),
        ],
        buttons: [{ label: 'Cancel', value: false }, { label: changed ? 'Accept new key' : 'Trust & connect', value: true, primary: !changed, danger: changed }],
      }) === true;
    } else if (kind === 'secret') {
      const canSave = p.allowSave && App.vault.unlocked;
      const r = await inputBox(p.title || 'Authentication', p.label || 'Password', {
        password: !p.plain,
        okLabel: 'Continue',
        checkbox: canSave ? { label: 'Save in vault', checked: true } : null,
      });
      answer = r ? { value: r.value, save: canSave && r.checked } : null;
      if (r && r.checked && canSave) setTimeout(refreshVault, 500);
    }
    vytty.replyPrompt(reqId, answer);
  });

  // ------------------------------------------------------- shortcuts
  function combo(e) {
    let key = e.key;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (e.code === 'Equal' || e.code === 'NumpadAdd') key = '=';
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') key = '-';
    else if (e.code === 'Comma') key = ',';
    return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${key}`;
  }

  function cycleTab(dir) {
    if (!App.tabs.length) return;
    const i = App.tabs.indexOf(App.active);
    App.tabs[(i + dir + App.tabs.length) % App.tabs.length].activate();
  }

  const SHORTCUTS = {
    'Ctrl+Shift+N': () => App.emit('new-session'),
    'Ctrl+Shift+K': () => { $('#qc-input').focus(); $('#qc-input').select(); },
    'Ctrl+Shift+E': () => App.emit('focus-session-search'),
    'Ctrl+Shift+T': (t) => t && App.openSession(t.source),
    'Ctrl+Shift+W': (t) => t && t.close(),
    'Ctrl+Tab': () => cycleTab(1),
    'Ctrl+Shift+Tab': () => cycleTab(-1),
    'Ctrl+PageDown': () => cycleTab(1),
    'Ctrl+PageUp': () => cycleTab(-1),
    'Ctrl+Shift+F': () => App.emit('find'),
    'Ctrl+Shift+M': () => App.toggleMultiExec(),
    'Ctrl+Shift+R': (t) => t && t.connect(),
    'Ctrl+Shift+C': (t) => t && t.copy(),
    'Ctrl+Insert': (t) => t && t.copy(),
    'Ctrl+Shift+V': (t) => t && t.paste(),
    'Shift+Insert': (t) => t && t.paste(),
    'Ctrl+Shift+L': (t) => t && t.term.clear(),
    'Ctrl+Shift+B': () => App.toggleSidebar(),
    'Ctrl+=': () => App.zoom(1),
    'Ctrl+Shift+=': () => App.zoom(1),
    'Ctrl+-': () => App.zoom(-1),
    'Ctrl+0': () => App.zoom(0),
    'Ctrl+,': () => App.emit('open-settings'),
    F11: () => vytty.win.fullscreen(),
  };
  for (let i = 1; i <= 9; i++) SHORTCUTS[`Alt+${i}`] = () => { const t = i === 9 ? App.tabs[App.tabs.length - 1] : App.tabs[i - 1]; if (t) t.activate(); };

  App.handleShortcut = (e, tab) => {
    if (UI.hasModal()) return false;
    const fn = SHORTCUTS[combo(e)];
    if (!fn) return false;
    e.preventDefault();
    fn(tab || App.active);
    return true;
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.classList && e.target.classList.contains('xterm-helper-textarea')) return; // handled by the terminal
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const c = combo(e);
    if (inField && !/^Ctrl\+Shift\+|^Ctrl\+Tab|^F11$|^Alt\+\d$/.test(c)) return;
    App.handleShortcut(e);
  });

  // ------------------------------------------------------ side panels
  function initSidePanels() {
    const nav = $('#side-tabs');
    const panels = [['sessions', 'Sessions', 'server'], ['sftp', 'SFTP', 'folder'], ['snippets', 'Snippets', 'code']];
    const show = (name) => {
      for (const b of nav.children) b.classList.toggle('active', b.dataset.p === name);
      for (const p of $$('.side-panel')) p.classList.toggle('active', p.dataset.panel === name);
      if (!App.settings.sidebarVisible) App.toggleSidebar(true);
      try { localStorage.setItem('vytty.panel', name); } catch { /* ignore */ }
      App.emit('panel-shown', name);
    };
    nav.append(...panels.map(([id, label, ic]) => el('button.side-tab', { dataset: { p: id }, on: { click: () => show(id) } }, icon(ic, 14), label)));
    App.on('show-panel', show);
    let last = 'sessions';
    try { last = localStorage.getItem('vytty.panel') || 'sessions'; } catch { /* ignore */ }
    show(last);
  }

  // --------------------------------------------------------- boot
  async function boot() {
    [App.info, App.settings, App.tree] = await Promise.all([vytty.appInfo(), vytty.settings.get(), vytty.sessions.get()]);
    App.applyTheme();
    App.initCore();
    App.Sessions.init();
    App.Tabs.init();
    App.Sftp.init();
    App.Snippets.init();
    initSidePanels();
    App.emit('tab-changed', null);

    vytty.win.onCloseRequest(async () => {
      const live = App.tabs.filter((t) => t.state === 'connected');
      if (live.length && App.settings.confirmCloseConnected) {
        const ok = await confirmBox('Quit Vytty', `${live.length} session${live.length > 1 ? 's are' : ' is'} still connected. Quit anyway?`, { okLabel: 'Quit' });
        if (!ok) return;
      }
      vytty.win.forceClose();
    });

    await refreshVault();
    await vaultUnlock();
    App.emit('booted');
  }

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => {
      console.error(e);
      document.body.append(el('pre', { text: `Startup failed: ${e.stack || e.message}`, style: { color: 'red', padding: '20px' } }));
    });
  });
})();
