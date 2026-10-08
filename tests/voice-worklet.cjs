'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processorFixture } = require('../scripts/lib/voice-worklet.cjs');
function delayedEngine() {
  const input = new Float32Array(480), output = new Float32Array(480), previous = new Float32Array(480);
  return { input, output, scale: 1, latencySamples: 480,
    process() { output.set(previous); previous.set(input); return 1; }, destroy() {} };
}
function blocks(processor, samples) {
  const input = new Float32Array(128), output = new Float32Array(128);
  const inputs = [[input]], outputs = [[output]], rendered = new Float32Array(samples.length);
  for (let offset = 0; offset < samples.length; offset += 128) {
    for (let i = 0; i < 128; i++) input[i] = samples[offset + i] || 0;
    assert.equal(processor.process(inputs, outputs), true);
    rendered.set(output, offset);
  }
  return rendered;
}
test('128/480 FIFO stays bounded and wet/dry signals have identical timing', async () => {
  const source = new Float32Array(128 * 180); source[128] = .7;
  for (const strength of [0, .5, 1]) {
    const { processor } = await processorFixture({ strength, createLightEngine: delayedEngine });
    processor.gateGain = 1; processor.gateHold = 100000;
    const rendered = blocks(processor, source);
    assert.equal(rendered.findIndex(x => x !== 0), 128 + 928);
    assert.ok(Math.abs(rendered[128 + 928] - .7) < 1e-6);
    assert.equal(processor.underruns, 0);
    assert.equal(processor.processedFrames, Math.floor(source.length / 480));
    assert.ok(processor.outputCount <= processor.outputQueue.length);
    processor.destroy();
  }
});
test('render callbacks reuse typed buffers and smooth the gate after its 120ms hold', async () => {
  let rendering = false;
  const GuardedArray = new Proxy(Float32Array, { construct(target, args) {
    assert.equal(rendering, false, 'AudioWorklet allocated a typed buffer during rendering');
    return new target(...args);
  } });
  const { processor } = await processorFixture({ Float32Array: GuardedArray, createLightEngine: delayedEngine, compressor: true });
  const input = new Float32Array(128), output = new Float32Array(128), inputs = [[input]], outputs = [[output]];
  input.fill(.1);
  rendering = true;
  for (let i = 0; i < 50; i++) assert.equal(processor.process(inputs, outputs), true);
  assert.ok(processor.gateGain > .99);
  input.fill(0);
  for (let i = 0; i < 40; i++) processor.process(inputs, outputs);
  assert.ok(processor.gateGain > .99, 'gate closed before hold elapsed');
  for (let i = 0; i < 50; i++) processor.process(inputs, outputs);
  assert.ok(processor.gateGain > 0 && processor.gateGain < .5, 'release must be gradual');
  rendering = false;
  processor.destroy();
});
test('sustained over-budget processing and FIFO underruns each fall back once to Light', async () => {
  let timestamp = 0;
  const createSlow = () => { const engine = delayedEngine(); const normal = engine.process;
    engine.process = () => { timestamp += 5; return normal(); }; return engine; };
  const { processor, messages } = await processorFixture({ mode: 'high-quality', realtime: true,
    clock: { now: () => timestamp }, createLightEngine: delayedEngine, createHighQualityEngine: createSlow });
  blocks(processor, new Float32Array(128 * 200));
  assert.equal(processor.mode, 'light');
  assert.equal(messages.filter(m => m.type === 'fallback').length, 1);
  processor.publishStats(7);
  assert.equal(messages.at(-1).estimatedLatencyMs, 928 / 48);
  assert.equal(messages.at(-1).id, 7);
  processor.destroy();
  const second = await processorFixture({ mode: 'high-quality', createLightEngine: delayedEngine, createHighQualityEngine: delayedEngine });
  second.processor.outputCount = 0;
  blocks(second.processor, new Float32Array(128));
  assert.equal(second.processor.mode, 'light');
  assert.equal(second.messages.filter(m => m.type === 'fallback').length, 1);
  second.processor.destroy();
});
test('actual local engines render finite mono frames at 48k without memory growth or FIFO gaps', async () => {
  for (const mode of ['light', 'high-quality']) {
    const { processor, messages } = await processorFixture({ mode, compressor: true });
    assert.equal(processor.mode, mode, JSON.stringify(messages));
    const inputView = processor.active.input;
    const samples = new Float32Array(128 * 1200);
    for (let i = 0; i < samples.length; i++) samples[i] = .12 * Math.sin(i * .023) + .015 * Math.sin(i * .43);
    const rendered = blocks(processor, samples);
    assert.ok(rendered.every(Number.isFinite));
    assert.ok(rendered.some(x => Math.abs(x) > .001));
    assert.equal(processor.active.input, inputView);
    assert.equal(processor.underruns, 0);
    processor.destroy();
  }
});
