# Website audio helper provenance

These independent command-line programs are used only to resolve one public
YouTube video or SoundCloud track into an audio URL. Freqx downloads and validates
the bytes itself; the helpers never write media, open a browser, use cookies,
load plugins/user configuration, invoke a shell or update themselves.

| Component | Version | License |
| --- | --- | --- |
| yt-dlp official Windows x64 executable | 2026.08.19 | GPL-3.0-or-later combined executable; yt-dlp source is Unlicense |
| Deno official Windows x64 executable | 2.9.7 | MIT; bundled Rust/V8/TypeScript components retain their licenses |

The source links and SHA-256 pins are in `manifest.json`. Official GitHub release
asset digests and downloaded bytes were checked before inclusion. `yt-dlp.zip`
is a ZIP of the unchanged official `yt-dlp.exe`; `deno.zip` is the unchanged
official release archive. Only these pinned archives are extracted offline to
the app-owned tools cache; archive and executable hashes are verified before
use. No executable or dependency is downloaded from a pasted URL.

All helper license terms remain applicable, separately from Freqx's license.
`GPL-3.0.txt`, `YTDLP-LICENSE.txt` and the complete official
`YTDLP-THIRD-PARTY-LICENSES.txt` are shipped with the unmodified executable.
`yt-dlp-source.tar.gz` contains the matching official source release and build
scripts. Sources for the bundled third-party components are identified in the
upstream third-party notice, available from their original projects and upstream
maintainers. Distributors must preserve the source availability obligations of
the helper and its bundled components.

`DENO-LICENSE.txt`, the V8/Rust/TypeScript/Node/Undici notices and
`DENO-THIRD-PARTY-LICENSES.txt` accompany Deno. The conservative Rust notice list
covers all 1,046 registry packages in the pinned Deno Cargo.lock, including
packages for other targets/build tools. `DENO-rust-dependencies.json` lists every
version, checksum, declared license and source URL. Some upstream crates do not
package a license text; their exact source and declared license remain listed.
Regenerate the combined notices using `py -3 scripts/collect-link-tool-notices.py`.

The bundled yt-dlp EJS solver evaluates YouTube's player challenge in Deno with
no file, environment, network or subprocess permissions. Its command includes
`--no-prompt`, `--no-remote`, `--no-config`, `--no-npm` and `--cached-only`; remote
EJS components and alternate JS runtimes are disabled. `npm.cmd run
test:link-tools` checks the actual binary denies those permissions.

The extractor's own HTTPS requests use a short-lived authenticated local proxy
restricted to that site's official domains and public connection-time DNS.
Its output has a deadline and size bound; audio URLs undergo the normal HTTPS,
DNS, byte-limit, signature and disposable Chromium decode checks afterward.

Official references:
- [yt-dlp 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)
- [yt-dlp licensing](https://github.com/yt-dlp/yt-dlp#licensing)
- [Pinned Deno solver permission flags](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/youtube/jsc/_builtin/deno.py)
- [Deno 2.9.7](https://github.com/denoland/deno/releases/tag/v2.9.7)
- [Deno permission model](https://docs.deno.com/runtime/fundamentals/security/)
