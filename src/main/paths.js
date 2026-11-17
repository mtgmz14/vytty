'use strict';
// Resolves where Vytty keeps its data. Vytty is portable: everything lives
// next to the executable in "VyttyData" (or ./data when running from source).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const PORTABLE_ARG = '--vytty-portable-exe=';

// The portable launcher (build/portable.nsi) starts the unpacked app with
// --vytty-portable-exe=<path of the launcher>. Older launchers (and
// electron-builder's portable target) used environment variables instead.
function portableExe(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(PORTABLE_ARG));
  if (arg) return arg.slice(PORTABLE_ARG.length).replace(/^"|"$/g, '') || null;
  return env.PORTABLE_EXECUTABLE_FILE || null;
}

function resolveDataDir() {
  if (process.env.VYTTY_DATA_DIR) return process.env.VYTTY_DATA_DIR;
  // CI smoke test of a packaged build: never touch a real data folder.
  if (process.argv.includes('--smoke-test')) return path.join(os.tmpdir(), `vytty-smoke-${process.pid}`);
  if (!app.isPackaged) return path.join(__dirname, '..', '..', 'data');
  // Microsoft Store (MSIX) builds run from a read-only folder.
  if (process.windowsStore) return path.join(app.getPath('appData'), 'Vytty');
  const exe = portableExe();
  if (exe) return path.join(path.dirname(exe), 'VyttyData');
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'VyttyData');
  return path.join(path.dirname(process.execPath), 'VyttyData');
}

const dataDir = resolveDataDir();

const paths = {
  dataDir,
  settings: path.join(dataDir, 'settings.json'),
  sessions: path.join(dataDir, 'sessions.json'),
  vault: path.join(dataDir, 'vault.json'),
  knownHosts: path.join(dataDir, 'known_hosts.json'),
  updateState: path.join(dataDir, 'update-state.json'),
  defaultLogs: path.join(dataDir, 'logs'),
  chromium: path.join(dataDir, '.chromium'),
};

function ensureDirs() {
  for (const d of [paths.dataDir, paths.defaultLogs, paths.chromium]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { paths, ensureDirs, portableExe, PORTABLE_ARG };
