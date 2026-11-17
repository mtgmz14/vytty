'use strict';
const { fixture } = require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseImport } = require('../../src/main/importers');
const mremoteng = require('../../src/main/importers/mremoteng');
const securecrt = require('../../src/main/importers/securecrt');

const byName = (res, name) => res.sessions.find((s) => s.name === name);
const folderPath = (res, id) => {
  const parts = [];
  let f = res.folders.find((x) => x.id === id);
  while (f) { parts.unshift(f.name); f = res.folders.find((x) => x.id === f.parentId); }
  return parts.join('/');
};

test('PuTTY .reg (UTF-16): ssh, telnet with user@host, serial; defaults and raw skipped', () => {
  const r = parseImport('putty', fs.readFileSync(fixture('putty.reg')));
  assert.strictEqual(r.sessions.length, 3);
  const ssh = byName(r, 'core sw01');
  assert.deepStrictEqual([ssh.protocol, ssh.host, ssh.port, ssh.username, ssh.keyPath], ['ssh', '10.0.0.1', 22, 'admin', 'C:\\Users\\me\\keys\\core.ppk']);
  const tel = byName(r, 'old-switch');
  assert.deepStrictEqual([tel.protocol, tel.host, tel.port, tel.username], ['telnet', '10.0.0.9', 23, 'netops']);
  const ser = byName(r, 'console');
  assert.deepStrictEqual([ser.serialPath, ser.baudRate, ser.stopBits, ser.flowControl], ['COM4', 9600, 1, 'software']);
  assert.strictEqual(r.stats.skipped.Raw, 1);
  assert.strictEqual(folderPath(r, ssh.folderId), 'PuTTY');
  assert.throws(() => parseImport('putty', Buffer.from('hello')), /registry export/);
});

test('SecureCRT XML export: nested folders, ports, identity file, serial', () => {
  const r = parseImport('securecrt', fs.readFileSync(fixture('securecrt.xml')));
  const core = byName(r, 'core-sw01');
  assert.deepStrictEqual([core.protocol, core.host, core.port, core.username, core.keyPath], ['ssh', '10.0.0.1', 2222, 'admin', 'C:\\keys\\id_ed25519']);
  assert.match(core.notes, /bastion/);
  assert.strictEqual(folderPath(r, core.folderId), 'SecureCRT/Datacenter & Lab');
  const tel = byName(r, 'sw-telnet');
  assert.strictEqual(folderPath(r, tel.folderId), 'SecureCRT/Datacenter & Lab/Access');
  assert.strictEqual(tel.protocol, 'telnet');
  const ser = byName(r, 'console');
  assert.deepStrictEqual([ser.serialPath, ser.baudRate, ser.parity, ser.stopBits, ser.flowControl], ['COM3', 115200, 'even', 2, 'hardware']);
  assert.ok(!byName(r, 'Default'), 'the Default template is not a session');
  assert.strictEqual(r.stats.skipped.RLogin, 1);
});

test('SecureCRT session folder (.ini files)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-scrt-'));
  fs.mkdirSync(path.join(dir, 'Core'));
  fs.writeFileSync(path.join(dir, 'Core', 'sw1.ini'), 'S:"Protocol Name"=SSH2\r\nS:"Hostname"=10.1.1.1\r\nS:"Username"=admin\r\nD:"[SSH2] Port"=00000016\r\nB:"Something"=00000002\r\n 00 01\r\n');
  fs.writeFileSync(path.join(dir, 'Core', '__FolderData__.ini'), 'S:"Is Expanded"=1\r\n');
  fs.writeFileSync(path.join(dir, 'Default.ini'), 'S:"Protocol Name"=SSH2\r\n');
  const r = securecrt.parseSessionDir(dir);
  assert.strictEqual(r.sessions.length, 1);
  assert.deepStrictEqual([r.sessions[0].name, r.sessions[0].host, r.sessions[0].port], ['sw1', '10.1.1.1', 22]);
  assert.strictEqual(folderPath(r, r.sessions[0].folderId), 'SecureCRT/Core');
  fs.rmSync(dir, { recursive: true, force: true });
});

const mrngXml = (pw, opts = {}) => {
  const enc = (t) => mremoteng.encryptGcm(t, pw);
  return `<?xml version="1.0" encoding="utf-8"?>
<mrng:Connections xmlns:mrng="http://mremoteng.org" Name="Connections" Export="false" EncryptionEngine="AES" BlockCipherMode="GCM" KdfIterations="1000" FullFileEncryption="false" Protected="${enc(opts.custom ? 'ThisIsProtected' : 'ThisIsNotProtected')}" ConfVersion="2.6">
  <Node Name="Routers" Type="Container" Username="netops" Password="${enc('folder-secret')}">
    <Node Name="r1" Type="Connection" Hostname="10.2.0.1" Protocol="SSH2" Port="22" InheritUsername="true" InheritPassword="true" Descr="edge router" />
    <Node Name="r2" Type="Connection" Hostname="10.2.0.2" Protocol="Telnet" Port="23" Username="admin" Password="${enc('telnet-secret')}" />
    <Node Name="dc-rdp" Type="Connection" Hostname="10.2.0.9" Protocol="RDP" Port="3389" />
  </Node>
</mrng:Connections>`;
};

test('mRemoteNG: folders, inheritance, passwords with the default key', () => {
  const r = parseImport('mremoteng', Buffer.from(mrngXml(mremoteng.DEFAULT_PASSWORD)));
  const r1 = byName(r, 'r1');
  const r2 = byName(r, 'r2');
  assert.deepStrictEqual([r1.protocol, r1.host, r1.username, r1.notes], ['ssh', '10.2.0.1', 'netops', 'edge router']);
  assert.strictEqual(folderPath(r, r1.folderId), 'mRemoteNG/Routers');
  assert.deepStrictEqual(r.secrets[r1.id], { password: 'folder-secret' });
  assert.deepStrictEqual(r.secrets[r2.id], { password: 'telnet-secret' });
  assert.strictEqual(r2.protocol, 'telnet');
  assert.strictEqual(r.stats.skipped.RDP, 1);
  assert.strictEqual(r.protected, false);
});

test('mRemoteNG: protected file needs the master password', () => {
  const xml = Buffer.from(mrngXml('S3cret!', { custom: true }));
  const without = parseImport('mremoteng', xml);
  assert.strictEqual(without.protected, true);
  assert.strictEqual(Object.keys(without.secrets).length, 0, 'no passwords without the master password');
  assert.strictEqual(without.sessions.length, 2, 'sessions are still imported');
  const withPw = parseImport('mremoteng', xml, { password: 'S3cret!' });
  assert.strictEqual(Object.keys(withPw.secrets).length, 2);
  assert.throws(() => parseImport('mremoteng', xml, { password: 'wrong' }), /Wrong mRemoteNG master password/);
});

test('mRemoteNG legacy CBC decryption round trip', () => {
  const crypto = require('crypto');
  const key = crypto.createHash('md5').update('mR3m').digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  const b64 = Buffer.concat([iv, c.update('old-pass', 'utf8'), c.final()]).toString('base64');
  assert.strictEqual(mremoteng.decryptCbc(b64, 'mR3m'), 'old-pass');
});

test('OpenSSH config: aliases, defaults from Host *, ProxyJump, forwards', () => {
  const r = parseImport('sshconfig', fs.readFileSync(fixture('ssh_config')));
  assert.deepStrictEqual(r.sessions.map((s) => s.name).sort(), ['bastion', 'core-sw01', 'db1']);
  const bastion = byName(r, 'bastion');
  const core = byName(r, 'core-sw01');
  assert.deepStrictEqual([bastion.host, bastion.port, bastion.username], ['bastion.example.com', 2222, 'jump']);
  assert.strictEqual(core.jumpId, bastion.id);
  assert.strictEqual(core.username, 'admin');
  assert.match(core.keyPath, /\.ssh[\\/]id_ed25519$/);
  assert.ok(!core.keyPath.startsWith('~'));
  assert.deepStrictEqual(core.forwards, [
    { type: 'L', listenHost: '127.0.0.1', listenPort: 8443, destHost: '10.0.0.1', destPort: 443 },
    { type: 'D', listenHost: '127.0.0.1', listenPort: 1080 },
  ]);
  const db = byName(r, 'db1');
  assert.deepStrictEqual([db.host, db.username], ['db1.db.example.com', 'fallback']);
  assert.strictEqual(r.stats.skippedBlocks.match, 1);
});

test('CSV: delimiter detection, aliases, folders, user@host, prefixes, platforms', () => {
  const r = parseImport('csv', fs.readFileSync(fixture('sessions.csv')));
  assert.strictEqual(r.sessions.length, 4);
  const core = byName(r, 'core-sw01');
  assert.deepStrictEqual([core.host, core.port, core.username, core.notes, core.highlight], ['10.0.0.1', 22, 'admin', 'Core; main', 'cisco-nxos']);
  assert.strictEqual(folderPath(r, core.folderId), 'DC/Core');
  const edge = byName(r, 'edge-rtr');
  assert.deepStrictEqual([edge.protocol, edge.host, edge.port, edge.username, edge.highlight], ['telnet', '10.0.0.254', 23, 'admin', 'cisco-ios']);
  const web = byName(r, 'web01');
  assert.deepStrictEqual([web.protocol, web.port, web.highlight], ['ssh', 2222, 'linux']);
  assert.throws(() => parseImport('csv', Buffer.from('a,b\n1,2\n')), /No host/);
});

test('MobaXterm: folders, users, key placeholders, gateways become jump hosts', () => {
  const r = parseImport('mobaxterm', fs.readFileSync(fixture('sample.mxtsessions')));
  const core1 = byName(r, 'core-sw01');
  const core2 = byName(r, 'core-sw02');
  assert.strictEqual(folderPath(r, core1.folderId), 'Network/Core');
  assert.strictEqual(core1.username, 'admin');
  assert.ok(core1.keyPath.startsWith(os.homedir()), core1.keyPath);
  assert.ok(core1.jumpId && core1.jumpId === core2.jumpId, 'one jump session per gateway');
  const jump = r.sessions.find((s) => s.id === core1.jumpId);
  assert.deepStrictEqual([jump.host, jump.port, jump.username], ['bastion.example.com', 2222, 'jumpuser']);
  assert.strictEqual(folderPath(r, jump.folderId), 'Jump hosts');
  assert.strictEqual(byName(r, 'old-sw').protocol, 'telnet');
  assert.strictEqual(byName(r, 'console').serialPath, 'COM3');
  assert.strictEqual(r.stats.skipped.RDP, 1);
});

test('XML parser: entities, CDATA, comments, attribute quoting', () => {
  const { parseXml } = require('../../src/main/importers/xml');
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'q"q\'><b>t&lt;1&#65;&#x42;</b><c><![CDATA[<raw>]]></c><d/></a>');
  const a = doc.children[0];
  assert.deepStrictEqual(a.attrs, { x: '1 & 2', y: 'q"q' });
  assert.strictEqual(a.children[0].text, 't<1AB');
  assert.strictEqual(a.children[1].text, '<raw>');
  assert.strictEqual(a.children[2].name, 'd');
});
