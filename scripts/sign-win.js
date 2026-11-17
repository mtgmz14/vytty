// Authenticode signing for files built outside electron-builder (the portable
// launcher, a re-packed Vytty.exe). Uses whatever the environment provides and
// does nothing when no signing is configured, so unsigned builds keep working:
//
//   WIN_CSC_LINK (+ WIN_CSC_KEY_PASSWORD)   a .pfx file (path or base64) - e.g. a
//                                           company-internal certificate
//   AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE
//                                           Azure Artifact Signing (with AZURE_TENANT_ID,
//                                           AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)
//
// SignPath.io (free for open source) runs as GitHub Actions steps instead,
// see .github/workflows/release.yml and docs/PODPISYWANIE.md.
// Usage: node scripts/sign-win.js <file> [file...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TIMESTAMP = process.env.SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';

function findSigntool() {
  if (process.env.SIGNTOOL && fs.existsSync(process.env.SIGNTOOL)) return process.env.SIGNTOOL;
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  let versions = [];
  try { versions = fs.readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse(); } catch { /* ignore */ }
  for (const v of versions) {
    const p = path.join(kits, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'signtool.exe';
}

function method() {
  const e = process.env;
  if (e.AZURE_SIGNING_ENDPOINT && e.AZURE_SIGNING_ACCOUNT && e.AZURE_SIGNING_PROFILE) return 'azure';
  if (e.WIN_CSC_LINK || e.CSC_LINK) return 'pfx';
  return null;
}

function pfxPath() {
  const link = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
  if (fs.existsSync(link)) return { file: link, temp: false };
  const file = path.join(os.tmpdir(), `vytty-sign-${process.pid}.pfx`);
  fs.writeFileSync(file, Buffer.from(link.replace(/^data:.*?base64,/, ''), 'base64'), { mode: 0o600 });
  return { file, temp: true };
}

function signFile(file) {
  const m = method();
  if (!m) { console.log(`[sign] no signing configured - ${path.basename(file)} stays unsigned`); return false; }
  if (process.platform !== 'win32') throw new Error('Authenticode signing needs Windows');
  if (m === 'pfx') {
    const pfx = pfxPath();
    try {
      const args = ['sign', '/fd', 'sha256', '/tr', TIMESTAMP, '/td', 'sha256', '/f', pfx.file];
      const pw = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;
      if (pw) args.push('/p', pw);
      args.push('/d', 'Vytty', '/du', 'https://github.com/mtgmz14/vytty', file);
      execFileSync(findSigntool(), args, { stdio: ['ignore', 'inherit', 'inherit'] });
    } finally {
      if (pfx.temp) fs.rmSync(pfx.file, { force: true });
    }
  } else {
    const e = process.env;
    const ps = [
      'if (-not (Get-Module -ListAvailable -Name TrustedSigning)) { Install-Module -Name TrustedSigning -Force -Scope CurrentUser }',
      `Invoke-TrustedSigning -Endpoint '${e.AZURE_SIGNING_ENDPOINT}' -CodeSigningAccountName '${e.AZURE_SIGNING_ACCOUNT}' -CertificateProfileName '${e.AZURE_SIGNING_PROFILE}' -Files '${file.replace(/'/g, "''")}' -FileDigest SHA256 -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256`,
    ].join('; ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
  }
  console.log(`[sign] signed ${path.basename(file)} (${m})`);
  return true;
}

if (require.main === module) {
  for (const f of process.argv.slice(2)) signFile(path.resolve(f));
}

module.exports = { signFile, method };
