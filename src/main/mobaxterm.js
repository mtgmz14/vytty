'use strict';
// Import MobaXterm session files (.mxtsessions, .mobaxterm, MobaXterm.ini or a
// single .moba). These are CP1252 INI files whose [Bookmarks*] sections hold
// folders (SubRep) and one session per line.
//
// A session line is:  Name= [reconnect]#icon#type%p1%p2%...#terminal%...#0#comment#-1
// The '%' group after the icon carries the connection parameters; params[0] is
// the session type (0 SSH, 1 Telnet, 7 SFTP, 8 Serial, 10 Shell...).
//
// NOTE: these files never contain passwords - MobaXterm keeps those encrypted
// in the Windows registry, tied to the Windows user. This parser only reads the
// plaintext connection metadata; passwords are added separately in Vytty.

const crypto = require('crypto');

// Bytes 0x80-0x9F of Windows-1252 that differ from Latin-1.
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeCp1252(buf) {
  let out = '';
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? (CP1252[b] || '') : String.fromCharCode(b);
  return out;
}

// MobaXterm escapes a few characters inside its fields.
const unescape = (s) => (s || '')
  .replace(/__PTVIRG__/g, ';')
  .replace(/__PIPE__/g, '|')
  .replace(/__PERCENT__/g, '%')
  .replace(/__APOS__/g, "'")
  .replace(/__DQUOTE__/g, '"');

// MobaXterm replaces the drive letter of key paths with "_CurrentDrive_"
// (keeping the following ":"). Normalise both forms back to "C:".
const fixPath = (s) => unescape(s).replace(/_CurrentDrive_:?/g, 'C:');

const TYPES = { 0: 'ssh', 1: 'telnet', 7: 'ssh', 8: 'serial', 10: 'local' };
const TYPE_LABEL = { 0: 'SSH', 1: 'Telnet', 2: 'RSH', 3: 'XDMCP', 4: 'RDP', 5: 'VNC', 6: 'FTP', 7: 'SFTP', 8: 'Serial', 9: 'File', 10: 'Shell', 11: 'Browser', 12: 'Mosh', 13: 'AWS S3', 16: 'WSL' };

const uid = () => crypto.randomUUID();

function parse(buf) {
  const text = Buffer.isBuffer(buf) ? decodeCp1252(buf) : String(buf);
  const lines = text.split(/\r\n|\r|\n/);

  const folders = [];
  const folderByPath = new Map(); // "A\\B" -> folder id
  const sessions = [];
  const stats = { total: 0, imported: 0, byType: {}, skipped: {} };

  // Create the nested folders for a SubRep path, return the leaf folder id.
  function folderFor(pathStr) {
    const clean = (pathStr || '').replace(/\/+/g, '\\').replace(/^\\+|\\+$/g, '');
    if (!clean) return null;
    if (folderByPath.has(clean)) return folderByPath.get(clean);
    const segments = clean.split('\\').map((s) => unescape(s.trim())).filter(Boolean);
    let parentId = null;
    let acc = '';
    for (const name of segments) {
      acc = acc ? `${acc}\\${name}` : name;
      let id = folderByPath.get(acc);
      if (!id) {
        id = uid();
        folders.push({ id, name, parentId });
        folderByPath.set(acc, id);
      }
      parentId = id;
    }
    return parentId;
  }

  let inBookmarks = false;
  let currentFolder = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inBookmarks = /^Bookmarks(_\d+)*$/i.test(header[1].trim());
      currentFolder = null;
      continue;
    }
    if (!inBookmarks || !line.trim()) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);

    if (/^SubRep$/i.test(key)) { currentFolder = folderFor(value.trim()); continue; }
    if (/^ImgNum$/i.test(key)) continue;
    if (!value.includes('#')) continue; // not a session line

    stats.total++;
    const session = parseSession(key, value, currentFolder);
    if (session) {
      sessions.push(session);
      stats.imported++;
      stats.byType[session._srcType] = (stats.byType[session._srcType] || 0) + 1;
    } else {
      // record the skipped type for the summary
    }
  }

  for (const s of sessions) delete s._srcType;

  // Drop folders left empty because their only sessions were of a skipped type.
  // Keep a folder if a session lives in it, or if a kept folder descends from it.
  const used = new Set();
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (const s of sessions) {
    let id = s.folderId;
    while (id && !used.has(id)) { used.add(id); id = (byId.get(id) || {}).parentId; }
  }
  const keptFolders = folders.filter((f) => used.has(f.id));

  return { folders: keptFolders, sessions, stats };
}

function parseSession(name, value, folderId) {
  // value: [reconnect]#icon#type%p1%p2...#terminal...#0#comment#-1
  const fields = value.split('#');
  // The connection group is the first field like "0%host%...": a type digit
  // followed by '%'-separated parameters.
  let gi = fields.findIndex((f) => /^\d+%/.test(f));
  if (gi === -1) gi = fields.findIndex((f) => f.includes('%'));
  if (gi === -1) return null;
  const params = fields[gi].split('%');
  const typeId = parseInt(params[0], 10);
  const proto = TYPES[typeId];
  const label = TYPE_LABEL[typeId] || `type ${params[0]}`;
  if (!proto) { bumpSkip(label); return null; }

  const comment = (fields[gi + 3] || '').trim();
  const base = {
    id: uid(),
    name: unescape(name).trim() || 'session',
    folderId: folderId || null,
    highlight: 'auto',
    logging: true,
    notes: comment && comment !== '-1' && comment !== '0' ? comment : '',
    _srcType: label,
  };

  let host = unescape(params[1] || '').trim();
  const user = (params[3] || '').trim();
  let username = user && user !== '<default>' ? unescape(user) : '';
  // MobaXterm sometimes leaves the username field empty and keeps the login in
  // the host ("user@host") or the session name ("user@host"). Read it from
  // there so the imported session carries a username.
  if (!username) {
    const m = /^([^@\s/]+)@(.+)$/.exec(host);
    if (m) { username = m[1]; host = m[2].trim(); }
  }
  if (!username) {
    const m = /^([^@\s/]+)@[^\s]+$/.exec(base.name);
    if (m) username = m[1];
  }
  // Session names often wrap the login in brackets ("[root]@host"); the
  // brackets are only decoration, not part of the actual username.
  username = username.trim().replace(/^\[\s*(.*?)\s*\]$/, '$1');

  if (proto === 'ssh') {
    if (!host) { bumpSkip(label); return null; }
    const s = { ...base, protocol: 'ssh', host, port: Number(params[2]) || 22, username };
    const keyPath = fixPath(params[14] || '').trim();
    if (keyPath) s.keyPath = keyPath;
    // SSH gateway (jump host): keep it in notes so nothing is lost.
    const gwHost = unescape(params[8] || '').trim();
    if (gwHost) {
      const gwUser = unescape(params[10] || '').split('|')[0];
      const gwPort = (params[9] || '22').split('|')[0];
      const gw = `Jump host: ${gwUser ? `${gwUser}@` : ''}${gwHost.split('|')[0]}:${gwPort}`;
      s.notes = s.notes ? `${s.notes}\n${gw}` : gw;
    }
    if (typeId === 7) s.notes = s.notes ? `${s.notes}\n(MobaXterm SFTP session)` : '(MobaXterm SFTP session)';
    return s;
  }
  if (proto === 'telnet') {
    if (!host) { bumpSkip(label); return null; }
    return { ...base, protocol: 'telnet', host, port: Number(params[2]) || 23, username, autoLogin: true };
  }
  if (proto === 'serial') {
    const serialPath = unescape(params[1] || '').trim();
    if (!serialPath) { bumpSkip(label); return null; }
    return { ...base, protocol: 'serial', serialPath, baudRate: Number(params[2]) || 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' };
  }
  if (proto === 'local') {
    return { ...base, protocol: 'local', shell: '', shellArgs: '' };
  }
  bumpSkip(label);
  return null;
}

// Skipped-type counting via a module-level accumulator set per parse() call.
let skipAcc = null;
function bumpSkip(label) { if (skipAcc) skipAcc[label] = (skipAcc[label] || 0) + 1; }

function parseFile(buf) {
  skipAcc = {};
  const res = parse(buf);
  res.stats.skipped = skipAcc;
  skipAcc = null;
  return res;
}

module.exports = { parseFile };
