'use strict';
// Shared test setup: a temporary data folder and a stand-in for the parts of
// the `electron` module the main-process code touches, so it runs under plain
// Node (`node --test`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-test-'));
process.env.VYTTY_DATA_DIR = dataDir;

const electronStub = {
  app: {
    isPackaged: false,
    getVersion: () => '0.10.0',
    getPath: () => dataDir,
    setPath: () => {},
    relaunch: () => {},
  },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

module.exports = { dataDir, electronStub, fixture: (name) => path.join(__dirname, '..', 'fixtures', name) };
