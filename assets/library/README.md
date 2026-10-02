# Freqx originals

These six short effects are original synthesized sounds made for Freqx. They
contain no recorded audio, third-party samples, or microphone input. They are
provided under the project's ISC license for use, copying, and modification.

Regenerate the deterministic mono 48 kHz, 16-bit PCM WAV files and catalog from
the repository root with `node scripts/generate-library-sounds.cjs`. Generation
is an explicit development action; the app only reads the packaged files.

The initial Discover page works offline with this clearly labeled starter
collection. `runtime/public-library.json` keeps remote URLs empty. This build
does not make R2 requests, contain storage credentials, upload audio, or expose
storage administration. Connecting a future public HTTPS catalog requires a
bounded, validated network adapter behind `runtime/public-library.cjs`; putting
URLs in the config alone does not enable remote access.

The renderer receives display metadata and bounded preview bytes through its
existing secured preload bridge. Only the main process resolves a selected ID
to a packaged file for the normal local import flow. A sound's filename is
derived from a strict ID; the catalog cannot supply an arbitrary path. Preview
and import validate the file's size, SHA-256, directory containment, and WAV
header before handing it to the app.
