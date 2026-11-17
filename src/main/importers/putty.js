'use strict';
// PuTTY / KiTTY sessions from a registry export (.reg):
//   reg export HKCU\Software\SimonTatham\PuTTY\Sessions putty.reg
//   reg export HKCU\Software\9bis.com\KiTTY\Sessions kitty.reg
// Regedit writes UTF-16 ("Windows Registry Editor Version 5.00") or ANSI
// ("REGEDIT4"). Session names are URL-encoded (%20 = space). Passwords are
// never stored by PuTTY, so there are none to import.
const { decodeText, splitUserHost, TreeBuilder } = require('./common');

const SESSION_KEY = /\\(?:SimonTatham\\PuTTY|9bis\.com\\KiTTY|[^\\]+)\\Sessions\\(.+)$/i;

function unquote(s) {
  return s.replace(/\\(["\\])/g, '$1');
}

function parseReg(text) {
  const keys = [];
  let cur = null;
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Hex values continue on the next line after a trailing backslash.
    while (/\\\s*$/.test(line) && i + 1 < lines.length && !/^\s*"/.test(lines[i + 1])) line = line.replace(/\\\s*$/, '') + lines[++i].trim();
    const h = /^\s*\[(-?)([^\]]+)\]\s*$/.exec(line);
    if (h) {
      cur = h[1] === '-' ? null : { path: h[2], values: {} };
      if (cur) keys.push(cur);
      continue;
    }
    if (!cur) continue;
    const v = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$/.exec(line);
    if (!v) continue;
    const name = unquote(v[1]);
    const raw = v[2].trim();
    if (raw.startsWith('"')) cur.values[name] = unquote(raw.replace(/^"/, '').replace(/"$/, ''));
    else if (/^dword:/i.test(raw)) cur.values[name] = parseInt(raw.slice(6), 16);
  }
  return keys;
}

const PARITY = ['none', 'odd', 'even', 'mark', 'space'];
const STOP = { 2: 1, 3: 1.5, 4: 2 };

function parse(input) {
  const text = decodeText(input);
  if (!/^\s*(Windows Registry Editor|REGEDIT4)/i.test(text)) throw new Error('Not a registry export (.reg) file');
  const tree = new TreeBuilder(/KiTTY/i.test(text) && !/SimonTatham/i.test(text) ? 'KiTTY' : 'PuTTY');
  for (const key of parseReg(text)) {
    const m = SESSION_KEY.exec(key.path);
    if (!m || m[1].includes('\\')) continue;
    let name;
    try { name = decodeURIComponent(m[1]); } catch { name = m[1]; }
    if (/^Default Settings$/i.test(name)) continue;
    const v = key.values;
    const proto = String(v.Protocol || 'ssh').toLowerCase();
    // KiTTY can group sessions in folders.
    const folderId = v.Folder ? tree.folder(String(v.Folder).split(/[\\/]/)) : undefined;
    const base = { name, ...(folderId ? { folderId } : {}) };
    if (proto === 'ssh' || proto === 'telnet') {
      let [user, host] = splitUserHost(v.HostName);
      if (!user) user = v.UserName || '';
      if (!host) { tree.skip(proto.toUpperCase()); continue; }
      const port = Number(v.PortNumber) || (proto === 'ssh' ? 22 : 23);
      const s = { ...base, protocol: proto, host, port, username: user };
      if (proto === 'ssh' && v.PublicKeyFile) s.keyPath = v.PublicKeyFile;
      if (proto === 'telnet') s.autoLogin = true;
      if (v.ProxyHost && Number(v.ProxyMethod) > 0) s.notes = `Proxy in PuTTY: ${v.ProxyHost}:${v.ProxyPort || ''}`;
      tree.add(s, proto === 'ssh' ? 'SSH' : 'Telnet');
    } else if (proto === 'serial') {
      if (!v.SerialLine) { tree.skip('Serial'); continue; }
      tree.add({
        ...base,
        protocol: 'serial',
        serialPath: v.SerialLine,
        baudRate: Number(v.SerialSpeed) || 9600,
        dataBits: Number(v.SerialDataBits) || 8,
        parity: PARITY[Number(v.SerialParity)] || 'none',
        stopBits: STOP[Number(v.SerialStopHalfbits)] || 1,
        flowControl: Number(v.SerialFlowControl) === 2 ? 'hardware' : Number(v.SerialFlowControl) === 1 ? 'software' : 'none',
      }, 'Serial');
    } else {
      tree.skip(proto === 'raw' ? 'Raw' : proto === 'rlogin' ? 'Rlogin' : proto);
    }
  }
  return tree.result();
}

module.exports = { parse, parseReg };
