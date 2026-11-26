'use strict';
// Release tooling: the update checksum / signature helpers in JavaScript, for
// scripts/checksums.js and scripts/sign-release.js. The app's own copy is in
// Rust (crates/vytty-core/src/update_verify.rs); both read update-keys.json.
//
// Every release carries SHA256SUMS.txt (plain `sha256sum` format, so it can
// also be checked by hand) and SHA256SUMS.txt.sig: an Ed25519 signature of the
// exact bytes of SHA256SUMS.txt, made with the release key - kept offline by
// the maintainer (scripts/sign-release.js) or as the release workflow's secret.
// The public half is built into Vytty (update-keys.json). An update
// is installed only when the signature is valid AND the downloaded file has the
// hash listed for its name - a file swapped on the download server, a
// corrupted download or a tampering proxy is refused.
const crypto = require('crypto');
const fs = require('fs');

const SUMS_NAME = 'SHA256SUMS.txt';
const SIG_NAME = 'SHA256SUMS.txt.sig';

// "1.2.3", "v1.2.3", "1.2.3-beta.1" -> { nums: [1,2,3], pre: 'beta.1' }
function parseVersion(v) {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return { nums: [0], pre: '' };
  return { nums: m[1].split('.').map((x) => parseInt(x, 10) || 0), pre: m[2] || '' };
}

// Is version a newer than version b? A release beats its own pre-releases.
function newer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x > y;
  }
  if (pa.pre === pb.pre) return false;
  if (!pa.pre) return true;
  if (!pb.pre) return false;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) > 0;
}

// `sha256sum` output: "<64 hex>  <name>" (or " *<name>" in binary mode).
// Lines that are empty or start with # are ignored.
function parseSums(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) throw new Error(`Malformed checksum line: ${line.slice(0, 80)}`);
    out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

function formatSums(entries) {
  return `${entries.map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`;
}

// Public keys are base64 DER (SPKI). Several may be listed for key rotation.
function publicKeyObjects(keys) {
  return (keys || []).map((k) => crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }));
}

function verifySignature(data, signatureB64, keys) {
  const sig = Buffer.from(String(signatureB64 || '').trim(), 'base64');
  if (sig.length !== 64) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  for (const key of publicKeyObjects(keys)) {
    try {
      if (crypto.verify(null, buf, key, sig)) return true;
    } catch { /* try the next key */ }
  }
  return false;
}

function sign(data, privateKeyPem) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return crypto.sign(null, buf, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// Check a signed checksum list and return the expected hash of `assetName`.
// Throws with a message meant for the user when anything does not add up.
function expectedHash({ sumsText, signature, keys, assetName, version }) {
  if (!keys || !keys.length) throw new Error('This build has no update signing key');
  if (!signature) throw new Error('The release has no signature (SHA256SUMS.txt.sig)');
  if (!verifySignature(sumsText, signature, keys)) throw new Error('The release signature is not valid');
  const sums = parseSums(sumsText);
  const hash = sums.get(assetName);
  if (!hash) throw new Error(`${assetName} is not listed in the signed checksums`);
  // The version is part of every asset name, so an old (validly signed)
  // checksum list cannot be replayed to push an older build.
  if (version && !assetName.includes(String(version).replace(/^v/i, ''))) throw new Error(`${assetName} does not belong to version ${version}`);
  return hash;
}

// Release asset expected for an install mode.
const ASSET_PATTERNS = {
  portable: /^Vytty-[\d.]+(?:-[\w.]+)?-portable\.exe$/i,
  folder: /^Vytty-[\d.]+(?:-[\w.]+)?-win-x64\.zip$/i,
  appimage: /^Vytty-[\d.]+(?:-[\w.]+)?\.AppImage$/i,
};

function assetNameFor(mode, version) {
  const v = String(version).replace(/^v/i, '');
  if (mode === 'portable') return `Vytty-${v}-portable.exe`;
  if (mode === 'folder') return `Vytty-${v}-win-x64.zip`;
  if (mode === 'appimage') return `Vytty-${v}.AppImage`;
  return null;
}

function pickAsset(assets, mode) {
  const re = ASSET_PATTERNS[mode];
  return re ? (assets || []).find((a) => re.test(a.name)) || null : null;
}

// Names a previous version left behind, safe to delete after an update.
const OLD_BUILD = /^Vytty-\d+\.\d+\.\d+(?:-[\w.]+)?(?:-portable\.exe|\.AppImage)$/i;

module.exports = {
  SUMS_NAME, SIG_NAME, OLD_BUILD,
  parseVersion, newer, parseSums, formatSums, verifySignature, sign, sha256File, expectedHash, assetNameFor, pickAsset,
};
