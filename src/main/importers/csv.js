'use strict';
// Sessions from a CSV file - from Excel, a CMDB / IPAM export, LibreNMS,
// Zabbix, phpIPAM... The first row names the columns (any order, common
// aliases accepted); the delimiter (comma, semicolon or tab) is detected.
//   name, host, port, protocol, username, folder, notes, key, serial, baud, platform
const { decodeText, guessHighlight, splitUserHost, TreeBuilder } = require('./common');

const ALIASES = {
  name: ['name', 'session', 'session name', 'label', 'device', 'device name', 'sysname', 'display name'],
  host: ['host', 'hostname', 'address', 'ip', 'ip address', 'ip_address', 'ipaddress', 'primary ip', 'mgmt ip', 'management ip', 'fqdn', 'dns name'],
  port: ['port', 'ssh port'],
  protocol: ['protocol', 'proto', 'type', 'connection type', 'method'],
  username: ['username', 'user', 'login', 'user name'],
  folder: ['folder', 'group', 'path', 'site', 'location', 'category'],
  notes: ['notes', 'note', 'description', 'descr', 'comment', 'comments'],
  keyPath: ['key', 'keyfile', 'keypath', 'key file', 'private key', 'identityfile', 'identity file'],
  serialPath: ['serial', 'serialpath', 'serial port', 'com', 'com port', 'comport', 'line'],
  baudRate: ['baud', 'baudrate', 'baud rate', 'speed'],
  platform: ['platform', 'os', 'device type', 'vendor', 'model', 'highlight'],
  color: ['color', 'colour'],
};

function detectDelimiter(line) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (!q && c in counts) counts[c]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// RFC 4180: quoted fields, doubled quotes, line breaks inside quotes.
function parseRows(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function protocolOf(value, { port, serial }) {
  const v = String(value || '').toLowerCase();
  if (/ssh/.test(v)) return 'ssh';
  if (/telnet/.test(v)) return 'telnet';
  if (/serial|com|console/.test(v)) return 'serial';
  if (/local|shell|powershell|cmd/.test(v)) return 'local';
  if (serial) return 'serial';
  return Number(port) === 23 ? 'telnet' : 'ssh';
}

function parse(input) {
  const text = decodeText(input);
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const rows = parseRows(text, detectDelimiter(firstLine));
  if (rows.length < 2) throw new Error('The CSV file needs a header row and at least one session');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
  const col = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i !== -1) col[key] = i;
  }
  if (col.host === undefined && col.serialPath === undefined) throw new Error('No host (or serial port) column found. Name it "host", "hostname" or "ip".');
  const tree = new TreeBuilder(null);
  const get = (r, key) => (col[key] === undefined ? '' : String(r[col[key]] || '').trim());
  for (const r of rows.slice(1)) {
    let [user, host] = splitUserHost(get(r, 'host'));
    host = host.replace(/\/\d+$/, ''); // "10.0.0.1/24" from IPAM exports
    const serialPath = get(r, 'serialPath');
    const port = get(r, 'port');
    const protocol = protocolOf(get(r, 'protocol'), { port, serial: serialPath && !host });
    if (protocol === 'serial' ? !serialPath : protocol !== 'local' && !host) { tree.skip(protocol); continue; }
    const folder = get(r, 'folder');
    const s = {
      name: get(r, 'name') || host || serialPath,
      protocol,
      folderId: folder ? tree.folder(folder.split(/\s*[\\/>]\s*/)) : null,
      notes: get(r, 'notes'),
      highlight: guessHighlight(get(r, 'platform')),
    };
    if (protocol === 'serial') Object.assign(s, { serialPath, baudRate: Number(get(r, 'baudRate')) || 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' });
    else if (protocol === 'local') Object.assign(s, { shell: host || '', shellArgs: '' });
    else Object.assign(s, { host, port: Number(port) || (protocol === 'ssh' ? 22 : 23), username: get(r, 'username') || user });
    if (get(r, 'keyPath') && protocol === 'ssh') s.keyPath = get(r, 'keyPath');
    if (protocol === 'telnet') s.autoLogin = true;
    if (/^#[0-9a-f]{6}$/i.test(get(r, 'color'))) s.color = get(r, 'color');
    tree.add(s, protocol.toUpperCase());
  }
  return tree.result();
}

module.exports = { parse, parseRows, detectDelimiter };
