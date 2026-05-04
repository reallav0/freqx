# SoundMuncher

SoundMuncher is an Electron soundboard for Discord voice chat. It mixes your real microphone with imported sound effects and sends the final mix to VB-CABLE.

## Features

- Import local audio files
- Trigger sounds from the app or with keybinds
- Stop all currently playing sounds
- Mix microphone, soundboard, and main output volume
- Route the Discord mix to VB-CABLE
- Choose where you personally hear meme sounds
- Run in the system tray
- Optional launch on Windows startup
- Optional bundled VB-CABLE installer

## Audio Routing

Use this setup:

```text
Real microphone -> SoundMuncher -> CABLE Input -> Discord input as CABLE Output
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
dist/SoundMuncher Setup 1.0.0.exe
```

## Bundling VB-CABLE

Place the official VB-CABLE installer files in:

```text
drivers/
```

Supported filenames:

```text
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
- `drivers/` - optional local driver installer files
