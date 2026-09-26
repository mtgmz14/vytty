'use strict';
// Terminal tabs: xterm.js instances wired to backend connections.
(() => {
  const { el, $, icon, modal, confirmBox, inputBox, contextMenu, toast, uid, debounce } = UI;
  const byConn = new Map();

  function termOptions() {
    const s = App.settings;
    return {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      wordSeparator: s.wordSeparator,
      theme: App.theme.term,
    };
  }

  let beepCtx = null;
  function beep() {
    try {
      beepCtx = beepCtx || new AudioContext();
      const o = beepCtx.createOscillator();
      const g = beepCtx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.05;
      o.connect(g).connect(beepCtx.destination);
      o.start();
      o.stop(beepCtx.currentTime + 0.08);
    } catch { /* ignore */ }
  }

  class Tab {
    constructor(session) {
      this.id = uid();
      this.source = session;
      this.title = session.name || session.host || 'session';
      this.state = 'idle';
      this.statusText = '';
      this.connId = null;
      this.everConnected = false;
      this.logEnabled = session.logging !== false;
      this.hlProfile = session.highlight || App.settings.highlight.defaultProfile || 'auto';
      this.broadcast = true;
      this.sftpCwd = null;
      this.build();
    }

    // --------------------------------------------------------- DOM
    build() {
      this.wrap = el('div.term-wrap');
      $('#terminals').append(this.wrap);

      this.term = new Terminal({
        ...termOptions(),
        allowProposedApi: true,
        drawBoldTextInBrightColors: true,
        rightClickSelectsWord: false,
        macOptionIsMeta: true,
        smoothScrollDuration: 0,
        fastScrollModifier: 'shift',
      });
      this.fit = new FitAddon.FitAddon();
      this.search = new SearchAddon.SearchAddon();
      this.term.loadAddon(this.fit);
      this.term.loadAddon(this.search);
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) vytty.openExternal(uri); }));
      try {
        this.term.loadAddon(new Unicode11Addon.Unicode11Addon());
        this.term.unicode.activeVersion = '11';
      } catch { /* ignore */ }
      this.term.open(this.wrap);
      this.hl = new VyttyHighlight.Highlighter(this.hlProfile, App.settings.highlight.customRules);

      this.term.onData((d) => this.input(d));
      this.term.onBinary((d) => this.input(d));
      this.term.onResize(({ cols, rows }) => {
        if (this.connId) vytty.conn.resize(this.connId, cols, rows);
        if (App.active === this) App.emit('resize');
      });
      this.term.onBell(() => {
        const b = App.settings.bell;
        if (b === 'sound') beep();
        if (b === 'visual' || b === 'sound') {
          this.wrap.classList.remove('bell');
          void this.wrap.offsetWidth;
          this.wrap.classList.add('bell');
          if (App.active !== this) this.tabEl.classList.add('activity');
        }
      });
      const copySel = debounce(() => {
        if (!App.settings.copyOnSelect || !this.term.hasSelection()) return;
        let text = this.term.getSelection();
        if (App.settings.trimSelection) text = text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
        if (text) vytty.clipboard.write(text);
      }, 120);
      this.term.onSelectionChange(copySel);
      this.term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if (this.state === 'closed' && (e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.altKey && !e.metaKey && App.settings.reconnectKey) {
          e.preventDefault();
          this.connect();
          return false;
        }
        return !App.handleShortcut(e, this);
      });

      this.wrap.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const mode = App.settings.rightClick;
        if (e.shiftKey || mode === 'menu') this.menu(e.clientX, e.clientY);
        else if (mode === 'paste') this.paste();
      });
      this.wrap.addEventListener('mousedown', (e) => {
        if (e.button === 1 && App.settings.middleClick === 'paste') { e.preventDefault(); this.paste(); }
      });
      this.wrap.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        App.zoom(e.deltaY < 0 ? 1 : -1);
      }, { passive: false, capture: true });

      // Drag files from the OS onto an SSH terminal -> SFTP upload.
      this.wrap.addEventListener('dragover', (e) => {
        if (this.source.protocol !== 'ssh' || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        this.wrap.classList.add('drop-hover');
      });
      this.wrap.addEventListener('dragleave', () => this.wrap.classList.remove('drop-hover'));
      this.wrap.addEventListener('drop', (e) => {
        this.wrap.classList.remove('drop-hover');
        if (this.source.protocol !== 'ssh' || !e.dataTransfer.files.length) return;
        e.preventDefault();
        const files = [...e.dataTransfer.files].map((f) => vytty.pathForFile(f)).filter(Boolean);
        App.emit('sftp-upload', this, files);
      });

      // tab header
      this.titleEl = el('span.title', { text: this.title });
      this.dotEl = el('span.status-dot');
      this.tabEl = el('div.tab', {
        draggable: true,
        title: this.title,
        on: {
          mousedown: (e) => { if (e.button === 0) this.activate(); },
          auxclick: (e) => { if (e.button === 1) { e.preventDefault(); this.close(); } },
          dblclick: () => this.rename(),
          contextmenu: (e) => { e.preventDefault(); this.menu(e.clientX, e.clientY, true); },
          dragstart: (e) => { e.dataTransfer.setData('text/vytty-tab', this.id); this.tabEl.classList.add('dragging'); },
          dragend: () => this.tabEl.classList.remove('dragging'),
          dragover: (e) => { if (e.dataTransfer.types.includes('text/vytty-tab')) { e.preventDefault(); this.tabEl.classList.add('drop-before'); } },
          dragleave: () => this.tabEl.classList.remove('drop-before'),
          drop: (e) => {
            this.tabEl.classList.remove('drop-before');
            const other = App.tabs.find((t) => t.id === e.dataTransfer.getData('text/vytty-tab'));
            if (!other || other === this) return;
            App.tabs.splice(App.tabs.indexOf(other), 1);
            App.tabs.splice(App.tabs.indexOf(this), 0, other);
            this.tabEl.before(other.tabEl);
          },
        },
      },
      el('span.tab-color', { style: { background: this.source.color || 'transparent' } }),
      this.dotEl,
      this.titleEl,
      el('span.bcast', { title: 'Receives multi-exec input' }, icon('broadcast', 12)),
      el('button.close', { title: 'Close (Ctrl+Shift+W)', on: { click: (e) => { e.stopPropagation(); this.close(); }, mousedown: (e) => e.stopPropagation() } }, icon('x', 12)));
      this.tabEl.classList.toggle('bcast-on', this.broadcast);
      $('#tabs').append(this.tabEl);
    }

    setState(state, text) {
      this.state = state;
      if (text !== undefined) this.statusText = text;
      this.dotEl.className = `status-dot ${state}`;
      App.emit('tab-state', this);
    }

    // ----------------------------------------------------- connection
    async connect() {
      if (this.connId) { byConn.delete(this.connId); vytty.conn.close(this.connId).catch(() => {}); }
      const saved = this.source.id && App.session(this.source.id);
      if (saved) {
        this.source = saved;
        saved.lastUsed = Date.now();
        App.saveTree();
      }
      if (this.everConnected) this.term.write('\r\n\x1b[2m──── reconnecting ────\x1b[0m\r\n');
      this.connId = uid();
      byConn.set(this.connId, this);
      this.setState('connecting', 'Connecting…');
      this.fitNow();
      try {
        await vytty.conn.open(this.connId, {
          session: App.resolveSession(this.source),
          cols: this.term.cols,
          rows: this.term.rows,
          logEnabled: this.logEnabled,
          logName: this.title,
        });
      } catch (e) {
        this.closed(`Error: ${e.message}`);
      }
    }

    receive(data) {
      if (App.settings.highlight.enabled && this.hlProfile !== 'none') this.hl.process(data, (t) => this.term.write(t));
      else this.term.write(data);
      if (App.active !== this && !this.tabEl.classList.contains('activity')) this.tabEl.classList.add('activity');
    }

    status(state, message) {
      if (state === 'connected') this.everConnected = true;
      this.setState(state, message);
    }

    closed(reason) {
      if (this.connId) byConn.delete(this.connId);
      this.connId = null;
      this.setState('closed', reason);
      if (this.disposed) return;
      const hint = App.settings.reconnectKey ? 'Press R to reconnect' : 'Use Ctrl+Shift+R to reconnect';
      this.term.write(`\r\n\x1b[0m\x1b[1;31m■ ${reason}\x1b[0m  \x1b[2m${hint}\x1b[0m\r\n`);
    }

    send(data) {
      if (this.connId && this.state === 'connected') vytty.conn.write(this.connId, data);
    }

    input(data) {
      if (this.state !== 'connected') return;
      if (App.multiExec && this.broadcast) {
        for (const t of App.tabs) if (t.broadcast) t.send(data);
      } else {
        this.send(data);
      }
    }

    // ------------------------------------------------------ clipboard
    copy() {
      if (!this.term.hasSelection()) return;
      let text = this.term.getSelection();
      if (App.settings.trimSelection) text = text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
      vytty.clipboard.write(text);
      toast('Copied', 'ok', 900);
    }

    async paste(textArg) {
      const text = textArg ?? await vytty.clipboard.read();
      if (!text) return;
      const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
      if (App.settings.confirmMultilinePaste && lines.length > 1) {
        const preview = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n… (${lines.length - 12} more lines)` : '');
        const ok = await modal({
          title: `Paste ${lines.length} lines?`,
          width: 560,
          body: [el('p.muted', { text: `This will send ${lines.length} lines to "${this.title}"${App.multiExec && this.broadcast ? ' and every other multi-exec tab' : ''}.` }), el('pre.hl-preview', { text: preview })],
          buttons: [{ label: 'Cancel', value: false }, { label: 'Paste', value: true, primary: true }],
        });
        if (!ok) { this.focus(); return; }
      }
      this.term.paste(text);
      this.focus();
    }

    // ------------------------------------------------------------ UI
    activate() {
      if (App.active === this) return;
      if (App.active) {
        App.active.wrap.classList.remove('active');
        App.active.tabEl.classList.remove('active');
      }
      App.active = this;
      this.wrap.classList.add('active');
      this.tabEl.classList.add('active');
      this.tabEl.classList.remove('activity');
      this.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      requestAnimationFrame(() => { this.fitNow(); this.focus(); });
      App.emit('tab-changed', this);
    }

    focus() { if (!UI.hasModal()) this.term.focus(); }

    fitNow() {
      if (!this.wrap.classList.contains('active') || this.disposed) return;
      try { this.fit.fit(); } catch { /* not visible */ }
    }

    setTitle(t) {
      this.title = t;
      this.titleEl.textContent = t;
      this.tabEl.title = t;
      App.emit('tab-state', this);
    }

    rename() {
      const input = el('input.title-input', { type: 'text', value: this.title });
      this.titleEl.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const done = (save) => {
        if (finished) return;
        finished = true;
        input.replaceWith(this.titleEl);
        if (save && input.value.trim()) this.setTitle(input.value.trim());
        this.focus();
      };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true), { once: true });
      input.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    setHighlight(profile) {
      this.hlProfile = profile;
      this.hl.setProfile(profile, App.settings.highlight.customRules);
      App.emit('tab-state', this);
      toast(`Highlighting: ${VyttyHighlight.PROFILES[profile]} (applies to new output)`, 'info', 1800);
    }

    toggleBroadcast() {
      this.broadcast = !this.broadcast;
      this.tabEl.classList.toggle('bcast-on', this.broadcast);
    }

    menu(x, y, fromTab) {
      const saved = this.source.id && App.session(this.source.id);
      const sel = this.term.hasSelection();
      contextMenu(x, y, [
        !fromTab ? { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+Shift+C', disabled: !sel, action: () => this.copy() } : null,
        !fromTab ? { label: 'Paste', shortcut: 'Ctrl+Shift+V', action: () => this.paste() } : null,
        !fromTab ? { label: 'Select all', action: () => this.term.selectAll() } : null,
        !fromTab ? { label: 'Find…', icon: 'search', shortcut: 'Ctrl+Shift+F', action: () => App.emit('find') } : null,
        !fromTab ? '-' : null,
        { label: this.state === 'closed' ? 'Reconnect' : 'Reconnect (restart)', icon: 'refresh', shortcut: 'Ctrl+Shift+R', action: () => this.connect() },
        { label: 'Duplicate tab', icon: 'copy', shortcut: 'Ctrl+Shift+T', action: () => App.openSession(this.source) },
        { label: 'Rename tab', icon: 'edit', action: () => this.rename() },
        saved ? { label: 'Edit session…', icon: 'settings', action: () => App.emit('edit-session', saved) } : { label: 'Save as session…', icon: 'plus', action: () => App.Sessions.saveAsSession(this.source) },
        '-',
        { label: 'Highlighting', icon: 'code', submenu: Object.entries(VyttyHighlight.PROFILES).map(([k, n]) => ({ label: n, checked: this.hlProfile === k, action: () => this.setHighlight(k) })) },
        { label: 'Receive multi-exec input', icon: 'broadcast', checked: this.broadcast, action: () => this.toggleBroadcast() },
        { label: 'Clear scrollback', shortcut: 'Ctrl+Shift+L', action: () => this.term.clear() },
        { label: 'Reset terminal', action: () => this.term.reset() },
        '-',
        { label: 'Close', icon: 'x', shortcut: 'Ctrl+Shift+W', action: () => this.close() },
        fromTab ? { label: 'Close others', action: () => App.tabs.filter((t) => t !== this).forEach((t) => t.close(true)) } : null,
        fromTab ? { label: 'Close tabs to the right', action: () => App.tabs.slice(App.tabs.indexOf(this) + 1).forEach((t) => t.close(true)) } : null,
      ]);
    }

    async close(skipConfirm) {
      if (this.state === 'connected' && App.settings.confirmCloseConnected && !skipConfirm) {
        if (!(await confirmBox('Close tab', `"${this.title}" is still connected. Disconnect and close?`, { okLabel: 'Close' }))) return;
      }
      this.disposed = true;
      if (this.connId) { byConn.delete(this.connId); vytty.conn.close(this.connId).catch(() => {}); }
      const idx = App.tabs.indexOf(this);
      App.tabs.splice(idx, 1);
      this.tabEl.remove();
      this.wrap.remove();
      this.term.dispose();
      if (App.active === this) {
        App.active = null;
        const next = App.tabs[idx] || App.tabs[idx - 1];
        if (next) next.activate();
        else { App.renderWelcome(); App.emit('tab-changed', null); }
      } else {
        App.emit('tab-changed', App.active);
      }
    }

    applySettings() {
      const o = termOptions();
      for (const [k, v] of Object.entries(o)) this.term.options[k] = v;
      this.hl.setProfile(this.hlProfile, App.settings.highlight.customRules);
      this.fitNow();
    }
  }

  // ------------------------------------------------------------ app API
  App.openSession = (session) => {
    if (!session) return null;
    const tab = new Tab(session);
    App.tabs.push(tab);
    tab.activate();
    tab.connect();
    return tab;
  };
  App.on('open-session', App.openSession);

  App.zoom = (() => {
    const save = debounce(() => App.saveSettings(), 600);
    return (dir) => {
      const s = App.settings;
      s.fontSize = dir === 0 ? 14 : Math.max(8, Math.min(32, s.fontSize + dir));
      for (const t of App.tabs) { t.term.options.fontSize = s.fontSize; t.fitNow(); }
      App.emit('resize');
      save();
    };
  })();

  App.on('settings', () => App.tabs.forEach((t) => t.applySettings()));
  App.on('theme', () => App.tabs.forEach((t) => { t.term.options.theme = App.theme.term; }));
  App.on('layout', () => requestAnimationFrame(() => App.active && App.active.fitNow()));
  App.on('focus-terminal', () => App.active && App.active.focus());
  // Give the keyboard back to the terminal when the last dialog closes.
  window.addEventListener('vytty:modal-closed', () => {
    const f = document.activeElement;
    if (App.active && (!f || f === document.body || f.closest('.modal'))) App.active.focus();
  });

  vytty.conn.onData((id, data) => { const t = byConn.get(id); if (t) t.receive(data); });
  vytty.conn.onStatus((id, state, msg) => { const t = byConn.get(id); if (t) t.status(state, msg); });
  vytty.conn.onClosed((id, reason) => { const t = byConn.get(id); if (t) t.closed(reason); });

  // ------------------------------------------------------------ find bar
  function initFind() {
    const bar = $('#findbar');
    const input = el('input', { type: 'text', placeholder: 'Find', spellcheck: false });
    const count = el('span.count');
    let caseSensitive = false;
    let regex = false;
    const caseBtn = el('button.icon-btn', { title: 'Match case', on: { click: () => { caseSensitive = !caseSensitive; caseBtn.classList.toggle('on', caseSensitive); run(true); } } }, el('span.lbl', { text: 'Aa' }));
    const reBtn = el('button.icon-btn', { title: 'Regular expression', on: { click: () => { regex = !regex; reBtn.classList.toggle('on', regex); run(true); } } }, el('span.lbl', { text: '.*' }));
    const opts = () => {
      const th = App.theme;
      return {
        caseSensitive, regex,
        decorations: {
          matchBackground: `${th.ui.warn}55`, activeMatchBackground: th.ui.warn, activeMatchBorder: th.ui.warn,
          matchOverviewRuler: th.ui.warn, activeMatchColorOverviewRuler: th.ui.accent,
        },
      };
    };
    let hooked = new WeakSet();
    const hook = (t) => {
      if (hooked.has(t)) return;
      hooked.add(t);
      t.search.onDidChangeResults(({ resultIndex, resultCount }) => {
        count.textContent = resultCount ? `${resultIndex + 1} / ${resultCount}` : 'No results';
      });
    };
    const run = (fresh, back) => {
      const t = App.active;
      if (!t) return;
      hook(t);
      if (!input.value) { t.search.clearDecorations(); count.textContent = ''; return; }
      try {
        if (back) t.search.findPrevious(input.value, opts());
        else t.search.findNext(input.value, { ...opts(), incremental: fresh });
      } catch { count.textContent = 'Bad regex'; }
    };
    const close = () => {
      bar.classList.add('hidden');
      if (App.active) { App.active.search.clearDecorations(); App.active.focus(); }
    };
    input.addEventListener('input', () => run(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(false, e.shiftKey); }
      if (e.key === 'Escape') close();
    });
    bar.append(icon('search', 14), input, count, caseBtn, reBtn,
      el('button.icon-btn', { title: 'Previous (Shift+Enter)', on: { click: () => run(false, true) } }, icon('up', 14)),
      el('button.icon-btn', { title: 'Next (Enter)', on: { click: () => run(false) } }, icon('chevronDown', 14)),
      el('button.icon-btn', { title: 'Close (Esc)', on: { click: close } }, icon('x', 14)));
    App.on('find', () => {
      if (!App.active) return;
      bar.classList.remove('hidden');
      const sel = App.active.term.getSelection();
      if (sel && !sel.includes('\n')) input.value = sel;
      input.focus();
      input.select();
      run(true);
    });
    App.on('tab-changed', () => { if (!bar.classList.contains('hidden')) count.textContent = ''; });
  }

  function initTabbar() {
    const btn = $('#tab-new');
    btn.append(icon('plus', 15));
    btn.addEventListener('click', (e) => {
      const r = btn.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: 'New session…', icon: 'plus', shortcut: 'Ctrl+Shift+N', action: () => App.emit('new-session') },
        { label: 'Quick connect', icon: 'zap', shortcut: 'Ctrl+Shift+K', action: () => $('#qc-input').focus() },
        '-',
        { header: 'Local shell' },
        ...App.localShellMenu(),
      ]);
      e.stopPropagation();
    });
    // double-click empty tab bar area opens a local shell (like browser new tab)
    $('#tabbar').addEventListener('dblclick', (e) => {
      if (e.target.id === 'tabs' || e.target.id === 'tabbar') App.localShellMenu()[0].action();
    });
    $('#tabs').addEventListener('wheel', (e) => { $('#tabs').scrollLeft += e.deltaY; }, { passive: true });

    const ro = new ResizeObserver(debounce(() => App.active && App.active.fitNow(), 30));
    ro.observe($('#terminals'));
  }

  App.Tabs = {
    init() { initTabbar(); initFind(); },
    Tab,
  };
})();
