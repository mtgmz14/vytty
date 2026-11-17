'use strict';
// External tools: open a session's host in another program (WinSCP,
// FileZilla, PuTTY, Remote Desktop, a browser...). Programs are started
// directly with an argument list - never through a shell - so values such as
// a host name cannot inject commands. Nothing runs unless the user picks the
// tool from a menu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function vars(session) {
  const s = session || {};
  return {
    host: s.host || '',
    port: String(s.port || (s.protocol === 'telnet' ? 23 : 22)),
    user: s.username || '',
    name: s.name || '',
    protocol: s.protocol || '',
    keyPath: s.keyPath || '',
    // "user@" or "" - handy in URLs: sftp://{userAt}{host}
    userAt: s.username ? `${encodeURIComponent(s.username)}@` : '',
  };
}

const expand = (template, v) => String(template).replace(/\{(host|port|user|name|protocol|keyPath|userAt)\}/g, (_, k) => v[k]);

// Presets; `paths` are tried in order to find an installed copy.
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PRESETS = [
  { id: 'winscp', name: 'WinSCP (SFTP)', platforms: ['win32'], protocols: ['ssh'], args: 'sftp://{userAt}{host}:{port}/', paths: [path.join(PF86, 'WinSCP', 'WinSCP.exe'), path.join(PF, 'WinSCP', 'WinSCP.exe'), path.join(LAD, 'Programs', 'WinSCP', 'WinSCP.exe')] },
  { id: 'filezilla', name: 'FileZilla (SFTP)', platforms: ['win32', 'linux', 'darwin'], protocols: ['ssh'], args: 'sftp://{userAt}{host}:{port}', paths: [path.join(PF, 'FileZilla FTP Client', 'filezilla.exe'), path.join(PF86, 'FileZilla FTP Client', 'filezilla.exe'), '/usr/bin/filezilla'] },
  { id: 'putty', name: 'PuTTY', platforms: ['win32', 'linux'], protocols: ['ssh', 'telnet'], args: '-{protocol} {host} -P {port}', userArgs: '-l {user}', paths: [path.join(PF, 'PuTTY', 'putty.exe'), path.join(PF86, 'PuTTY', 'putty.exe'), '/usr/bin/putty'] },
  { id: 'wt', name: 'Windows Terminal (OpenSSH)', platforms: ['win32'], protocols: ['ssh'], args: 'ssh -p {port} {userAt}{host}', paths: [path.join(LAD, 'Microsoft', 'WindowsApps', 'wt.exe')] },
  { id: 'rdp', name: 'Remote Desktop (RDP)', platforms: ['win32'], protocols: ['ssh', 'telnet'], args: '/v:{host}', paths: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe')] },
  { id: 'vnc', name: 'VNC Viewer', platforms: ['win32', 'linux'], protocols: ['ssh', 'telnet'], args: '{host}', paths: [path.join(PF, 'RealVNC', 'VNC Viewer', 'vncviewer.exe'), path.join(PF, 'TightVNC', 'tvnviewer.exe'), path.join(PF, 'uvnc bvba', 'UltraVNC', 'vncviewer.exe'), '/usr/bin/vncviewer'] },
  { id: 'web-https', name: 'Web UI (https)', platforms: ['win32', 'linux', 'darwin'], protocols: ['ssh', 'telnet'], type: 'url', args: 'https://{host}/' },
  { id: 'web-http', name: 'Web UI (http)', platforms: ['win32', 'linux', 'darwin'], protocols: ['ssh', 'telnet'], type: 'url', args: 'http://{host}/' },
];

function presets(platform = process.platform) {
  return PRESETS.filter((p) => p.platforms.includes(platform)).map((p) => {
    const found = (p.paths || []).find((x) => { try { return fs.statSync(x).isFile(); } catch { return false; } });
    return { id: p.id, name: p.name, type: p.type || 'program', path: found || (p.paths || [])[0] || '', args: p.args, userArgs: p.userArgs || '', protocols: p.protocols, installed: p.type === 'url' || !!found };
  });
}

// What would be run, for the settings preview and for launch().
function plan(tool, session) {
  const v = vars(session);
  if (tool.type === 'url') {
    const url = expand(tool.args || '', v);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Web tools need an http:// or https:// address');
    return { type: 'url', url };
  }
  if (!tool.path) throw new Error(`No program set for "${tool.name}"`);
  const args = splitArgs(tool.args).map((a) => expand(a, v));
  if (v.user && tool.userArgs) args.push(...splitArgs(tool.userArgs).map((a) => expand(a, v)));
  return { type: 'program', path: tool.path, args };
}

function launch(tool, session, openExternal) {
  const p = plan(tool, session);
  if (p.type === 'url') return openExternal(p.url).then(() => p);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(p.path, p.args, { detached: true, stdio: 'ignore', windowsHide: false, cwd: os.homedir(), shell: false });
    } catch (err) { reject(err); return; }
    child.once('error', (err) => reject(new Error(err.code === 'ENOENT' ? `Program not found: ${p.path}` : err.message)));
    child.once('spawn', () => { child.unref(); resolve(p); });
  });
}

module.exports = { presets, plan, launch, expand, vars, splitArgs, PRESETS };
