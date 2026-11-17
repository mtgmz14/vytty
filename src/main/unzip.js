'use strict';
// In-process zip extraction for the folder (zip) build's updates. Earlier
// versions ran Windows' tar.exe for this; a terminal app spawning tar.exe to
// unpack executables is a living-off-the-land pattern that EDR products flag.
// yauzl validates entry names (no absolute paths, no "..") and sizes.
const path = require('path');
const yauzl = require('yauzl');
// Inside Electron, plain `fs` treats *.asar files as folders; the archive
// contains resources/app.asar, which must be written as a normal file.
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();

function extractZip(zipPath, destDir) {
  const root = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
      if (err) { reject(err); return; }
      let files = 0;
      let failed = false;
      const fail = (e) => {
        if (failed) return;
        failed = true;
        try { zip.close(); } catch { /* ignore */ }
        reject(e);
      };
      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(files); });
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        const target = path.resolve(root, name);
        if (target !== root && !target.startsWith(root + path.sep)) { fail(new Error(`Unsafe path in archive: ${name}`)); return; }
        if (name.endsWith('/')) {
          fs.mkdir(target, { recursive: true }, (e) => (e ? fail(e) : zip.readEntry()));
          return;
        }
        fs.mkdir(path.dirname(target), { recursive: true }, (e) => {
          if (e) { fail(e); return; }
          zip.openReadStream(entry, (e2, rs) => {
            if (e2) { fail(e2); return; }
            const ws = fs.createWriteStream(target);
            rs.on('error', fail);
            ws.on('error', fail);
            ws.on('close', () => { files++; if (!failed) zip.readEntry(); });
            rs.pipe(ws);
          });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { extractZip };
