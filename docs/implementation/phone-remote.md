# Phone remote

Use a phone browser as a second screen for the desktop soundboard. No phone app,
account, or internet connection is needed. Audio stays on the computer and uses
Freqx's existing mix, monitoring, clip settings and Auto push-to-talk.

## Connect

1. Connect the computer and phone to the same private network. The computer can
   use Ethernet while the phone uses that router's Wi-Fi.
2. Open **Settings → Phone remote** in Freqx and press **Enable phone remote**.
3. If Windows Firewall asks, allow Freqx on **private networks**.
4. Scan the QR code with the phone camera and open the link. You can also copy
   the pairing link and open it in the phone browser.
5. Tap a sound pad. The clip plays through the computer's normal Freqx routing.

The phone can select a board, search sounds, filter favorites, adjust soundboard
volume (0–150%), and stop all sounds. Board selection and volume are shared with
the desktop and other connected phones. Search and Favorites filtering stay on
each phone. Playing pads update when playback starts or ends on the computer.
Clip behavior (overlap, restart, play once, or loop) follows its desktop setting.

Keep Freqx running. Closing it to the tray leaves the remote available when
**Keep running in tray when closed** is enabled. **Turn off remote**, quitting,
reloading, or crash recovery closes the server and disconnects all phones.
The remote is always off after an app restart; enabling is never saved.

## Pairing and reconnection

Pairing links expire after ten minutes. **Refresh pairing link** generates a new
link and QR code without disconnecting existing phones. **Disconnect all phones**
revokes their access and also refreshes the link. Each phone can disconnect itself.
There can be up to eight paired browser sessions, each lasting up to twelve hours
unless revoked earlier. Scanning again replaces that browser's existing session.

When Wi-Fi briefly drops or the phone returns from the background, the controller
fetches current state and reconnects. Playback controls are disabled while the
connection is unavailable. Commands are not queued for replay after reconnecting.
After restarting or disabling the server, enable it and scan its new QR code.

If several network adapters are available, choose **Pairing network** in the
desktop dialog and scan the updated code. Use the computer's Wi-Fi/Ethernet IP,
rather than an adapter belonging to a VPN or virtual machine. If the network
changes, turn the remote off and enable it again to refresh the address list.

If the link does not open, confirm both devices use the same router, allow Freqx
through the private-network firewall, and check whether guest Wi-Fi or access
point isolation blocks devices from reaching one another. Only private IPv4
addresses (10.x.x.x, 172.16–31.x.x, and 192.168.x.x) are advertised; public,
IPv6-only, and link-local networks are not supported in this version.

## Local API

`runtime/phone-remote.cjs` runs a bounded Node HTTP server on an operating-system
assigned port only while enabled. It serves exactly three static assets from
`runtime/phone-remote-web/`. No backend deployment or separate web host is needed.

| Request | Behavior |
| --- | --- |
| `POST /api/pair` | Exchanges `{token}` for an HttpOnly, SameSite=Strict session cookie and returns `{ok:true,state}`. |
| `GET /api/state` | Returns `{ok:true,state}` for a paired browser. |
| `GET /api/events` | Streams `state` events with JSON state and periodic heartbeat comments using SSE. |
| `POST /api/command` | Accepts one validated play, stop-all, volume, or board command and waits for the desktop acknowledgement. |
| `POST /api/disconnect` | Revokes the current browser session and clears its cookie. |

State contains board names, the selected board, sound titles/colors/favorites and
playing flags, and soundboard volume. Sound IDs are random and scoped to the
enabled server's lifetime. The phone receives no file paths, media URLs,
microphone audio, cloud credentials, imports, deletion controls or general IPC.

Control commands are `{type:'play',soundId}`, `{type:'stop-all'}`,
`{type:'volume',value}`, or `{type:'board',board}`. The server validates them
against the current state. The renderer uses its existing playback and mixer
functions; failures and cancelled starts produce an error instead of success.

Pairing uses a random 256-bit secret in the URL fragment. The browser immediately
removes the fragment and submits it in a same-origin JSON request; the secret is
never sent in a request URL. Only numeric local Host headers, private peers, and
matching request origins are accepted. No CORS access is granted. Static assets
use a restrictive CSP, no remote dependencies, and no caching. Bodies, sessions,
requests, streams, pending controls and outgoing buffers have explicit limits.
Stopping also invalidates secrets and sessions and closes established sockets.

HTTP traffic is not encrypted. Use a trusted private network, keep the pairing
link private, and do not expose the port through a router or public tunnel.

## Verification

```powershell
npm.cmd run test:phone-remote
npm.cmd run test:phone-remote-desktop
npm.cmd run lint
npm.cmd run test:unit
```

The desktop check launches the production main/preload/renderer in an isolated
profile, substitutes loopback networking, imports a synthetic WAV and uses silent
audio output with a fake microphone. A separate sandboxed browser loads the real
phone page. It checks QR rendering, pairing and re-pairing, actual audio playback,
bidirectional mixer updates, board changes, stop-all, revocation and shutdown.
It does not access the user's audio devices, profile or firewall.

For a packaged check:

```powershell
npm.cmd run pack -- --config.directories.output=output/phone-remote-build
node tests/packaged-startup.cjs --exe output/phone-remote-build/win-unpacked/freqx.exe --phone-remote
```

The startup harness saves desktop/phone screenshots and its JSON report under
`output/packaged-startup/run-*/`. The HTTP unit checks also cover hostile origins
and hosts, invalid/expired tokens, revoked sessions, bounded commands, restricted
static serving, timeouts and large live-state updates.
