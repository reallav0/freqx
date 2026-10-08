# Developer desktop configuration

Edit `runtime/desktop-config.json` to change the desktop's runtime defaults and
internal tuning. It is the configuration source for the main process, renderer,
audio processing, downloads, account client, updater, and crash recovery.

| Group | Settings |
| --- | --- |
| `app` | Window dimensions, startup/tray defaults, runtime options, import and process limits |
| `ui` | Theme and pad palettes, sound/board defaults, meters, Discover pagination |
| `audio` | Voice isolation, compressors, limiter, equalizer, gains, buffers, test tones, echo/reference tuning, capture timeouts |
| `network` | API origin, audio host allowlist, download size/time/redirect limits |
| `auth` | Account request limits, refresh timing, OAuth attempt lifetime, upload and favorites batching |
| `catalog` | Library source, catalog/audio size limits, pagination |
| `updater` | Trusted GitHub feed, startup delay, response and installer limits |
| `recovery` | Restart budget/backoff, watchdog timing, crash detail limits |

Voice modes are `light` (restored RNNoise) and `high-quality` (DFN3 low latency
SIMD). `audio.defaults.voiceIsolationStrength` is the default wet/dry blend
(0.85); users change it in settings. `audio.voiceModes["high-quality"]` controls
model attenuation (35 dB) and post-filter beta (0). Mic HPF defaults to 80 Hz
before denoising. Gate/compression run in the worklet; the compressor settings
use a -18 dB threshold, 12 dB knee and 2:1 ratio with no lookahead. Shared mixing,
limiting and gains preserve their defaults. JSON edits are explicit developer
tuning changes.

Restart a development app after editing. Run the checks and rebuild the app to
distribute a configuration change. JSON is not reloaded in a running audio graph.
The schema checks required keys, types, ranges, and related values before freezing
the configuration. Unsupported keys or invalid values fail validation instead of
silently applying partial tuning. Worklets validate the tuning supplied to them.

The app provides no settings screen, file picker, or IPC method for editing this
configuration. It does not load configuration overrides from user data, local
storage, or remote URLs. Existing user preferences, boards, and sound metadata
remain separate: the JSON defines their defaults, not users' saved choices.

Source launches retain the local API and optional native-keyboard-hook environment
flags for development. The offline library fixture flag also works only in
development. Packaged builds ignore these environment overrides; use the checked-in
JSON and rebuild when changing release configuration.

Developer-controlled configuration is not secret storage. Bundled desktop files
can be inspected or modified by the owner of the machine. Keep OAuth secrets,
server credentials, and private keys on the backend.

Protocol/API identities, security checks, native/WASM frame formats, and model
integrity manifests stay in their owning code or manifests. They are contracts or
invariants rather than runtime tuning. Dependency versions and Electron Builder
packaging metadata remain in `package.json` and `package-lock.json`.
