'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../../src/main/update-verify');
const S = require('../../scripts/sign-release');

const VERSION = '9.9.9';
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function fakeRelease(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vytty-sign-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = S.requiredAssets(VERSION);
  const entries = names.map((n) => {
    fs.writeFileSync(path.join(dir, n), `contents of ${n}`);
    return [n, sha(`contents of ${n}`)];
  });
  fs.writeFileSync(path.join(dir, V.SUMS_NAME), V.formatSums(entries));
  return { dir, names: [...names, V.SUMS_NAME], entries, sumsText: V.formatSums(entries) };
}

test('sign-release: arguments', () => {
  const env = {};
  assert.deepStrictEqual(S.parseArgs(['v1.2.3'], env).tag, 'v1.2.3');
  assert.strictEqual(S.parseArgs(['1.2.3'], env).tag, 'v1.2.3');
  const o = S.parseArgs(['v1.2.3-beta.1', '--key', 'k.pem', '--repo', 'a/b', '--no-publish', '--skip-provenance'], env);
  assert.deepStrictEqual(o, { tag: 'v1.2.3-beta.1', key: 'k.pem', repo: 'a/b', publish: false, provenance: false });
  assert.strictEqual(S.parseArgs(['v1.2.3'], { VYTTY_UPDATE_SIGNING_KEY_FILE: '/keys/x.pem' }).key, '/keys/x.pem');
  assert.throws(() => S.parseArgs([], env), /Usage/);
  assert.throws(() => S.parseArgs(['main'], env), /Usage/);
  assert.throws(() => S.parseArgs(['v1.2.3', '--key'], env), /needs a value/);
  assert.throws(() => S.parseArgs(['v1.2.3', '--force'], env), /Unknown argument/);
});

test('sign-release: the key check compares the public half', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.strictEqual(S.publicKeyOf(pem), publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
});

test('sign-release: a complete release checks out and signs the way the app verifies', async (t) => {
  const r = fakeRelease(t);
  const entries = await S.checkFiles({ dir: r.dir, sumsText: r.sumsText, assetNames: r.names, version: VERSION });
  assert.deepStrictEqual(entries, [...r.entries].sort((a, b) => a[0].localeCompare(b[0])));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const sig = V.sign(r.sumsText, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const keys = [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')];
  for (const [name, hash] of entries) {
    assert.strictEqual(V.expectedHash({ sumsText: r.sumsText, signature: sig, keys, assetName: name, version: VERSION }), hash);
  }
});

test('sign-release: refuses tampered, unlisted, missing and mislabelled files', async (t) => {
  const r = fakeRelease(t);
  const check = (over) => S.checkFiles({ dir: r.dir, sumsText: r.sumsText, assetNames: r.names, version: VERSION, ...over });

  fs.appendFileSync(path.join(r.dir, `Vytty-${VERSION}.AppImage`), 'x');
  await assert.rejects(check(), /Vytty-9\.9\.9\.AppImage: SHA-256 [0-9a-f]{64} does not match/);
  fs.writeFileSync(path.join(r.dir, `Vytty-${VERSION}.AppImage`), `contents of Vytty-${VERSION}.AppImage`);
  await check();

  fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'extra');
  await assert.rejects(check({ assetNames: [...r.names, 'notes.txt'] }), /notes\.txt is not listed in SHA256SUMS\.txt/);

  const withoutZip = r.names.filter((n) => !n.endsWith('.zip'));
  await assert.rejects(check({ assetNames: withoutZip }), (err) => /Vytty-9\.9\.9-win-x64\.zip is missing from the release/.test(err.message)
    && /SHA256SUMS\.txt lists Vytty-9\.9\.9-win-x64\.zip, which is not in the release/.test(err.message));

  await assert.rejects(check({ version: '9.9.10' }), /does not carry the version 9\.9\.10/);
  await assert.rejects(check({ sumsText: 'not a checksum list\n' }), /SHA256SUMS\.txt: Malformed checksum line/);
});

test('sign-release: provenance must name this repository, tag, workflow and commit', () => {
  const hash = 'a'.repeat(64);
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'Vytty-9.9.9.AppImage', digest: { sha256: hash } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        externalParameters: { workflow: { ref: 'refs/tags/v9.9.9', repository: 'https://github.com/o/r', path: '.github/workflows/release.yml' } },
        resolvedDependencies: [{ uri: 'git+https://github.com/o/r@refs/tags/v9.9.9', digest: { gitCommit: 'c0ffee' } }],
      },
      runDetails: { metadata: { invocationId: 'https://github.com/o/r/actions/runs/1/attempts/1' } },
    },
  };
  const want = { repo: 'o/r', tag: 'v9.9.9', sha256: hash, commit: 'c0ffee' };
  const response = { attestations: [{ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } }, { bundle_url: 'https://example.invalid' }] };
  const [parsed] = S.statementsFrom(response);
  assert.strictEqual(S.statementsFrom(response).length, 1);
  assert.ok(S.matchProvenance(parsed, want));

  const change = (fn) => { const s = JSON.parse(JSON.stringify(statement)); fn(s); return S.matchProvenance(s, want); };
  assert.strictEqual(change((s) => { s.subject[0].digest.sha256 = 'b'.repeat(64); }), false);
  assert.strictEqual(change((s) => { s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main'; }), false);
  assert.strictEqual(change((s) => { s.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/fork/r'; }), false);
  assert.strictEqual(change((s) => { s.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; }), false);
  assert.strictEqual(change((s) => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'bad'; }), false);
  assert.strictEqual(change((s) => { s.predicateType = 'https://example.com/other'; }), false);
  assert.deepStrictEqual(S.statementsFrom({}), []);
});
