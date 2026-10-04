'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, '../audio/vendor/aec3/aec3.wasm')));
const length = 48000 * 12;
function signal(seed) {
  const out = new Float32Array(length); let smooth = 0;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    smooth = .75 * smooth + .25 * (seed / 2147483648 - 1);
    out[i] = .4 * smooth;
  }
  return out;
}
const reference = signal(321), near = signal(456), silence = new Float32Array(480);
async function render({ delayMs = 30, doubleTalk = false, nearOnly = false, changeDelay = false } = {}) {
  const { Aec3Engine } = await import('../audio/aec3-engine.mjs');
  const engine = new Aec3Engine(wasm);
  const microphone = new Float32Array(480), output = new Float32Array(length);
  let echoEnergy = 0, residual = 0;
  try {
    for (let p = 0; p < length; p += 480) {
      const delay = (changeDelay && p > length / 2 ? 150 : delayMs) * 48;
      for (let j = 0; j < 480; j++) microphone[j] = (nearOnly ? 0 : p + j >= delay ? reference[p + j - delay] * .5 : 0) + (doubleTalk || nearOnly ? near[p + j] : 0);
      output.set(engine.process(nearOnly ? silence : reference.subarray(p, p + 480), microphone), p);
      if (p > length * .8) for (let j = 0; j < 480; j++) { echoEnergy += microphone[j] ** 2; residual += output[p + j] ** 2; }
    }
    assert.ok(output.every(v => Number.isFinite(v) && Math.abs(v) <= 1), 'finite bounded PCM');
    return { output, erle: 10 * Math.log10(echoEnergy / Math.max(residual, 1e-30)) };
  } finally { engine.close(); }
}
function correlation(output) {
  // WebRTC's three-band analysis/synthesis introduces a fixed filter delay.
  // Find alignment first; RMS alone could pass even if near speech is muted.
  let best = { correlation: -1, gain: 0, lag: 0 };
  for (let lag = 0; lag < 960; lag++) {
    let xx = 0, yy = 0, xy = 0;
    for (let i = length * .8; i < length; i += 4) { const x = near[i - lag], y = output[i]; xx += x * x; yy += y * y; xy += x * y; }
    const value = xy / Math.sqrt(xx * yy);
    if (value > best.correlation) best = { correlation: value, gain: xy / xx, lag };
  }
  return best;
}
for (const delayMs of [2, 30, 100, 250]) test(`real AEC3 cancels ${delayMs} ms playback echo`, async t => {
  const { erle } = await render({ delayMs });
  t.diagnostic(`Synthetic echo reduction: ${erle.toFixed(1)} dB`);
  assert.ok(erle > 15);
});
test('AEC3 reacquires an echo path after delay changes from 30 to 150 ms', async t => {
  const { erle } = await render({ changeDelay: true });
  t.diagnostic(`After reconvergence: ${erle.toFixed(1)} dB`);
  assert.ok(erle > 15);
});
for (const nearOnly of [true, false]) test(nearOnly ? 'near voice survives without playback' : 'near voice survives independent simultaneous playback', async t => {
  const { output } = await render({ nearOnly, doubleTalk: !nearOnly });
  const result = correlation(output);
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.correlation > .8 && result.gain > .75 && result.gain < 1.2);
});
test('production 128/480 worklet framing stays finite and releases engine on destroy', async () => {
  const messages = [];
  global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => messages.push(m) }; } };
  const { AecProcessor } = await import('../audio/aec-worklet.mjs');
  const processor = new AecProcessor({ processorOptions: { wasmModule: wasm, tuning: { aec: require('../runtime/desktop-config.cjs').config.audio.aec } } });
  const block = new Float32Array(128), output = new Float32Array(128);
  for (let p = 0; p < 48000 * 3; p += 128) {
    block.set(reference.subarray(p, p + 128));
    assert.equal(processor.process([[block], [block]], [[output]]), true);
    assert.ok(output.every(Number.isFinite));
    assert.ok(processor.write - processor.read >= 0 && processor.write - processor.read <= 480);
  }
  assert.ok(messages.some(m => m.type === 'stats' && m.referenceDb > -65));
  processor.port.onmessage({ data: { type: 'destroy' } });
  assert.equal(processor.engine, null);
  assert.equal(processor.process([], [[output]]), false);
  assert.ok(messages.some(m => m.type === 'destroyed'));
  delete global.AudioWorkletProcessor;
});
