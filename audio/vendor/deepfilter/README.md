# DeepFilterNet3 C/WASM runtime

Source: [kdrkdrkdr/DeepFilterNet3.c.wasm](https://github.com/kdrkdrkdr/DeepFilterNet3.c.wasm/tree/1695a9b3282e20515ab08eb97c83520f20d23138)
at commit `1695a9b3282e20515ab08eb97c83520f20d23138`.

`dfn3_weights.bin` is the unchanged pretrained weight file from that commit.
`dfn3.wasm` was built from its unmodified `dfn3_wasm.c`, `kiss_fft.c`, `kiss_fftr.c`
and included headers using the official WASI SDK 25 Windows native clang 19.1.5
toolchain, targeting wasm32-wasi with `-O3 -msimd128`. The module has fixed 64 MiB
memory and a 1 MiB stack. Only the microphone worklet instantiates it.

This native compiler build avoids Emscripten's Python build driver and generated
browser loader. No Python, PyTorch, model conversion, cloud inference or dynamic
model download is used. `manifest.json` records the engine/model hashes and API
pin; `scripts/prepare-audio.cjs` validates these before starting or packaging.

The app-specific AudioWorklet adapts the upstream API to Chromium's 128-sample
render quanta, keeping 480-sample processing frames. It preserves the model
allocation until engine destruction, disables upstream input/output AGC and HPF,
supports live attenuation/post-filter changes and reports bounded lifecycle
events. The compiled module and weights are loaded separately from local assets,
rather than embedded as base64 in a generated JavaScript file. WASI diagnostic
imports are handled locally; there is no WASI filesystem or network service.

`upstream/` contains the source snapshot used for compilation and reference
documentation. `.build/` contains ignored development toolchain downloads. These
directories are explicitly excluded by the app's runtime packaging allowlist.
Only runtime binaries, manifest, this notice and `licenses/` enter `app.asar`.

Run `node scripts/benchmark-voice-isolation.cjs` from the repository root to
measure the actual model on this machine with synthetic audio. It records 1,200
frames per mode after warmup. This is a DSP timing check, not an acoustic
echo-cancellation test or subjective voice-quality evaluation.

## Notices

- DeepFilterNet model: the original project's dual MIT/Apache-2.0 notice and
  texts are in `licenses/DeepFilterNet-*`.
- KissFFT: BSD-3-Clause, in `licenses/KissFFT-BSD-3-Clause.txt`.
- WASI libc: its aggregate notice is in `licenses/wasi-libc-LICENSE.txt`, with
  Apache/LLVM/MIT texts and musl/cloudlibc notices alongside it, from revision
  `574b88da4815` recorded in the WASI SDK 25 sysroot. Compiler runtime terms are
  in `LLVM-compiler-rt-LICENSE.txt` (LLVM revision `ab4b5a2db582`).
- The upstream AGC implementation (disabled in this integration) derives from
  WebRTC; its upstream BSD notice is in `licenses/WebRTC-LICENSE.txt`.
- The requested C-port repository does not include a standalone license for its
  own C implementation at this pinned commit. The model and dependency notices
  do not establish a separate license for that port; this is recorded explicitly
  rather than assigning it an invented license.

Runtime consumers need no compiler or SDK. Keep the model and WASM together and
include their notices when redistributing the application.
