// Prints the release notes for a version: its CHANGELOG.md section plus how to
// verify the download. Usage: node scripts/release-notes.js 0.10.0
const fs = require('fs');
const path = require('path');

const version = String(process.argv[2] || '').replace(/^v/, '');
const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((l) => new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
if (start === -1) { console.error(`No CHANGELOG.md section for ${version}`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end === -1) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();

process.stdout.write(`${body}

### Downloads

| File | |
| --- | --- |
| \`Vytty-${version}-portable.exe\` | Windows, one portable file (keeps its data in \`VyttyData\` next to it) |
| \`Vytty-${version}-win-x64.zip\` | Windows, the same app as a plain folder - unzip and run \`Vytty.exe\` |
| \`Vytty-${version}.AppImage\` | Linux |
| \`SHA256SUMS.txt\` / \`.sig\` | checksums, signed for the in-app updater |

### Verifying a download

\`\`\`
# Windows PowerShell
Get-FileHash .\\Vytty-${version}-portable.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
# Linux
sha256sum -c --ignore-missing SHA256SUMS.txt
# Built by this repository's GitHub Actions workflow (needs the GitHub CLI):
gh attestation verify Vytty-${version}-portable.exe --repo mtgmz14/vytty
\`\`\`
`);
