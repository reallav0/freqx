# Packaged WebRTC AEC3

The binary is the WebRTC EchoCanceller3 implementation shipped by
[`@ennuicastr/webrtcaec3.js` 0.3.0](https://github.com/ennuicastr/webrtcaec3.js/tree/e1d663e86f2ab03269b9ae873af38d0103c4df3d).
The npm archive was verified against the SHA-512 integrity in `manifest.json`.
`aec3.wasm` is extracted, unchanged, from the distribution's embedded base64
WASM. The full third-party license notice is retained in `LICENSE.txt`.

The upstream WebRTC implementation is BSD-3-Clause; its Abseil component is
Apache-2.0 and Emscripten/musl are MIT.
The complete Apache license is included in `Apache-2.0.txt` alongside the
upstream component notices. Upstream glue is 0BSD and does not require attribution.
The adapter is application code and makes no SDK/service requests. There are no
per-user processing fees.

`audio/aec3-engine.mjs` uses the pinned binary's minified C exports directly.
The export mapping is derived from the corresponding npm JS distribution.
Memory is fixed at 16 MiB. Compile happens outside the audio thread, then a
compiled module is cloned to the worklet. No dynamic evaluation or upstream
Emscripten loader is included at runtime.

This is a pinned 2024 build of AEC3, not a claim to contain the latest WebRTC
release or Discord's implementation. An upstream update requires reviewing the
ABI, licenses, binary hash, fixed memory limit and echo/double-talk regressions.

To reproduce extraction, download the manifest's exact npm version, verify its
archive integrity, decode `WebRtcAec3Wasm` in `dist/webrtcaec3-0.3.0.js`, copy
`license.js` as `LICENSE.txt`, then run `npm run prepare:audio` and `npm run test:echo`.
