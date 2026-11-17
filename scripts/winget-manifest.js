// Writes winget manifests for a published release (the zip build, installed
// by winget as a portable app with the command alias "vytty").
//   node scripts/winget-manifest.js 0.10.0
// Then submit them to https://github.com/microsoft/winget-pkgs - e.g. with
//   wingetcreate submit packaging/winget/manifests/m/mtgmz14/Vytty/0.10.0
// (the first submission of a new package is reviewed by the winget team).
const fs = require('fs');
const path = require('path');

const version = String(process.argv[2] || require('../package.json').version).replace(/^v/, '');
const ID = 'mtgmz14.Vytty';
const SCHEMA = '1.10.0';
const base = `https://github.com/mtgmz14/vytty/releases/download/v${version}`;
const zipName = `Vytty-${version}-win-x64.zip`;

async function sha256() {
  const res = await fetch(`${base}/SHA256SUMS.txt`);
  if (!res.ok) throw new Error(`SHA256SUMS.txt not found for v${version} (${res.status})`);
  const line = (await res.text()).split(/\r?\n/).find((l) => l.trim().endsWith(zipName));
  if (!line) throw new Error(`${zipName} is not listed in SHA256SUMS.txt`);
  return line.trim().split(/\s+/)[0].toUpperCase();
}

(async () => {
  const hash = await sha256();
  const dir = path.join(__dirname, '..', 'packaging', 'winget', 'manifests', 'm', 'mtgmz14', 'Vytty', version);
  fs.mkdirSync(dir, { recursive: true });
  const head = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${SCHEMA}.schema.json\n`;
  fs.writeFileSync(path.join(dir, `${ID}.yaml`), `${head('version')}
PackageIdentifier: ${ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${SCHEMA}
`);
  fs.writeFileSync(path.join(dir, `${ID}.installer.yaml`), `${head('installer')}
PackageIdentifier: ${ID}
PackageVersion: ${version}
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: Vytty.exe
    PortableCommandAlias: vytty
ArchiveBinariesDependOnPath: true
Installers:
  - Architecture: x64
    InstallerUrl: ${base}/${zipName}
    InstallerSha256: ${hash}
ManifestType: installer
ManifestVersion: ${SCHEMA}
`);
  fs.writeFileSync(path.join(dir, `${ID}.locale.en-US.yaml`), `${head('defaultLocale')}
PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: mtgmz14
PublisherUrl: https://github.com/mtgmz14
PackageName: Vytty
PackageUrl: https://github.com/mtgmz14/vytty
License: MIT
LicenseUrl: https://github.com/mtgmz14/vytty/blob/main/LICENSE
ShortDescription: Portable SSH, Telnet and serial terminal with a session manager, encrypted vault and Cisco / Linux highlighting.
Description: |-
  Vytty is a portable terminal for network and Linux work: SSH (jump hosts, port forwarding, SFTP), Telnet with
  auto-login, serial consoles and local shells, a session tree with an encrypted password vault, daily per-device
  logs, Cisco IOS / NX-OS / Linux syntax highlighting, and imports from MobaXterm, PuTTY, SecureCRT and mRemoteNG.
Tags:
  - ssh
  - telnet
  - serial
  - terminal
  - sftp
  - cisco
  - mobaxterm
ReleaseNotesUrl: https://github.com/mtgmz14/vytty/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${SCHEMA}
`);
  console.log(`winget manifests written to ${dir}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
