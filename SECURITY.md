# Security

## Reporting a vulnerability

Please report security problems privately through
[GitHub security advisories](https://github.com/mtgmz14/vytty/security/advisories/new) rather than in a public issue.

## Verifying a download

Every release is built by this repository's GitHub Actions workflow from the tagged source.

- `SHA256SUMS.txt` lists the SHA-256 of every file (`Get-FileHash` on Windows, `sha256sum -c` on Linux).
- `SHA256SUMS.txt.sig` is an Ed25519 signature of that list. The signing key is kept offline: the maintainer
  signs a release only after checking every file against the list and its build provenance
  (`scripts/sign-release.js`). Vytty checks the signature - with the public key in `src/main/update-keys.js` -
  before it installs an update, and refuses files that do not match.
- Build provenance: `gh attestation verify <file> --repo mtgmz14/vytty` proves the file was produced by this
  repository's workflow (Sigstore / SLSA provenance).

## Code signing policy

Windows binaries are currently not Authenticode-signed; the release pipeline is prepared for signing (see
[docs/PODPISYWANIE.md](docs/PODPISYWANIE.md)). When signing through the SignPath Foundation is enabled:
*Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).*

- Only binaries built by the GitHub Actions workflow of this repository from its own source are signed.
- Every signing request is approved manually by the maintainer.
- Committers and approvers: [@mtgmz14](https://github.com/mtgmz14) (maintainer). Changes from other contributors are
  reviewed by the maintainer before they are merged.

## Privacy

Vytty sends no telemetry. It connects only to:
- the hosts you open sessions to;
- `api.github.com` / `github.com` to check for and download updates - this can be turned off in *Settings → About*;
- your NetBox server, if you set up the NetBox integration.

Sessions, the encrypted vault, settings and logs stay in the `VyttyData` folder on your machine.

## What runs on your machine

Vytty starts other programs only when you ask for it: local shells (PowerShell, cmd, WSL, bash...), ping /
traceroute tabs and the external tools you configure. Updates are applied without helper processes.
