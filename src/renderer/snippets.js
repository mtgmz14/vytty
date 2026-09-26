'use strict';
// Snippets / macros: saved command text sent to the active tab (or all multi-exec tabs).
(() => {
  const { el, $, icon, modal, confirmBox, contextMenu, toast, uid } = UI;

  // \n and \r = Enter, \t = Tab, \\ = backslash, \xNN = raw byte (e.g. \x03 = Ctrl+C)
  const expand = (text) => text.replace(/\\(n|r|t|\\|x[0-9a-fA-F]{2})/g, (_, c) => {
    if (c === 'n' || c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === '\\') return '\\';
    return String.fromCharCode(parseInt(c.slice(1), 16));
  }).replace(/\r?\n/g, '\r');

  function run(sn) {
    const t = App.active;
    if (!t || t.state !== 'connected') { toast('No connected tab', 'error'); return; }
    t.input(expand(sn.text));
    t.focus();
  }

  async function edit(sn) {
    const isNew = !sn;
    const name = el('input.input', { type: 'text', value: sn ? sn.name : '', placeholder: 'e.g. Show interfaces', autofocus: true });
    const text = el('textarea.input', { rows: 6, placeholder: 'show ip interface brief\\n' });
    text.value = sn ? sn.text : '';
    const res = await modal({
      title: isNew ? 'New snippet' : 'Edit snippet',
      width: 520,
      body: [
        el('label.field', el('span', { text: 'Name' }), name),
        el('label.field', el('span', { text: 'Text to send' }), text, el('span.hint', { text: 'New lines and \\n send Enter. \\t = Tab, \\x03 = Ctrl+C. Without a trailing \\n the text is only typed.' })),
      ],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    });
    if (res !== 'save' || !text.value) return;
    const list = App.settings.snippets;
    if (isNew) list.push({ id: uid(), name: name.value.trim() || text.value.slice(0, 30), text: text.value });
    else Object.assign(sn, { name: name.value.trim() || sn.name, text: text.value });
    await App.saveSettings();
  }

  function render() {
    const scroll = $('#panel-snippets .panel-scroll');
    const list = App.settings.snippets || [];
    if (!list.length) {
      scroll.replaceChildren(el('div.panel-empty', 'Save commands you type often and send them with one click.', el('br'), el('button.btn.small.primary', { on: { click: () => edit() } }, icon('plus', 14), 'New snippet')));
      return;
    }
    scroll.replaceChildren(...list.map((sn) => el('div.snippet', {
      title: `${sn.text}\n\nClick to send${App.multiExec ? ' to all multi-exec tabs' : ''}`,
      on: {
        click: () => run(sn),
        contextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Send', icon: 'play', action: () => run(sn) },
            { label: 'Edit…', icon: 'edit', action: () => edit(sn) },
            { label: 'Move up', disabled: list.indexOf(sn) === 0, action: () => { const i = list.indexOf(sn); list.splice(i - 1, 0, list.splice(i, 1)[0]); App.saveSettings(); } },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, action: async () => {
              if (!(await confirmBox('Delete snippet', `Delete "${sn.name}"?`, { okLabel: 'Delete', danger: true }))) return;
              App.settings.snippets = list.filter((x) => x !== sn);
              App.saveSettings();
            } },
          ]);
        },
      },
    }, icon('code', 14), el('div.body', el('span.name', { text: sn.name }), el('span.text', { text: sn.text })), el('span.run', icon('play', 12)))));
  }

  function init() {
    const panel = $('#panel-snippets');
    panel.append(
      el('div.panel-head', el('span.muted', { text: 'Click to send to the active tab', style: { flex: 1, fontSize: '12px', paddingLeft: '4px' } }),
        el('button.icon-btn', { title: 'New snippet', on: { click: () => edit() } }, icon('plus'))),
      el('div.panel-scroll'));
    App.on('settings', render);
    App.on('multiexec', render);
    render();
  }

  App.Snippets = { init, run, expand };
})();
