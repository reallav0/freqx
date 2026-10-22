# Live voice changer

**Voice changer** sits directly below the Mixer's volume sliders. Its default
**Built-in presets** mode includes **Anime girl**, **Deep man**, **Robot**,
**Helium**, **Monster**, and **Radio**. Select a preset and turn on Voice changer.
These are pitch and tone effects that work offline with no engine, models, or
downloads. They change your own voice; they do not reproduce a trained AI voice.
Pitch adjusts each preset's default pitch by -12 to +12 semitones, with a total
shift limited to -18 to +18. Hear myself previews the effect through your chosen
headphone output. Turn the feature off to return to your natural microphone.

The section defaults off but always lists the six bundled presets. Untouched
settings from the previous release also open the built-in list. Previously
configured RVC voices retain their selected mode and model.

For AI model voices, select **AI voices (RVC)**. This optional mode uses a separately running,
local [VCClient / w-okada voice changer](https://github.com/w-okada/voice-changer)
with RVC support. Freqx lists the RVC voices actually installed in that engine.
Its character voices require suitable trained models; Freqx does not bundle an
AI engine or character models.

## Optional AI engine setup

1. Download an RVC-compatible Windows edition from the voice changer's official
   download links. Choose an edition that explicitly supports RVC: edition
   capabilities vary, and a Beatrice-only edition cannot supply RVC voices.
2. Start the engine locally and load the RVC models you want in its interface.
   Follow each model author's usage terms. The engine manages model installation,
   downloads, and any hardware-specific inference requirements.
3. Stop audio capture/playback in the engine. Freqx supplies the microphone audio
   and handles output routing itself; the engine must remain running.
4. Open Freqx's Mixer, choose **Voice changer > AI voices (RVC)**, expand **Setup**, and match the engine port
   (default **18000**). **Open engine setup** opens the engine's local interface;
   **Engine download** opens its official repository.
5. Press **Refresh**, select an installed voice, and enable **Voice changer**. Adjust
   **Pitch** between -12 and +12 semitones. Enable **Hear myself (headphones)**
   to preview the converted microphone through your local listening output.

Your voice preference, pitch, engine port, monitor preference, and enabled state
are saved with mixer settings. The feature defaults off. An ordinary launch with
it off makes no engine requests and adds no conversion worklet to the audio graph.
Explicitly pressing Refresh still queries installed voices while the feature is off.

**Preparing** mutes the microphone while the model initializes. If the engine
stops, falls behind, or returns invalid audio, the microphone remains muted and
the Mixer explains the error. Turn **Voice changer off** to use your natural voice;
turn it back on to retry conversion. Soundboard clips keep playing independently.

## Audio and performance

```text
Microphone -> isolation / echo cancellation -> voice effect -> microphone gain / EQ
           -> compression / peak protection -> outgoing mix
Soundboard ---------------------------------> outgoing mix
```

Microphone boost up to 300% follows conversion. Voice priority still detects
speech on the clean microphone before conversion. Soundboard clips, previews,
and the combined mix are never sent into the voice engine. **Hear myself** is
independent of the soundboard's Hear control and uses the selected local output
with peak protection. Use headphones to avoid acoustic feedback.

Built-in presets process mono 48 kHz audio on the audio thread, without IPC or
network requests. Pitch-shifted presets use two overlapping variable-delay
grains over a 75 ms window; the audible delay varies within that window. Robot
uses ring modulation; Radio uses band filtering and soft saturation. Gain and
peak protection follow all effects. This independently implemented delay-based
approach follows the same general DSP principle described by
[Tone.js PitchShift](https://tonejs.github.io/docs/15.1.22/classes/PitchShift.html);
no Tone.js code or package is bundled.

Optional AI conversion uses mono 48 kHz audio in 7,680-sample blocks (160 ms). Capture buffering,
model context, inference, transport, and audio devices all contribute to latency.
The Mixer's conversion time measures one engine request; it is not total
microphone-to-call latency. Some hardware/model combinations cannot keep up.
A maximum of three outstanding blocks bounds backlog; excessive delay stops
conversion instead of allowing speech to drift indefinitely.

The integration was exercised against Windows VCClient **2.0.78-beta std** with
two supplied ONNX RVC voices, using synthetic voiced harmonics and no microphone
or output device. Thirty-two live-paced blocks per voice produced finite,
non-silent converted audio. Measured mean conversion times on the development
machine were approximately 116 ms and 123 ms per block. This checks transport,
model switching, and inference; it does not establish intelligibility, voice
similarity, or performance on other computers. Legacy VCClient 1.x REST settings
and PCM transport are covered by fixtures rather than a live 1.x engine.

## Integration details

`audio/voice-presets.js` loads the bundled `audio/voice-presets-worklet.mjs` once
per context, handles cancellation and processor errors, and provides the six
preset definitions. The worklet reuses a bounded delay buffer, sanitizes input,
limits output, and stops silently when disconnected. Neither preset selection
nor processing contacts the optional AI engine.

For optional AI mode, `runtime/voice-conversion.cjs` talks only to literal `127.0.0.1` on a validated
integer port (1024-65535), through main-process IPC restricted to the main
soundboard frame. It rejects redirects and bounds request duration and response
size. Renderer networking and Content Security Policy do not change.

The adapter discovers modern `/api/slot-manager/slots` first and falls back to
legacy `/info` only on HTTP 404. It selects an installed RVC slot, configures
48 kHz client input/output and pitch, disables engine passthrough and recording,
then verifies those settings. Modern startup primes inference with synthetic
audio and discards bounded transitional buffers before connecting the microphone.
The engine's selected slot and these settings remain changed after Freqx stops;
configure the engine again before using it separately.

`audio/voice-conversion.js` serializes requests and validates returned samples.
`audio/voice-conversion-worklet.mjs` captures microphone blocks and plays only
converted output. Session IDs and sequence numbers prevent late replies from
entering a replacement microphone session. Microphone changes, disabling AI,
navigation, crashes, unresponsiveness, and quit stop conversion. The backend
also expires an idle session. Engine inference requests are local; the companion
engine and its model-download behavior are managed separately.

## Checks

```powershell
npm.cmd run test:voice-conversion
npm.cmd run test:voice-conversion-desktop
npm.cmd run test:voice-presets
npm.cmd run test:voice-presets-desktop

# Optional: start your local engine and install at least two RVC voices first.
npm.cmd run test:voice-conversion-live -- --port 18000 --voices 0,2
```

The desktop check uses the production renderer and real Web Audio worklets,
with synthetic capture, silent sinks, isolated settings, and a fixture engine
bridge. It verifies routing, model/pitch changes, monitoring, cancellation,
failure muting, and saved preferences. The opt-in live check uses actual engine
inference on synthetic audio, then streams it through the production preload,
IPC handlers, and real audio worklet in a sandboxed Electron window. It never
captures a microphone or opens an audio output, and writes WAVs and timing
results under `output/voice-conversion-live/`. Add `--app-root <path-to-app.asar>`
to exercise the packaged bridge and worklet in that final Electron check.
