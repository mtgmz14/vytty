'use strict';
const fs = require('fs');
const { paths } = require('./paths');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Antivirus / EDR scanners (Defender, CrowdStrike...) briefly open files that
// were just written; on Windows a rename over such a file then fails with
// EPERM/EBUSY. Retry for a moment instead of losing the save.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(from, to, tries = 12) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(Math.min(25 * (i + 1), 200));
    }
  }
}

// Write to a temp file, flush it to disk and rename, so a crash or a power
// cut never leaves half-written JSON behind.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    try { fs.fsyncSync(fd); } catch { /* not supported everywhere */ }
  } finally {
    fs.closeSync(fd);
  }
  renameRetry(tmp, file);
}

const DEFAULT_SETTINGS = {
  theme: 'vytty-dark',
  fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  fontSize: 14,
  lineHeight: 1.1,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 20000,
  bell: 'visual',
  copyOnSelect: true,
  trimSelection: true,
  rightClick: 'paste', // paste | menu | none
  middleClick: 'paste', // paste | none
  confirmMultilinePaste: true,
  wordSeparator: ' ()[]{}\'"`,;<>|',
  logging: {
    enabled: true,
    dir: '',
    timestamps: true,
    sessionTag: true,
  },
  highlight: {
    enabled: true,
    defaultProfile: 'auto',
    customRules: [],
  },
  ssh: {
    keepaliveInterval: 30,
    legacyAlgorithms: false,
    readyTimeout: 20000,
  },
  telnet: {
    autoLogin: true,
  },
  updates: {
    autoCheck: true,
    skipVersion: '',
  },
  reconnectKey: true,
  confirmCloseConnected: true,
  sidebarWidth: 260,
  sidebarVisible: true,
  snippets: [],
};

const LEGACY_SNIPPETS = {
  sn1: 'Cisco: show ip int brief|show ip interface brief\\n',
  sn2: 'Cisco: terminal length 0|terminal length 0\\n',
  sn3: 'Nexus: show int status|show interface status\\n',
  sn4: 'Linux: system info|uname -a && uptime && df -h\\n',
};

// Saved values over the defaults. A saved value of the wrong type (a hand
// edited or damaged file) falls back to the default instead of breaking the UI.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object' && !Array.isArray(over)) {
      for (const k of Object.keys(over)) {
        if (UNSAFE_KEYS.has(k)) continue;
        out[k] = Object.prototype.hasOwnProperty.call(base, k) ? deepMerge(base[k], over[k]) : over[k];
      }
    }
    return out;
  }
  if (over === undefined || over === null || typeof over !== typeof base) return base;
  return over;
}

const store = {
  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(paths.settings, {}));
    // 0.1.0 shipped example snippets; drop them unless the user edited them.
    s.snippets = s.snippets.filter((sn) => !(LEGACY_SNIPPETS[sn.id] && LEGACY_SNIPPETS[sn.id] === `${sn.name}|${sn.text}`));
    return s;
  },
  saveSettings(settings) {
    writeJson(paths.settings, settings);
    return this.getSettings();
  },
  getSessions() {
    const s = readJson(paths.sessions, null);
    if (s && Array.isArray(s.sessions)) return { folders: s.folders || [], sessions: s.sessions, credentials: s.credentials || [] };
    return { folders: [], sessions: [], credentials: [] };
  },
  // credentials: [{ id, name, username, auto }] - passwords live in the vault as "cred:<id>".
  saveSessions(tree) {
    writeJson(paths.sessions, { folders: tree.folders || [], sessions: tree.sessions || [], credentials: tree.credentials || [] });
  },
  getKnownHosts() {
    return readJson(paths.knownHosts, {});
  },
  saveKnownHosts(hosts) {
    writeJson(paths.knownHosts, hosts);
  },
  readJson,
  writeJson,
};

module.exports = { store, DEFAULT_SETTINGS, deepMerge, renameRetry };
