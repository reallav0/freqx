# Local microphone voice isolation

The existing microphone input router now uses the C/WASM DeepFilterNet3 engine
from [kdrkdrkdr/DeepFilterNet3.c.wasm](https://github.com/kdrkdrkdr/DeepFilterNet3.c.wasm),
pinned in `vendor/deepfilter/manifest.json`. The app design, imported sounds,
soundboard gain, mixer, virtual output and monitor output retain their routing.

## Pipeline

```text
Physical microphone
  → getUserMedia: Chromium/WebRTC echo cancellation during startup/fallback
      noiseSuppression=false, autoGainControl=false, mono/48 kHz preferred
  → dedicated 48 kHz AudioContext (resamples negotiated capture if necessary)
  → WebRTC AEC3 with selected WASAPI playback reference (Chromium AEC disabled)
  → DeepFilterNet3 SIMD WASM AudioWorklet
  → optional mic compressor (service option, disabled by default)
  → MediaStreamAudioDestinationNode.stream
  → existing mic gain, EQ and mic compressor
  → existing mixer alongside unprocessed soundboard clips
```

No processed microphone is connected to the isolation context's speakers.
`micIsolationSession.stream` is the reusable cleaned MediaStream consumed by the
current mixer. DeepFilterNet's built-in AGC and high-pass filter are disabled.
The microphone EQ uses zero gain adjustments, a 20 Hz high-pass and narrow
20 Hz notch, and a 24 kHz low-pass. Its compressor uses a 1:1 ratio for transparent
level handling. The old adaptive expander and
hard gate are bypassed so they do not cut quiet speech, including during fallback.
The shared master compressor is unchanged.

| Mode | Processing |
| --- | --- |
| Off | Chromium echo cancellation; isolation context is released |
| Standard | DeepFilterNet3, maximum attenuation 20 dB, post-filter disabled (beta 0) |
| Strong | DeepFilterNet3, maximum attenuation 20 dB, post-filter disabled (beta 0) |

Both enabled modes use the same gentle profile to preserve natural speech.
Disabling the post-filter reduces speech coloration and can leave more background
noise. The attenuation setting is a limit, not a guaranteed measured reduction.
Developer tuning lives in `audio.voiceModes` in
[`runtime/desktop-config.json`](../runtime/desktop-config.json).
The checkbox retains the last active mode. Both preferences persist. Standard
and Strong send parameters to the same worklet; Off reconnects the existing
protected capture stream. Enabling AEC3 may acquire an additional raw track on
drivers that cannot switch capture processing; Standard ↔ Strong keeps that
track and its model alive. The app does not need to restart for mode changes.

## Service

`audio/mic-isolation.js` exports `window.VoiceIsolation` and the compatible
`window.MicVoiceIsolation` alias. It does not require renderer Node integration.
Load `runtime/config-schema.js` and `runtime/desktop-config.js` before the audio
scripts, as the production `index.html` does. `create()` waits for validated
configuration and passes selected tuning into the worklets.

```js
const raw = await navigator.mediaDevices.getUserMedia({
  audio: VoiceIsolation.captureConstraints(deviceId), video: false
});
let isolation;
try {
  isolation = await VoiceIsolation.create(raw, {
    mode: 'standard',
    compressor: false,
    onError(error) { useMicrophoneStream(raw); }
  });
  useMicrophoneStream(isolation.stream);
} catch (error) {
  useMicrophoneStream(raw); // Retains the capture track's WebRTC echo cancellation.
}
// Live update; output MediaStream identity stays stable.
isolation?.setMode('strong');
// To disable: reconnect raw first, then isolation.close().
// To release capture: close isolation, then stop all raw tracks.
```

`useMicrophoneStream` represents the caller's own downstream consumer. The app
implements it as `connectMicStreamToMixer`. `create` also accepts an AbortSignal
for canceled startup. Sessions expose `resume()`, `mode` and `contextState`.
The caller owns the original stream; `close()` only stops processed tracks.

## Latency and recovery

See [ECHO-CANCELLATION.md](ECHO-CANCELLATION.md) for playback selection, AEC3
fallback, latency, packaging and echo/double-talk validation. Both engines run
locally without SDK fees. The neural worklet bridges 128-sample Web Audio quanta into 480-sample (10 ms) frames
without per-frame heap allocation. Its FIFO adds 10 ms; DeepFilterNet's STFT and
lookahead add approximately 30 ms. Capture, WebRTC AEC, context transport, optional
compression and selected output hardware add further latency. This is not an
end-to-end latency measurement or a guarantee on every computer.

Assets are fetched and WASM compiled off the audio rendering thread, then cloned
into the worklet. The model allocation remains alive for the engine's lifetime.
Startup has a deadline. Unsupported SIMD/AudioWorklet, corrupt/missing assets,
native traps, processor errors and unexpected context closure return control to
the app's raw AEC input. A low-frequency ping detects an unresponsive worklet.
Unexpected context suspension attempts a bounded resume before fallback.

Microphone changes cancel pending model startup and release the previous capture
and processor. Track-ended events stop the microphone branch and report the
disconnect. Permission failures leave the app and soundboard usable. Window
unload releases sessions and capture. Existing whole-app crash recovery remains
responsible for fatal Electron process crashes and reloads saved preferences.

## Packaging and security

All runtime files live under `audio/vendor/deepfilter/`: `dfn3.wasm`,
`dfn3_weights.bin`, the pinned manifest and notices/licenses. `prepare:audio`
checks their exact sizes, SHA-256 hashes and WASM API/imports without downloads.
Electron Builder explicitly includes these files in `app.asar`; SDK/build files
and upstream C source are excluded. Relative URLs based on the service script
work in development and in `file:///.../resources/app.asar/audio/`.

The existing `contextIsolation: true`, `nodeIntegration: false`, sandbox and CSP
remain in effect. `wasm-unsafe-eval` already permits WASM compilation, without
permitting JavaScript eval. The engine has no network, filesystem, cloud inference,
Python or PyTorch runtime. See the vendor README for source/build provenance.

## Checks

```powershell
npm.cmd run prepare:audio
npm.cmd run test:mic-isolation
npm.cmd run test:voice-security
npm.cmd run pack -- --config.directories.output=output/voice-isolation-build
node tests/mic-isolation.cjs --packaged
node tests/voice-isolation-security.cjs --packaged
```

The integration suite uses the real renderer, worklet and measured PCM, with
fixture devices/IPC and silent sinks. The security suite uses Chromium's native
fake-device capture in the real Electron sandbox, with remote requests blocked.
Neither suite accesses the user's physical microphone or profile. Physical
acoustic echo cancellation and subjective speech quality require a listening
check with the user's actual microphone, speakers and calling application.

## Files changed for this integration

| File(s) | Change and purpose |
| --- | --- |
| `audio/mic-isolation.js` | Reusable VoiceIsolation API, capture constraints, local asset cache, SIMD detection, live modes, optional compressor, resume/health checks and cleanup. |
| `audio/voice-isolation-worklet.mjs` | Replaces RNNoise with the actual DeepFilterNet3 engine, normalized PCM, 128/480 FIFO, safe model ownership and live mode messages. |
| `renderer.js` | Routes only the mic through the service, persists modes, uses AEC capture, bypasses old gates, handles device/permission/track-end races and raw-mic fallback. |
| `index.html`, `styles.css` | Adds the small Off/Standard/Strong selector alongside the existing isolation switch, retaining the existing app design. |
| `package.json`, `package-lock.json` | Removes the old RNNoise development dependency, adds the security test command and explicitly packages DeepFilterNet runtime files. Lockfile version matches the existing 1.7.0 app version. |
| `scripts/prepare-audio.cjs` | Replaces RNNoise extraction with offline model/WASM hash and API verification. |
| `scripts/benchmark-voice-isolation.cjs` | Measures actual local WASM processing times with deterministic synthetic input and verifies finite output. |
| `tests/mic-isolation.cjs` | Extends the real renderer/PCM regression suite for modes, AEC, SIMD fallback, lifecycle and packaged assets. |
| `tests/voice-isolation-security.cjs` | Adds a native fake-mic test with sandbox/context isolation enabled and all network access blocked. |
| `README.md`, `audio/VOICE-ISOLATION.md` | Updates setup, pipeline, service usage, packaging and verification documentation. |
| `audio/vendor/deepfilter/dfn3.wasm`, `dfn3_weights.bin` | Adds the actual pinned SIMD inference module and pretrained model, completely local. |
| `audio/vendor/deepfilter/manifest.json`, `README.md`, `.gitignore` | Records exact checksums, source/compiler provenance and licensing status; excludes local SDK build artifacts from Git. |
| `audio/vendor/deepfilter/upstream/dfn3.h`, `dfn3_math.h`, `dfn3_weights.h`, `dfn3_wasm.c`, `webrtc_agc.h` | Preserves the unmodified pinned model engine sources used to compile the runtime. |
| `audio/vendor/deepfilter/upstream/kiss_fft.c`, `kiss_fft.h`, `_kiss_fft_guts.h`, `kiss_fft_log.h`, `kiss_fftr.c`, `kiss_fftr.h` | Preserves the pinned FFT implementation/headers used by the model. |
| `audio/vendor/deepfilter/upstream/build.sh`, `README.md`, `OPTIMIZATION.md` | Preserves upstream build/API/optimization references; these are not packaged runtime code. |
| `audio/vendor/deepfilter/licenses/DeepFilterNet-APACHE.txt`, `DeepFilterNet-MIT.txt`, `DeepFilterNet-LICENSE.txt` | Model licensing texts and upstream dual-license notice. |
| `audio/vendor/deepfilter/licenses/KissFFT-BSD-3-Clause.txt`, `WebRTC-LICENSE.txt` | Notices for FFT and the upstream AGC implementation. |
| `audio/vendor/deepfilter/licenses/wasi-libc-LICENSE.txt`, `wasi-libc-APACHE.txt`, `wasi-libc-APACHE-LLVM.txt`, `wasi-libc-MIT.txt`, `musl-COPYRIGHT.txt`, `cloudlibc-BSD-2-Clause.txt`, `LLVM-compiler-rt-LICENSE.txt` | Notices and license texts for native libraries linked into the WASM module. |
| `.gitignore` | Removes the obsolete RNNoise-generated-binary ignore rule. |
| Removed `audio/vendor/NOTICE.txt`, `LICENSE-RNNoise.txt` | Removes notices for the superseded RNNoise runtime; its generated WASM is also removed. |

Prior website, icon and version/author changes were retained. No main-process,
preload, output-routing or Electron security setting changes were necessary.
