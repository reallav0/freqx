# Windows releases and updates

The existing electron-builder configuration is retained. `npm run dist` builds
the NSIS Windows setup executable without publishing from a workstation.
Production changes pushed or merged to `main` automatically trigger GitHub Actions
to build and upload the release; no manual executable uploads are needed. Feature
branch pushes and local edits do not publish releases.
The release workflow runs reusable CI before a main-only patch increment,
updates package.json/package-lock.json together, commits
`chore(release): vX.Y.Z [skip ci]`, tags the release and atomically pushes both.

For an explicitly chosen major or minor release, update both package versions,
then annotate its version tag with `Release-Source: <source SHA>` pointing to
that exact main commit and atomically push main and the tag. The workflow reuses
the matching tag after CI passes, so it builds the chosen version without an
additional patch increment. Never reuse a published version or move its tag.

Each source SHA is recorded in the release commit/tag. Reruns find that tag and
do not bump again. Published releases are skipped; failed drafts can be completed.
The release lookup uses GitHub GraphQL so a missing release returns a successful
null result instead of leaving PowerShell with a failing CLI exit code. Lookup
errors stop the job; publication rechecks the release and refuses to replace
artifacts if it has already been published.
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

Release assets: FreqX-Setup-X.Y.Z.exe, its NSIS blockmap, and latest.yml for
in-app updates. Portable executables are no longer built or uploaded.
SHA256SUMS.txt and the CycloneDX SBOM are generated inside CI and are not
uploaded as release assets. The SBOM covers production npm
dependencies plus Electron and hash-pinned native audio model/WASM assets; it is
not a claim to enumerate every library linked into Electron's executable.
GitHub provenance attestations are produced for public repositories. Private
repository attestation support depends on GitHub plan; the job skips that step
for private repositories instead of claiming unsupported attestations exist.
The draft is published only after all artifacts are uploaded.

electron-updater uses the fixed GitHub repository in trusted package build
configuration. An automatic check runs five seconds after startup and every six
hours while the app stays open; users can also check from Settings. Scheduled
checks leave active downloads and verified, ready-to-install updates alone and
stop when Freqx quits. Startup checks do not block audio startup. Installed Windows
builds download updates, show progress, validate SHA-512 and offer Restart and install.
No automatic installation on normal quit is enabled. Renderer IPC accepts no feed
URL, installer path or update metadata. Development builds update manually.
Invalid/missing checksums block installation, and errors leave FreqX usable.

When a newer version is found, an in-app popup shows the version and automatic
download progress, then enables **Restart and install** after verification.
**Later** or Escape dismisses reminders for that version during the current
renderer session; the update remains accessible in Settings. A different newer
version can notify again. Current, unsupported, and offline-without-a-detected-update
states do not open a popup. Existing modals finish before an automatic notice opens.

The popup ships as application code. Older releases that lack it, including
v2.0.9, need one update through **Settings → Check for updates → Restart and install**
before future releases can show this popup. Publishing a new release alone cannot
change the UI already running inside an older installed executable.

The popup is covered by `npm run test:update-notice-desktop` and its packaged
counterpart. The offline production smoke also exercises the real preload/main
path, verifies an inert installer fixture and intercepts the final installer call:

```powershell
node tests/packaged-startup.cjs --exe output/update-notice-build/win-unpacked/freqx.exe --update-notice
```

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

Live validation on 2026-10-23 launched the existing v2.0.4 executable with an
isolated profile/cache and synthetic microphone. Its automatic startup check
found the published v2.0.9 release, downloaded the 224,143,693-byte installer,
verified its SHA-512 checksum, and displayed the restart button. Canceling the
production confirmation blocked installation; confirming reached an intercepted
`quitAndInstall(false, true)`. No installer was executed and the installed app
was unchanged. Actual installer replacement and relaunch remain untested.

To repeat against an older packaged Windows version:

```powershell
node tests/packaged-startup.cjs --exe 'C:\path\to\older\freqx.exe' --updates
```

This optional live check uses GitHub and downloads the installer into its own
`output/packaged-startup/run-*/update-cache` directory. It waits for the automatic
startup check, exercises the real production preload/main update IPC and prompts,
and intercepts installer execution. It fails if the supplied version is already
current or the network/update feed is unavailable. It is not part of offline CI.
