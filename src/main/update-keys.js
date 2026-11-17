'use strict';
// Ed25519 public keys (base64 DER / SPKI) trusted to sign SHA256SUMS.txt of a
// release. The private key lives only in the release workflow's secret
// VYTTY_UPDATE_SIGNING_KEY (and the maintainer's offline backup).
//
// Rotating the key: add the new public key here and ship a release signed with
// the OLD key; once users have that version, releases can be signed with the
// new key and the old entry removed.
module.exports = [
  'MCowBQYDK2VwAyEAWRbGPnBb8AbauAtu+yRUdVD0eja9p3tS82bYgqDBHq4=',
];
