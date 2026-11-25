# Changelog

## 0.11.0 - 2026-11-25

**Rewritten in Rust**
- The whole backend - SSH, Telnet, serial and local shells, SFTP, the session store, the vault, logging, the importers
  and exporters, NetBox, ssh:// links and the updater - is now Rust instead of Electron / Node.js. The window is
  [Tauri 2](https://tauri.app) on the system web view (WebView2 on Windows, WebKitGTK on Linux); the interface is the
  same.
- Windows: **one executable of about EXE_MB MB** instead of a 140 MB self-extracting launcher that unpacked 275 MB to
  `%LOCALAPPDATA%\Vytty\app` for every version. Nothing is unpacked or installed, it starts in about a second, and
  the portable `.exe` and the `Vytty.exe` in the zip are the same file. No launcher also means one pattern less that
  endpoint protection (CrowdStrike, Defender) reacts to.
- Needs the Microsoft Edge WebView2 Runtime, which is part of Windows 10 and 11; if it is missing or blocked, Vytty
  says so instead of failing silently.
- SSH uses [russh](https://github.com/Eugeny/russh): keys in OpenSSH, PEM and PuTTY `.ppk` format, the SSH agent /
  Pageant, keyboard-interactive, the legacy algorithms older network gear needs (DH group 1/14 SHA-1, CBC, 3DES,
  `ssh-rsa`, DSA), jump hosts, local and SOCKS5 forwards, and SFTP with pipelined transfers.
- Everything is read as it is: `VyttyData` (settings, sessions, `vault.json`, known host keys, logs), exported session
  files and their encrypted passwords. Nothing to migrate.
- Updating from 0.10 works with the in-app updater (the same signed checksums). The first start of 0.11 then removes
  what the Electron version left behind: the old portable `.exe`, the unpacked copies in `%LOCALAPPDATA%\Vytty\app`,
  the Electron files of an updated zip folder and the old browser profile in `VyttyData\.chromium`. Only files that
  are recognisably Vytty's are deleted.

**Fixes**
- Icons are centred on the text next to them (the quick connect bar, the session tree, the settings navigation and the
  new-tab button in the Rounded style were 2-9 px off). The end-to-end test now measures every icon against its text
  in all three interface styles.
- Linux AppImage: the data folder is next to the `.AppImage` file. 0.10 kept it in the AppImage's temporary folder,
  so sessions, settings and the vault were gone after a restart.
- Settings navigation labels no longer wrap with wider fonts.

**Notes**
- Two small interface preferences that lived in the old browser profile (collapsed folders, the last sidebar panel)
  are reset once.
- The tests are Rust now: SSH and Telnet against test servers (host key prompt, stored and asked passwords, jump host
  without leftover connections), local shells, the importers on the same fixtures, vault files written by 0.10, and
  the updater against a fake GitHub (tampered file, forged signature, clean-up after the Electron version). The
  end-to-end test drives the real app on a virtual display.

## 0.10.0 - 2026-11-17

**Safer updates and fewer endpoint-protection alarms**
- Updates are verified before they are installed: every release carries `SHA256SUMS.txt` signed with an Ed25519
  key whose public half is built into Vytty. A file that does not match, or a signature that does not verify, is
  refused - including a corrupted download or a tampering proxy.
- No helper programs any more: the zip build is unpacked inside Vytty (it used to run `tar.exe`), and dragging large
  files out of the SFTP panel no longer starts a hidden PowerShell to look at Explorer windows. Both are patterns that
  endpoint protection (CrowdStrike, Defender for Endpoint) flags in unsigned software.
- The portable `.exe` is no longer replaced while in use: the new version is saved next to the old one and started;
  the old file is deleted only after the new version has started successfully.
- New update setting *Only tell me*: Vytty never downloads anything and only points to the release page - the
  natural choice on managed work PCs. Copies installed with winget are told to use `winget upgrade`.
- The portable launcher uses no NSIS plugins (the System plugin was unpacked to `%TEMP%` on every start).
- Electron fuses: the packaged app can no longer be started as a Node.js interpreter (`ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS`, `--inspect`), and the `app.asar` integrity is checked on Windows.
- Electron 44.11.3 (security fixes), electron-builder 26.18.1.
- Releases come with build provenance attestations (`gh attestation verify`) and the build pipeline is ready for
  code signing (SignPath, a certificate file or Azure Artifact Signing) - see `docs/PODPISYWANIE.md`.

**Integrations**
- Import sessions from **PuTTY / KiTTY** (`.reg` export), **SecureCRT** (XML export or the session folder),
  **mRemoteNG** (`confCons.xml`, including passwords), **OpenSSH** `~/.ssh/config` (ProxyJump, forwards) and **CSV**
  (Excel, CMDB/IPAM exports). Importing the same file again does not duplicate sessions.
- MobaXterm import: SSH gateways become jump host sessions; `_ProfileDir_` key paths are resolved.
- Export to an OpenSSH config, CSV and an Ansible inventory (groups from folders, `ansible_network_os` from the
  highlighting profile).
- **NetBox** sync: devices (and optionally VMs) become sessions in folders by site / role / tenant; syncing again
  updates them; the API token is kept in the vault.
- **ssh:// and telnet:// links** (opt-in, Windows): links in NetBox, Zabbix, LibreNMS or a wiki open a tab in Vytty.
- **Open with** external tools from a session or tab menu: WinSCP, FileZilla, PuTTY, Windows Terminal, Remote
  Desktop, VNC, a web UI, or any program; plus ping and traceroute in a tab.

**Interface**
- New interface styles: **Minimal** (default - flat, square, hairline borders), **Compact** (denser) and
  **Rounded** (the previous look).
- Six calm themes: Graphite (new default), Paper, Mono Dark, Mono Light, Classic and Amber.
- A plain start page and a flat icon.

**Fixes**
- An SSH connection through a jump host left the jump connection open when the target could not be reached.
- Closing a tab while it was still connecting left the SSH connection running in the background.
- Telnet waited for the operating system's TCP timeout on unreachable hosts; it now uses the connect timeout.
- Closing a connected tab twice quickly could close another tab instead.
- "Save as session" saved the session even when the dialog was cancelled.
- Importing a Vytty file could re-point jump hosts of existing sessions.
- A session with an unknown protocol in `sessions.json` broke the session tree.
- After dragging a file out of the SFTP panel, "Choose a folder" downloaded from the active tab instead of the tab
  the file came from.
- Settings, sessions and the vault are written with retries when an antivirus briefly locks the file, and flushed
  to disk.
- Temporary copies made for SFTP drag-out are removed when their connection closes.
- A dark strip below the last terminal row (xterm 6).

**Tests**
- 47 unit and integration tests (`npm test`), including SSH, jump host and Telnet sessions against real test
  servers, and an end-to-end run of the app (`npm run test:e2e`).

## 0.9.1 and earlier

See the [git history](https://github.com/mtgmz14/vytty/commits/main) and the
[releases](https://github.com/mtgmz14/vytty/releases).
