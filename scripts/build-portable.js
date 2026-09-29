// Builds dist/Vytty-<version>-portable.exe from dist/win-unpacked with our own
// launcher (build/portable.nsi), which unpacks each version only once.
// Needs NSIS (makensis): on PATH, in MAKENSIS, or in the default install folder.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const appDir = path.join(root, 'dist', 'win-unpacked');
const out = path.join(root, 'dist', `Vytty-${version}-portable.exe`);

if (!fs.existsSync(path.join(appDir, 'Vytty.exe'))) {
  console.error(`${appDir}\\Vytty.exe not found - run electron-builder first`);
  process.exit(1);
}

const candidates = [process.env.MAKENSIS, 'C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].filter(Boolean);
const makensis = candidates.find((p) => fs.existsSync(p)) || 'makensis';

execFileSync(makensis, ['/V2', `/DVERSION=${version}`, `/DAPP_DIR=${appDir}`, `/DOUT_FILE=${out}`, path.join(root, 'build', 'portable.nsi')], { stdio: 'inherit' });
console.log(`built ${out}`);
