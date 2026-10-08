# Local microphone voice isolation

Settings provides **Off**, **Light (RNNoise)** and **High quality (DeepFilterNet3)**,
plus a live wet/dry strength slider, default 85%. Light restores Freqx's exact
previous RNNoise binary. High quality uses the official DFN3 low latency model
with SIMD libDF inference. Legacy Standard/Strong settings migrate to High
quality; an older enabled-only setting becomes Light. Requested mode and
strength persist in `soundmuncher:mixer-settings` localStorage. Runtime fallback
does not overwrite the requested preference.

```text
getUserMedia (echoCancellation=false, noiseSuppression=false, autoGainControl=false)
  -> interactive 48 kHz AudioContext (device resampling/downmix to mono)
  -> optional local AEC3 with explicitly selected playback reference, default Off
  -> 80 Hz high-pass
  -> mic-only AudioWorklet: 480-sample model frames / 128-sample render blocks
       -> aligned raw/denoised wet/dry blend
       -> gate: 120 ms hold, 3 ms attack, 70 ms smooth release
       -> gentle 2:1 compressor, 12 dB knee, no lookahead
  -> processed mic stream -> existing mic gain/EQ -> existing master mixer

soundboard source -> sound gain -> sound-to-mix gain -> existing master mixer
master mixer -> existing mix output AudioContext.setSinkId(CABLE Input)
soundboard monitor -> separate local output AudioContext.setSinkId(headphones)
```

Soundboard clips and the final mix never connect to the denoiser. Only a physical
mic stream feeds its input. The original capture remains caller-owned during
model startup and failure; no microphone frames or model inference are uploaded.
The app's unrelated sound library/account network functions remain separate.

Off skips the denoiser and gate, using the existing mic EQ/compressor. Light and
High quality use the same surrounding mic chain. Optional AEC3 uses the original
unprocessed capture; Chromium processing stays off through startup, failure,
mode/device changes and teardown. A missing reference bypasses local AEC3.

## Timing and safety

Both models consume mono 48 kHz frames of 480 floats (10 ms). The ring buffer
starts with `480 - gcd(480,128) = 448` silent samples and collects each complete
input quantum before draining output. This covers all quantum phases without
normal underruns and adds 9.33 ms. Both models add 480 samples (10 ms), so the dry
branch is delayed by one model frame before blending. This prevents comb filtering
and misaligned syllables at intermediate strength values.

DSP buffering is **19.33 ms**. The compressor adds no buffering. Diagnostics
include the processing context's reported base latency and optional AEC3 delay;
the observed normal estimate on this Windows machine is **29.33 ms**. This is a
software estimate of added processing latency, not a measured mic-to-Discord
round trip. Inter-context MediaStream transport, capture, VB-CABLE, playback
hardware and calling-app buffers can increase real end-to-end latency. Optional
AEC3 adds at least 40 ms and exceeds the normal low latency target.

The settings debug line updates once a second with worklet milliseconds/frame,
estimated added latency and underruns. `micIsolationSession.diagnostics` exposes
processing/peak times, frame count, effective mode and latency in DevTools.
AudioWorklet environments without `performance.now()` use the coarser local
`Date.now()` clock. Full-frame timings include blend, gate and compression.

After 32 warmup frames, sustained work above the 128-sample render budget
(2.67 ms), FIFO starvation or an HQ inference failure switches immediately to
preallocated RNNoise. A nonblocking settings notice explains the fallback while
keeping the selected High quality preference. Startup failure, missing SIMD or
HQ asset failure also selects Light; failure of both engines restores raw mic
capture without affecting soundboard routing. Select Light then High quality to
retry. Do not add work to the render callback that allocates JS buffers.

Models and all JS PCM buffers/views are initialized before capture connects.
No JS buffers, slices, collections or closures are created in normal rendering.
Native Rust/tract inference still uses its internal allocator; this integration
is not an allocation-free rewrite of tract. Unexpected memory growth falls back.
Final model teardown acknowledges a last render quantum before closing the
processing context; serialized startup prevents stale sessions or abandoned
WASM heaps during rapid toggles.

## Local verification and listening

```powershell
npm.cmd run prepare:audio
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run test:mic-isolation
npm.cmd run test:voice-security
npm.cmd run test:echo
npm.cmd run test:reference-desktop
npm.cmd run benchmark:voice
npm.cmd run compare:voice -- C:\path\noisy-speech.wav
npm.cmd run compare:voice -- C:\path\noisy-speech.wav 1
npm.cmd run pack
node tests/packaged-startup.cjs --exe dist/win-unpacked/freqx.exe
node tests/mic-isolation.cjs --app-root dist/win-unpacked/resources/app.asar
node tests/voice-isolation-security.cjs --app-root dist/win-unpacked/resources/app.asar
```

The comparison writes `input.wav`, `off.wav`, `light.wav`, `high-quality.wav` and
`comparison.json` to a newly created Windows temp directory. It runs the exact
worklet model, strength, gate and zero-lookahead compressor in a Node harness,
with an 80 Hz biquad before it. Off uses the same compressor for level comparison.
The hardware/mixer is omitted and automatic overload fallback is disabled to
produce a true High quality output. WAVs are PCM16/24/32 or float32; channels are
downmixed. Prefer 48 kHz input: other sample rates use a simple linear resampler
for this listening tool, while live capture uses Chromium's resampler. Neural
and FIFO delay is removed for aligned A/B listening. No audio file is committed.

Unit checks cover 128/480 framing, aligned blend endpoints, gate hold/release,
no new typed buffers while rendering, forced overload/underrun fallback and
actual local engines. Browser tests run real worklets with silent output sinks,
including native 44.1 kHz stereo capture -> 48 kHz mono, persistence, failures,
CSP/offline loading, routing and soundboard signal invariance. This JS repository
has no existing TypeScript/typecheck configuration; JS syntax, strict runtime
schema validation and lint are the applicable checks.

## VB-CABLE end to end

1. In Freqx choose your **physical microphone** and **CABLE Input** for virtual
   output. Enable Mic and Mix. Choose physical headphones for Monitor output.
2. In Discord or another voice app choose **CABLE Output** as microphone and
   physical headphones as speakers. Disable that app's denoiser, AGC and echo
   processing while comparing so it does not mask Freqx's output.
3. Start at High quality, 85% strength. Speak at a normal distance while running
   a fan, typing and clicking. Record/listen to CABLE Output; compare Off and Light
   at the same mic level. Listen for missed syllables and background noise.
4. Trigger a soundboard clip while silent and while speaking. Its timbre/level
   must remain the same across isolation modes and strengths.
5. Watch frame time, effective mode notices and estimated latency. If High quality
   falls back repeatedly, use Light; lower strength for fewer speech artifacts.
6. Keep echo cancellation Off with headphones. With speakers, explicitly select
   the physical call-playback endpoint under Echo cancellation, verify the reference
   meter moves and accept its extra delay. Never use VB-CABLE as call playback.

## Dependencies and limitations

New runtime: self-built libDF/DFN3 SIMD (MIT OR Apache-2.0), tract 0.23.4
(MIT OR Apache-2.0), RustFFT (MIT OR Apache-2.0), RealFFT (MIT), ndarray and
getrandom (MIT OR Apache-2.0), plus locked permissive Rust dependencies.
Restored build dependency: `@shiguredo/rnnoise-wasm` 2025.1.5 (Apache-2.0 wrapper,
BSD-3-Clause RNNoise/model). No other npm dependency was added. Research evidence,
full licenses, provenance and rebuild instructions are under
[vendor/deepfilter](vendor/deepfilter/README.md) and
[vendor/rnnoise](vendor/rnnoise/README.md). The previous C port lacked its own
license and is removed from runtime packaging.

High quality adds a roughly 58 MB WASM asset and uses substantially more memory.
On this machine, 60 HQ enable/disable cycles stayed around 360–366 MB total renderer
RSS and returned to about 233 MB when Off. These totals include the Electron UI
and test fixtures. Inference cost varies with input/model branches; benchmark
p95 frames can exceed 2.67 ms, making fallback necessary on weak or busy systems.
DeepFilterNet reduces non-speech noise and cannot reliably separate nearby talkers.
Krisp-equivalent perceptual quality has not been established by these regression
checks; evaluate your own microphone and noise conditions with the comparison
WAVs and a voice-app recording.
