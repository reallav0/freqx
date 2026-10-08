// Benchmark actual packaged engines; no microphone, network or audio output.
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const { createLightEngine, createHighQualityEngine } = await import('../audio/denoiser-engines.mjs');
  const results = [];
  for (const [mode, file, create] of [['light', 'rnnoise/rnnoise.wasm', createLightEngine], ['high-quality', 'deepfilter/df_bg.wasm', createHighQualityEngine]]) {
    const module = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, '../audio/vendor', file)));
    const engine = create(module), timings = [];
    let seed = 2357;
    try {
      for (let frame = 0; frame < 1300; frame++) {
        for (let i = 0; i < 480; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const t = (frame * 480 + i) / 48000;
          engine.input[i] = (.08 * Math.sin(t * Math.PI * 2 * 180) * (.5 + .5 * Math.sin(t * 17)) + .04 * (seed / 2147483648 - 1)) * engine.scale;
        }
        const start = performance.now(); engine.process();
        if (frame >= 100) timings.push(performance.now() - start);
        if (!engine.output.every(Number.isFinite)) throw new Error('Non-finite PCM from ' + mode);
      }
      timings.sort((a, b) => a - b);
      results.push({ mode, frames: timings.length, hopMs: 10, renderQuantumMs: 128 / 48,
        modelLatencyMs: engine.latencySamples / 48,
        meanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
        medianMs: timings[600], p95Ms: timings[1140], p99Ms: timings[1188], maxMs: timings.at(-1) });
    } finally { engine.destroy(); }
  }
  const target = path.join(__dirname, '../output/voice-isolation-benchmark.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ runtime: process.version, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
