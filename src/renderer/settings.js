'use strict';
// Settings dialog. Changes apply live and are saved immediately.
(() => {
  const { el, icon, modal, confirmBox, inputBox, toast, uid, debounce } = UI;

  const SAMPLE = [
    'core-sw01#show ip interface brief',
    'Interface              IP-Address      OK? Method Status                Protocol',
    'GigabitEthernet1/0/1   10.10.0.1       YES manual up                    up',
    'GigabitEthernet1/0/2   unassigned      YES unset  administratively down down',
    'Vlan10                 192.168.10.1    YES NVRAM  up                    up',
    '*Sep 26 09:14:02.113: %LINK-3-UPDOWN: Interface GigabitEthernet1/0/7, changed state to down',
    'core-sw01(config-if)# description Uplink to dist-sw02',
    'core-sw01(config-if)# no shutdown',
    '% Invalid input detected at \'^\' marker.',
    'nexus01# show interface status',
    'Eth1/1        uplink        connected 1       full    10G     10Gbase-SR',
    'Eth1/2        --            sfpAbsent 1       auto    auto    --',
    'vPC Peer-link status: peer adjacency formed ok',
    'root@srv01:~# systemctl status nginx',
    '     Active: active (running) since 2026-09-26 09:00:00 UTC; 14min ago',
    '[  OK  ] Started nginx.service   [FAILED] Failed to start backup.service',
    '/dev/sda1        50G   46G  4.0G  92% /',
  ].join('\n');

  // Render ANSI SGR text as HTML using the current theme's palette.
  function ansiToHtml(text) {
    const th = App.theme.term;
    const pal = [th.black, th.red, th.green, th.yellow, th.blue, th.magenta, th.cyan, th.white, th.brightBlack, th.brightRed, th.brightGreen, th.brightYellow, th.brightBlue, th.brightMagenta, th.brightCyan, th.brightWhite];
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    let out = '';
    let open = false;
    const parts = text.split(/\x1b\[([\d;]*)m/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { out += esc(parts[i]); continue; }
      if (open) { out += '</span>'; open = false; }
      const codes = parts[i].split(';').map(Number);
      if (codes.length === 1 && codes[0] === 0) continue;
      const css = [];
      for (const c of codes) {
        if (c === 1) css.push('font-weight:700');
        else if (c === 2) css.push('opacity:.6');
        else if (c === 3) css.push('font-style:italic');
        else if (c === 4) css.push('text-decoration:underline');
        else if (c === 7) css.push(`background:${th.foreground};color:${th.background}`);
        else if (c >= 30 && c <= 37) css.push(`color:${pal[c - 30]}`);
        else if (c >= 90 && c <= 97) css.push(`color:${pal[c - 82]}`);
      }
      out += `<span style="${css.join(';')}">`;
      open = true;
    }
    return out + (open ? '</span>' : '');
  }

  const INSTALL_LABEL = {
    portable: 'Portable .exe - updates itself',
    folder: 'Folder from the .zip - updates itself',
    appimage: 'AppImage - updates itself',
    winget: 'Installed with winget - update with: winget upgrade mtgmz14.Vytty',
    store: 'Microsoft Store - updated by the Store',
  };

  // Settings -> Integrations: NetBox, ssh:// links, external tools.
  function integrationsPane(s, set, field, check, select, text, rerender) {
    const nb = s.integrations.netbox;
    const out = [el('h3', { text: 'Integrations' })];

    // ------------------------------------------------------------ NetBox
    const token = el('input.input', { type: 'password', autocomplete: 'new-password', spellcheck: false, placeholder: App.vault.unlocked ? 'API token (read-only is enough)' : 'Unlock the vault to store the token' });
    if (App.vault.unlocked) {
      vytty.vault.get('integration:netbox').then((v) => { if (v && v.token) token.placeholder = 'Saved in the vault - leave empty to keep it'; }).catch(() => {});
    }
    const status = el('div.notice.hidden');
    const show = (msg, kind) => { status.className = `notice ${kind || 'info'}`; status.textContent = msg; };
    const saveToken = async () => {
      const t = token.value.trim();
      if (!t) return true;
      if (!App.vault.unlocked) { show('Unlock the vault (status bar) to store the token.', 'danger'); return false; }
      await vytty.vault.set('integration:netbox', { token: t });
      token.value = '';
      token.placeholder = 'Saved in the vault - leave empty to keep it';
      return true;
    };
    const busy = (btn, on) => { btn.disabled = on; };
    const testBtn = el('button.btn', { type: 'button' }, 'Test connection');
    const syncBtn = el('button.btn.primary', { type: 'button' }, 'Sync now');
    testBtn.addEventListener('click', async () => {
      busy(testBtn, true);
      try {
        const r = await vytty.netbox.test(App.Integrations.netboxOpts(nb, token.value.trim() || undefined));
        show(`Connected to NetBox ${r.version}.`, 'ok');
      } catch (e) { show(e.message, 'danger'); }
      busy(testBtn, false);
    });
    syncBtn.addEventListener('click', async () => {
      busy(syncBtn, true);
      try {
        if (await saveToken()) {
          await App.saveSettings();
          const r = await App.Integrations.netboxSync();
          if (r) show(`Synced: ${r.added} added, ${r.updated} updated.`, 'ok');
        }
      } catch (e) { show(e.message, 'danger'); }
      busy(syncBtn, false);
    });
    out.push(
      el('h4', { text: 'NetBox' }),
      el('p.muted', { text: 'Creates a session for every device (and optionally VM) in NetBox, in folders by site and role. Syncing again updates them; your own changes to credentials, colours and logging are kept.' }),
      field('NetBox URL', text('integrations.netbox.url', { placeholder: 'https://netbox.example.com' })),
      field('API token', token, 'Stored encrypted in the vault, never in settings.json.'),
      el('div.field-row',
        field('Device filter', text('integrations.netbox.deviceFilter', { placeholder: 'status=active&site=waw1&role=switch' }), 'NetBox API query parameters'),
        field('Group into folders by', select('integrations.netbox.groupBy', [['site/role', 'Site / role'], ['site', 'Site'], ['tenant/site', 'Tenant / site'], ['role', 'Role'], ['none', 'No subfolders']]))),
      el('div.field-row',
        field('Connect to', select('integrations.netbox.hostFrom', [['ip', 'Primary IP'], ['dns', 'DNS name of the primary IP'], ['name', 'Device name']])),
        field('Domain for device names', text('integrations.netbox.domain', { placeholder: 'optional, e.g. corp.example' })),
        field('Protocol', select('integrations.netbox.protocol', [['ssh', 'SSH'], ['telnet', 'Telnet']])),
        field('Username', text('integrations.netbox.username', { placeholder: 'optional' }))),
      check('integrations.netbox.includeVMs', 'Include virtual machines'),
      el('div.btn-row', testBtn, syncBtn),
      status,
      nb.lastSync ? el('p.muted', { text: `Last sync: ${new Date(nb.lastSync).toLocaleString()}` }) : null);

    // ------------------------------------------------------------- links
    const linkInfo = el('p.muted', { text: 'Checking…' });
    const linkBtn = el('button.btn', { type: 'button', disabled: true }, '…');
    const refreshLinks = async () => {
      let st;
      try { st = await vytty.urlHandler.status(); } catch { st = { available: false }; }
      if (!st.available) {
        linkInfo.textContent = App.info.platform === 'win32' ? 'Available in the release builds.' : 'Available on Windows.';
        linkBtn.classList.add('hidden');
        return;
      }
      linkInfo.textContent = st.registered ? `ssh:// and telnet:// links open in Vytty (${st.exe}).` : 'ssh:// and telnet:// links open in another program (or nowhere).';
      linkBtn.disabled = false;
      linkBtn.textContent = st.registered ? 'Stop handling links' : 'Open ssh:// and telnet:// links with Vytty';
      linkBtn.onclick = async () => {
        try {
          await vytty.urlHandler.set(!st.registered);
          set('integrations.urlHandler', !st.registered);
        } catch (e) { toast(e.message, 'error'); }
        refreshLinks();
      };
    };
    refreshLinks();
    out.push(
      el('h4', { text: 'ssh:// and telnet:// links' }),
      el('p.muted', { text: 'Clicking an ssh:// or telnet:// link (in NetBox, Zabbix, LibreNMS, a wiki...) opens a tab in Vytty - the saved session for that host if there is one. Links only open connections; they cannot run commands.' }),
      linkInfo, el('div.btn-row', linkBtn));

    // ---------------------------------------------------- external tools
    const tools = s.externalTools;
    const list = el('div');
    const saveTools = () => set('externalTools', tools);
    const renderTools = () => {
      list.replaceChildren(...(tools.length ? tools.map((t) => {
        const name = el('input.input', { type: 'text', value: t.name || '', placeholder: 'Name' });
        const prog = el('input.input', { type: 'text', value: t.type === 'url' ? '(web browser)' : (t.path || ''), placeholder: 'Program path', disabled: t.type === 'url', spellcheck: false });
        const args = el('input.input.mono', { type: 'text', value: t.args || '', placeholder: '{host} {port} {user}', spellcheck: false });
        const upd = () => { t.name = name.value; if (t.type !== 'url') t.path = prog.value.trim(); t.args = args.value; saveTools(); };
        [name, prog, args].forEach((n) => n.addEventListener('input', upd));
        const browse = el('button.icon-btn', { type: 'button', title: 'Browse…', disabled: t.type === 'url', on: { click: async () => { const p = await vytty.dialog.openFile({ title: 'Program' }); if (p) { prog.value = p; upd(); } } } }, icon('folder', 14));
        const del = el('button.icon-btn', { type: 'button', title: 'Remove', on: { click: () => { tools.splice(tools.indexOf(t), 1); saveTools(); renderTools(); } } }, icon('trash', 14));
        return el('div.tool-row', name, prog, args, browse, del);
      }) : [el('p.muted', { text: 'No tools yet. Add WinSCP, PuTTY, Remote Desktop, a web UI... and open them from a session\'s menu (Open with).' })]));
    };
    renderTools();
    const addPreset = async (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      let presets = [];
      try { presets = await vytty.tools.presets(); } catch { /* ignore */ }
      UI.contextMenu(r.left, r.bottom + 2, [
        ...presets.map((p) => ({ label: `${p.name}${p.installed ? '' : ' (not found)'}`, action: () => { tools.push({ id: uid(), enabled: true, ...p, installed: undefined }); saveTools(); renderTools(); } })),
        '-',
        { label: 'Custom program…', action: () => { tools.push({ id: uid(), enabled: true, name: 'New tool', type: 'program', path: '', args: '{host}', protocols: ['ssh', 'telnet'] }); saveTools(); renderTools(); } },
        { label: 'Custom web address…', action: () => { tools.push({ id: uid(), enabled: true, name: 'Web UI', type: 'url', args: 'https://{host}/', protocols: ['ssh', 'telnet'] }); saveTools(); renderTools(); } },
      ]);
    };
    out.push(
      el('h4', { text: 'External tools' }),
      el('p.muted', { text: 'Placeholders: {host} {port} {user} {userAt} {name} {protocol} {keyPath}. Programs are started directly (no shell), only when you pick them.' }),
      list,
      el('div.btn-row', el('button.btn.small', { type: 'button', on: { click: addPreset } }, icon('plus', 12), 'Add tool')));
    return out;
  }

  async function openSettings(section = 'Appearance') {
    const s = App.settings;
    const save = debounce(() => App.saveSettings(), 250);
    const set = (path, value) => {
      const keys = path.split('.');
      let o = s;
      for (const k of keys.slice(0, -1)) o = o[k];
      o[keys[keys.length - 1]] = value;
      save();
    };
    const get = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), s);

    const field = (label, control, hint) => el('label.field', el('span', { text: label }), control, hint ? el('span.hint', { text: hint }) : null);
    const check = (path, label, hint) => {
      const cb = el('input', { type: 'checkbox', checked: !!get(path) });
      cb.addEventListener('change', () => set(path, cb.checked));
      return el('label.check', cb, el('span', { text: label }), hint ? el('span.hint', { text: hint }) : null);
    };
    const select = (path, options, cast = String) => {
      const sel = el('select.input', options.map(([v, l]) => el('option', { value: String(v), text: l })));
      sel.value = String(get(path));
      sel.addEventListener('change', () => set(path, cast(sel.value)));
      return sel;
    };
    const text = (path, props = {}, cast = String) => {
      const inp = el('input.input', { type: 'text', value: get(path) ?? '', spellcheck: false, ...props });
      inp.addEventListener('input', () => set(path, cast(inp.value)));
      return inp;
    };
    const num = (path, min, max) => text(path, { type: 'number', min, max }, (v) => Math.max(min, Math.min(max, Number(v) || min)));

    const sections = {};

    // ----------------------------------------------------- appearance
    sections.Appearance = () => {
      const grid = el('div.theme-grid');
      const paint = () => grid.replaceChildren(...Object.entries(VYTTY_THEMES).map(([id, th]) => el(`div.theme-card${s.theme === id ? '.sel' : ''}`, {
        on: { click: async () => { await App.setTheme(id); paint(); } },
      }, el('div.preview', { style: { background: th.term.background, color: th.term.foreground },
        html: `<span style="color:${th.term.green}">user@host</span>:<span style="color:${th.term.blue}">~</span>$ ls<br><span style="color:${th.term.cyan}">10.0.0.1</span> <span style="color:${th.term.red}">down</span> <span style="color:${th.term.green}">up</span>` }),
      el('div.tname', { text: th.name, style: { background: th.ui.panel, color: th.ui.text } }))));
      paint();
      const styles = el('div.segmented', Object.entries(VYTTY_UI_STYLES).map(([id, st]) => el(`button${(s.uiStyle || 'minimal') === id ? '.active' : ''}`, {
        type: 'button', title: st.desc, on: { click: async () => { await App.setStyle(id); rerender(); } },
      }, st.name)));
      return [
        el('h3', { text: 'Appearance' }),
        el('h4', { text: 'Interface' }), styles,
        el('p.muted', { style: { marginTop: '-4px' }, text: (VYTTY_UI_STYLES[s.uiStyle] || VYTTY_UI_STYLES.minimal).desc }),
        el('h4', { text: 'Colours' }), grid,
        el('h4', { text: 'Terminal font' }),
        el('div.field-row',
          field('Font family', text('fontFamily'), 'Any installed monospace font, comma separated fallbacks'),
          field('Size', num('fontSize', 8, 32)),
          field('Line height', text('lineHeight', { type: 'number', step: 0.05, min: 1, max: 2 }, (v) => Number(v) || 1))),
        el('div.field-row',
          field('Cursor', select('cursorStyle', [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']])),
          field('Scrollback lines', num('scrollback', 1000, 500000))),
        check('cursorBlink', 'Blinking cursor'),
      ];
    };

    // ----------------------------------------------- terminal & mouse
    sections['Mouse & clipboard'] = () => [
      el('h3', { text: 'Mouse & clipboard' }),
      check('copyOnSelect', 'Copy selected text to the clipboard automatically'),
      check('trimSelection', 'Trim trailing spaces from copied lines'),
      field('Right click', select('rightClick', [['paste', 'Paste clipboard'], ['menu', 'Show context menu'], ['none', 'Do nothing']]), 'Shift + right click always opens the context menu'),
      field('Middle click', select('middleClick', [['paste', 'Paste clipboard'], ['none', 'Do nothing']])),
      check('confirmMultilinePaste', 'Ask before pasting multiple lines'),
      field('Word separators (double-click selection)', text('wordSeparator')),
      el('h4', { text: 'Behaviour' }),
      field('Bell', select('bell', [['visual', 'Flash the terminal'], ['sound', 'Beep + flash'], ['none', 'Ignore']])),
      check('reconnectKey', 'Press R in a disconnected tab to reconnect'),
      check('confirmCloseConnected', 'Confirm before closing a connected tab'),
    ];

    // ----------------------------------------------------- highlighting
    sections.Highlighting = () => {
      const preview = el('div.hl-preview', { style: { background: App.theme.term.background, color: App.theme.term.foreground } });
      const profileSel = el('select.input', Object.entries(VyttyHighlight.PROFILES).map(([k, n]) => el('option', { value: k, text: n })));
      profileSel.value = s.highlight.defaultProfile;
      const refresh = () => { preview.innerHTML = ansiToHtml(VyttyHighlight.colorize(SAMPLE, profileSel.value, s.highlight.customRules)); };
      profileSel.addEventListener('change', () => { set('highlight.defaultProfile', profileSel.value); refresh(); });

      const rulesBox = el('div');
      const styleOptions = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'gray', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'bold red', 'bold green', 'bold yellow', 'bold', 'inverse', 'underline', 'italic gray'];
      const renderRules = () => {
        rulesBox.replaceChildren(...s.highlight.customRules.map((r) => {
          const en = el('input', { type: 'checkbox', checked: r.enabled !== false, title: 'Enabled' });
          const name = el('input.input', { type: 'text', value: r.name || '', placeholder: 'Name' });
          const pat = el('input.input.mono', { type: 'text', value: r.pattern || '', placeholder: 'Regex, e.g. \\bVLAN\\d+\\b', spellcheck: false });
          const style = el('select.input', styleOptions.map((o) => el('option', { value: o, text: o })));
          style.value = r.style || 'yellow';
          const upd = () => {
            Object.assign(r, { enabled: en.checked, name: name.value, pattern: pat.value, style: style.value });
            try { new RegExp(pat.value); pat.style.borderColor = ''; } catch { pat.style.borderColor = 'var(--danger)'; }
            save();
            refresh();
          };
          [en, name, pat, style].forEach((n) => n.addEventListener('input', upd));
          return el('div.rule-row', en, name, pat, style, el('button.icon-btn', { type: 'button', title: 'Remove', on: { click: () => { s.highlight.customRules.splice(s.highlight.customRules.indexOf(r), 1); save(); renderRules(); refresh(); } } }, icon('trash', 14)));
        }));
      };
      renderRules();
      refresh();
      const enabled = check('highlight.enabled', 'Enable syntax highlighting');
      return [
        el('h3', { text: 'Syntax highlighting' }),
        enabled,
        field('Default profile for new sessions', profileSel, 'Each session can override it; the status bar switches it per tab.'),
        el('h4', { text: 'Preview' }), preview,
        el('h4', { text: 'Custom rules (applied before the built-in ones)' }),
        rulesBox,
        el('button.btn.small', { type: 'button', on: { click: () => { s.highlight.customRules.push({ id: uid(), name: '', pattern: '', style: 'yellow', enabled: true }); renderRules(); } } }, icon('plus', 12), 'Add rule'),
      ];
    };

    // ---------------------------------------------------------- logging
    sections.Logging = () => {
      const dir = text('logging.dir', { placeholder: App.info.logDir });
      return [
        el('h3', { text: 'Session logging' }),
        el('div.notice.info', { text: 'Every device gets one file per day: hostname#YYYY-MM-DD.log. The hostname is read from the device prompt (e.g. SW1#, user@host:~$), so all sessions to the same device that day append to the same file, with open/close markers. If no prompt is recognised the session\'s host address is used. Escape codes are stripped.' }),
        check('logging.enabled', 'Log session output'),
        field('Log folder', el('div.with-btn', dir, el('button.btn', { type: 'button', on: { click: async () => { const p = await vytty.dialog.openDir(); if (p) { dir.value = p; set('logging.dir', p); } } } }, 'Browse'),
          el('button.btn', { type: 'button', on: { click: () => vytty.logs.open() } }, 'Open')), 'Leave empty for the portable data folder'),
        check('logging.timestamps', 'Prefix every line with a timestamp [HH:MM:SS]'),
        check('logging.sessionTag', 'Prefix every line with the session name', '(keeps parallel sessions readable)'),
      ];
    };

    // ------------------------------------------------------ connections
    sections.Connections = () => [
      el('h3', { text: 'Connections' }),
      el('h4', { text: 'SSH' }),
      el('div.field-row',
        field('Keepalive interval (seconds, 0 = off)', num('ssh.keepaliveInterval', 0, 3600)),
        field('Connect timeout (ms)', num('ssh.readyTimeout', 3000, 120000))),
      check('ssh.legacyAlgorithms', 'Allow legacy algorithms by default', '(new sessions)'),
      el('h4', { text: 'Known hosts' }),
      el('p.muted', { text: 'Host key fingerprints are kept in known_hosts.json inside the data folder. A changed key always asks before connecting.' }),
    ];

    // ----------------------------------------------------------- vault
    sections['Vault & security'] = () => {
      const st = App.vault;
      const box = el('div');
      const info = el('div.kv',
        el('span.k', { text: 'Status' }), el('span.v', { text: !st.exists ? 'Not set up' : st.unlocked ? 'Unlocked' : 'Locked' }),
        el('span.k', { text: 'Protection' }), el('span.v', { text: st.mode === 'master' ? 'Master password (AES-256-GCM, scrypt)' : st.mode === 'none' ? 'No master password (obfuscated only)' : '-' }),
        el('span.k', { text: 'Stored credentials' }), el('span.v', { text: String(st.count ?? '-') }));
      box.append(info, el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } },
        st.unlocked && st.mode === 'master' ? el('button.btn', { type: 'button', on: { click: async () => { await App.vaultLock(); rerender(); } } }, icon('lock', 14), 'Lock now') : null,
        !st.unlocked && st.exists ? el('button.btn', { type: 'button', on: { click: async () => { await App.vaultUnlock(); rerender(); } } }, icon('unlock', 14), 'Unlock') : null,
        st.unlocked ? el('button.btn', { type: 'button', on: { click: async () => { await App.vaultChangeMaster(); rerender(); } } }, icon('key', 14), st.mode === 'master' ? 'Change master password' : 'Set a master password') : null,
        !st.exists ? el('button.btn.primary', { type: 'button', on: { click: async () => { await App.vaultSetup(); rerender(); } } }, 'Set up vault') : null));
      return [el('h3', { text: 'Vault & security' }),
        st.mode === 'none' ? el('div.notice', { text: 'Passwords are encrypted with a built-in key. Anyone with the data folder can decrypt them. Set a master password for real protection.' }) : null,
        box];
    };

    // ----------------------------------------------------- credentials
    sections.Credentials = () => App.Credentials.pane(rerender);

    // -------------------------------------------------------- sessions
    sections['Import / export'] = () => {
      const IMPORTS = [
        ['mobaxterm', 'MobaXterm…'], ['putty', 'PuTTY / KiTTY (.reg)…'], ['securecrt', 'SecureCRT (XML)…'], ['securecrt-dir', 'SecureCRT session folder…'],
        ['mremoteng', 'mRemoteNG…'], ['sshconfig', 'OpenSSH config…'], ['csv', 'CSV…'],
      ];
      const help = el('p.muted', { style: { fontSize: '12px', minHeight: '18px' }, text: 'Point at a button to see where to get the file.' });
      const importBtn = ([fmt, label]) => el('button.btn', {
        type: 'button',
        on: { click: () => App.Integrations.importFrom(fmt), mouseenter: () => { help.textContent = App.Integrations.HELP[fmt] || ''; } },
      }, label);
      return [
        el('h3', { text: 'Import / export' }),
        el('h4', { text: 'Vytty' }),
        el('p.muted', { text: 'All folders, sessions and credentials as JSON. Passwords are included only when you give an export password (they are encrypted with it).' }),
        el('div.btn-row',
          el('button.btn', { type: 'button', on: { click: exportSessions } }, icon('download', 14), 'Export…'),
          el('button.btn', { type: 'button', on: { click: importSessions } }, icon('upload', 14), 'Import Vytty file…')),
        el('h4', { text: 'Import from other tools' }),
        el('div.btn-row', IMPORTS.map(importBtn)),
        help,
        el('div.notice', { text: 'MobaXterm, PuTTY and SecureCRT exports do not contain passwords. After importing, set one password per username (offered right away, or Settings → Credentials), paste passwords per host in bulk, or let Vytty save each one the first time you connect. mRemoteNG passwords are imported.' }),
        el('div.btn-row', el('button.btn', { type: 'button', on: { click: bulkPasswords } }, icon('key', 14), 'Add passwords in bulk…')),
        el('h4', { text: 'Export for other tools' }),
        el('p.muted', { text: 'Passwords are never written to these files.' }),
        el('div.btn-row',
          el('button.btn', { type: 'button', on: { click: () => App.Integrations.exportAs('sshconfig') } }, 'OpenSSH config…'),
          el('button.btn', { type: 'button', on: { click: () => App.Integrations.exportAs('csv') } }, 'CSV (Excel)…'),
          el('button.btn', { type: 'button', on: { click: () => App.Integrations.exportAs('ansible') } }, 'Ansible inventory…')),
      ];
    };

    sections.Integrations = () => integrationsPane(s, set, field, check, select, text, rerender);

    sections.About = () => [
      el('h3', { text: 'About Vytty' }),
      el('div.kv',
        el('span.k', { text: 'Version' }), el('span.v', { text: App.info.version }),
        el('span.k', { text: 'Data folder' }), el('span.v', el('a', { href: '#', text: App.info.dataDir, on: { click: (e) => { e.preventDefault(); vytty.openPath(App.info.dataDir); } } })),
        el('span.k', { text: 'Log folder' }), el('span.v', { text: App.info.logDir }),
        el('span.k', { text: 'Serial support' }), el('span.v', { text: App.info.capabilities.serial ? 'yes' : 'no' }),
        el('span.k', { text: 'Local shells' }), el('span.v', { text: App.info.capabilities.local ? 'yes' : 'no' }),
        el('span.k', { text: 'License' }), el('span.v', { text: 'MIT' })),
      el('h4', { text: 'Updates' }),
      check('updates.autoCheck', 'Check for new versions automatically', '(at startup and every 6 hours)'),
      field('When a new version is available', select('updates.install', [['ask', 'Ask, then download, verify and install it'], ['notify', 'Only tell me - I download it myself']]),
        'Downloads are installed only when their SHA-256 matches the release\'s signed checksum list (Ed25519). "Only tell me" never downloads anything, which suits managed work PCs.'),
      el('div.kv', { style: { margin: '6px 0 12px' } },
        el('span.k', { text: 'Installation' }), el('span.v', { text: INSTALL_LABEL[App.info.install && App.info.install.mode] || 'Development copy' })),
      el('button.btn.small', { type: 'button', on: { click: () => App.checkUpdates(true) } }, icon('download', 12), 'Check for updates now'),
      el('p.muted', { style: { marginTop: '16px' }, text: 'Vytty is portable: copy the executable together with the VyttyData folder to take all sessions, settings, the vault and logs with you.' }),
      el('button.btn.small', { type: 'button', on: { click: () => vytty.win.devtools() } }, 'Developer tools'),
    ];

    const icons = { Appearance: 'palette', 'Mouse & clipboard': 'copy', Highlighting: 'code', Logging: 'logs', Connections: 'server', 'Vault & security': 'lock', Credentials: 'key', 'Import / export': 'download', Integrations: 'link', About: 'info' };
    const nav = el('div.settings-nav');
    const content = el('div.settings-content');
    let current = sections[section] ? section : 'Appearance';
    const rerender = () => {
      nav.replaceChildren(...Object.keys(sections).map((k) => el(`button${k === current ? '.active' : ''}`, { type: 'button', on: { click: () => { current = k; rerender(); } } }, icon(icons[k], 14), k)));
      content.replaceChildren(...[].concat(sections[current]()).filter(Boolean));
      const scroller = content.closest('.modal-body');
      if (scroller) scroller.scrollTop = 0;
    };
    rerender();
    await modal({ title: 'Settings', width: 820, className: 'tall', focus: 'primary', body: el('div.settings', nav, content), buttons: [{ label: 'Done', primary: true }] });
    await App.saveSettings();
  }

  async function exportSessions() {
    const r = await inputBox('Export sessions', 'Export password (optional - leave empty to export without passwords)', { password: true });
    if (r === null) return;
    if (r.value && !App.vault.unlocked) { toast('Unlock the vault to export passwords', 'error'); return; }
    try {
      const file = await vytty.sessions.export(App.tree, r.value || null);
      if (file) toast(`Exported to ${file}`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function importSessions() {
    let data;
    try { data = await vytty.sessions.importRead(); } catch (e) { toast(e.message, 'error'); return; }
    if (!data) return;
    const folderMap = {};
    const idMap = {};
    for (const f of data.folders || []) folderMap[f.id] = uid();
    for (const f of data.folders || []) App.tree.folders.push({ ...f, id: folderMap[f.id], parentId: f.parentId ? folderMap[f.parentId] : null });
    for (const s of data.sessions || []) idMap[s.id] = uid();
    // Jump hosts point at sessions of the same file (sessions already in the
    // tree are left alone, even if their ids happen to match).
    for (const s of data.sessions || []) {
      App.tree.sessions.push({ ...s, id: idMap[s.id], folderId: s.folderId ? folderMap[s.folderId] || null : null, jumpId: s.jumpId ? idMap[s.jumpId] || null : null });
    }
    const credMap = {};
    if (!App.tree.credentials) App.tree.credentials = [];
    for (const c of data.credentials || []) {
      credMap[c.id] = uid();
      idMap[`cred:${c.id}`] = `cred:${credMap[c.id]}`;
      App.tree.credentials.push({ ...c, id: credMap[c.id] });
    }
    for (const s of data.sessions || []) {
      const ns = App.session(idMap[s.id]);
      if (ns && s.credentialId && s.credentialId !== 'none') ns.credentialId = credMap[s.credentialId] || null;
    }
    if (data.secrets) {
      if (!App.vault.unlocked) toast('Vault locked - passwords were not imported', 'error');
      else {
        const r = await inputBox('Import passwords', 'Export password used for this file', { password: true });
        if (r && r.value) {
          try { await vytty.sessions.importSecrets(data.secrets, r.value, idMap); } catch (e) { toast(e.message, 'error'); }
        }
      }
    }
    await App.saveTree();
    toast(`Imported ${(data.sessions || []).length} sessions`, 'ok');
  }

  // Attach passwords in bulk. The user pastes one session per line:
  //   host  user  password    or    host  password    or    name  password
  // (separated by tab, comma, or 2+ spaces). Matches by host+user, then host, then name.
  async function bulkPasswords() {
    if (!App.vault.unlocked) {
      toast('Unlock the vault first (status bar) to store passwords', 'error');
      return;
    }
    const ta = el('textarea.input', { rows: 10, spellcheck: false, placeholder: 'core-sw01\tadmin\tS3cret!\n10.0.0.2, admin, hunter2\nweb-prod-01   r00tpass', style: { fontFamily: 'var(--mono)' } });
    const res = await modal({
      title: 'Add passwords in bulk',
      width: 560,
      body: [
        el('p.muted', { text: 'One session per line. Columns separated by Tab, comma, or two or more spaces:' }),
        el('div.kv',
          el('span.k', { text: 'host  user  password' }), el('span.v', { text: 'matched by host + username' }),
          el('span.k', { text: 'host  password' }), el('span.v', { text: 'matched by host' }),
          el('span.k', { text: 'name  password' }), el('span.v', { text: 'matched by session name' })),
        ta,
        el('p.muted', { text: 'Passwords are stored in Vytty\'s encrypted vault. Nothing is sent anywhere.' }),
      ],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'apply', primary: true }],
    });
    if (res !== 'apply' || !ta.value.trim()) return;

    const sessions = App.tree.sessions;
    const byHostUser = new Map();
    const byHost = new Map();
    const byName = new Map();
    for (const s of sessions) {
      if (s.host) {
        byHost.set(s.host.toLowerCase(), s);
        if (s.username) byHostUser.set(`${s.host.toLowerCase()}|${s.username.toLowerCase()}`, s);
      }
      byName.set(s.name.toLowerCase(), s);
    }

    let matched = 0;
    let unmatched = 0;
    const fails = [];
    for (const rawLine of ta.value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const cols = line.split(/\t|\s{2,}|\s*,\s*/).map((c) => c.trim()).filter((c, i, a) => c !== '' || i < a.length - 1);
      if (cols.length < 2) { unmatched++; fails.push(line); continue; }
      const password = cols[cols.length - 1];
      let session = null;
      if (cols.length >= 3) session = byHostUser.get(`${cols[0].toLowerCase()}|${cols[1].toLowerCase()}`) || byHost.get(cols[0].toLowerCase());
      if (!session) session = byHost.get(cols[0].toLowerCase()) || byName.get(cols[0].toLowerCase());
      if (!session) { unmatched++; fails.push(cols[0]); continue; }
      try {
        const cur = await vytty.vault.get(session.id);
        await vytty.vault.set(session.id, { ...cur, password });
        matched++;
      } catch (e) { fails.push(`${cols[0]}: ${e.message}`); }
    }
    await App.refreshVault();
    toast(`Set ${matched} password${matched === 1 ? '' : 's'}${unmatched ? `, ${unmatched} not matched` : ''}`, matched ? 'ok' : 'error', 4000);
    if (fails.length) {
      modal({
        title: 'Some lines were not matched',
        width: 480,
        body: [el('p.muted', { text: 'These lines did not match any imported session (check the host or name):' }), el('pre.hl-preview', { text: fails.slice(0, 40).join('\n') + (fails.length > 40 ? `\n… (${fails.length - 40} more)` : '') })],
        buttons: [{ label: 'OK', primary: true }],
      });
    }
  }

  App.on('open-settings', (sec) => openSettings(sec));
  App.Settings = { open: openSettings, ansiToHtml };
})();
