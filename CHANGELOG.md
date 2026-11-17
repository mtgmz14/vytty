# Changelog

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
