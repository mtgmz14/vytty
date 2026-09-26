'use strict';
// All terminal backends: SSH (with jump host, port forwarding and SFTP),
// Telnet (with a small option negotiator and auto-login), Serial and local shells.
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Client, utils: sshUtils } = require('ssh2');
const { SessionLog } = require('./logger');

let SerialPort = null;
let pty = null;
try { ({ SerialPort } = require('serialport')); } catch { /* optional */ }
try { pty = require('@lydell/node-pty'); } catch { /* optional */ }

const LEGACY_ALGOS = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'] },
  cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] },
  serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
  hmac: { append: ['hmac-sha1', 'hmac-md5'] },
};

const describe = (s) => {
  switch (s.protocol) {
    case 'ssh': return `ssh ${s.username ? `${s.username}@` : ''}${s.host}:${s.port || 22}`;
    case 'telnet': return `telnet ${s.host}:${s.port || 23}`;
    case 'serial': return `serial ${s.serialPath} ${s.baudRate || 9600}`;
    case 'local': return `local ${s.shell || defaultShell()}`;
    default: return s.protocol;
  }
};

function defaultShell() {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class ConnectionManager {
  constructor({ send, prompt, getSettings, vault, store }) {
    this.send = send;
    this.prompt = prompt;
    this.getSettings = getSettings;
    this.vault = vault;
    this.store = store;
    this.conns = new Map();
  }

  // ---------------------------------------------------------------- common

  secretFor(session, overrides) {
    let secret = {};
    try { if (session.id) secret = this.vault.get(session.id); } catch { /* locked */ }
    // No password of its own: fall back to the credential profile the UI resolved
    // (picked explicitly or matched by username).
    if (!secret.password && session.credentialId) {
      try {
        const cred = this.vault.get(`cred:${session.credentialId}`);
        if (cred.password) secret = { ...secret, password: cred.password };
      } catch { /* locked */ }
    }
    return { ...secret, ...(overrides || {}) };
  }

  async open(id, { session, secret: secretOverride, cols, rows, logEnabled, logName }) {
    const secret = this.secretFor(session, secretOverride);
    const conn = {
      id,
      session,
      secret,
      cols: cols || 80,
      rows: rows || 24,
      decoder: new StringDecoder('utf8'),
      log: new SessionLog(logName || session.name || session.host || 'session', describe(session), logEnabled !== false),
      closed: false,
      write: () => {},
      resize: () => {},
      destroy: () => {},
      autoLogin: null,
      startup: null,
      servers: [],
    };
    this.conns.set(id, conn);
    this.status(id, 'connecting', `Connecting: ${describe(session)}`);
    try {
      switch (session.protocol) {
        case 'ssh': await this.openSsh(conn); break;
        case 'telnet': this.openTelnet(conn); break;
        case 'serial': await this.openSerial(conn); break;
        case 'local': this.openLocal(conn); break;
        default: throw new Error(`Unknown protocol ${session.protocol}`);
      }
    } catch (err) {
      this.fail(conn, err);
    }
  }

  status(id, state, message) {
    this.send('conn:status', id, state, message || '');
  }

  emit(conn, chunk) {
    if (conn.closed) return;
    const text = typeof chunk === 'string' ? chunk : conn.decoder.write(chunk);
    if (!text) return;
    conn.log.write(text);
    this.send('conn:data', conn.id, text);
    if (conn.autoLogin) this.autoLoginStep(conn, text);
    if (conn.startup) conn.startup.onOutput();
  }

  fail(conn, err) {
    const msg = err && err.message ? err.message : String(err);
    this.finish(conn, `Error: ${msg}`);
  }

  finish(conn, reason) {
    if (conn.closed) return;
    conn.closed = true;
    conn.log.close(reason);
    for (const s of conn.servers) { try { s.close(); } catch { /* ignore */ } }
    try { conn.destroy(); } catch { /* ignore */ }
    this.conns.delete(conn.id);
    this.send('conn:closed', conn.id, reason || 'Connection closed');
  }

  write(id, data) {
    const c = this.conns.get(id);
    if (c && !c.closed) c.write(data);
  }

  resize(id, cols, rows) {
    const c = this.conns.get(id);
    if (!c || c.closed) return;
    c.cols = cols;
    c.rows = rows;
    try { c.resize(cols, rows); } catch { /* ignore */ }
  }

  close(id) {
    const c = this.conns.get(id);
    if (c) this.finish(c, 'Closed by user');
  }

  closeAll() {
    for (const c of [...this.conns.values()]) this.finish(c, 'Application closed');
  }

  // Startup commands: sent line by line once the output has been quiet for a moment.
  armStartup(conn) {
    const text = (conn.session.startupCommands || '').trim();
    if (!text) return;
    const lines = text.split(/\r?\n/);
    let timer = null;
    const fire = () => {
      conn.startup = null;
      let delay = 0;
      for (const line of lines) {
        setTimeout(() => this.write(conn.id, `${line}\r`), delay);
        delay += 200;
      }
    };
    conn.startup = {
      onOutput: () => {
        if (conn.autoLogin && !conn.autoLogin.done) return;
        clearTimeout(timer);
        timer = setTimeout(fire, 800);
      },
    };
    conn.startup.onOutput();
  }

  // Auto-login for Telnet / Serial: answer Username:/Password: prompts once.
  armAutoLogin(conn) {
    const { username } = conn.session;
    const { password } = conn.secret;
    if (conn.session.autoLogin === false || (!username && !password)) return;
    conn.autoLogin = { tail: '', userSent: !username, passSent: !password, done: false, started: Date.now() };
  }

  autoLoginStep(conn, text) {
    const a = conn.autoLogin;
    if (a.done) return;
    if (Date.now() - a.started > 60000) { a.done = true; return; }
    a.tail = (a.tail + text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-200);
    if (!a.userSent && /(user ?name|login)\s*:\s*$/i.test(a.tail)) {
      a.userSent = true;
      a.tail = '';
      this.write(conn.id, `${conn.session.username}\r`);
    } else if (!a.passSent && /pass(word|code)?\s*:\s*$/i.test(a.tail)) {
      a.passSent = true;
      a.tail = '';
      this.write(conn.id, `${conn.secret.password}\r`);
    }
    if (a.userSent && a.passSent) a.done = true;
  }

  // ------------------------------------------------------------------- SSH

  async verifyHostKey(host, port, key, ask = this.prompt) {
    const fingerprint = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const known = this.store.getKnownHosts();
    const hostId = `[${host}]:${port}`;
    if (known[hostId] === fingerprint) return true;
    const accepted = await ask('hostkey', {
      host, port, fingerprint, previous: known[hostId] || null,
    });
    if (accepted) {
      const fresh = this.store.getKnownHosts();
      fresh[hostId] = fingerprint;
      this.store.saveKnownHosts(fresh);
    }
    return !!accepted;
  }

  async loadPrivateKey(session, secret, warn) {
    if (!session.keyPath) return null;
    // Imported sessions (e.g. from MobaXterm) may point at keys that are not on
    // this machine: skip the key and fall back to password authentication.
    if (!fs.existsSync(session.keyPath)) {
      if (warn) warn(`[33m[Vytty] Private key not found: ${session.keyPath} - trying password[0m
`);
      return null;
    }
    const raw = fs.readFileSync(session.keyPath);
    let passphrase = secret.passphrase;
    let parsed = sshUtils.parseKey(raw, passphrase);
    if (parsed instanceof Error && /encrypted|passphrase/i.test(parsed.message)) {
      const answer = await this.prompt('secret', { title: 'Key passphrase', label: `Passphrase for ${session.keyPath}`, allowSave: !!session.id });
      if (!answer) throw new Error('Key passphrase required');
      passphrase = answer.value;
      parsed = sshUtils.parseKey(raw, passphrase);
      if (parsed instanceof Error) throw new Error(`Cannot load key: ${parsed.message}`);
      if (answer.save && session.id) this.saveSecret(session.id, { passphrase });
    } else if (parsed instanceof Error) {
      throw new Error(`Cannot load key: ${parsed.message}`);
    }
    return { key: raw, passphrase };
  }

  saveSecret(id, patch) {
    try {
      const cur = this.vault.get(id);
      this.vault.set(id, { ...cur, ...patch });
    } catch { /* vault locked - ignore */ }
  }

  // Connects an ssh2 Client for the given session. Resolves once authenticated.
  connectClient(session, secret, sock, onBanner) {
    const settings = this.getSettings();
    const host = session.host;
    const port = Number(session.port) || 22;
    return new Promise(async (resolve, reject) => {
      // Our own handshake timeout that pauses while the user answers a prompt
      // (ssh2's readyTimeout would keep ticking during host key / password dialogs).
      const timeoutMs = settings.ssh.readyTimeout || 20000;
      let timer = null;
      let paused = 0;
      let client = null;
      const arm = () => {
        clearTimeout(timer);
        if (paused || !client) return;
        timer = setTimeout(() => {
          reject(new Error('Timed out while waiting for handshake'));
          try { client.destroy(); } catch { /* ignore */ }
        }, timeoutMs);
      };
      const ask = async (kind, payload) => {
        paused++;
        clearTimeout(timer);
        try { return await this.prompt(kind, payload); } finally { paused--; arm(); }
      };

      let username = session.username;
      if (!username) {
        const ans = await this.prompt('secret', { title: 'Login', label: `Username for ${host}`, plain: true });
        if (!ans) return reject(new Error('Username required'));
        username = ans.value;
      }
      let keyInfo = null;
      try { keyInfo = await this.loadPrivateKey(session, secret, onBanner); } catch (e) { return reject(e); }

      let password = secret.password;
      let askedPassword = false;
      const askPassword = async (label) => {
        const ans = await ask('secret', { title: 'Password', label: label || `Password for ${username}@${host}`, allowSave: !!session.id });
        if (!ans) return null;
        askedPassword = true;
        password = ans.value;
        if (ans.save && session.id) this.saveSecret(session.id, { password });
        return password;
      };

      const methods = [];
      if (keyInfo) methods.push('publickey');
      if (session.useAgent) methods.push('agent');
      methods.push('password', 'keyboard-interactive');
      let passwordTries = 0;

      client = new Client();
      const nextAuth = async (methodsLeft, cb) => {
        while (methods.length) {
          const m = methods.shift();
          if (methodsLeft && !methodsLeft.includes(m === 'password-retry' ? 'password' : m)) continue;
          if (m === 'publickey') return cb({ type: 'publickey', username, key: keyInfo.key, passphrase: keyInfo.passphrase });
          if (m === 'agent') {
            const agent = process.platform === 'win32' ? (process.env.SSH_AUTH_SOCK || 'pageant') : process.env.SSH_AUTH_SOCK;
            if (agent) return cb({ type: 'agent', username, agent });
            continue;
          }
          if (m === 'password') {
            if (!password && !(await askPassword())) return cb(false);
            passwordTries++;
            // allow one retry after a wrong stored/typed password
            if (passwordTries < 3) methods.unshift('password-retry');
            return cb({ type: 'password', username, password });
          }
          if (m === 'password-retry') {
            if (!(await askPassword(`Wrong password. Password for ${username}@${host}`))) return cb(false);
            passwordTries++;
            if (passwordTries < 3) methods.unshift('password-retry');
            return cb({ type: 'password', username, password });
          }
          if (m === 'keyboard-interactive') {
            return cb({
              type: 'keyboard-interactive',
              username,
              prompt: async (name, instructions, lang, prompts, finish) => {
                const answers = [];
                for (const p of prompts) {
                  if (/password/i.test(p.prompt) && password && !askedPassword) { answers.push(password); continue; }
                  const ans = await ask('secret', { title: name || 'Authentication', label: `${instructions ? `${instructions}\n` : ''}${p.prompt}`, plain: !!p.echo });
                  answers.push(ans ? ans.value : '');
                }
                finish(answers);
              },
            });
          }
        }
        return cb(false);
      };
      // ssh2 treats a non-undefined return value as the answer, so never return the promise.
      const authHandler = (methodsLeft, _partial, cb) => { nextAuth(methodsLeft, cb).catch(() => cb(false)); };

      client.on('ready', () => { clearTimeout(timer); resolve(client); });
      client.on('error', (err) => { clearTimeout(timer); reject(err); });
      client.on('close', () => { clearTimeout(timer); reject(new Error('Connection closed during handshake')); });
      if (onBanner) client.on('banner', onBanner);

      const cfg = {
        host,
        port,
        username,
        sock,
        authHandler,
        tryKeyboard: true,
        readyTimeout: 0,
        keepaliveInterval: (session.keepalive ?? settings.ssh.keepaliveInterval) * 1000 || 0,
        keepaliveCountMax: 5,
        hostVerifier: (key, verify) => {
          this.verifyHostKey(host, port, key, ask).then(verify, () => verify(false));
        },
      };
      if (session.legacyAlgorithms ?? settings.ssh.legacyAlgorithms) cfg.algorithms = LEGACY_ALGOS;
      try { client.connect(cfg); arm(); } catch (e) { reject(e); }
    });
  }

  async openSsh(conn) {
    const { session, secret } = conn;
    let sock;
    let jumpClient = null;
    if (session.jump && session.jump.session) {
      const js = session.jump.session;
      this.emit(conn, `\x1b[2mVia jump host ${js.host}...\x1b[0m\r\n`);
      jumpClient = await this.connectClient(js, this.secretFor(js), undefined);
      sock = await new Promise((resolve, reject) => {
        jumpClient.forwardOut('127.0.0.1', 0, session.host, Number(session.port) || 22, (err, stream) => (err ? reject(err) : resolve(stream)));
      });
    }
    const client = await this.connectClient(session, secret, sock, (msg) => this.emit(conn, msg.replace(/\r?\n/g, '\r\n')));
    if (conn.closed) { client.end(); if (jumpClient) jumpClient.end(); return; }
    conn.client = client;
    client.on('close', () => this.finish(conn, 'Connection closed'));
    client.on('error', (err) => this.fail(conn, err));

    const stream = await new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: conn.cols, rows: conn.rows }, (err, s) => (err ? reject(err) : resolve(s)));
    });
    conn.stream = stream;
    conn.write = (d) => stream.write(d);
    conn.resize = (c, r) => stream.setWindow(r, c, 0, 0);
    conn.destroy = () => { client.end(); if (jumpClient) jumpClient.end(); };
    stream.on('data', (d) => this.emit(conn, d));
    stream.stderr.on('data', (d) => this.emit(conn, d));
    stream.on('close', () => this.finish(conn, 'Session ended'));
    this.status(conn.id, 'connected', describe(session));
    this.setupForwards(conn);
    this.armStartup(conn);
  }

  setupForwards(conn) {
    for (const f of conn.session.forwards || []) {
      if (!f || !f.listenPort) continue;
      const listenHost = f.listenHost || '127.0.0.1';
      let server;
      if (f.type === 'D') server = this.socksServer(conn);
      else {
        server = net.createServer((sock) => {
          conn.client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, f.destHost, Number(f.destPort), (err, stream) => {
            if (err) { sock.destroy(); return; }
            sock.pipe(stream).pipe(sock);
            sock.on('error', () => stream.close());
            stream.on('error', () => sock.destroy());
          });
        });
      }
      server.on('error', (err) => this.emit(conn, `\r\n\x1b[31m[forward ${f.listenPort}] ${err.message}\x1b[0m\r\n`));
      server.listen(Number(f.listenPort), listenHost, () => {
        const what = f.type === 'D' ? 'SOCKS5 proxy' : `-> ${f.destHost}:${f.destPort}`;
        this.emit(conn, `\x1b[2m[forward] ${listenHost}:${f.listenPort} ${what}\x1b[0m\r\n`);
      });
      conn.servers.push(server);
    }
  }

  // Minimal SOCKS5 (no auth, CONNECT only) for dynamic forwarding.
  socksServer(conn) {
    return net.createServer((sock) => {
      sock.once('data', (hello) => {
        if (hello[0] !== 5) return sock.destroy();
        sock.write(Buffer.from([5, 0]));
        sock.once('data', (req) => {
          if (req[0] !== 5 || req[1] !== 1) return sock.destroy();
          let host;
          let offset;
          if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); offset = 8; }
          else if (req[3] === 3) { const len = req[4]; host = req.subarray(5, 5 + len).toString(); offset = 5 + len; }
          else if (req[3] === 4) { host = req.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); offset = 20; }
          else return sock.destroy();
          const port = req.readUInt16BE(offset);
          conn.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
            if (err) { sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            sock.pipe(stream).pipe(sock);
            sock.on('error', () => stream.close());
            stream.on('error', () => sock.destroy());
          });
        });
      });
      sock.on('error', () => {});
    });
  }

  // ------------------------------------------------------------------ SFTP

  sftp(id) {
    const c = this.conns.get(id);
    if (!c || !c.client) return Promise.reject(new Error('SFTP is available for connected SSH sessions only'));
    if (c.sftpPromise) return c.sftpPromise;
    c.sftpPromise = new Promise((resolve, reject) => {
      c.client.sftp((err, sftp) => {
        if (err) { c.sftpPromise = null; reject(err); } else resolve(sftp);
      });
    });
    return c.sftpPromise;
  }

  async sftpOp(id, op, args) {
    const sftp = await this.sftp(id);
    const call = (fn, ...a) => new Promise((resolve, reject) => sftp[fn](...a, (err, res) => (err ? reject(err) : resolve(res))));
    switch (op) {
      case 'realpath': return call('realpath', args.path || '.');
      case 'list': {
        const list = await call('readdir', args.path);
        return list.map((e) => ({
          name: e.filename,
          size: e.attrs.size,
          mtime: e.attrs.mtime * 1000,
          isDir: (e.attrs.mode & 0o170000) === 0o040000,
          isLink: (e.attrs.mode & 0o170000) === 0o120000,
          mode: e.attrs.mode,
        })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
      }
      case 'stat': {
        const st = await call('stat', args.path);
        return { isDir: (st.mode & 0o170000) === 0o040000, size: st.size };
      }
      case 'mkdir': return call('mkdir', args.path);
      case 'rmdir': return call('rmdir', args.path);
      case 'unlink': return call('unlink', args.path);
      case 'rename': return call('rename', args.from, args.to);
      case 'download': return this.transfer(id, call, 'download', args.remote, args.local);
      case 'upload': return this.transfer(id, call, 'upload', args.local, args.remote);
      // Upload local files and folders (recursively) into a remote directory.
      case 'uploadPaths': {
        let count = 0;
        const put = async (local, remoteDir) => {
          const name = path.basename(local);
          const remote = path.posix.join(remoteDir, name);
          const st = await fs.promises.stat(local);
          if (st.isDirectory()) {
            await call('mkdir', remote).catch(() => {});
            for (const child of await fs.promises.readdir(local)) await put(path.join(local, child), remote);
          } else {
            await this.transfer(id, call, 'upload', local, remote);
            count++;
          }
        };
        for (const local of args.locals) await put(local, args.remoteDir);
        return count;
      }
      // Download remote files and folders (recursively) into a local directory.
      case 'downloadPaths': return this.downloadTree(id, call, args.items, args.localDir);
      // Delete files, or folders with everything inside.
      case 'remove': {
        const rm = async (p, isDir) => {
          if (!isDir) return call('unlink', p);
          for (const e of await call('readdir', p)) {
            await rm(path.posix.join(p, e.filename), (e.attrs.mode & 0o170000) === 0o040000);
          }
          return call('rmdir', p);
        };
        for (const it of args.items) await rm(it.path, it.isDir);
        return true;
      }
      default: throw new Error(`Unknown SFTP op ${op}`);
    }
  }

  async downloadTree(id, call, items, localDir) {
    const out = [];
    const get = async (remote, isDir, targetDir) => {
      const local = path.join(targetDir, path.posix.basename(remote));
      if (isDir) {
        await fs.promises.mkdir(local, { recursive: true });
        for (const e of await call('readdir', remote)) {
          await get(path.posix.join(remote, e.filename), (e.attrs.mode & 0o170000) === 0o040000, local);
        }
      } else {
        await this.transfer(id, call, 'download', remote, local);
      }
      return local;
    };
    await fs.promises.mkdir(localDir, { recursive: true });
    for (const it of items) out.push(await get(it.path, it.isDir, localDir));
    return out;
  }

  // Single file transfer with throttled progress events.
  transfer(id, call, op, from, to) {
    const fn = op === 'download' ? 'fastGet' : 'fastPut';
    const name = from.split(/[\\/]/).pop();
    let last = 0;
    return call(fn, from, to, {
      step: (transferred, _chunk, total) => {
        const now = Date.now();
        if (now - last > 150 || transferred === total) {
          last = now;
          this.send('sftp:progress', id, { name, transferred, total, op });
        }
      },
    });
  }

  // Download remote items into a per-drag temp folder so they can be dragged
  // out to Explorer. Results are cached by path + size + mtime, so dragging
  // the same file again is instant.
  prepareDrag(id, items) {
    this.dragCache = this.dragCache || new Map();
    const key = `${id}|${items.map((i) => `${i.path}:${i.size}:${i.mtime}`).join('|')}`;
    if (!this.dragCache.has(key)) {
      const dir = path.join(os.tmpdir(), 'vytty-drag', crypto.randomBytes(6).toString('hex'));
      const p = this.sftp(id)
        .then((sftp) => {
          const call = (fn, ...a) => new Promise((resolve, reject) => sftp[fn](...a, (err, res) => (err ? reject(err) : resolve(res))));
          return this.downloadTree(id, call, items, dir);
        })
        .catch((err) => { this.dragCache.delete(key); throw err; });
      this.dragCache.set(key, p);
    }
    return this.dragCache.get(key);
  }

  static cleanupDragTemp() {
    try { fs.rmSync(path.join(os.tmpdir(), 'vytty-drag'), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- Telnet

  openTelnet(conn) {
    const { session } = conn;
    const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
    const ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;
    const sock = net.connect({ host: session.host, port: Number(session.port) || 23 });
    let naws = false;
    let state = 0; // 0 data, 1 IAC, 2 option verb, 3 SB, 4 SB-IAC
    let verb = 0;
    let sbBuf = [];

    const sendNaws = () => {
      if (!naws) return;
      const b = Buffer.from([IAC, SB, NAWS, conn.cols >> 8, conn.cols & 255, conn.rows >> 8, conn.rows & 255, IAC, SE]);
      sock.write(b);
    };

    sock.setNoDelay(true);
    sock.on('connect', () => {
      this.status(conn.id, 'connected', describe(session));
      this.armAutoLogin(conn);
      this.armStartup(conn);
    });
    sock.on('data', (buf) => {
      const out = [];
      for (const byte of buf) {
        if (state === 0) {
          if (byte === IAC) state = 1; else out.push(byte);
        } else if (state === 1) {
          if (byte === IAC) { out.push(IAC); state = 0; }
          else if (byte >= WILL && byte <= DONT) { verb = byte; state = 2; }
          else if (byte === SB) { sbBuf = []; state = 3; }
          else state = 0;
        } else if (state === 2) {
          const opt = byte;
          if (verb === DO) {
            if (opt === NAWS) { sock.write(Buffer.from([IAC, WILL, NAWS])); naws = true; sendNaws(); }
            else if (opt === TTYPE) sock.write(Buffer.from([IAC, WILL, TTYPE]));
            else if (opt === SGA) sock.write(Buffer.from([IAC, WILL, SGA]));
            else sock.write(Buffer.from([IAC, WONT, opt]));
          } else if (verb === WILL) {
            if (opt === ECHO || opt === SGA) sock.write(Buffer.from([IAC, DO, opt]));
            else sock.write(Buffer.from([IAC, DONT, opt]));
          }
          state = 0;
        } else if (state === 3) {
          if (byte === IAC) state = 4; else sbBuf.push(byte);
        } else if (state === 4) {
          if (byte === SE) {
            if (sbBuf[0] === TTYPE && sbBuf[1] === 1) {
              sock.write(Buffer.concat([Buffer.from([IAC, SB, TTYPE, 0]), Buffer.from('XTERM-256COLOR'), Buffer.from([IAC, SE])]));
            }
            state = 0;
          } else { sbBuf.push(byte); state = 3; }
        }
      }
      if (out.length) this.emit(conn, Buffer.from(out));
    });
    sock.on('error', (err) => this.fail(conn, err));
    sock.on('close', () => this.finish(conn, 'Connection closed by remote host'));
    conn.write = (d) => {
      // Escape IAC bytes in user data.
      const b = Buffer.from(d, 'utf8');
      sock.write(b.includes(IAC) ? Buffer.from([...b].flatMap((x) => (x === IAC ? [IAC, IAC] : [x]))) : b);
    };
    conn.resize = () => sendNaws();
    conn.destroy = () => sock.destroy();
  }

  // ---------------------------------------------------------------- Serial

  async openSerial(conn) {
    if (!SerialPort) throw new Error('Serial support is not available in this build');
    const s = conn.session;
    const port = new SerialPort({
      path: s.serialPath,
      baudRate: Number(s.baudRate) || 9600,
      dataBits: Number(s.dataBits) || 8,
      parity: s.parity || 'none',
      stopBits: Number(s.stopBits) || 1,
      rtscts: s.flowControl === 'hardware',
      xon: s.flowControl === 'software',
      xoff: s.flowControl === 'software',
      autoOpen: false,
    });
    await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    port.on('data', (d) => this.emit(conn, d));
    port.on('error', (err) => this.fail(conn, err));
    port.on('close', () => this.finish(conn, 'Serial port closed'));
    conn.write = (d) => port.write(d);
    conn.destroy = () => { if (port.isOpen) port.close(); };
    this.status(conn.id, 'connected', describe(s));
    this.armAutoLogin(conn);
    this.armStartup(conn);
    // Wake the console so the prompt shows up.
    setTimeout(() => { if (!conn.closed) port.write('\r'); }, 300);
  }

  static async listSerialPorts() {
    if (!SerialPort) return [];
    try {
      return (await SerialPort.list()).map((p) => ({ path: p.path, label: [p.path, p.friendlyName || p.manufacturer].filter(Boolean).join(' - ') }));
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------------- Local

  openLocal(conn) {
    if (!pty) throw new Error('Local shell support is not available in this build');
    const s = conn.session;
    const shell = s.shell || defaultShell();
    const proc = pty.spawn(shell, splitArgs(s.shellArgs), {
      name: 'xterm-256color',
      cols: conn.cols,
      rows: conn.rows,
      cwd: s.cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    proc.onData((d) => this.emit(conn, d));
    proc.onExit(({ exitCode }) => this.finish(conn, `Process exited with code ${exitCode}`));
    conn.write = (d) => proc.write(d);
    conn.resize = (c, r) => proc.resize(c, r);
    conn.destroy = () => { try { proc.kill(); } catch { /* ignore */ } };
    this.status(conn.id, 'connected', describe(s));
    this.armStartup(conn);
  }
}

module.exports = { ConnectionManager, capabilities: { serial: !!SerialPort, local: !!pty } };
