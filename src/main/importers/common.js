'use strict';
// Shared pieces of the session importers: a folder/session tree builder with
// import statistics, text decoding and small mapping helpers.
const crypto = require('crypto');

const uid = () => crypto.randomUUID();

// UTF-16 (with BOM), UTF-8 (with or without BOM) or, failing that, Windows-1252.
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
function decodeCp1252(buf) {
  let out = '';
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? (CP1252[b] || '') : String.fromCharCode(b);
  return out;
}
function decodeText(input) {
  if (typeof input === 'string') return input.replace(/^﻿/, '');
  const buf = Buffer.from(input);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? decodeCp1252(buf) : utf8;
}

// Highlight profile from a platform / OS / device type description.
function guessHighlight(text) {
  const t = String(text || '').toLowerCase();
  if (/nx-?os|nexus/.test(t)) return 'cisco-nxos';
  if (/ios|catalyst|cisco|asa\b/.test(t)) return 'cisco-ios';
  if (/linux|ubuntu|debian|centos|rhel|red ?hat|rocky|alma|suse|fedora|unix|bsd/.test(t)) return 'linux';
  return 'auto';
}

// "user@host" -> ['user', 'host']
function splitUserHost(s) {
  const m = /^([^@\s/]+)@(.+)$/.exec(String(s || '').trim());
  return m ? [m[1], m[2].trim()] : ['', String(s || '').trim()];
}

class TreeBuilder {
  // rootName: put everything into one top folder (for flat sources like PuTTY).
  constructor(rootName) {
    this.folders = [];
    this.sessions = [];
    this.secrets = {};
    this.notes = [];
    this.byPath = new Map();
    this.stats = { total: 0, imported: 0, byType: {}, skipped: {} };
    this.rootId = null;
    if (rootName) this.rootId = this.folder([rootName], null);
  }

  // Folder for a list of names below the root; returns its id (or the root's).
  folder(segments, base = this.rootId) {
    let parentId = base;
    for (const raw of segments || []) {
      const name = String(raw).trim();
      if (!name) continue;
      const key = `${parentId || ''}\u0000${name.toLowerCase()}`;
      let id = this.byPath.get(key);
      if (!id) {
        id = uid();
        this.folders.push({ id, name, parentId });
        this.byPath.set(key, id);
      }
      parentId = id;
    }
    return parentId;
  }

  add(session, typeLabel) {
    this.stats.total++;
    this.stats.imported++;
    this.stats.byType[typeLabel] = (this.stats.byType[typeLabel] || 0) + 1;
    const s = { id: uid(), highlight: 'auto', logging: true, notes: '', folderId: this.rootId, ...session };
    if (!s.folderId) s.folderId = null;
    this.sessions.push(s);
    return s;
  }

  skip(typeLabel) {
    this.stats.total++;
    this.stats.skipped[typeLabel] = (this.stats.skipped[typeLabel] || 0) + 1;
  }

  // Drop folders left without sessions (e.g. only skipped types inside).
  result() {
    const used = new Set();
    const byId = new Map(this.folders.map((f) => [f.id, f]));
    for (const s of this.sessions) {
      let id = s.folderId;
      while (id && !used.has(id)) { used.add(id); id = (byId.get(id) || {}).parentId; }
    }
    return { folders: this.folders.filter((f) => used.has(f.id)), sessions: this.sessions, stats: this.stats, secrets: this.secrets, notes: this.notes };
  }
}

module.exports = { uid, decodeText, decodeCp1252, guessHighlight, splitUserHost, TreeBuilder };
