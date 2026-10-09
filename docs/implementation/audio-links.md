# Play audio from a link

Click **Add link**, paste a direct HTTPS audio URL, public YouTube video URL or
public SoundCloud track URL, then click **Play**. Freqx checks the download,
saves a normalized 48 kHz PCM16 WAV on the selected board, and plays it through
the existing soundboard controls and mixer. Keybinds, trim, volume, repeat and
Stop all work normally. This audio bypasses microphone isolation.

Input is limited to 24 MiB and five minutes, one or two channels. Supported
direct formats are PCM/float WAV, MP3, FLAC, AAC, audio-only M4A and Ogg
Vorbis/Opus. Windows x64 website resolution supports one public track with an
available progressive HTTPS audio stream. Playlists, livestreams, HLS-only
media, arbitrary webpages, private/account-only media and DRM are unsupported.
YouTube and SoundCloud may block automated access or change their APIs; helper
updates require reviewing and replacing pinned assets. No cookies are read.

The URL itself is never navigated to or embedded. Webpages, JavaScript, SVG,
archives and executable signatures are rejected. HTTPS certificate validation
remains enabled; credentials, custom ports, control characters, private/local
addresses, unsafe redirects and nonpublic DNS results are blocked at the actual
connection. A single deadline covers redirects/body, and streamed byte limits
apply even without a Content-Length. The existing Discover host allowlist is
unchanged.

Content-Type and file signatures are both checked. Media decoding occurs in a
fresh sandboxed Chromium renderer with no Node, preload, app IPC, permissions,
remote network, navigation or popups. Only its local validator and one staged
file are readable. The main process verifies a fixed WAV header and bounds
before an exclusive library write; original bytes and source metadata are
discarded. Cancel, close and Stop all prevent late playback. Staging files are
cleaned after failure/cancellation and after a prior crash. Signed source URL
queries are not persisted or included in user-facing failure messages.

These controls reduce the attack surface; they are not an antivirus or a
guarantee against future media decoder/runtime vulnerabilities. Keep Electron
and the pinned helper runtimes maintained. Website extraction evaluates the
official YouTube challenge in a separate permission-restricted Deno process;
no webpage scripts run in Freqx's UI. See [helper versions, licenses and
provenance](../../runtime/vendor/link-tools/README.md).

Validation:

```powershell
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run test:audio-links-desktop
npm.cmd run test:link-tools
```

The desktop harness uses an isolated profile, controlled HTTPS transport and
silent audio sinks; it exercises the real production UI/preload/IPC, isolated
decoder, audio routing, cancellation, rejected files and board persistence.
Pass `--app-root PATH_TO_APP_ASAR` directly to
`node tests/audio-links-electron.cjs` to check a packaged build. Audio fixtures
and screenshots are written only under ignored `output/`.
