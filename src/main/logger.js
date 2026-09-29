'use strict';
// Session logs, one file per device and day: <logDir>/<hostname>#YYYY-MM-DD.log.
// Every session to the same device that day appends to the same file.
// The hostname is read from the device prompt ("SW1#", "SW1(config)#",
// "user@host:~$", "[user@host ~]$"), so a device reached by IP or by name
// ends up in one file; output before the first prompt (banner, login) is held
// until it is known. Without a recognisable prompt the session's host is used.
// Output is turned into plain text with a tiny line emulator (handles \r, \b,
// erase-line and cursor left/right) so "--More--" prompts and progress bars do
// not leave garbage.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('./paths');

const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStamp = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

let settings = { enabled: true, dir: '', timestamps: true, sessionTag: true };

function logDir() {
  return settings.dir && settings.dir.trim() ? settings.dir.trim() : paths.defaultLogs;
}

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'unknown';
const fileFor = (host) => path.join(logDir(), `${safeName(host)}#${dayStamp()}.log`);

// Prompt patterns. The first capture group is the hostname.
const PROMPTS = [
  // Linux / Juniper / MikroTik: user@host:~$, [user@host dir]$, user@host>, [admin@host] >
  /^\[?[\w.-]+@([A-Za-z0-9][\w.-]*)(?::\S*?|\s[^\]\s]*)?\]?\s?[$#>%](?:\s|$)/,
  /^([A-Za-z0-9][\w.-]{0,62})(?:\([\w./:-]*\))?[#>]/, // Cisco IOS / NX-OS / ASA: host#, host(config-if)#, host>
];
const PROMPT_END = /[#>$%\]]\s?$/;

function hostFromPrompt(text, partial) {
  if (partial && !PROMPT_END.test(text)) return null;
  for (const re of PROMPTS) {
    const m = re.exec(text);
    if (m && !/^\d+$/.test(m[1]) && m[1].length > 1) return m[1];
  }
  return null;
}

// Writes are batched per file: syncing to disk on every line blocked the main
// process (which also relays keystrokes) and made busy terminals feel laggy.
const queue = new Map(); // file -> text
let queued = 0;
let flushTimer = null;
const madeDirs = new Set();

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const [file, text] of queue) {
    try {
      const dir = path.dirname(file);
      if (!madeDirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); madeDirs.add(dir); }
      fs.appendFileSync(file, text, 'utf8');
    } catch (err) {
      madeDirs.clear();
      console.error('[vytty] log write failed:', err.message);
    }
  }
  queue.clear();
  queued = 0;
}

function appendTo(file, text) {
  queue.set(file, (queue.get(file) || '') + text);
  queued += text.length;
  if (queued > 256 * 1024) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, 500);
}

const HOLD_MS = 30000;
const HOLD_BYTES = 512 * 1024;

class SessionLog {
  // fallbackHost: used when no prompt is recognised (session host, serial port...).
  constructor(name, descriptor, enabled, fallbackHost) {
    this.name = name;
    this.enabled = enabled;
    this.fallback = fallbackHost || name;
    this.host = null;
    this.held = [];
    this.heldBytes = 0;
    this.line = [];
    this.cursor = 0;
    this.esc = '';
    if (this.enabled) {
      this.out(`\n===== [${dayStamp()} ${timeStamp()}] OPEN  "${name}" (${descriptor}) =====\n`);
      this.holdTimer = setTimeout(() => { if (!this.host) this.setHost(this.fallback); }, HOLD_MS);
      if (this.holdTimer.unref) this.holdTimer.unref();
    }
  }

  out(text) {
    if (this.host) { appendTo(fileFor(this.host), text); return; }
    this.held.push(text);
    this.heldBytes += text.length;
    if (this.heldBytes > HOLD_BYTES) this.setHost(this.fallback);
  }

  // Start writing to the file of `host`. A later prompt with another hostname
  // (e.g. ssh/telnet from a jump box to the next device) moves to that file.
  setHost(host) {
    if (!host || host === this.host) return;
    const stamp = `[${dayStamp()} ${timeStamp()}]`;
    if (this.host) {
      appendTo(fileFor(this.host), `----- ${stamp} "${this.name}" continues on ${host} -----\n`);
      appendTo(fileFor(host), `\n----- ${stamp} "${this.name}" continued from ${this.host} -----\n`);
    }
    this.host = host;
    clearTimeout(this.holdTimer);
    if (this.held.length) {
      appendTo(fileFor(host), this.held.join(''));
      this.held = [];
      this.heldBytes = 0;
    }
  }

  prefix() {
    let p = '';
    if (settings.timestamps) p += `[${timeStamp()}] `;
    if (settings.sessionTag) p += `[${this.name}] `;
    return p;
  }

  emitLine() {
    const text = this.line.join('').replace(/\s+$/, '');
    this.line = [];
    this.cursor = 0;
    const host = hostFromPrompt(text, false);
    if (host) this.setHost(host);
    this.out(this.prefix() + text + '\n');
  }

  putChar(ch) {
    if (this.cursor < this.line.length) this.line[this.cursor] = ch;
    else {
      while (this.line.length < this.cursor) this.line.push(' ');
      this.line.push(ch);
    }
    this.cursor++;
  }

  handleCsi(seq) {
    const final = seq[seq.length - 1];
    const n = parseInt(seq.slice(2, -1), 10);
    const count = Number.isNaN(n) ? 1 : n;
    if (final === 'K') {
      const mode = Number.isNaN(n) ? 0 : n;
      if (mode === 0) this.line.length = Math.min(this.line.length, this.cursor);
      else if (mode === 2) { this.line = []; }
    } else if (final === 'D') this.cursor = Math.max(0, this.cursor - count);
    else if (final === 'C') this.cursor += count;
    else if (final === 'G') this.cursor = Math.max(0, count - 1);
  }

  write(text) {
    if (!this.enabled || !settings.enabled) return;
    for (const ch of text) {
      if (this.esc) {
        this.esc += ch;
        const s = this.esc;
        if (s.length === 2 && s[1] !== '[' && s[1] !== ']' && s[1] !== '(' && s[1] !== ')') this.esc = '';
        else if (s[1] === '[' && s.length > 2 && ch >= '@' && ch <= '~') { this.handleCsi(s); this.esc = ''; }
        else if (s[1] === ']' && (ch === '\x07' || s.endsWith('\x1b\\'))) this.esc = '';
        else if ((s[1] === '(' || s[1] === ')') && s.length === 3) this.esc = '';
        else if (s.length > 256) this.esc = '';
        continue;
      }
      if (ch === '\x1b') { this.esc = ch; continue; }
      if (ch === '\n') { this.emitLine(); continue; }
      if (ch === '\r') { this.cursor = 0; continue; }
      if (ch === '\b') { this.cursor = Math.max(0, this.cursor - 1); continue; }
      if (ch === '\t') { this.putChar('\t'); continue; }
      if (ch < ' ' || ch === '\x7f') continue;
      this.putChar(ch);
    }
    // A prompt waiting for input is the last, unterminated line.
    if (!this.host && this.line.length && this.line.length < 200) {
      const host = hostFromPrompt(this.line.join('').replace(/\s+$/, ' '), true);
      if (host) this.setHost(host);
    }
  }

  close(reason) {
    if (!this.enabled) return;
    if (this.line.length) this.emitLine();
    if (!this.host) this.setHost(this.fallback);
    this.out(`===== [${dayStamp()} ${timeStamp()}] CLOSE "${this.name}"${reason ? ` (${reason})` : ''} =====\n`);
    flush();
    this.enabled = false;
  }
}

// Default file name for a session that has not shown a prompt yet.
function fallbackHost(session) {
  if (session.protocol === 'local') return os.hostname();
  if (session.protocol === 'serial') return path.basename(session.serialPath || 'serial');
  return session.host || session.name || 'session';
}

module.exports = {
  SessionLog,
  configure(s) { flush(); settings = { ...settings, ...(s || {}) }; },
  flush,
  logDir,
  fallbackHost,
};
