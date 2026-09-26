'use strict';
// Credential profiles (like MobaXterm "User credentials"): a name, a username and
// a password kept in the vault as "cred:<id>". A session can pick a profile, or
// with "auto" on, every session whose username matches uses that password.
(() => {
  const { el, icon, modal, confirmBox, toast, uid } = UI;

  const list = () => {
    if (!App.tree.credentials) App.tree.credentials = [];
    return App.tree.credentials;
  };

  const needVault = () => {
    if (App.vault.unlocked) return true;
    toast('Unlock the vault first (status bar) to store passwords', 'error');
    return false;
  };

  async function setPassword(id, password) {
    const key = `cred:${id}`;
    if (password) await vytty.vault.set(key, { password });
    else await vytty.vault.remove(key);
  }

  // Sessions that currently resolve to this profile.
  const usage = (cred) => App.tree.sessions.filter((s) => { const c = App.credentialFor(s); return c && c.id === cred.id; }).length;

  async function edit(cred, defaults = {}) {
    if (!needVault()) return null;
    const isNew = !cred;
    let current = '';
    if (!isNew) { try { current = (await vytty.vault.get(`cred:${cred.id}`)).password || ''; } catch { /* ignore */ } }
    const name = el('input.input', { type: 'text', value: cred ? cred.name : (defaults.name || ''), placeholder: 'e.g. Cisco admin', autofocus: true });
    const username = el('input.input', { type: 'text', value: cred ? cred.username : (defaults.username || ''), placeholder: 'admin', spellcheck: false });
    const password = el('input.input', { type: 'password', value: current, autocomplete: 'new-password' });
    const show = el('button.icon-btn', { type: 'button', title: 'Show / hide', on: { click: () => { password.type = password.type === 'password' ? 'text' : 'password'; } } }, icon('key', 14));
    const auto = el('input', { type: 'checkbox', checked: cred ? cred.auto !== false : true });
    const err = el('div.notice.danger.hidden');
    const res = await modal({
      title: isNew ? 'New credential' : `Edit credential: ${cred.name}`,
      width: 480,
      body: [
        err,
        el('label.field', el('span', { text: 'Name' }), name),
        el('div.field-row',
          el('label.field', el('span', { text: 'Username' }), username),
          el('label.field', el('span', { text: 'Password' }), el('div.with-btn', password, show))),
        el('label.check', auto, el('span', { text: 'Use automatically for every session with this username' })),
        el('p.muted', { style: { fontSize: '12px' }, text: 'Sessions can also pick this credential explicitly in their settings. A password saved in a session itself always wins.' }),
      ],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true, validate: () => {
        const msg = !username.value.trim() ? 'Username is required' : '';
        err.textContent = msg;
        err.classList.toggle('hidden', !msg);
        return !msg;
      } }],
    });
    if (res !== 'save') return null;
    const data = { name: name.value.trim() || username.value.trim(), username: username.value.trim(), auto: auto.checked };
    let target = cred;
    if (isNew) { target = { id: uid(), ...data }; list().push(target); } else Object.assign(cred, data);
    try { await setPassword(target.id, password.value); } catch (e) { toast(`Vault: ${e.message}`, 'error'); }
    await App.saveTree();
    App.refreshVault();
    return target;
  }

  async function remove(cred) {
    const n = App.tree.sessions.filter((s) => s.credentialId === cred.id).length;
    if (!(await confirmBox('Delete credential', `Delete "${cred.name}" (${cred.username})?${n ? `\n${n} session${n > 1 ? 's' : ''} that picked it will fall back to automatic matching.` : ''}`, { okLabel: 'Delete', danger: true }))) return;
    App.tree.credentials = list().filter((c) => c !== cred);
    for (const s of App.tree.sessions) if (s.credentialId === cred.id) s.credentialId = null;
    try { await vytty.vault.remove(`cred:${cred.id}`); } catch { /* ignore */ }
    await App.saveTree();
  }

  // Settings pane content.
  function pane(rerender) {
    const rows = list().map((c) => el('div.cred-row',
      icon('key', 14),
      el('div.cred-main', el('b', { text: c.name }), el('span.muted', { text: ` ${c.username}` })),
      el('span.cred-meta', { text: `${c.auto !== false ? 'auto · ' : ''}${usage(c)} session${usage(c) === 1 ? '' : 's'}` }),
      el('button.icon-btn', { type: 'button', title: 'Edit', on: { click: async () => { await edit(c); rerender(); } } }, icon('edit', 14)),
      el('button.icon-btn', { type: 'button', title: 'Delete', on: { click: async () => { await remove(c); rerender(); } } }, icon('trash', 14))));
    return [
      el('h3', { text: 'Credentials' }),
      el('p.muted', { text: 'Predefined username + password pairs, like MobaXterm user credentials. With "auto" on, every session whose username matches uses that password, so one entry covers all devices with the same login. Passwords are stored in the encrypted vault.' }),
      !App.vault.unlocked ? el('div.notice', { text: 'The vault is locked. Unlock it to add or edit credentials.' }) : null,
      rows.length ? el('div.cred-list', rows) : el('p.muted', { text: 'No credentials yet.' }),
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
        el('button.btn.primary', { type: 'button', on: { click: async () => { await edit(); rerender(); } } }, icon('plus', 14), 'New credential'),
        el('button.btn', { type: 'button', on: { click: async () => { await perUser(); rerender(); } } }, icon('key', 14), 'Passwords per username…')),
    ];
  }

  // One password per distinct username found in the sessions (e.g. after a
  // MobaXterm import). Creates or updates an "auto" credential for each.
  async function perUser(onlyIds) {
    if (!needVault()) return;
    const pool = onlyIds ? App.tree.sessions.filter((s) => onlyIds.has(s.id)) : App.tree.sessions;
    const counts = new Map();
    for (const s of pool) {
      if (!s.username || s.protocol === 'local') continue;
      const key = s.username.trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!counts.size) { toast('No sessions with a username', 'error'); return; }
    const existing = (u) => list().find((c) => c.auto !== false && c.username.toLowerCase() === u.toLowerCase());
    const inputs = [];
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([user, n]) => {
      const cred = existing(user);
      const input = el('input.input', { type: 'password', autocomplete: 'new-password', placeholder: cred ? 'unchanged (already set)' : 'leave empty to skip' });
      inputs.push({ user, input, cred });
      return el('div.peruser-row', el('div', el('b', { text: user }), el('span.muted', { text: ` · ${n} session${n > 1 ? 's' : ''}` })), input);
    });
    const res = await modal({
      title: 'Passwords per username',
      width: 540,
      body: [
        el('p.muted', { text: 'Set one password for each login. Every session with that username will use it (you can still override it per session). Empty fields are skipped.' }),
        el('div.peruser-list', rows),
      ],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    });
    if (res !== 'save') return;
    let n = 0;
    for (const { user, input, cred } of inputs) {
      if (!input.value) continue;
      let target = cred;
      if (!target) { target = { id: uid(), name: user, username: user, auto: true }; list().push(target); }
      try { await setPassword(target.id, input.value); n++; } catch (e) { toast(`Vault: ${e.message}`, 'error'); }
    }
    await App.saveTree();
    App.refreshVault();
    if (n) toast(`Saved ${n} credential${n > 1 ? 's' : ''}`, 'ok');
  }

  App.Credentials = { edit, remove, pane, perUser, list };
})();
