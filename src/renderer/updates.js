'use strict';
// Update check: on startup and every few hours (Settings → About can turn it
// off), plus "Check for updates" on demand. Asks before downloading anything.
(() => {
  const { el, modal, confirmBox, toast, fmtSize } = UI;
  const EVERY = 6 * 60 * 60 * 1000;
  let busy = false;
  let timer = null;

  async function check(manual = false) {
    if (busy) return;
    busy = true;
    try {
      let info;
      try { info = await vytty.update.check(); } catch (e) {
        if (manual) toast(`Update check failed: ${e.message}`, 'error', 5000);
        return;
      }
      if (!info.available) {
        if (manual) toast(`Vytty ${info.current} is the latest version`, 'ok');
        return;
      }
      if (!manual && App.settings.updates.skipVersion === info.version) return;
      if (!manual && UI.hasModal()) return; // don't interrupt a dialog; the next check will ask
      await offer(info);
    } finally {
      busy = false;
    }
  }

  async function offer(info) {
    const notes = info.notes.trim();
    const res = await modal({
      title: 'Update available',
      width: 540,
      body: [
        el('p', { text: `Vytty ${info.version} is available. You have ${info.current}.` }),
        notes ? el('div.pre.muted', { style: { maxHeight: '220px', overflow: 'auto', fontSize: '12px', marginBottom: '12px' }, text: notes }) : null,
        info.canInstall
          ? el('p.muted', { style: { fontSize: '12px' }, text: `The new version (${fmtSize(info.asset.size)}) is downloaded next to the current executable. Vytty then restarts; sessions, settings, the vault and logs are kept.` })
          : el('div.notice', { text: 'This copy cannot update itself (not a packaged release build). Download the new version from GitHub instead.' }),
      ],
      buttons: [
        { label: 'Skip this version', value: 'skip', left: true },
        { label: 'Later', value: null },
        { label: info.canInstall ? 'Update now' : 'Open download page', value: 'go', primary: true },
      ],
    });
    if (res === 'skip') {
      App.settings.updates.skipVersion = info.version;
      await App.saveSettings();
      return;
    }
    if (res !== 'go') return;
    if (!info.canInstall) { vytty.openExternal(info.page); return; }

    const live = App.tabs.filter((t) => t.state === 'connected');
    if (live.length) {
      const ok = await confirmBox('Update Vytty', `Vytty restarts after the download. ${live.length} connected session${live.length > 1 ? 's' : ''} will be closed. Continue?`, { okLabel: 'Update' });
      if (!ok) return;
    }
    await install(info);
  }

  async function install(info) {
    const bar = el('div', { style: { height: '100%', width: '0%', background: 'var(--accent)', transition: 'width .15s' } });
    const label = el('p.muted', { style: { fontSize: '12px', marginTop: '8px' }, text: 'Starting download…' });
    const err = el('div.notice.danger.hidden');
    let finished = false;
    const off = vytty.update.onProgress((got, total) => {
      bar.style.width = total ? `${Math.min(100, (got / total) * 100).toFixed(1)}%` : '0%';
      label.textContent = total ? `${fmtSize(got)} of ${fmtSize(total)}` : fmtSize(got);
    });
    const dialog = modal({
      title: `Downloading Vytty ${info.version}`,
      width: 460,
      body: [err, el('div', { style: { height: '8px', borderRadius: '4px', background: 'var(--hover)', overflow: 'hidden' } }, bar), label],
      buttons: [{ label: 'Cancel', value: null }],
    }).then(() => { if (!finished) vytty.update.cancel().catch(() => {}); });

    try {
      await vytty.update.download();
      finished = true;
      label.textContent = 'Restarting…';
      await vytty.update.install();
      vytty.win.forceClose();
    } catch (e) {
      finished = true;
      if (/cancelled/i.test(e.message)) return;
      err.textContent = e.message;
      err.classList.remove('hidden');
      label.textContent = 'The update was not installed. You can download it from GitHub instead.';
    } finally {
      off();
    }
    await dialog;
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!App.settings.updates.autoCheck) return;
    timer = setInterval(() => check(false), EVERY);
  }

  App.checkUpdates = check;
  App.on('settings', schedule);
  App.on('booted', () => {
    schedule();
    if (App.settings.updates.autoCheck) setTimeout(() => check(false), 4000);
  });
})();
