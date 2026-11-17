'use strict';
// mRemoteNG connection file (confCons.xml).
// Containers become folders; SSH1/SSH2 and Telnet connections are imported,
// other protocols (RDP, VNC, HTTP...) are counted as skipped.
//
// Passwords: mRemoteNG encrypts them with AES-GCM (or AES-CBC in old files)
// using a key derived from its master password. Files saved without a master
// password use the built-in one ("mR3m"), so their passwords can be moved into
// Vytty's vault during the import. For a protected file the user is asked for
// the master password. Nothing is decrypted unless the user imports the file.
const crypto = require('crypto');
const { parseXml, localName } = require('./xml');
const { decodeText, TreeBuilder } = require('./common');

const DEFAULT_PASSWORD = 'mR3m';

// AES-GCM: base64(salt[16] | nonce[16] | ciphertext | tag[16]),
// key = PBKDF2-HMAC-SHA1(password, salt, iterations, 32), AAD = salt.
function decryptGcm(b64, password, iterations = 1000) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 48) throw new Error('too short');
  const salt = buf.subarray(0, 16);
  const nonce = buf.subarray(16, 32);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(32, buf.length - 16);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha1');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  d.setAAD(salt);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function encryptGcm(text, password, iterations = 1000) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha1');
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(salt);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([salt, nonce, enc, c.getAuthTag()]).toString('base64');
}

// Old files: base64(iv[16] | AES-128-CBC(md5(password))).
function decryptCbc(b64, password) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 32) throw new Error('too short');
  const key = crypto.createHash('md5').update(password, 'utf8').digest();
  const d = crypto.createDecipheriv('aes-128-cbc', key, buf.subarray(0, 16));
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8');
}

function decryptor(root, password) {
  const gcm = /gcm/i.test(root.attrs.BlockCipherMode || '') || /aes/i.test(root.attrs.EncryptionEngine || '');
  const iterations = Number(root.attrs.KdfIterations) || 1000;
  return (b64) => {
    if (!b64) return '';
    try { return gcm ? decryptGcm(b64, password, iterations) : decryptCbc(b64, password); } catch {
      try { return gcm ? decryptCbc(b64, password) : decryptGcm(b64, password, iterations); } catch { return null; }
    }
  };
}

const PROTOCOLS = { ssh1: 'ssh', ssh2: 'ssh', telnet: 'telnet' };

// password: the mRemoteNG master password, if the user gave one.
function parse(input, { password } = {}) {
  let doc = parseXml(decodeText(input));
  let root = doc.children.find((n) => localName(n.name) === 'Connections');
  if (!root) throw new Error('Not an mRemoteNG connection file (no <Connections> element)');
  const tree = new TreeBuilder('mRemoteNG');

  // Which password opens this file? "Protected" holds an encrypted marker.
  let pw = password || DEFAULT_PASSWORD;
  let dec = decryptor(root, pw);
  const marker = root.attrs.Protected ? dec(root.attrs.Protected) : 'ThisIsNotProtected';
  const canDecrypt = marker === 'ThisIsNotProtected' || marker === 'ThisIsProtected';
  if (!canDecrypt && !password) {
    // Protected with a master password we were not given: import without passwords.
    tree.notes.push('protected');
    pw = null;
  } else if (!canDecrypt) {
    throw new Error('Wrong mRemoteNG master password');
  }
  // Whole-file encryption: the element's text is the encrypted XML.
  if (/^true$/i.test(root.attrs.FullFileEncryption || '')) {
    if (!pw) throw new Error('This mRemoteNG file is fully encrypted - enter its master password');
    const inner = dec(root.text.trim());
    if (!inner) throw new Error('Could not decrypt the mRemoteNG file');
    doc = parseXml(`<Connections>${inner}</Connections>`);
    root = { ...root, children: doc.children[0].children };
  }

  let passwords = 0;
  const walk = (node, segments, inherited) => {
    for (const n of node.children.filter((c) => localName(c.name) === 'Node')) {
      const a = n.attrs;
      const user = /^true$/i.test(a.InheritUsername || '') ? inherited.username : (a.Username || '');
      const encPw = /^true$/i.test(a.InheritPassword || '') ? inherited.password : (a.Password || '');
      if (/^container$/i.test(a.Type || '')) {
        walk(n, [...segments, a.Name || 'Folder'], { username: user, password: encPw });
        continue;
      }
      if (!/^connection$/i.test(a.Type || '')) continue;
      const proto = PROTOCOLS[String(a.Protocol || '').toLowerCase()];
      if (!proto) { tree.skip(a.Protocol || 'unknown'); continue; }
      const host = String(a.Hostname || '').trim();
      if (!host) { tree.skip(a.Protocol); continue; }
      const s = tree.add({
        name: a.Name || host,
        protocol: proto,
        host,
        port: Number(a.Port) || (proto === 'ssh' ? 22 : 23),
        username: user,
        notes: a.Descr || '',
        folderId: tree.folder(segments),
        ...(proto === 'telnet' ? { autoLogin: true } : {}),
      }, a.Protocol);
      if (pw && encPw) {
        const plain = dec(encPw);
        if (plain) { tree.secrets[s.id] = { password: plain }; passwords++; }
      }
    }
  };
  walk(root, [], { username: '', password: '' });
  const res = tree.result();
  res.stats.passwords = passwords;
  res.protected = tree.notes.includes('protected');
  return res;
}

module.exports = { parse, decryptGcm, encryptGcm, decryptCbc, DEFAULT_PASSWORD };
