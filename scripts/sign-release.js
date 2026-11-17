'use strict';
// Signs a draft release with the offline update key and publishes it.
//
// Without the VYTTY_UPDATE_SIGNING_KEY secret the release workflow stops at a
// draft release holding the binaries and SHA256SUMS.txt. On the computer that
// keeps the key run
//
//   node scripts/sign-release.js v0.10.0
//
// It downloads every file of the release, checks it against SHA256SUMS.txt,
// and checks that GitHub holds a build provenance attestation for it from this
// tag's run of the release workflow, built from the commit the tag points to.
// Then it signs SHA256SUMS.txt (the private key never leaves this computer),
// checks the signature exactly the way the app does, uploads
// SHA256SUMS.txt.sig and publishes the release.
//
// Options:
//   --key <file.pem>    default: env VYTTY_UPDATE_SIGNING_KEY_FILE, then
//                       ~/.config/vytty-release/update-signing-key.pem
//   --repo <owner/name> default: mtgmz14/vytty
//   --no-publish        sign, but leave the release a draft
//   --skip-provenance   do not look up the build attestations
// Needs the GitHub CLI (gh), logged in with write access to the repository.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const V = require('../src/main/update-verify');
const KEYS = require('../src/main/update-keys');

const DEFAULT_REPO = 'mtgmz14/vytty';
const WORKFLOW = '.github/workflows/release.yml';
const DEFAULT_KEY = path.join(os.homedir(), '.config', 'vytty-release', 'update-signing-key.pem');
const USAGE = 'Usage: node scripts/sign-release.js v<version> [--key file.pem] [--repo owner/name] [--no-publish] [--skip-provenance]';

function parseArgs(argv, env = process.env) {
  const o = { tag: '', key: env.VYTTY_UPDATE_SIGNING_KEY_FILE || DEFAULT_KEY, repo: DEFAULT_REPO, publish: true, provenance: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' || a === '--repo') {
      if (!argv[i + 1]) throw new Error(`${a} needs a value\n${USAGE}`);
      o[a.slice(2)] = argv[++i];
    } else if (a === '--no-publish') o.publish = false;
    else if (a === '--skip-provenance') o.provenance = false;
    else if (!a.startsWith('-') && !o.tag) o.tag = /^\d/.test(a) ? `v${a}` : a;
    else throw new Error(`Unknown argument ${a}\n${USAGE}`);
  }
  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(o.tag)) throw new Error(USAGE);
  return o;
}

const publicKeyOf = (pem) => crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64');

// Files every release has; the app picks its download by these names.
const requiredAssets = (version) => ['portable', 'folder', 'appimage'].map((m) => V.assetNameFor(m, version));

// Checks downloaded release files against SHA256SUMS.txt and returns the
// [name, sha256] entries. Throws listing every problem it found.
async function checkFiles({ dir, sumsText, assetNames, version }) {
  let sums;
  try {
    sums = V.parseSums(sumsText);
  } catch (err) {
    throw new Error(`${V.SUMS_NAME}: ${err.message}`);
  }
  const problems = [];
  const files = assetNames.filter((n) => n !== V.SUMS_NAME && n !== V.SIG_NAME);
  for (const n of requiredAssets(version)) if (!files.includes(n)) problems.push(`${n} is missing from the release`);
  for (const n of files) {
    if (!sums.has(n)) problems.push(`${n} is not listed in ${V.SUMS_NAME}`);
    if (!n.includes(version)) problems.push(`${n} does not carry the version ${version}`);
  }
  for (const n of sums.keys()) if (!files.includes(n)) problems.push(`${V.SUMS_NAME} lists ${n}, which is not in the release`);
  const entries = [];
  for (const n of files.filter((f) => sums.has(f)).sort()) {
    const actual = await V.sha256File(path.join(dir, n));
    if (actual === sums.get(n)) entries.push([n, actual]);
    else problems.push(`${n}: SHA-256 ${actual} does not match ${V.SUMS_NAME} (${sums.get(n)})`);
  }
  if (problems.length) throw new Error(`The release does not check out:\n  - ${problems.join('\n  - ')}`);
  return entries;
}

// The in-toto statements in a response of GitHub's attestations API.
function statementsFrom(response) {
  const out = [];
  for (const a of (response && response.attestations) || []) {
    const env = a && a.bundle && a.bundle.dsseEnvelope;
    if (!env || !env.payload) continue;
    try {
      out.push(JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')));
    } catch { /* not a statement */ }
  }
  return out;
}

// Does a SLSA provenance statement say this file was built by the release
// workflow of `repo`, run for `tag`, from `commit`?
function matchProvenance(statement, { repo, tag, sha256, commit }) {
  if (!statement || !/^https:\/\/slsa\.dev\/provenance\//.test(statement.predicateType || '')) return false;
  if (!(statement.subject || []).some((s) => s && s.digest && s.digest.sha256 === sha256)) return false;
  const def = (statement.predicate && statement.predicate.buildDefinition) || {};
  const wf = (def.externalParameters && def.externalParameters.workflow) || {};
  if (wf.repository !== `https://github.com/${repo}` || wf.ref !== `refs/tags/${tag}` || wf.path !== WORKFLOW) return false;
  if (commit && !(def.resolvedDependencies || []).some((d) => d && d.digest && d.digest.gitCommit === commit)) return false;
  return true;
}

function gh(args, opts = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: opts.stdio || ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const detail = String(err.stderr || '').trim() || err.message;
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`);
  }
}

function provenance({ repo, tag, commit, sha256 }) {
  let res;
  try {
    res = JSON.parse(gh(['api', `repos/${repo}/attestations/sha256:${sha256}`]));
  } catch (err) {
    throw new Error(`No build provenance attestation for sha256:${sha256} (${err.message})`);
  }
  const count = (res.attestations || []).length;
  if (!count) throw new Error(`No build provenance attestation for sha256:${sha256}`);
  const statements = statementsFrom(res);
  if (!statements.length) return `${count} attestation(s), not inline - check with gh attestation verify`;
  const hit = statements.find((s) => matchProvenance(s, { repo, tag, sha256, commit }));
  if (!hit) throw new Error(`The attestation for sha256:${sha256} is not from ${WORKFLOW} at ${tag} (${commit.slice(0, 7)})`);
  return `built by ${(hit.runDetails && hit.runDetails.metadata && hit.runDetails.metadata.invocationId) || WORKFLOW}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vytty-release-check', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// What a user's copy of Vytty will see: the latest release and its signed
// checksum list, fetched anonymously.
async function checkPublic(repo, tag, sig, expectLatest) {
  const base = `https://github.com/${repo}/releases/download/${tag}/`;
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const [sums, pubSig] = await Promise.all([fetchText(base + V.SUMS_NAME), fetchText(base + V.SIG_NAME)]);
      if (pubSig.trim() !== sig || !V.verifySignature(sums, pubSig, KEYS)) throw new Error('published signature does not verify');
      if (expectLatest) {
        const latest = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/releases/latest`));
        if (latest.tag_name !== tag) throw new Error(`latest release is ${latest.tag_name}`);
      }
      return `${expectLatest ? `latest release is ${tag}, ` : ''}the public SHA256SUMS.txt signature verifies`;
    } catch (err) {
      last = err;
      await sleep(5000);
    }
  }
  throw new Error(`Published, but the public check failed: ${last.message}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const version = o.tag.slice(1);
  const pem = fs.readFileSync(o.key, 'utf8');
  if (!KEYS.includes(publicKeyOf(pem))) throw new Error(`${o.key} is not a key Vytty trusts (src/main/update-keys.js)`);

  const rel = JSON.parse(gh(['release', 'view', o.tag, '--repo', o.repo, '--json', 'tagName,isDraft,assets']));
  const names = rel.assets.map((a) => a.name);
  if (!names.includes(V.SUMS_NAME)) throw new Error(`${o.tag} has no ${V.SUMS_NAME}`);
  const mb = rel.assets.reduce((n, a) => n + (a.size || 0), 0) / 1048576;
  console.log(`${o.repo} ${o.tag}: ${rel.isDraft ? 'draft' : 'published'} release, ${names.length} files, ${mb.toFixed(0)} MB`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-sign-'));
  let sig;
  try {
    gh(['release', 'download', o.tag, '--repo', o.repo, '--dir', dir]);
    const sumsText = fs.readFileSync(path.join(dir, V.SUMS_NAME), 'utf8');
    const entries = await checkFiles({ dir, sumsText, assetNames: names, version });
    for (const [n, h] of entries) console.log(`  sha256 ok   ${h}  ${n}`);

    if (o.provenance) {
      const commit = gh(['api', `repos/${o.repo}/commits/${o.tag}`, '--jq', '.sha']).trim();
      for (const [n, h] of entries) console.log(`  provenance  ${n}: ${provenance({ repo: o.repo, tag: o.tag, commit, sha256: h })}`);
    }

    sig = V.sign(sumsText, pem);
    // The same check the app runs before it installs an update.
    for (const [n, h] of entries) {
      if (V.expectedHash({ sumsText, signature: sig, keys: KEYS, assetName: n, version }) !== h) throw new Error(`Self-check failed for ${n}`);
    }
    const sigFile = path.join(dir, V.SIG_NAME);
    const old = names.includes(V.SIG_NAME) ? fs.readFileSync(sigFile, 'utf8').trim() : null;
    if (old === sig) {
      console.log(`${V.SIG_NAME} is already there and valid`);
    } else {
      if (old) console.log(`${V.SIG_NAME} is there but does not match - replacing it`);
      fs.writeFileSync(sigFile, `${sig}\n`);
      gh(['release', 'upload', o.tag, sigFile, '--repo', o.repo, '--clobber']);
      console.log(`signed ${V.SUMS_NAME}, uploaded ${V.SIG_NAME}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (!o.publish) {
    console.log('left as a draft (--no-publish)');
    return;
  }
  if (rel.isDraft) gh(['release', 'edit', o.tag, '--repo', o.repo, '--draft=false', '--latest']);
  console.log(`published https://github.com/${o.repo}/releases/tag/${o.tag}`);
  console.log(await checkPublic(o.repo, o.tag, sig, rel.isDraft));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, publicKeyOf, requiredAssets, checkFiles, statementsFrom, matchProvenance };
