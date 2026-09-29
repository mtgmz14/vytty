'use strict';
// Update check: on startup and every few hours (Settings → About can turn it
// off), plus "Check for updates" on demand. Asks before downloading anything.
// The portable .exe is also offered a one-time switch to the folder version,
// which starts much faster (the .exe unpacks the whole app on every start).
(() => {
  const { el, modal, confirmBox, toast, fmtSize } = UI;
  const EVERY = 6 * 60 * 60 * 1000;
  let busy = false;
  let timer = null;

  const isPortable = () => App.info.install && App.info.install.mode === 'portable';
  const folderNote = () => (App.info.install.folderTarget === App.info.dataDir.replace(/[\\/]VyttyData$/i, '')
    ? `Vytty.exe and its files are unpacked into ${App.info.install.folderTarget}, next to your VyttyData (sessions, settings, vault and logs stay where they are), and the old .exe is removed.`
    : `It goes to ${App.info.install.folderTarget}; your sessions, settings, vault and logs (VyttyData) move with it and the old .exe is removed.`);

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

  const shortcutBox = () => el('input', { type: 'checkbox', checked: true });

  async function offer(info) {
    const notes = info.notes.trim();
    const shortcut = shortcutBox();
    const res = await modal({
      title: 'Update available',
      width: 540,
      body: [
        el('p', { text: `Vytty ${info.version} is available. You have ${info.current}.` }),
        notes ? el('div.pre.muted', { style: { maxHeight: '220px', overflow: 'auto', fontSize: '12px', marginBottom: '12px' }, text: notes }) : null,
        !info.canInstall
          ? el('div.notice', { text: 'This copy cannot update itself (not a packaged release build). Download the new version from GitHub instead.' })
          : isPortable()
            ? [el('div.notice.info', { text: `The update also switches Vytty from the single .exe to the folder version, which starts much faster. ${folderNote()}` }),
              el('label.check', shortcut, el('span', { text: 'Create a desktop shortcut' }))]
            : el('p.muted', { style: { fontSize: '12px' }, text: `The update (${fmtSize(info.asset.size)}) is downloaded, then Vytty restarts. Sessions, settings, the vault and logs are kept.` }),
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
    if (!(await confirmLive())) return;
    await progress(`Downloading Vytty ${info.version}`, () => vytty.update.download(), { shortcut: shortcut.checked });
  }

  async function confirmLive() {
    const live = App.tabs.filter((t) => t.state === 'connected');
    if (!live.length) return true;
    return confirmBox('Restart Vytty', `Vytty restarts when this is done. ${live.length} connected session${live.length > 1 ? 's' : ''} will be closed. Continue?`, { okLabel: 'Continue' });
  }

  const PHASES = { extract: 'Unpacking…', copy: 'Copying files…' };

  // Progress dialog around `work` (download / convert), then restart.
  async function progress(title, work, installOpts) {
    const bar = el('div', { style: { height: '100%', width: '0%', background: 'var(--accent)', transition: 'width .15s' } });
    const label = el('p.muted', { style: { fontSize: '12px', marginTop: '8px' }, text: 'Starting…' });
    const err = el('div.notice.danger.hidden');
    let finished = false;
    const off = vytty.update.onProgress((got, total, phase) => {
      if (PHASES[phase]) { bar.style.width = '100%'; label.textContent = PHASES[phase]; return; }
      bar.style.width = total ? `${Math.min(100, (got / total) * 100).toFixed(1)}%` : '0%';
      label.textContent = total ? `${fmtSize(got)} of ${fmtSize(total)}` : fmtSize(got);
    });
    const dialog = modal({
      title,
      width: 460,
      body: [err, el('div', { style: { height: '8px', borderRadius: '4px', background: 'var(--hover)', overflow: 'hidden' } }, bar), label],
      buttons: [{ label: 'Cancel', value: null }],
    }).then(() => { if (!finished) vytty.update.cancel().catch(() => {}); });

    try {
      await work();
      finished = true;
      label.textContent = 'Restarting…';
      await vytty.update.install(installOpts);
      vytty.win.forceClose();
    } catch (e) {
      finished = true;
      if (/cancelled/i.test(e.message)) return;
      err.textContent = e.message;
      err.classList.remove('hidden');
      label.textContent = 'Nothing was changed. You can download the new version from GitHub instead.';
    } finally {
      off();
    }
    await dialog;
  }

  // One-time offer for the portable .exe: switch to the folder version.
  async function offerFolder(manual = false) {
    if (!isPortable()) return;
    if (!manual && App.settings.updates.folderPromptDismissed) return;
    const shortcut = shortcutBox();
    const res = await modal({
      title: 'Start Vytty faster',
      width: 540,
      body: [
        el('p', { text: 'The single-file .exe unpacks the whole application (about 275 MB) to a temporary folder on every start, which is why Vytty takes 10+ seconds to open.' }),
        el('p', { text: `The folder version starts in about 2 seconds. Vytty can switch to it now. ${folderNote()} Future updates keep working.` }),
        el('label.check', shortcut, el('span', { text: 'Create a desktop shortcut' })),
      ],
      buttons: [
        { label: 'Don\'t ask again', value: 'never', left: true },
        { label: 'Not now', value: null },
        { label: 'Switch & restart', value: 'go', primary: true },
      ],
    });
    if (res === 'never') {
      App.settings.updates.folderPromptDismissed = true;
      await App.saveSettings();
      toast('You can switch later in Settings → About', 'info');
      return;
    }
    if (res !== 'go' || !(await confirmLive())) return;
    // The shortcut is created by convert itself; install only arranges the swap.
    await progress('Switching to the folder version', () => vytty.update.convert({ shortcut: shortcut.checked }), {});
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!App.settings.updates.autoCheck) return;
    timer = setInterval(() => check(false), EVERY);
  }

  App.checkUpdates = check;
  App.offerFolderVersion = offerFolder;
  App.on('settings', schedule);
  App.on('booted', async () => {
    schedule();
    await offerFolder(false);
    if (App.settings.updates.autoCheck) setTimeout(() => check(false), 4000);
  });
})();
