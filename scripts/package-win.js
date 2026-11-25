// After `cargo build --release -p vytty` on Windows: package the one
// executable as
//   dist/Vytty-<version>-portable.exe   (the file itself - nothing to unpack)
//   dist/Vytty-<version>-win-x64.zip    (the same file as Vytty.exe in a zip,
//                                        also what Vytty 0.10's updater expects)
// CI signs Vytty.exe first (SignPath, a .pfx or Azure) and then packages it.
// Usage: node scripts/package-win.js [path to the built exe]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const built = path.resolve(process.argv[2] || path.join(root, 'target', 'release', 'vytty.exe'));
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'win-unpacked');
const zip = path.join(dist, `Vytty-${version}-win-x64.zip`);
const portable = path.join(dist, `Vytty-${version}-portable.exe`);

function makeZip() {
  fs.rmSync(zip, { force: true });
  try {
    // 7-Zip is on the GitHub Windows runners.
    execFileSync('7z', ['a', '-tzip', '-mx=9', '-bso0', '-bsp0', zip, 'Vytty.exe'], { cwd: stage, stdio: 'inherit' });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${path.join(stage, 'Vytty.exe')}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' });
  }
}

try {
  if (!fs.existsSync(built)) throw new Error(`${built} not found - run cargo build --release -p vytty first`);
  const staged = path.join(stage, 'Vytty.exe');
  fs.mkdirSync(stage, { recursive: true });
  // CI signs dist/win-unpacked/Vytty.exe in place and passes that file.
  if (path.resolve(built).toLowerCase() !== staged.toLowerCase()) fs.copyFileSync(built, staged);
  for (const f of fs.readdirSync(stage)) if (f !== 'Vytty.exe') fs.rmSync(path.join(stage, f), { recursive: true, force: true });
  makeZip();
  fs.copyFileSync(staged, portable);
  for (const f of [zip, portable]) console.log(`built ${path.relative(root, f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
