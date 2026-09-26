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

// Write to a temp file and rename so a crash never leaves half-written JSON.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
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
  reconnectKey: true,
  confirmCloseConnected: true,
  sidebarWidth: 260,
  sidebarVisible: true,
  snippets: [
    { id: 'sn1', name: 'Cisco: show ip int brief', text: 'show ip interface brief\\n' },
    { id: 'sn2', name: 'Cisco: terminal length 0', text: 'terminal length 0\\n' },
    { id: 'sn3', name: 'Nexus: show int status', text: 'show interface status\\n' },
    { id: 'sn4', name: 'Linux: system info', text: 'uname -a && uptime && df -h\\n' },
  ],
};

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') {
      for (const k of Object.keys(over)) {
        out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
      }
    }
    return out;
  }
  return over === undefined ? base : over;
}

const store = {
  getSettings() {
    return deepMerge(DEFAULT_SETTINGS, readJson(paths.settings, {}));
  },
  saveSettings(settings) {
    writeJson(paths.settings, settings);
    return this.getSettings();
  },
  getSessions() {
    const s = readJson(paths.sessions, null);
    if (s && Array.isArray(s.sessions)) return { folders: s.folders || [], sessions: s.sessions };
    return { folders: [], sessions: [] };
  },
  saveSessions(tree) {
    writeJson(paths.sessions, { folders: tree.folders || [], sessions: tree.sessions || [] });
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

module.exports = { store, DEFAULT_SETTINGS };
