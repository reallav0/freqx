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
- Route the Discord mix to VB-CABLE
- Persist selected microphone, virtual output, and local hearing output
- Use the routing setup wizard to refresh, pick, and test devices
- Choose where you personally hear meme sounds
- Run in the system tray
- Optional launch on Windows startup
- Optional bundled VB-CABLE installer

## Audio Routing

Use this setup:

```text
Real microphone -> freqx -> CABLE Input -> Discord input as CABLE Output
```

Discord settings:

- Input Device: `CABLE Output`
- Output Device: headphones or speakers

Do not set Discord output to VB-CABLE.

## Development

Install dependencies:

```powershell
npm.cmd install
```

Run the app:

```powershell
npm.cmd run dev
```

Electron Builder rebuilds the app's native audio dependencies during installation.
Global keybinds use Electron's built-in shortcuts by default. Set
`FREQX_ENABLE_NATIVE_KEY_HOOK=1` to enable the optional `uiohook-napi` keyboard hook.

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
dist/freqx Setup <version>.exe
```

## GitHub Update Checks

The app checks `https://github.com/reallav0/freqx` for the latest public
GitHub release and compares the release tag with the local `package.json`
version. Use release tags like `v1.0.1`, and upload the installer asset to the
release so the in-app Download button can open it.

To point a local build at another repository without editing `package.json`,
set `FREQX_UPDATE_REPOSITORY` to `owner/repo` before launching the app.

## Bundling VB-CABLE

Place the full official VB-CABLE zip in:

```text
drivers/
```

The installer will extract the zip during install, temporarily trust the
package signer for the Windows driver prompt, and run the official setup in
hidden install mode. You can also extract the zip into `drivers/` before
building. Do not copy only the setup executable; VB-CABLE needs the companion
driver files from the same package, such as the `.inf`, `.sys`, and catalog
files.

Supported package/setup filenames:

```text
*.zip
VBCABLE_Setup_x64.exe
VBCABLE_Setup.exe
```

Only redistribute VB-CABLE if the VB-Audio license or explicit permission allows it.

## Project Files

- `main.js` - Electron main process, tray, startup, installer-facing logic
- `preload.js` - safe IPC bridge
- `renderer.js` - soundboard, mixer, keybinds, device routing
- `index.html` - app UI
- `styles.css` - app styling
- `installer/vbcable.nsh` - NSIS hook for bundled VB-CABLE installer
- `installer/install-vbcable-driver.ps1` - silent VB-CABLE setup helper
- `drivers/` - optional local unzipped driver package files
