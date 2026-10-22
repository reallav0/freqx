# Instant Replay and audio editor

Open the **Replay** tab beside Soundboard and Discover. Choose a source and a
15, 30, or 60 second buffer, then press **Start buffer**. Recording is off on
launch and never starts just by opening the tab. A recording badge stays visible
when you switch tabs. **Stop buffer** releases capture resources and clears the
rolling buffer; a clip already captured in the editor remains available.

## Sources

- **Desktop - all apps** captures app playback across Windows output devices.
  Replay does not add or open a microphone for this source. Audio already playing
  through another app or virtual output is part of desktop playback.
- **App** captures the selected process and its child processes, including its
  audio on different outputs. Refresh lists apps with audio sessions. Browser
  windows belonging to one process tree are captured together.
- **Playback device** captures everything sent to that specific output, including
  virtual outputs if selected.
- **Microphone** captures the selected raw microphone. The current mixer input
  uses a cloned track; stopping Replay does not stop the mixer's microphone.
- **Freqx mix** captures the processed outgoing voice and soundboard combination,
  with the mixer's current volume, mute, voice effects, and routing preferences.

All-app and individual-app capture use Windows process loopback and require
Windows build 20348 or newer. On older builds, select a playback device instead;
unavailable app-capture options are not invented. Protected or otherwise
uncapturable audio may be silent. A disconnected or failed source stops capture
and shows an error instead of switching to a different source.

## Capture and edit

Press **Capture last Ns** to copy the buffered moment into the editor. If the
buffer has not filled, it captures the available audio. Recording can continue
while you edit; capturing again replaces the editor's current clip.

Drag over the real waveform or enter **In** and **Out** times. **Keep selection**
trims away everything outside the range. **Cut selection** removes the selected
middle portion and joins the remaining audio. Undo, Redo, and Reset clip cover
cuts, trims, volume, and fades. Volume reaches 300%; output is bounded to avoid
invalid PCM. Fade in and Fade out are applied to the resulting clip edges.

**Play selection** and the seek control audition locally through the selected
monitor output and peak protection, independently of soundboard Hear. Preview
never enters the outgoing Freqx mix or Auto push-to-talk. If desktop recording
is still running, local preview is itself desktop playback and can be captured;
stop the buffer before auditioning when you want to avoid that.

Name the clip, select a board, and press **Save to soundboard**. This writes a new
48 kHz PCM WAV to the existing local library and adds board metadata. **Export
WAV** opens a file picker; canceling keeps your edited clip. The original
captured samples are unchanged by edits. Unsaved buffers and edited clips stay
in memory and are discarded when Freqx closes or reloads.

## Implementation

`audio/native/ReplayCapture.cs` is a separate helper from the echo-reference
capture helper. It uses WASAPI render/process loopback, emits stereo 48 kHz
float PCM in bounded packets, and stops on parent-pipe closure. Process-loopback
activation follows the Windows API documented in Microsoft's
[Application Loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
`prepare:audio` builds it with the existing Windows .NET Framework compiler;
the packaged app needs no download or compiler.

`runtime/replay-capture.cjs` validates source identities against enumeration,
bounds packet delivery with acknowledgements, and stops stalled/dead owners.
Only the main soundboard frame can enumerate, record, save, or export. Save IPC
accepts a strict bounded WAV format and uses exclusive library reservations;
the renderer cannot supply a destination path. Export paths come only from the
main-process file picker.

`audio/replay-worklet.mjs` keeps a bounded stereo ring buffer and always outputs
silence. Native packets are acknowledged on the audio thread. Snapshots use
main-thread-allocated buffers and copy in bounded slices ahead of the ring writer.
`audio/replay-audio.js` owns capture contexts/tracks and an editor with bounded,
non-destructive segment/effect history. No network calls or automatic disk
recording occur. The UI is in `replay.js` and `replay.css`.

## Checks

```powershell
npm.cmd run test:replay
npm.cmd run test:replay-desktop
npm.cmd run test:replay-windows
node tests/replay-desktop.cjs --app-root output/replay-build/win-unpacked/resources/app.asar
node tests/packaged-startup.cjs --exe output/replay-build/win-unpacked/freqx.exe --replay
```

Unit checks cover stereo edits, waveform peaks, WAV validation, ring wrap,
microphone exclusion from desktop capture, source ownership, cancellation,
backpressure, and save IPC. Desktop checks use real Web Audio recording and
synthetic native packets with silent outputs and an isolated profile. The native
Windows check enumerates devices/apps and activates capture only against its
own silent Node process, testing startup, heartbeat, and shutdown without
recording user audio.
The packaged startup check records a synthetic Freqx mix, trims it, and saves a
validated WAV through the production preload and main process in an isolated
profile, with native recording disabled.
