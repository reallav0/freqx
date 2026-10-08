# Local DeepFilterNet3 Rust/WASM assets

High quality uses the official `DeepFilterNet3_ll` low latency model, compiled
from Rust `libDF` with SIMD. The model is embedded in `df_bg.wasm`; there is no
runtime download, Python, cloud inference, or remote audio processing.

Source: [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet), via the
[SIMD fork](https://github.com/lofcz/DeepFilterNet/tree/773cf0ca65da1f82bc63ee5d8fd15d9314190231)
at `773cf0ca65da1f82bc63ee5d8fd15d9314190231`. The fork adds tract 0.23 SIMD,
DSP SIMD, and wasm SIMD FFT kernels. `rust/Cargo.lock` pins every build dependency;
tract is pinned to 0.23.4 because later 0.23 releases changed its API.

`rust/src/lib.rs` is Freqx's small borrowed-buffer ABI: fixed input/output arrays
of 480 floats live with the model. The published package's owning-slice and
per-frame JavaScript Float32Array wrappers are deliberately avoided. Warmup
happens during construction, before connecting capture. JS PCM buffers and views
are preallocated; no buffers are created in normal render callbacks. Rust/tract
still performs internal allocator operations during inference. Memory growth or
inference failure during live processing triggers Light fallback.

The model's zero lookahead plus 960-point STFT gives 480 samples (10 ms) of
algorithmic delay. The worklet adds 448 samples (9.33 ms) to bridge 128/480 blocks.
`manifest.json` pins the binary hash, compiler, source and model variant.

## Research and dependency choices

Verified against npm registry metadata, actual tarballs and GitHub on 2026-10-08:

| Candidate | Version / license | Decision |
| --- | --- | --- |
| `@lofcz/deepfilternet-web` | 0.1.0, MIT OR Apache-2.0 | SIMD Rust build and embedded DFN3 model; its wrapper allocates/consumes input each frame. Build its licensed libDF source with a borrowed-buffer ABI and the official low latency model instead. |
| `deepfilternet3-noise-filter` | 1.3.0, Apache-2.0 OR MIT | LiveKit-facing wrapper; assets are external to the npm tarball, unsuitable for this app's self-contained adapter. |
| `@sapphi-red/web-noise-suppressor` | 0.4.1, MIT | Verified AudioWorklet/WASM implementation, but its RNNoise build is from 2022. Preserve the exact previous Freqx engine instead. |
| `@shiguredo/rnnoise-wasm` | 2025.1.5, Apache-2.0; RNNoise BSD-3-Clause | Exact previous Light engine, restored and pinned. |

The superseded C-port WASM and weight file are removed. That port lacked a
standalone implementation license; it is no longer packaged or used.

## Rebuild

Install Rust 1.99.0 and its `wasm32-unknown-unknown` target, then run:

```powershell
rustup toolchain install 1.99.0 --profile minimal --target wasm32-unknown-unknown
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-deepfilter.ps1
npm.cmd run prepare:audio
npm.cmd run benchmark:voice
```

The build script compiles the locked source with `-C target-feature=+simd128`
and copies the result to `df_bg.wasm`. Rebuilding an identical pin verifies its
hash. An intentional source/toolchain change needs a reviewed manifest hash and
ABI update; never silently rewrite integrity pins. Ordinary installation/startup
only verifies the committed binaries and prepares the existing Windows helper.
Rust, Cargo caches and model source checkouts are not included in app packages.

## Attributions

- DeepFilterNet/libDF and model: Hendrik Schroeter, MIT OR Apache-2.0, original
  notices in `licenses/DeepFilterNet-*`.
- tract 0.23.4: MIT OR Apache-2.0. RustFFT 6.4.1: MIT OR Apache-2.0.
- RealFFT 3.5.0: MIT, Henrik Enquist (upstream README declares its license).
- ndarray 0.17.2 and getrandom 0.3.4: MIT OR Apache-2.0.
- Full Rust dependency versions, licenses and notices (including build tools)
  are recorded in `licenses/rust-dependencies.json` and `licenses/rust-crates/`.
- Rust standard library/compiler runtime: MIT OR Apache-2.0, with the LLVM
  compiler runtime exception where applicable. Original Apache/MIT and LLVM
  runtime texts are retained in `licenses/`.

Freqx's own adapter follows the repository's PolyForm Noncommercial license.
Third-party model/runtime notices retain their original terms. The historical
WASI/KissFFT/WebRTC notice files remain as credits for earlier bundled engines;
those components are not linked into the new DFN3 binary.
