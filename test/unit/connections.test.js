'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { Server, utils } = require('ssh2');
const { ConnectionManager } = require('../../src/main/connections');
const logger = require('../../src/main/logger');

logger.configure({ enabled: false });
const hostKey = utils.generateKeyPairSync('ed25519').private;

// A tiny SSH server: password auth, a shell that prints a prompt and echoes,
// and (optionally) direct-tcpip forwarding so it can act as a jump host.
function sshServer({ user = 'admin', pass = 'secret', prompt = 'SW1#', forward = false } = {}) {
  const clients = new Set();
  const srv = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (ok) => ok && ok());
        session.on('window-change', (ok) => ok && ok());
        session.on('shell', (ok) => {
          const stream = ok();
          stream.write(`Welcome\r\n${prompt}`);
          stream.on('data', (d) => stream.write(d));
        });
      });
      if (forward) {
        client.on('tcpip', (accept, reject, info) => {
          const sock = net.connect(info.destPort, info.destIP);
          sock.on('error', () => { try { reject(); } catch { /* ignore */ } });
          sock.on('connect', () => { const ch = accept(); sock.pipe(ch).pipe(sock); });
        });
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, clients })));
}

function manager({ answers = {} } = {}) {
  const events = [];
  const known = {};
  const secrets = {};
  const mgr = new ConnectionManager({
    send: (channel, ...args) => events.push([channel, ...args]),
    prompt: async (kind, payload) => { events.push(['prompt', kind, payload]); return kind === 'hostkey' ? (answers.hostkey ?? true) : (answers.secret ?? null); },
    getSettings: () => ({ ssh: { readyTimeout: 3000, keepaliveInterval: 0, legacyAlgorithms: false } }),
    vault: { get: (id) => secrets[id] || {}, set: (id, v) => { secrets[id] = v; } },
    store: { getKnownHosts: () => ({ ...known }), saveKnownHosts: (h) => Object.assign(known, h) },
  });
  const waitFor = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = events.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.slice(0, 3)))}`);
  };
  const text = (id) => events.filter((e) => e[0] === 'conn:data' && e[1] === id).map((e) => e[2]).join('');
  return { mgr, events, known, secrets, waitFor, text };
}

test('SSH: host key prompt, password from the vault, shell output, echo, close', async () => {
  const { srv, port } = await sshServer();
  const m = manager();
  m.secrets.s1 = { password: 'secret' };
  await m.mgr.open('c1', { session: { id: 's1', name: 'sw1', protocol: 'ssh', host: '127.0.0.1', port, username: 'admin' }, cols: 80, rows: 24, logEnabled: false });
  await m.waitFor((e) => e[0] === 'conn:status' && e[2] === 'connected');
  await m.waitFor(() => m.text('c1').includes('SW1#'));
  assert.ok(m.events.some((e) => e[0] === 'prompt' && e[1] === 'hostkey'));
  assert.ok(Object.values(m.known)[0].startsWith('SHA256:'), 'host key remembered');
  m.mgr.write('c1', 'show ver\r');
  await m.waitFor(() => m.text('c1').includes('show ver'));
  m.mgr.close('c1');
  await m.waitFor((e) => e[0] === 'conn:closed' && e[1] === 'c1');
  srv.close();
});

test('SSH: refusing a changed host key aborts the connection', async () => {
  const { srv, port } = await sshServer();
  const m = manager({ answers: { hostkey: false } });
  m.known[`[127.0.0.1]:${port}`] = 'SHA256:somethingelse';
  m.secrets.s1 = { password: 'secret' };
  await m.mgr.open('c2', { session: { id: 's1', protocol: 'ssh', host: '127.0.0.1', port, username: 'admin' }, logEnabled: false });
  const closed = await m.waitFor((e) => e[0] === 'conn:closed' && e[1] === 'c2');
  assert.match(closed[2], /Error/);
  const prompt = m.events.find((e) => e[0] === 'prompt' && e[1] === 'hostkey');
  assert.strictEqual(prompt[2].previous, 'SHA256:somethingelse', 'the UI is told the key changed');
  srv.close();
});

test('SSH via a jump host', async () => {
  const target = await sshServer({ prompt: 'TARGET#' });
  const jump = await sshServer({ user: 'jumper', pass: 'jp', forward: true });
  const m = manager();
  m.secrets.t = { password: 'secret' };
  m.secrets.j = { password: 'jp' };
  const session = { id: 't', protocol: 'ssh', host: '127.0.0.1', port: target.port, username: 'admin', jump: { session: { id: 'j', protocol: 'ssh', host: '127.0.0.1', port: jump.port, username: 'jumper' } } };
  await m.mgr.open('c3', { session, logEnabled: false });
  await m.waitFor(() => m.text('c3').includes('TARGET#'));
  assert.match(m.text('c3'), /Via jump host/);
  m.mgr.close('c3');
  await m.waitFor((e) => e[0] === 'conn:closed' && e[1] === 'c3');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(jump.clients.size, 0, 'jump connection closed with the tab');
  target.srv.close();
  jump.srv.close();
});

test('SSH via a jump host: a failing target does not leave the jump connection open', async () => {
  const jump = await sshServer({ user: 'jumper', pass: 'jp', forward: true });
  const closedPort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const m = manager();
  m.secrets.j = { password: 'jp' };
  const session = { id: 't', protocol: 'ssh', host: '127.0.0.1', port: closedPort, username: 'admin', jump: { session: { id: 'j', protocol: 'ssh', host: '127.0.0.1', port: jump.port, username: 'jumper' } } };
  await m.mgr.open('c4', { session, logEnabled: false });
  await m.waitFor((e) => e[0] === 'conn:closed' && e[1] === 'c4');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(jump.clients.size, 0, 'jump connection was ended');
  jump.srv.close();
});

test('Telnet: option negotiation (NAWS), auto-login, IAC escaping', async () => {
  const IAC = 255;
  const received = [];
  const srv = net.createServer((sock) => {
    sock.write(Buffer.from([IAC, 253, 31])); // DO NAWS
    sock.write('User Access Verification\r\n\r\nUsername: ');
    sock.on('data', (d) => {
      received.push(d);
      const t = Buffer.concat(received).toString('latin1');
      if (t.includes('admin\r') && !t.includes('PASSSENT')) { received.push(Buffer.from('PASSSENT')); sock.write('Password: '); }
      if (t.includes('s3cret\r') && !t.includes('DONE')) { received.push(Buffer.from('DONE')); sock.write('\r\nSW2#'); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const m = manager();
  m.secrets.tel = { password: 's3cret' };
  await m.mgr.open('c5', { session: { id: 'tel', protocol: 'telnet', host: '127.0.0.1', port: srv.address().port, username: 'admin', autoLogin: true }, cols: 100, rows: 30, logEnabled: false });
  await m.waitFor(() => m.text('c5').includes('SW2#'));
  const all = Buffer.concat(received);
  assert.ok(all.includes(Buffer.from([IAC, 251, 31])), 'WILL NAWS');
  assert.ok(all.includes(Buffer.from([IAC, 250, 31, 0, 100, 0, 30, IAC, 240])), 'window size 100x30');
  m.mgr.write('c5', 'x\xffy');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(Buffer.concat(received).includes(Buffer.from([0xc3, 0xbf])), 'non-ASCII sent as UTF-8');
  m.mgr.close('c5');
  srv.close();
});

test('Telnet: an unreachable host times out instead of hanging', async () => {
  const m = manager();
  m.mgr.getSettings = () => ({ ssh: { readyTimeout: 400 } });
  const started = Date.now();
  await m.mgr.open('c6', { session: { protocol: 'telnet', host: '10.255.255.1', port: 23 }, logEnabled: false });
  const closed = await m.waitFor((e) => e[0] === 'conn:closed' && e[1] === 'c6', 5000);
  assert.ok(Date.now() - started < 4000);
  assert.match(closed[2], /Error/);
});

test('output bursts reach the UI as one message, in order', async () => {
  const m = manager();
  const conn = { id: 'b', closed: false, outBuf: '', flushQueued: false, decoder: { write: (b) => b.toString() }, log: { write() {}, close() {} }, servers: [], destroy() {} };
  m.mgr.conns.set('b', conn);
  for (let i = 0; i < 50; i++) m.mgr.emit(conn, `line ${i}\r\n`);
  await new Promise((r) => setImmediate(r));
  const data = m.events.filter((e) => e[0] === 'conn:data');
  assert.strictEqual(data.length, 1);
  assert.ok(data[0][2].startsWith('line 0') && data[0][2].endsWith('line 49\r\n'));
  m.mgr.emit(conn, 'tail');
  m.mgr.finish(conn, 'bye');
  const kinds = m.events.slice(-2).map((e) => e[0]);
  assert.deepStrictEqual(kinds, ['conn:data', 'conn:closed'], 'pending output is flushed before the close');
});
