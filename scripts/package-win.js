// After `electron-builder --win dir`: package dist/win-unpacked as
//   dist/Vytty-<version>-win-x64.zip      (files at the top level of the zip)
//   dist/Vytty-<version>-portable.exe     (our caching launcher)
// Doing this ourselves (instead of electron-builder's zip target) lets CI sign
// Vytty.exe first - e.g. through SignPath - and package the signed file.
// Usage: node scripts/package-win.js [--zip-only|--portable-only] [--no-sign]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildPortable } = require('./build-portable');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const appDir = path.join(root, 'dist', 'win-unpacked');
const zip = path.join(root, 'dist', `Vytty-${version}-win-x64.zip`);
const args = process.argv.slice(2);

function makeZip() {
  fs.rmSync(zip, { force: true });
  try {
    // 7-Zip is on the GitHub Windows runners; much faster than PowerShell.
    execFileSync('7z', ['a', '-tzip', '-mx=7', '-bso0', '-bsp0', zip, '.\\*'], { cwd: appDir, stdio: 'inherit' });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' });
  }
  console.log(`built ${zip}`);
}

try {
  if (!fs.existsSync(path.join(appDir, 'Vytty.exe'))) throw new Error(`${appDir}\\Vytty.exe not found - run electron-builder --win dir first`);
  if (!args.includes('--portable-only')) makeZip();
  if (!args.includes('--zip-only')) buildPortable({ sign: !args.includes('--no-sign') });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
