'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const { toSshConfig, toCsv, toAnsibleInventory } = require('../../src/main/exporters');
const { parseImport } = require('../../src/main/importers');

const tree = {
  folders: [{ id: 'f1', name: 'DC', parentId: null }, { id: 'f2', name: 'Core 1', parentId: 'f1' }],
  sessions: [
    { id: 'j', name: 'bastion', protocol: 'ssh', host: 'bastion.example.com', port: 2222, username: 'jump', folderId: null },
    { id: 's1', name: 'core sw01', protocol: 'ssh', host: '10.0.0.1', port: 22, username: 'admin', folderId: 'f2', jumpId: 'j', highlight: 'cisco-nxos', keyPath: 'C:\\Users\\me\\.ssh\\id ed', forwards: [{ type: 'L', listenPort: 8443, destHost: '10.0.0.1', destPort: 443 }, { type: 'D', listenPort: 1080 }], legacyAlgorithms: true },
    { id: 's2', name: '=cmd', protocol: 'telnet', host: '10.0.0.2', port: 23, folderId: 'f1', notes: 'line1, "quoted"', highlight: 'cisco-ios' },
    { id: 's3', name: 'console', protocol: 'serial', serialPath: 'COM3', baudRate: 9600 },
  ],
};

test('OpenSSH config export round-trips through the importer', () => {
  const text = toSshConfig(tree);
  assert.match(text, /Host core-sw01\n {4}HostName 10\.0\.0\.1\n {4}User admin\n/);
  assert.match(text, /ProxyJump bastion/);
  assert.match(text, /IdentityFile "C:\\Users\\me\\\.ssh\\id ed"/);
  assert.match(text, /LocalForward 8443 10\.0\.0\.1:443/);
  assert.match(text, /DynamicForward 1080/);
  assert.match(text, /HostKeyAlgorithms \+ssh-rsa/);
  const back = parseImport('sshconfig', text);
  const core = back.sessions.find((s) => s.name === 'core-sw01');
  const bastion = back.sessions.find((s) => s.name === 'bastion');
  assert.strictEqual(core.jumpId, bastion.id);
  assert.strictEqual(bastion.port, 2222);
});

test('CSV export escapes quotes, delimiters and formula prefixes, and re-imports', () => {
  const csv = toCsv(tree);
  assert.ok(csv.startsWith('\uFEFFname,folder,protocol'));
  assert.match(csv, /"'=cmd"|'=cmd/);
  assert.match(csv, /"line1, ""quoted"""/);
  assert.match(csv, /core sw01,DC\/Core 1,ssh,10\.0\.0\.1,22,admin/);
  const back = parseImport('csv', csv);
  assert.strictEqual(back.sessions.length, 4);
});

test('Ansible inventory: groups from folders, network_os from highlighting', () => {
  const inv = toAnsibleInventory(tree);
  assert.match(inv, /\[dc_core_1\]\ncore-sw01 ansible_host=10\.0\.0\.1 ansible_user=admin ansible_connection=ansible\.netcommon\.network_cli ansible_network_os=cisco\.nxos\.nxos/);
  assert.match(inv, /\[ungrouped\]\nbastion ansible_host=bastion\.example\.com ansible_port=2222 ansible_user=jump/);
  assert.match(inv, /cisco\.ios\.ios/);
  assert.ok(!/COM3/.test(inv), 'serial sessions are not in the inventory');
});
