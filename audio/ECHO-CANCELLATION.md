# Playback echo cancellation

For Discord, select your real microphone in FreqX, CABLE Input as the virtual
output, and CABLE Output as Discord's microphone. Set Discord's playback and
FreqX's **Call playback / echo reference** to the same physical headphones or
speakers. Keep soundboard monitoring on that device too. The meter should move
while remote speech or music plays. **Quiet** is normal when nothing is playing;
quiet during audible playback usually means the wrong reference was selected.

With voice isolation enabled and a usable playback reference:

```text
WASAPI loopback of selected physical playback endpoint ──→ AEC3 render reference
Real mic → WebRTC AEC3 → DeepFilterNet3 → mic gain / EQ / compressor
         → mix with soundboard → virtual cable → calling app
```

Local echo cancellation is optional and defaults Off. Choose a physical call
playback endpoint explicitly to enable it. Chromium echoCancellation,
noiseSuppression and autoGainControl stay false throughout capture, startup,
failure and teardown. AEC3 uses the original unprocessed mic track. Losing the
reference or an AEC failure bypasses AEC3 while retaining the local denoiser;
no second microphone or browser-processing fallback is opened.

AEC3 provides delay estimation, adaptive echo cancellation, double-talk handling
and residual echo suppression. The previous 512-tap NLMS processor was removed.
The app uses mono 48 kHz, 10 ms frames and fixed 16 MiB AEC3 memory. Microphone
capture is delayed by 30 ms to allow the asynchronous native reference to arrive;
the frame FIFO adds 10 ms and WebRTC's band filters add about 9 ms in synthetic
tests. The reference queue targets 15 ms and resamples the hardware clock with
bounded drift correction. The low latency DFN3/RNNoise path adds 19.33 ms of buffering, with no compressor
lookahead. Thus enabling AEC3 adds at least 40 ms beyond the usual processing
estimate (roughly 70?80 ms total before other transport/device latency);
this is not a measured round-trip or a guarantee for all machines.

Only selected render-endpoint audio is captured, locally and transiently. The
helper does not open a microphone, generate output, capture video or save audio.
Virtual cables are excluded as references to avoid using the outgoing mic/mix.
IPC checks the main app frame and scopes capture IDs to its WebContents. The
native pipe, acknowledged IPC delivery and worklet queues are bounded. Capture
ends on device invalidation, cancellation, navigation, renderer exit or quit.
Choosing a disconnected endpoint keeps that selection and reports fallback;
it does not silently switch to another endpoint. Refresh after reconnecting and
reselect the desired device. Changing the Windows default rebuilds the reference
when a device-change event is observed and the default option is selected.

`prepare:audio` validates pinned hashes/ABI and builds
`audio/native/LoopbackCapture.cs` using Windows' .NET Framework compiler. The
helper ships unpacked beside `app.asar`; customers do not compile it. The model
and WASM engines ship inside the archive. Runtime has no downloads or cloud calls.
See `vendor/aec3/README.md` for provenance and licenses.

## Validation

- `npm run test:echo`: real pinned WASM at 2/30/100/250 ms echo delays, changing
  delay, near voice, double-talk correlation/gain, production worklet framing,
  PCM decoding, endpoint restrictions, ownership, backpressure and cleanup.
- `npm run test:mic-isolation`: real Chromium worklets and the app controller,
  synthetic microphone/reference, mode/device changes, failures, fallback and
  preserved soundboard routing. All outputs use silent sinks.
- `npm run test:voice-security`: sandbox/CSP/offline loading, permission and
  model failures. Tests can also target the packaged application.
- `npm run test:reference-desktop`: production preload IPC, actual reference
  worklet, 44.1/48 kHz PCM, capture release and native disconnect, with synthetic
  packets and silent sinks; also supports `-- --packaged`.

Synthetic tests establish regressions, not Discord-equivalent subjective quality.
For an acoustic check, play remote speech through the selected output, record
the virtual microphone in the calling app, then repeat while speaking. Listen
for residual remote words and missing near-end syllables at normal and louder
speaker volume. Keep the same recording level and compare isolation off,
Light and High quality. No physical microphone recording is automated by the tests.

## Alternatives to paid Krisp

The optional WebRTC AEC3 + DeepFilterNet path has no SDK fees. Third-party component
terms and licensing caveats are documented with the [AEC3](vendor/aec3/README.md)
and [DeepFilterNet3](vendor/deepfilter/README.md) assets.
DeepFilterNet suppresses non-speech background noise; it does not promise to
separate arbitrary nearby people from your voice. Light uses RNNoise as an alternative noise suppressor; either noise model
still needs a separate playback reference to address acoustic echo. Krisp's RTC/background-voice models need licensed vendor files;
they are not included or required. No incomplete Krisp provider is exposed.
