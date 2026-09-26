'use strict';
// Resolves where Vytty keeps its data. Vytty is portable: everything lives
// next to the executable in "VyttyData" (or ./data when running from source).
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function resolveDataDir() {
  if (process.env.VYTTY_DATA_DIR) return process.env.VYTTY_DATA_DIR;
  if (!app.isPackaged) return path.join(__dirname, '..', '..', 'data');
  // electron-builder "portable" target extracts to a temp dir and exposes
  // the real exe location through PORTABLE_EXECUTABLE_DIR.
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  return path.join(exeDir, 'VyttyData');
}

const dataDir = resolveDataDir();

const paths = {
  dataDir,
  settings: path.join(dataDir, 'settings.json'),
  sessions: path.join(dataDir, 'sessions.json'),
  vault: path.join(dataDir, 'vault.json'),
  knownHosts: path.join(dataDir, 'known_hosts.json'),
  defaultLogs: path.join(dataDir, 'logs'),
  chromium: path.join(dataDir, '.chromium'),
};

function ensureDirs() {
  for (const d of [paths.dataDir, paths.defaultLogs, paths.chromium]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { paths, ensureDirs };
