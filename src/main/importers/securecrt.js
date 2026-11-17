'use strict';
// SecureCRT sessions, from either
//   * the XML file of File -> Export Settings (<VanDyke><key name="Sessions">…), or
//   * the session folder itself (%APPDATA%\VanDyke\Config\Sessions), whose
//     .ini files hold lines like  S:"Hostname"=10.0.0.1  and  D:"[SSH2] Port"=00000016.
// Passwords are encrypted with a SecureCRT-specific scheme and are not imported.
const fs = require('fs');
const path = require('path');
const { parseXml, localName } = require('./xml');
const { decodeText, TreeBuilder } = require('./common');

const PARITY = ['none', 'odd', 'even', 'mark', 'space'];
const STOP = [1, 1.5, 2];

// values: { name -> string | number } for one session.
function toSession(name, v) {
  const proto = String(v['Protocol Name'] || '').toLowerCase();
  const base = { name };
  const notes = [];
  if (v.Description) notes.push(String(v.Description));
  const fw = String(v['Firewall Name'] || '');
  if (fw && !/^none$/i.test(fw)) notes.push(`Firewall / jump in SecureCRT: ${fw.replace(/^Session:/i, '')}`);
  if (proto.startsWith('ssh')) {
    const host = String(v.Hostname || '').trim();
    if (!host) return { skip: 'SSH' };
    const s = { ...base, protocol: 'ssh', host, port: Number(v['[SSH2] Port'] || v.Port) || 22, username: String(v.Username || '') };
    const key = v['Identity Filename V2'] || v['Identity Filename'];
    // "Identity Filename V2" may carry a suffix such as "::rawkey".
    if (key && String(key).trim()) s.keyPath = String(key).replace(/::.*$/, '').trim();
    if (notes.length) s.notes = notes.join('\n');
    return { session: s, label: 'SSH' };
  }
  if (proto.startsWith('telnet')) {
    const host = String(v.Hostname || '').trim();
    if (!host) return { skip: 'Telnet' };
    return { session: { ...base, protocol: 'telnet', host, port: Number(v.Port) || 23, username: String(v.Username || ''), autoLogin: true, notes: notes.join('\n') }, label: 'Telnet' };
  }
  if (proto === 'serial') {
    const port = String(v['Com Port'] || '').trim();
    if (!port) return { skip: 'Serial' };
    return {
      session: {
        ...base,
        protocol: 'serial',
        serialPath: port,
        baudRate: Number(v['Baud Rate']) || 9600,
        dataBits: Number(v['Data Bits']) || 8,
        parity: PARITY[Number(v.Parity)] || 'none',
        stopBits: STOP[Number(v['Stop Bits'])] || 1,
        flowControl: Number(v['CTS Flow']) ? 'hardware' : Number(v['XON Flow']) ? 'software' : 'none',
        notes: notes.join('\n'),
      },
      label: 'Serial',
    };
  }
  return { skip: v['Protocol Name'] ? String(v['Protocol Name']) : 'unknown' };
}

function addOne(tree, folderSegments, name, values) {
  if (/^default$/i.test(name) && !folderSegments.length) return;
  const r = toSession(name, values);
  if (r.skip) { tree.skip(r.skip); return; }
  r.session.folderId = tree.folder(folderSegments);
  tree.add(r.session, r.label);
}

// ---------------------------------------------------------------- XML export
function parseXmlExport(input) {
  const doc = parseXml(decodeText(input));
  const vandyke = doc.children.find((n) => localName(n.name) === 'VanDyke');
  const sessionsKey = vandyke && vandyke.children.find((n) => n.name === 'key' && n.attrs.name === 'Sessions');
  if (!sessionsKey) throw new Error('Not a SecureCRT settings export (no <key name="Sessions">)');
  const tree = new TreeBuilder('SecureCRT');
  const walk = (node, segments) => {
    for (const child of node.children.filter((c) => c.name === 'key')) {
      const values = {};
      for (const v of child.children) {
        if (v.name === 'string') values[v.attrs.name] = v.text;
        else if (v.name === 'dword') values[v.attrs.name] = Number(v.text);
      }
      if (values['Protocol Name'] || values.Hostname) addOne(tree, segments, child.attrs.name, values);
      else walk(child, [...segments, child.attrs.name]);
    }
  };
  walk(sessionsKey, []);
  return tree.result();
}

// ------------------------------------------------------------ session folder
function parseIni(text) {
  const v = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([SD]):"([^"]+)"=(.*)$/.exec(line);
    if (!m) continue;
    v[m[2]] = m[1] === 'D' ? parseInt(m[3], 16) : m[3];
  }
  return v;
}

function parseSessionDir(dir) {
  const tree = new TreeBuilder('SecureCRT');
  const walk = (abs, segments) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(abs, e.name), [...segments, e.name]);
      else if (/\.ini$/i.test(e.name) && !/^__FolderData__\.ini$/i.test(e.name)) {
        const values = parseIni(decodeText(fs.readFileSync(path.join(abs, e.name))));
        if (values['Protocol Name'] || values.Hostname) addOne(tree, segments, e.name.replace(/\.ini$/i, ''), values);
      }
    }
  };
  walk(dir, []);
  return tree.result();
}

module.exports = { parseXmlExport, parseSessionDir, parseIni };
