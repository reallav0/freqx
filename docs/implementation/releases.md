# Windows releases and updates

The existing electron-builder configuration is retained. `npm run dist` builds
NSIS and portable Windows executables without publishing from a workstation.
Production changes pushed or merged to `main` automatically trigger GitHub Actions
to build and upload the release; no manual executable uploads are needed. Feature
branch pushes and local edits do not publish releases.
The release workflow runs reusable CI before a main-only patch increment,
updates package.json/package-lock.json together, commits
`chore(release): vX.Y.Z [skip ci]`, tags the release and atomically pushes both.
The version remains 1.8.0 locally; automation was not run against the remote.

Each source SHA is recorded in the release commit/tag. Reruns find that tag and
do not bump again. Published releases are skipped; failed drafts can be completed.
Version and tag push are atomic, preventing a partial remote bump. Workflows are
serialized and never cancel an active release. If main advances while its checks
run, the old event stops rather than releasing unchecked newer code; the latest
main event releases the accumulated changes. Very rapid merges can therefore be
coalesced into one release, not one installer per displaced pending workflow.

Repository configuration: enable Actions. The version and build jobs explicitly
request `contents: write`; the repository default can remain read-only when its
Actions policy permits these job permissions. Require CI application/security
checks; allow the release automation identity to update
main and create v* tags. GitHub rulesets that prohibit the GITHUB_TOKEN actor
need a narrowly scoped GitHub App added to the bypass list, with its installation
token substituted for checkout's write token in the version job. Avoid broad PATs.
If direct bot pushes are not acceptable, use a reviewed release PR carrying the
version bump and publish only after it merges; the supplied direct-push workflow
fails closed rather than bypassing branch protection. Configure those permissions
before enabling automatic releases.

Release artifacts: FreqX-Setup-X.Y.Z.exe, portable executable, NSIS blockmap,
latest.yml, SHA256SUMS.txt and CycloneDX SBOM. The SBOM covers production npm
dependencies plus Electron and hash-pinned native audio model/WASM assets; it is
not a claim to enumerate every library linked into Electron's executable.
GitHub provenance attestations are produced for public repositories. Private
repository attestation support depends on GitHub plan; the job skips that step
for private repositories instead of claiming unsupported attestations exist.
The draft is published only after all artifacts are uploaded.

electron-updater uses the fixed GitHub repository in trusted package build
configuration. Startup checks do not block audio startup. Installed Windows builds
download updates, show progress, validate SHA-512 and offer Restart and install.
No automatic installation on normal quit is enabled. Renderer IPC accepts no feed
URL, installer path or update metadata. Development/portable builds update manually.
Invalid/missing checksums block installation, and errors leave FreqX usable.

**No Windows code-signing certificate exists in this workspace.** The actual
generated installer reports Authenticode `NotSigned`; electron-builder's generic
"signing" log does not establish signing. Checksum verification over a trusted
GitHub/TLS feed detects corruption but is not independent publisher authentication
if the GitHub repository itself is compromised. GitHub provenance is independently
inspectable with `gh attestation verify`, but the desktop does not currently verify
that attestation. Protect repository/release credentials with MFA, branch rules
and least privilege. A trusted Windows signing certificate and publisher checks
are recommended before broad distribution/automatic update rollout. Do not set
an invented publisher name or disable an existing signature failure to install.

Local validation built the Windows installer, portable executable and updater
metadata, generated SBOM/checksums, and passed updater corruption/failure tests.
No GitHub release has been published by this task. End-to-end update installation
requires two installed, published versions in a staging repository plus explicit
user restart; that live transition remains untested here.
