'use strict';
// Encrypted credential vault.
// Every secret is sealed with AES-256-GCM using a key derived with scrypt
// from the master password. The master password itself is never stored:
// a known plaintext ("check") sealed with the key lets us verify it.
// "none" mode derives the key from a built-in constant so the vault stays
// portable without a master password - that is obfuscation, not security,
// and the UI says so.
const crypto = require('crypto');
const fs = require('fs');
const { paths } = require('./paths');
const { store } = require('./store');

const NO_MASTER_SECRET = 'vytty:portable:no-master-password';
const CHECK_PLAINTEXT = 'vytty-vault-ok';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let key = null;
let data = null;

function deriveKey(password, saltB64) {
  return crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), 32, SCRYPT);
}

function seal(k, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') };
}

function open(k, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

function load() {
  if (!data) data = store.readJson(paths.vault, null);
  return data;
}

function persist() {
  store.writeJson(paths.vault, data);
}

const vault = {
  status() {
    const d = load();
    return { exists: !!d, mode: d ? d.mode : null, unlocked: !!key, count: d ? Object.keys(d.entries).length : 0 };
  },

  create(password) {
    const mode = password ? 'master' : 'none';
    const salt = crypto.randomBytes(16).toString('base64');
    const k = deriveKey(password || NO_MASTER_SECRET, salt);
    data = { version: 1, kdf: 'scrypt', mode, salt, check: seal(k, CHECK_PLAINTEXT), entries: {} };
    persist();
    key = k;
    return this.status();
  },

  unlock(password) {
    const d = load();
    if (!d) throw new Error('Vault does not exist');
    const k = deriveKey(d.mode === 'none' ? NO_MASTER_SECRET : password || '', d.salt);
    try {
      if (open(k, d.check) !== CHECK_PLAINTEXT) throw new Error();
    } catch {
      throw new Error('Wrong master password');
    }
    key = k;
    return this.status();
  },

  lock() {
    key = null;
    return this.status();
  },

  requireUnlocked() {
    if (!key) throw new Error('Vault is locked');
  },

  get(id) {
    this.requireUnlocked();
    const box = load().entries[id];
    if (!box) return {};
    return JSON.parse(open(key, box));
  },

  set(id, secret) {
    this.requireUnlocked();
    const clean = {};
    for (const [k, v] of Object.entries(secret || {})) if (v) clean[k] = v;
    if (Object.keys(clean).length === 0) delete data.entries[id];
    else data.entries[id] = seal(key, JSON.stringify(clean));
    persist();
  },

  remove(id) {
    if (!load() || !data.entries[id]) return;
    delete data.entries[id];
    persist();
  },

  // Re-encrypt every entry under a new key. Empty newPassword switches to "none" mode.
  changeMaster(oldPassword, newPassword) {
    const d = load();
    if (!d) return this.create(newPassword);
    this.unlock(oldPassword);
    const plain = {};
    for (const [id, box] of Object.entries(d.entries)) plain[id] = open(key, box);
    const mode = newPassword ? 'master' : 'none';
    const salt = crypto.randomBytes(16).toString('base64');
    const k = deriveKey(newPassword || NO_MASTER_SECRET, salt);
    const entries = {};
    for (const [id, text] of Object.entries(plain)) entries[id] = seal(k, text);
    data = { version: 1, kdf: 'scrypt', mode, salt, check: seal(k, CHECK_PLAINTEXT), entries };
    persist();
    key = k;
    return this.status();
  },

  // Drop the vault entirely (forgotten master password).
  reset() {
    try { fs.unlinkSync(paths.vault); } catch { /* ignore */ }
    data = null;
    key = null;
    return this.status();
  },

  // Export/import helpers keep secrets encrypted with the export password.
  exportSecrets(ids, exportPassword) {
    this.requireUnlocked();
    const out = {};
    for (const id of ids) {
      const s = this.get(id);
      if (Object.keys(s).length) out[id] = s;
    }
    const salt = crypto.randomBytes(16).toString('base64');
    const k = deriveKey(exportPassword, salt);
    return { salt, box: seal(k, JSON.stringify(out)) };
  },

  importSecrets(blob, exportPassword, idMap) {
    this.requireUnlocked();
    const k = deriveKey(exportPassword, blob.salt);
    let parsed;
    try {
      parsed = JSON.parse(open(k, blob.box));
    } catch {
      throw new Error('Wrong export password');
    }
    for (const [oldId, secret] of Object.entries(parsed)) {
      const newId = idMap[oldId];
      if (newId) this.set(newId, secret);
    }
  },
};

module.exports = { vault };
