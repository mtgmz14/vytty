'use strict';
// Session import from other tools. Each parser returns
//   { folders, sessions, stats: { total, imported, byType, skipped }, secrets? }
// where sessions/folders carry their own ids (the renderer gives them fresh
// ones when merging) and secrets maps a session id to { password } for
// formats that contain passwords (mRemoteNG).
const mobaxterm = require('./mobaxterm');
const putty = require('./putty');
const securecrt = require('./securecrt');
const mremoteng = require('./mremoteng');
const sshconfig = require('./sshconfig');
const csv = require('./csv');

const FORMATS = {
  mobaxterm: {
    label: 'MobaXterm',
    filters: [{ name: 'MobaXterm sessions', extensions: ['mxtsessions', 'mobaxterm', 'moba', 'ini', 'txt'] }],
    parse: (data) => mobaxterm.parseFile(data),
  },
  putty: {
    label: 'PuTTY / KiTTY',
    filters: [{ name: 'Registry export', extensions: ['reg'] }],
    parse: (data) => putty.parse(data),
  },
  securecrt: {
    label: 'SecureCRT',
    filters: [{ name: 'SecureCRT XML export', extensions: ['xml'] }],
    parse: (data) => securecrt.parseXmlExport(data),
  },
  'securecrt-dir': {
    label: 'SecureCRT (session folder)',
    directory: true,
    parse: (dir) => securecrt.parseSessionDir(dir),
  },
  mremoteng: {
    label: 'mRemoteNG',
    filters: [{ name: 'mRemoteNG connections', extensions: ['xml'] }],
    parse: (data, opts) => mremoteng.parse(data, opts),
  },
  sshconfig: {
    label: 'OpenSSH config',
    filters: [{ name: 'SSH config', extensions: ['*'] }],
    defaultPath: sshconfig.defaultPath,
    parse: (data) => sshconfig.parse(data),
  },
  csv: {
    label: 'CSV',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt', 'tsv'] }],
    parse: (data) => csv.parse(data),
  },
};

function parseImport(format, data, opts) {
  const f = FORMATS[format];
  if (!f) throw new Error(`Unknown import format ${format}`);
  return f.parse(data, opts || {});
}

module.exports = { FORMATS, parseImport };
