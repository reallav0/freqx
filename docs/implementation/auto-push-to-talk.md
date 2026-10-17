# Automatic push-to-talk

In the Mixer, choose a running target app, choose the same talk key used by that
app, then enable **Auto push-to-talk**. Start a sound with the app focused.
Letters, digits, F1–F24, Space, and mouse side buttons 4/5 are supported. Mouse
talk keys additionally require the pointer over the selected app, because Windows
routes synthetic mouse-button input to the window under the pointer.

The feature defaults off. The selected executable name, key, and enabled preference
are saved in the existing mixer settings. A target that is not running remains
selected. Refresh lists visible apps; the list is not polled. No process starts
on an ordinary launch with the feature off, apart from an explicit app-list request.

Only audible soundboard playback sent to the virtual output acquires PTT. Local
Discover previews, editor previews, test tones, and zero-volume clips do not.
Mix off, a non-virtual output, zero soundboard/master volume, or disabling/changing
PTT releases existing holds. Re-enabling an output does not acquire PTT halfway through a clip.
The talk key cannot also be a Freqx sound/Stop shortcut.

The renderer waits for a PTT acquisition before starting each sound. Requests
are individually cancelable, including during decode, loudness analysis, and
key acquisition. Main-process leases share one native key hold across overlapping
sounds. Loops retain a lease until stopped. There is an 80 ms lead-in and 120 ms
release padding, configured in `audio.autoPushToTalk` in the desktop configuration.

`runtime/auto-ptt.cjs` owns leases and a bounded JSON-line protocol to the hidden
Windows helper `audio/native/AutoPushToTalk.exe`. `prepare:audio` builds the helper
using the Windows .NET Framework compiler already used for playback-reference
capture. The helper ships unpacked; users need no compiler, new dependency, or
runtime download.

Native focus checks restrict input to the selected executable and exclude the
Freqx process. Focus loss releases the key; returning to the app does not press
it again until another sound starts. Physical key/button state is checked before
acquisition. A key already held by the user is borrowed without a synthetic down
or up. A physical press/release during automation hands control back to the user.
Only the configured PTT key is observed; typing is never recorded or forwarded.

Refresh heartbeats exist only while playback has active leases. Expired renderer
leases release input. The helper independently releases on parent pipe closure or
a missing parent heartbeat. Renderer navigation, crash, unresponsiveness, app quit,
and Windows session end stop it. Only the main soundboard frame can call PTT IPC;
child frames and external windows cannot send keys through the bridge.

This uses standard Windows `SendInput`; it does not bypass game input restrictions
or Windows privilege boundaries. A blocked press reports an error in the Mixer.
If Windows blocks a key release, the helper retains ownership and retries until
input is permitted again or a physical key event takes over, even after Freqx exits.
See [Microsoft's SendInput documentation](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput).

Checks:

```powershell
npm.cmd run test:auto-ptt
npm.cmd run test:auto-ptt-desktop
npm.cmd run test:auto-ptt-windows
```

The desktop check uses synthetic audio, silent outputs, and a mock key bridge in
an isolated profile. The Windows check focuses a dedicated receiver window and
verifies actual F24/mouse input, shared holds, focus loss, borrowed input, EOF, and
native heartbeat expiry. It restores focus/pointer and closes only its own fixtures.
