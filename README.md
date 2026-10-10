# Freqx

**Your voice. Your sounds. Your moment.**

Turn a perfectly timed sound into part of the conversation. Freqx is a Windows soundboard that mixes your microphone with your favorite clips, so you can bring reactions, sound effects, and personality to voice chats and games. Use it with apps and games that let you choose a microphone input.

### Freqx introduction

https://github.com/user-attachments/assets/40e06b0f-d9c8-447d-a0c6-7e8856d06956

[Download for Windows](https://github.com/reallav0/freqx/releases/latest) · [Visit freqx.app](https://freqx.app/) · [Browse sounds](https://freqx.app/soundboard) · [Account](https://freqx.app/account) · [Report a bug or suggest a feature](https://github.com/reallav0/freqx/issues)

## Make it your soundboard

- **Find your next favorite sound.** Browse and preview the public library in Discover, then add sounds to your boards. Import your own audio files, too.
- **Hit the moment.** Play from a pad or use keybinds while you're in a game or call. Pin favorites, search your collection, and stop every sound with one action.
- **Shape every clip.** Adjust volume, trim, fades, and color. Choose overlap, restart, play once, or toggle loop to suit the sound.
- **Keep your voice clear.** Choose Light (RNNoise), High quality (local DeepFilterNet3), or Off, with adjustable strength to reduce microphone background noise before your voice joins the mix. Soundboard clips bypass isolation, and microphone audio is not uploaded for processing.
- **Control what everyone hears.** Balance your microphone, soundboard, and main output, and choose a separate output for hearing your own clips.
- **Make it feel like yours.** Organize boards, switch app and pad themes, and use compact mode. The interface pairs dot lettering and monochrome pads with red accents.

Your local boards and playback work without an account. Freqx also runs in the system tray, remembers your audio devices, and offers optional launch on Windows startup.

## Start playing in your next call or game

1. Download and install `FreqX-Setup-<version>.exe` from the [latest release](https://github.com/reallav0/freqx/releases/latest).
2. Install the official [VB-CABLE virtual audio driver](https://vb-audio.com/Cable/) if it is not already installed. It carries Freqx's mix to your voice app or game.
3. In Freqx's routing setup, select your real microphone and set the virtual output to **CABLE Input**. Choose headphones or speakers for your local listening output. Use the setup wizard to refresh and test your devices.
4. In your voice app or game's audio settings, select **CABLE Output** as the microphone input. Keep its playback output on your headphones or speakers.
5. Import a clip or find one in Discover, add it to a board, and press play.

```text
Microphone + soundboard → Freqx → CABLE Input → CABLE Output → voice app or game
```

VB-CABLE's names describe the two ends of the same cable: Freqx sends audio into **CABLE Input**, and your voice app receives it from **CABLE Output**. Keep the voice app's speaker output off VB-CABLE to avoid feeding the call back into your microphone mix.

Voice isolation is enabled by default. Its control sits below **Microphone input** in the mixer, with **Off**, **Standard**, and **Strong** options. If isolation becomes unavailable, microphone audio continues through the fallback path.

## Source-available, made to be explored

This repository contains the Electron desktop app, its audio engine, and the interface for boards, Discover, and accounts. Explore the code, build it yourself, or help improve the experience. The API and website live in a [separate backend project](https://github.com/reallav0/freqx-api); local soundboard development does not require running that server.

### Run from source

Use Windows and Node.js 22, the version used by CI. From this checkout:

```powershell
npm.cmd ci
npm.cmd run dev
```

Installation prepares the committed DeepFilterNet3 WASM/model assets and rebuilds native audio dependencies. No model download, Python, or runtime compiler is required for voice isolation. If you install with lifecycle scripts disabled, run `npm.cmd run prepare:audio` before starting the app.

### Build a Windows release

```powershell
npm.cmd run pack   # Unpacked app for local verification
npm.cmd run dist   # Windows installer and portable executable
```

Builds go to `dist/`: `FreqX-Setup-<version>.exe` and `FreqX-Portable-<version>.exe`. These commands build locally without publishing. Installed builds offer background update downloads and ask you to confirm a restart to install them; source and portable builds update manually. See [releases and updates](docs/implementation/releases.md).

### Contribute

Bug reports, feature ideas, and pull requests are welcome. For bugs, include your Windows version, Freqx version, audio devices, and steps to reproduce. For code changes, explain the behavior you changed and how you verified it.

Contributions are made under the repository's contribution terms, including [LICENSE](LICENSE). Ensure you have the right to submit your work.

Start with the standard checks and run additional checks relevant to your change:

```powershell
npm.cmd run lint
npm.cmd run test:unit
```

Discover loads pages from `GET https://api.freqx.app/api/sounds`, follows `nextCursor` when more sounds are requested, and sends search and category filters to the API. Its library total comes from `GET /api/catalog/stats`; sorting applies to loaded sounds, and category choices accumulate as pages and searches return them. The packaged catalog remains available when the API cannot be reached.

Verify Discover with `npm.cmd run test:public-library`. Use `npm.cmd run test:public-library:live` to check the live API, Chromium audio decoding, local importing, and soundboard playback with an isolated profile and silent audio outputs. The live check uses anonymous API reads and creates no cloud sounds.

Useful places to start:

| Area | Files and documentation |
| --- | --- |
| Desktop, tray, and IPC | [`main.js`](main.js), [`preload.js`](preload.js) |
| Soundboard, mixer, and routing | [`renderer.js`](renderer.js), [`audio/`](audio/) |
| Interface and Discover | [`index.html`](index.html), [`styles.css`](styles.css), [`discover.js`](discover.js) |
| Microphone processing | [Voice isolation](audio/VOICE-ISOLATION.md), [echo cancellation](audio/ECHO-CANCELLATION.md) |
| Runtime settings | [Desktop configuration](docs/implementation/desktop-configuration.md), [`runtime/desktop-config.json`](runtime/desktop-config.json) |
| API integration | [Platform architecture](docs/implementation/platform.md), [desktop setup](instruction.md) |
| Releases and driver packaging | [Release guide](docs/implementation/releases.md), [driver verification](security/driver-verification.md) |

<details>
<summary>Audio checks, integrations, and packaging notes</summary>

**Audio and recovery checks.** Run the checks relevant to your changes:

```powershell
npm.cmd run test:mic-isolation
npm.cmd run test:voice-security
npm.cmd run test:recovery
```

The microphone checks use synthetic or fake microphone audio. Recovery checks intentionally terminate isolated test processes to verify restart behavior.

**Local API development.** Start the separate backend after setting up its database and migrations, then point a source build at it:

```powershell
$env:FREQX_API_BASE_URL = 'http://127.0.0.1:3000'
npm.cmd run dev
```

Packaged builds use the trusted `https://api.freqx.app` configuration. Keep server credentials in the backend project.

**Keybinds.** Ordinary keys use Electron's built-in global shortcuts. On Windows, keypad bindings automatically load the existing `uiohook-napi` hook to distinguish physical keypad navigation aliases. Numpad 1 works with Num Lock on or off, including modifier chords, without also binding the separate End key. The hook stops when no keypad bindings remain. If the native hook cannot load or start, keypad digits fall back to Electron's Num Lock on shortcuts; an occupied shortcut is reported as unavailable. `app.nativeKeyHookEnabled: false` keeps ordinary keys on Electron. Developers can opt other keys into the hook through that configuration flag; source launches also accept `FREQX_ENABLE_NATIVE_KEY_HOOK=1`.

**Website imports.** Installed Windows builds register `freqx://`. Links can import audio into the local library or pass the request to the running instance:

```text
freqx://import-sound?url=https%3A%2F%2Fexample.com%2Fsound.mp3&filename=sound.mp3&title=Sound
```

Use **Add link** to paste a direct audio URL, public YouTube video or public SoundCloud track and play it on your board. HTTPS links are checked for public addresses, safe redirects, supported audio bytes, and a 24 MiB/five-minute limit. Downloads are decoded in a disposable sandbox and saved as PCM WAV. Website protocol imports use the same validation. See [link playback and security](docs/implementation/audio-links.md).

**Driver packaging.** Optional VB-CABLE packages belong in `drivers/`. Include the full official package and its companion driver files; automatic driver installation requires reviewed verification pins. The current policy blocks automatic driver installation until those pins are reviewed. Redistribution requires the appropriate VB-Audio license or permission. Follow the [driver verification guide](security/driver-verification.md).

**Crash recovery.** A hidden monitor can restart the app in the tray after fatal errors, preserving saved settings and library files without replaying interrupted sounds. Recovery is limited to three restarts in five minutes. If the limit is reached, inspect `crash-logs/freqx-crash.log` in the app's data folder before launching manually. Quit and Windows shutdown stop the monitor.

</details>

## License

Freqx is source-available and licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal and other permitted non-commercial use, including modification and experimentation, is governed by that license. Commercial use outside its permitted purposes requires a [separate commercial license](COMMERCIAL_LICENSE.md). The [LICENSE](LICENSE) is authoritative; this change does not revoke rights previously granted under earlier licenses.

The Freqx name, logo, and branding are covered separately by [TRADEMARKS.md](TRADEMARKS.md). Third-party components included with or used by Freqx remain subject to their respective licenses. Bundled audio notices, licenses and build provenance are documented with the [DeepFilterNet3 assets](audio/vendor/deepfilter/README.md), [RNNoise assets](audio/vendor/rnnoise/README.md) and [AEC3 assets](audio/vendor/aec3/README.md). See [voice isolation testing and VB-CABLE setup](audio/VOICE-ISOLATION.md).

Website audio uses independent pinned [yt-dlp and Deno helpers](runtime/vendor/link-tools/README.md). Their licenses, source references and full third-party notices ship alongside the helpers.
