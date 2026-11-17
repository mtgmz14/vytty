'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const netbox = require('../../src/main/integrations/netbox');
const tools = require('../../src/main/tools');
const { parseConnectUrl, urlsFromArgv } = require('../../src/main/urlhandler');

const device = (id, extra = {}) => ({
  id, name: `sw${id}`, display_url: `https://nb.example.com/dcim/devices/${id}/`,
  primary_ip: { address: `10.0.0.${id}/24`, dns_name: `sw${id}.corp.example` },
  site: { name: 'WAW1' }, role: { name: 'Access switch' }, tenant: { name: 'Ops' }, platform: { name: 'Cisco NX-OS', slug: 'nxos' }, ...extra,
});

function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === '/api/status/') return { ok: true, status: 200, json: async () => ({ 'netbox-version': '4.4.2' }) };
    const key = `${u.pathname}${u.searchParams.get('offset') ? `@${u.searchParams.get('offset')}` : ''}`;
    const page = pages[key];
    if (!page) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => page };
  };
  fn.calls = calls;
  return fn;
}

test('NetBox: pagination stays on the configured host, token header, mapping', async () => {
  const fetch = fakeFetch({
    '/api/dcim/devices/': { count: 3, next: 'http://internal:8000/api/dcim/devices/?limit=500&offset=2&status=active', results: [device(1), device(2, { platform: { name: 'IOS-XE', slug: 'ios-xe' } })] },
    '/api/dcim/devices/@2': { count: 3, next: null, results: [device(3, { primary_ip: null, name: 'no-ip-switch' })] },
  });
  const res = await netbox.fetchSessions(fetch, { url: 'https://nb.example.com/', token: 'abc123', deviceFilter: 'status=active', groupBy: 'site/role' });
  assert.strictEqual(res.devices, 3);
  assert.ok(fetch.calls.every((c) => c.url.startsWith('https://nb.example.com/api/')), 'never follows "next" to another host');
  assert.ok(fetch.calls.every((c) => c.auth === 'Token abc123'));
  assert.ok(fetch.calls[0].url.includes('status=active'));
  const [a, b, c] = res.items;
  assert.deepStrictEqual([a.sourceId, a.name, a.host, a.highlight], ['dcim.device:1', 'sw1', '10.0.0.1', 'cisco-nxos']);
  assert.deepStrictEqual(a.folder, ['NetBox', 'WAW1', 'Access switch']);
  assert.strictEqual(b.highlight, 'cisco-ios');
  assert.strictEqual(c.host, 'no-ip-switch', 'falls back to the device name');
});

test('NetBox: host from DNS / name + domain, v2 tokens, errors', async () => {
  assert.strictEqual(netbox.mapObject(device(5), 'device', { hostFrom: 'dns' }).host, 'sw5.corp.example');
  assert.strictEqual(netbox.mapObject(device(5), 'device', { hostFrom: 'name', domain: 'lan' }).host, 'sw5.lan');
  assert.deepStrictEqual(netbox.mapObject(device(5), 'device', { groupBy: 'tenant/site' }).folder, ['NetBox', 'Ops', 'WAW1']);
  assert.deepStrictEqual(netbox.mapObject(device(5), 'device', { groupBy: 'none' }).folder, ['NetBox']);
  assert.strictEqual(netbox.mapObject({ id: 9, name: null, primary_ip: null }, 'device', {}), null);
  assert.strictEqual(netbox.authHeader('nbt_abc.def'), 'Bearer nbt_abc.def');
  assert.strictEqual(netbox.authHeader('Token x'), 'Token x');
  assert.throws(() => netbox.apiUrl('ftp://x', '/api/'), /https/);
  const denied = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(netbox.fetchSessions(denied, { url: 'https://nb', token: 't' }), /rejected the API token/);
  const st = await netbox.testConnection(fakeFetch({}), { url: 'https://nb.example.com', token: 't' });
  assert.strictEqual(st.version, '4.4.2');
});

test('external tools: argument lists, placeholders, no shell, web tools', () => {
  const session = { name: 'core', protocol: 'ssh', host: '10.0.0.1', port: 2222, username: 'ad min' };
  const p = tools.plan({ name: 'WinSCP', path: 'C:\\WinSCP\\WinSCP.exe', args: 'sftp://{userAt}{host}:{port}/' }, session);
  assert.deepStrictEqual(p.args, ['sftp://ad%20min@10.0.0.1:2222/']);
  const putty = tools.plan({ name: 'PuTTY', path: 'putty.exe', args: '-{protocol} {host} -P {port}', userArgs: '-l {user}' }, session);
  assert.deepStrictEqual(putty.args, ['-ssh', '10.0.0.1', '-P', '2222', '-l', 'ad min']);
  const evil = tools.plan({ name: 'x', path: 'x.exe', args: '"{host}"' }, { host: 'a & calc.exe', protocol: 'ssh' });
  assert.deepStrictEqual(evil.args, ['a & calc.exe'], 'one argument, no shell parsing');
  assert.deepStrictEqual(tools.plan({ type: 'url', args: 'https://{host}/' }, session), { type: 'url', url: 'https://10.0.0.1/' });
  assert.throws(() => tools.plan({ type: 'url', args: 'file:///{host}' }, session), /http/);
  assert.throws(() => tools.plan({ name: 'empty', path: '', args: '' }, session), /No program/);
});

test('ssh:// and telnet:// links', () => {
  assert.deepStrictEqual(parseConnectUrl('ssh://admin@10.0.0.1:2222'), { protocol: 'ssh', host: '10.0.0.1', port: 2222, username: 'admin', name: 'admin@10.0.0.1:2222' });
  assert.deepStrictEqual(parseConnectUrl('telnet://sw1.example.com'), { protocol: 'telnet', host: 'sw1.example.com', port: 23, username: '', name: 'sw1.example.com' });
  assert.strictEqual(parseConnectUrl('ssh://user;fingerprint=ssh-rsa-xx@host').username, 'user');
  assert.strictEqual(parseConnectUrl('ssh://[fe80::1]:22').host, 'fe80::1');
  assert.strictEqual(parseConnectUrl('http://x'), null);
  assert.strictEqual(parseConnectUrl('ssh://bad host'), null);
  assert.strictEqual(parseConnectUrl('ssh://x:99999'), null);
  assert.strictEqual(parseConnectUrl('ssh://a%22b@h').username, '', 'odd user names are dropped');
  assert.deepStrictEqual(urlsFromArgv(['vytty.exe', '--vytty-portable-exe=C:\\x', 'ssh://h']).map((u) => u.host), ['h']);
});
