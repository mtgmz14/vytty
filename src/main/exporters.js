'use strict';
// Session export for other tools: an OpenSSH client config, CSV (Excel, CMDB)
// and an Ansible INI inventory. Passwords are never written to these files.

const folderPathOf = (folders, id) => {
  const byId = new Map((folders || []).map((f) => [f.id, f]));
  const parts = [];
  let f = byId.get(id);
  const seen = new Set();
  while (f && !seen.has(f.id)) { seen.add(f.id); parts.unshift(f.name); f = byId.get(f.parentId); }
  return parts;
};

// "core-sw01 (Lab)" -> "core-sw01-lab"; unique within the export.
function aliasMaker() {
  const used = new Set();
  return (name, fallback) => {
    let base = String(name || fallback || 'host').toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
    let a = base;
    for (let i = 2; used.has(a); i++) a = `${base}-${i}`;
    used.add(a);
    return a;
  };
}

const quoteSsh = (v) => (/[\s"]/.test(v) ? `"${String(v).replace(/"/g, '')}"` : v);

function toSshConfig({ folders, sessions }) {
  const ssh = (sessions || []).filter((s) => s.protocol === 'ssh' && s.host);
  const alias = aliasMaker();
  const aliases = new Map(ssh.map((s) => [s.id, alias(s.name, s.host)]));
  const out = [`# Exported from Vytty on ${new Date().toISOString().slice(0, 10)} (${ssh.length} SSH sessions)`, ''];
  for (const s of ssh) {
    const folder = folderPathOf(folders, s.folderId).join(' / ');
    if (folder || s.name !== aliases.get(s.id)) out.push(`# ${[folder, s.name].filter(Boolean).join(' / ')}`);
    out.push(`Host ${aliases.get(s.id)}`);
    out.push(`    HostName ${s.host}`);
    if (s.username) out.push(`    User ${quoteSsh(s.username)}`);
    if (s.port && Number(s.port) !== 22) out.push(`    Port ${s.port}`);
    if (s.keyPath) out.push(`    IdentityFile ${quoteSsh(s.keyPath)}`);
    if (s.jumpId && aliases.has(s.jumpId)) out.push(`    ProxyJump ${aliases.get(s.jumpId)}`);
    for (const f of s.forwards || []) {
      if (f.type === 'D') out.push(`    DynamicForward ${f.listenHost && f.listenHost !== '127.0.0.1' ? `${f.listenHost}:` : ''}${f.listenPort}`);
      else if (f.destHost) out.push(`    LocalForward ${f.listenHost && f.listenHost !== '127.0.0.1' ? `${f.listenHost}:` : ''}${f.listenPort} ${f.destHost}:${f.destPort}`);
    }
    if (s.legacyAlgorithms) {
      out.push('    KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group1-sha1');
      out.push('    HostKeyAlgorithms +ssh-rsa');
      out.push('    PubkeyAcceptedAlgorithms +ssh-rsa');
    }
    out.push('');
  }
  return out.join('\n');
}

const CSV_COLUMNS = ['name', 'folder', 'protocol', 'host', 'port', 'username', 'keyPath', 'serialPath', 'baudRate', 'highlight', 'notes'];
const csvField = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  // A leading = + - @ would be run as a formula by Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function toCsv({ folders, sessions }) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const s of sessions || []) {
    const row = { ...s, folder: folderPathOf(folders, s.folderId).join('/') };
    rows.push(CSV_COLUMNS.map((c) => csvField(row[c])).join(','));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

const NETWORK_OS = { 'cisco-ios': 'cisco.ios.ios', 'cisco-nxos': 'cisco.nxos.nxos' };

function toAnsibleInventory({ folders, sessions }) {
  const groups = new Map();
  const alias = aliasMaker();
  const groupName = (parts) => (parts.length ? parts.join('_') : 'ungrouped').toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'g_$1') || 'ungrouped';
  for (const s of sessions || []) {
    if (!s.host || (s.protocol !== 'ssh' && s.protocol !== 'telnet')) continue;
    const g = groupName(folderPathOf(folders, s.folderId));
    const vars = [`ansible_host=${s.host}`];
    if (s.port && Number(s.port) !== (s.protocol === 'ssh' ? 22 : 23)) vars.push(`ansible_port=${s.port}`);
    if (s.username) vars.push(`ansible_user=${s.username}`);
    if (NETWORK_OS[s.highlight]) vars.push('ansible_connection=ansible.netcommon.network_cli', `ansible_network_os=${NETWORK_OS[s.highlight]}`);
    if (s.protocol === 'telnet') vars.push('# telnet session in Vytty');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`${alias(s.name, s.host)} ${vars.join(' ')}`);
  }
  const out = [`# Ansible inventory exported from Vytty on ${new Date().toISOString().slice(0, 10)}`, '# Groups follow the Vytty folders. Passwords are not exported: use --ask-pass or ansible-vault.', ''];
  for (const [g, hosts] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`[${g}]`, ...hosts, '');
  }
  return out.join('\n');
}

const EXPORTERS = {
  sshconfig: { label: 'OpenSSH config', ext: 'config', defaultName: 'ssh_config', filters: [{ name: 'SSH config', extensions: ['*'] }], run: toSshConfig },
  csv: { label: 'CSV', ext: 'csv', defaultName: 'vytty-sessions.csv', filters: [{ name: 'CSV', extensions: ['csv'] }], run: toCsv },
  ansible: { label: 'Ansible inventory', ext: 'ini', defaultName: 'inventory.ini', filters: [{ name: 'Ansible inventory', extensions: ['ini', 'txt'] }], run: toAnsibleInventory },
};

module.exports = { EXPORTERS, toSshConfig, toCsv, toAnsibleInventory, folderPathOf };
