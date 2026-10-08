# RNNoise Light mode

This is the exact RNNoise binary previously used by Freqx (Git commit a2bae25),
extracted unchanged from `@shiguredo/rnnoise-wasm` **2025.1.5**. Source revision:
`70f1d256acd4b34a572f999a05c87bf00b67730d` in https://github.com/xiph/rnnoise.
The wrapper/build package is https://github.com/shiguredo/rnnoise-wasm/tree/2025.1.5.

RNNoise/model: **BSD-3-Clause**, see `LICENSE-RNNoise.txt`.
Shiguredo wrapper/build distribution: **Apache-2.0**, see `LICENSE-Shiguredo-APACHE.txt`.
Only the unchanged WASM binary is used by the AudioWorklet. Its JavaScript
wrapper is a pinned build dependency, not part of the renderer's inference path.

`manifest.json` pins the binary hash and version. To reproduce extraction:

```js
const fs = require('node:fs');
const source = fs.readFileSync('node_modules/@shiguredo/rnnoise-wasm/dist/rnnoise.js', 'utf8');
const encoded = source.match(/return FA\("([A-Za-z0-9+/=]+)"\);/)[1];
fs.writeFileSync('audio/vendor/rnnoise/rnnoise.wasm', Buffer.from(encoded, 'base64'));
```

Run `npm.cmd run prepare:audio` to verify assets. Only microphone frames enter
this engine. Soundboard clips, master/output streams and playback references
are never inputs. Both noise models operate locally.
