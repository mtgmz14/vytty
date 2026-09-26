'use strict';
// Daily session logs: every session writes into <logDir>/YYYY-MM-DD.log and
// every session that day appends to the same file. Output is turned into
// plain text with a tiny line emulator (handles \r, \b, erase-line and cursor
// left/right) so "--More--" prompts and progress bars do not leave garbage.
const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');

const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStamp = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

let settings = { enabled: true, dir: '', timestamps: true, sessionTag: true };

function logDir() {
  return settings.dir && settings.dir.trim() ? settings.dir.trim() : paths.defaultLogs;
}

function todayFile() {
  return path.join(logDir(), `${dayStamp()}.log`);
}

function appendRaw(text) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(todayFile(), text, 'utf8');
  } catch (err) {
    console.error('[vytty] log write failed:', err.message);
  }
}

class SessionLog {
  constructor(name, descriptor, enabled) {
    this.name = name;
    this.enabled = enabled;
    this.line = [];
    this.cursor = 0;
    this.esc = '';
    if (this.enabled) {
      appendRaw(`\n===== [${dayStamp()} ${timeStamp()}] OPEN  "${name}" (${descriptor}) =====\n`);
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
    appendRaw(this.prefix() + text + '\n');
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
  }

  close(reason) {
    if (!this.enabled) return;
    if (this.line.length) this.emitLine();
    appendRaw(`===== [${dayStamp()} ${timeStamp()}] CLOSE "${this.name}"${reason ? ` (${reason})` : ''} =====\n`);
    this.enabled = false;
  }
}

module.exports = {
  SessionLog,
  configure(s) { settings = { ...settings, ...(s || {}) }; },
  logDir,
  todayFile,
};
