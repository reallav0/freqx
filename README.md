# freqx

freqx is an Electron soundboard for Discord voice chat. It mixes your real microphone with imported sound effects and sends the final mix to VB-CABLE.

Website: <https://freqx.app>

## Features

- Nothing OS inspired interface with dot lettering, monochrome pads, and red accents
- Import local audio files
- Organize sounds into boards with search and sorting
- Mark favorite and pinned sounds for faster access
- Edit sound name, board, color, volume, trim, fade, and playback mode
- Switch app and pad themes, or use compact mode for dense soundboard sessions
- Trigger sounds from the app or with keybinds
- Use single-key or modifier-combo keybinds where supported
- Stop all currently playing sounds
- Choose playback behavior per sound: overlap, restart, play once, or toggle loop
- Mix microphone, soundboard, and main output volume
- Reduce microphone background noise with local DeepFilterNet3 voice isolation
- Route the Discord mix to VB-CABLE
- Persist selected microphone, virtual output, and local hearing output
- Use the routing setup wizard to refresh, pick, and test devices
- Choose where you personally hear meme sounds
- Run in the system tray
- Recover from fatal errors with a hidden restart
- Optional launch on Windows startup
- Optional bundled VB-CABLE installer

## Audio Routing

Voice isolation is enabled by default. Its switch is directly below **Microphone
input** in the mixer. DeepFilterNet3 runs locally on the microphone before it joins the
mix; soundboard clips, test tones, and output processing bypass isolation. No
microphone audio is uploaded. Choose **Off**, **Standard** or **Strong** without
restarting or recapturing the microphone. Chromium echo cancellation stays on;
Chromium noise suppression and automatic gain control stay off. If the model
cannot start or fails, the app keeps the echo-cancelled microphone working and
shows an unavailable status. The mode and enabled preference are saved.

The isolation engine has its own 48 kHz audio context. The shared mixer and output
contexts keep their original sample rates and routing.
See [the voice isolation integration notes](audio/VOICE-ISOLATION.md) for the
pipeline, reusable service, recovery behavior, bundled assets and verification.

Use this setup:

```text
Real microphone -> freqx -> CABLE Input -> Discord input as CABLE Output
```

Discord settings:

- Input Device: `CABLE Output`
- Output Device: headphones or speakers

Do not set Discord output to VB-CABLE.

## Development

Desktop runtime defaults and internal tuning live in
[`runtime/desktop-config.json`](runtime/desktop-config.json), including voice-isolation
strength, audio processing, networking, updates, and recovery. See
[developer configuration](docs/implementation/desktop-configuration.md) for editing
and validation. The app exposes no editor for this file.

After a fatal renderer/main error or unexpected main-process termination, a
separate hidden monitor restarts freqx in the tray. Library files and saved
settings remain in the normal profile; interrupted sounds are not replayed.
Automatic recovery is limited to three restarts in five minutes. If that limit
is reached, launch the app manually after checking `crash-logs/freqx-crash.log`
inside the app's data folder. Quit and Windows shutdown/logoff stop the monitor.
Recoverable Electron service exits are logged without restarting the app.

Recovery runs after the renderer-crash callback returns, avoiding Electron's
[documented synchronous-navigation crash](https://releases.electronjs.org/pr/51917).
The monitor also logs abrupt main-process loss when JavaScript cannot write a
stack trace. It cannot recover if Windows or another program kills both the
app and its monitor together.

Install dependencies:

```powershell
npm.cmd install
```

Run the app:

```powershell
npm.cmd run dev
```

The pinned DeepFilterNet3 WASM and model are checked automatically during install,
start and packaging. They are committed local assets; no model download, Python,
PyTorch or runtime compiler is required. Run `npm.cmd run prepare:audio` after
installing with scripts disabled.
Run `npm.cmd run test:mic-isolation` to verify mic processing and soundboard/output
separation using synthetic audio without opening your microphone.
Run `npm.cmd run test:voice-security` to verify the service in a sandboxed,
isolated Electron renderer with a Chromium fake microphone and network blocked.
Run `npm.cmd run test:recovery` to check crash handling and hidden restart using
isolated test profiles. These checks deliberately terminate test processes.

Electron Builder rebuilds the app's native audio dependencies during installation.
Global keybinds use Electron's built-in shortcuts by default. Developers can enable
the optional `uiohook-napi` keyboard hook with `app.nativeKeyHookEnabled` in the
configuration; source launches also accept `FREQX_ENABLE_NATIVE_KEY_HOOK=1`.

## Protocol Imports

Installed Windows builds register the `freqx://` protocol. The website can open
links like:

```text
freqx://import-sound?url=https%3A%2F%2Fexample.com%2Fsound.mp3&filename=sound.mp3&title=Sound
```

The desktop app imports the linked audio into the local sound library after it
starts, or routes the request to the already-running instance. Audio URLs must
use HTTPS, resolve to a public network address, return a supported audio type,
and be 100 MB or smaller.

## Build Installer

Build the Windows installer:

```powershell
npm.cmd run dist
```

Output files are created in:

```text
dist/
```

Use this file for distribution:

```text
dist/FreqX-Setup-<version>.exe
```

## GitHub Updates

Installed Windows builds use electron-updater with the trusted GitHub repository
in packaging configuration. Updates download in the background, verify their
checksum and require an explicit restart/install confirmation. Development and
portable builds update manually. Network failure does not block app startup.
The [release documentation](docs/implementation/releases.md) explains automated
patch bumps, GitHub permissions, artifacts and remaining signing/live-test limits.

## Bundling VB-CABLE

Place the full official VB-CABLE zip in:

```text
drivers/
```

The privileged installer verifies the package against a reviewed hash/signature
policy and fails closed on missing or uncertain verification. The initial empty
policy deliberately blocks automatic driver installation until official package
pins are reviewed; see [driver verification](security/driver-verification.md).
You can also extract the zip into `drivers/` before building. Do not copy only
the setup executable; VB-CABLE needs the companion
driver files from the same package, such as the `.inf`, `.sys`, and catalog
files.

Supported package/setup filenames:

```text
*.zip
VBCABLE_Setup_x64.exe
VBCABLE_Setup.exe
```

Only redistribute VB-CABLE if the VB-Audio license or explicit permission allows it.

## Desktop and backend development

This repository contains only the Electron desktop application, its audio engine,
Discover, account UI, API client, secure OS-backed credential storage and Windows
release/update workflow. Local boards and anonymous playback remain available.

The Express/PostgreSQL/R2 backend, server authentication, website and Heroku
deployment are a separate project: C:\Users\Nguyen\Desktop\freqxback, intended
GitHub repository reallav0/freqx-api. Backend credentials belong there, never here.
See [desktop setup instructions](instruction.md) and [current architecture](docs/implementation/platform.md).

Start the API from freqxback with npm run dev after its database/migrations are ready.
Then from this desktop checkout:

```powershell
$env:FREQX_API_BASE_URL = 'http://127.0.0.1:3000'
npm run dev
```

Packaged builds use the trusted https://api.freqx.app configuration. Desktop
login screens and IPC clients stay here; authentication/authorization run on the
separate server. Each project has independent installs, tests, CI and deployment.
Desktop releases stay at reallav0/freqx; backend pushes do not bump the desktop.

## Project Files

- `main.js` - Electron main process, tray, startup, installer-facing logic
- `preload.js` - safe IPC bridge
- `renderer.js` - soundboard, mixer, keybinds, device routing
- `index.html` - app UI
- `styles.css` - app styling
- `installer/vbcable.nsh` - NSIS hook for bundled VB-CABLE installer
- `installer/install-vbcable-driver.ps1` - silent VB-CABLE setup helper
- `drivers/` - optional local unzipped driver package files
