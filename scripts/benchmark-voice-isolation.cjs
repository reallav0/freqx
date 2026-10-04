// Exercise the actual packaged SIMD model. No microphone, network, or audio output.
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../runtime/desktop-config.cjs');
const directory = path.resolve(__dirname, '../audio/vendor/deepfilter');
const module_ = new WebAssembly.Module(fs.readFileSync(path.join(directory, 'dfn3.wasm')));
let engine;
engine = new WebAssembly.Instance(module_, { wasi_snapshot_preview1: {
  fd_close: () => 8, fd_seek: () => 8,
  fd_write: (_fd, vectors, count, written) => {
    const memory = new DataView(engine.memory.buffer);
    let bytes = 0;
    for (let i = 0; i < count; i++) bytes += memory.getUint32(vectors + i * 8 + 4, true);
    memory.setUint32(written, bytes, true); return 0;
  }
} }).exports;
const weights = fs.readFileSync(path.join(directory, 'dfn3_weights.bin'));
const pointer = engine.malloc(weights.length);
new Uint8Array(engine.memory.buffer, pointer, weights.length).set(weights);
const results = [];
try {
  for (const [mode, { attenuationDb: attenuation, postFilterBeta: beta }] of Object.entries(config.audio.voiceModes)) {
    if (engine.dfn3_wasm_create(pointer, weights.length) !== 0) throw new Error('Model initialization failed.');
    engine.dfn3_wasm_set_input_agc(0); engine.dfn3_wasm_set_output_agc(0); engine.dfn3_wasm_set_hpf(0);
    engine.dfn3_wasm_set_atten_lim(attenuation); engine.dfn3_wasm_set_post_filter_beta(beta);
    const input = new Float32Array(engine.memory.buffer, engine.dfn3_wasm_get_input_ptr(), 480);
    const output = new Float32Array(engine.memory.buffer, engine.dfn3_wasm_get_output_ptr(), 480);
    const timings = [];
    let seed = 2357;
    for (let frame = 0; frame < 1300; frame++) {
      for (let i = 0; i < 480; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const t = (frame * 480 + i) / 48000;
        input[i] = .08 * Math.sin(t * Math.PI * 2 * 180) * (.5 + .5 * Math.sin(t * 17)) + .04 * (seed / 2147483648 - 1);
      }
      const start = process.hrtime.bigint();
      engine.dfn3_wasm_process();
      const milliseconds = Number(process.hrtime.bigint() - start) / 1e6;
      if (frame >= 100) timings.push(milliseconds);
      if (!output.every(Number.isFinite)) throw new Error('Non-finite PCM from model.');
    }
    timings.sort((a, b) => a - b);
    results.push({ mode, frames: timings.length, hopMs: 10, renderQuantumMs: 128 / 48,
      meanMs: timings.reduce((sum, value) => sum + value, 0) / timings.length,
      medianMs: timings[Math.floor(timings.length * .5)], p95Ms: timings[Math.floor(timings.length * .95)],
      p99Ms: timings[Math.floor(timings.length * .99)], maxMs: timings.at(-1) });
    engine.dfn3_wasm_destroy();
  }
} finally { engine.dfn3_wasm_destroy(); engine.free(pointer); }
const destination = path.resolve(__dirname, '../output/voice-isolation-benchmark.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify({ runtime: process.version, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
