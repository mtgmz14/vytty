// Writes SHA256SUMS.txt for the release files in a folder and, when the
// update signing key is available (env VYTTY_UPDATE_SIGNING_KEY, a PEM Ed25519
// private key), SHA256SUMS.txt.sig - the signature Vytty checks before it
// installs an update.
// Usage: node scripts/checksums.js <dir> [--require-signature]
const fs = require('fs');
const path = require('path');
const V = require('../src/main/update-verify');
const KEYS = require('../src/main/update-keys');

const RELEASE_FILE = /^Vytty-.*\.(exe|zip|AppImage)$/i;

async function main() {
  const dir = path.resolve(process.argv[2] || 'dist');
  const files = fs.readdirSync(dir).filter((f) => RELEASE_FILE.test(f)).sort();
  if (!files.length) throw new Error(`No release files in ${dir}`);
  const entries = [];
  for (const f of files) entries.push([f, await V.sha256File(path.join(dir, f))]);
  const text = V.formatSums(entries);
  fs.writeFileSync(path.join(dir, V.SUMS_NAME), text);
  console.log(text.trim());

  const key = process.env.VYTTY_UPDATE_SIGNING_KEY;
  if (!key) {
    if (process.argv.includes('--require-signature')) throw new Error('VYTTY_UPDATE_SIGNING_KEY is not set');
    console.warn('VYTTY_UPDATE_SIGNING_KEY not set: no signature written (Vytty will not auto-install this release)');
    return;
  }
  const sig = V.sign(text, key);
  // Never publish a signature the app would reject (wrong key in the secret).
  if (!V.verifySignature(text, sig, KEYS)) throw new Error('The signing key does not match any public key in src/main/update-keys.js');
  fs.writeFileSync(path.join(dir, V.SIG_NAME), `${sig}\n`);
  console.log(`signed ${V.SUMS_NAME} -> ${V.SIG_NAME}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
