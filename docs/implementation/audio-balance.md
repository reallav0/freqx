# Voice and clip balance

The mixer provides microphone volume from 0–300%. 100% is unity gain;
300% multiplies the post-isolation signal by three (about +9.5 dB). Existing
saved volume settings retain their values. The same gain works with isolation
off or unavailable, using the raw-microphone fallback.
A separate Mic level readout measures the boosted, protected microphone before
it joins the soundboard mix. Its visual updates pause while the page is hidden.

**Voice priority** lowers only the soundboard branch sent to the call. Gentle,
Medium, and Strong apply 6, 12, and 18 dB reductions. Local clip monitoring stays
at its selected volume. The sidechain measures the microphone stream after
isolation and before the volume control, so boosting the voice does not change
detection sensitivity. Mic off, disconnection, zero mic volume, and disabling
the feature release ducking. Attack, hold, hysteresis, and release run entirely
in `audio/mix-worklet.mjs`; hidden-window meter throttling cannot stop them.

**Match clip loudness** measures each decoded clip's trimmed region using
K weighting and gated 400 ms blocks with 75% overlap, following the measurement
approach in [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770).
The application target is -18 LUFS, with a maximum 12 dB boost, 24 dB reduction,
and -1 dBFS sample-peak headroom. Short effects use their available duration.
Silence is left unchanged. Mono is measured as the dual-mono signal heard in
stereo playback; quad and 5.1 use Web Audio speaker downmix coefficients.
These controls are for consistent playback, not a certified broadcast meter
or an oversampled true-peak measurement.

Analysis yields between bounded chunks and shares pending/results by decoded
buffer and trim values in a weak cache. It adds no eager library decoding,
retains no additional decoded buffers, and never edits original files. Stop,
restart, and removal cancel pending playback even while shared analysis finishes.
Manual pad volume and fades apply after the measured correction. The sound
editor supports opting a clip out; editor previews use the same playback path.
Discover previews remain local and bypass the shared microphone/soundboard mix.

Voice priority and matching default off, and their saved preferences are restored
on launch. Individual sounds participate in matching by default once it is on.
Settings and tuning live in `runtime/desktop-config.json` (`audio.defaults`,
`audio.voicePriority`, `audio.loudness`, and `audio.peakProtection`).

Three linked-stereo peak limiters protect the microphone after processing/gain,
the final mixed output, and local clip output. Each uses 3 ms of lookahead and
an 80 ms gain release with a -1 dBFS sample ceiling. The microphone reaches the
outgoing mix through two stages (6 ms total added buffering); clips and local
monitoring each cross one stage. Initialization is shared across simultaneous
play requests. DSP startup/runtime errors stop capture and playback, suspend
outputs, and display a restart message rather than bypassing protection.

Verification:

```powershell
npm.cmd run test:mix-features
npm.cmd run test:mix-features-desktop
npm.cmd run test:mic-isolation
```

The desktop checks use synthetic microphone/audio signals and silent output
devices in an isolated Electron profile. They verify gain, limiting, hidden-page
ducking, monitor separation, opt-out, and persisted settings without accessing
the user's microphone, audio devices, or saved profile.
