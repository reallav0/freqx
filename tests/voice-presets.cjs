'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rate = 48000;
const loader = fs.readFileSync(path.join(__dirname, '../audio/voice-presets.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../audio/voice-presets-worklet.mjs'), 'utf8');
const globals = { URL, location: { href: 'file:///freqx/index.html' } };
vm.runInNewContext(loader, globals);
const presets = globals.FreqxVoicePresets.presets;

function fixture(options, FloatArray = Float32Array) {
  let Processor;
  const posted = [];
  vm.runInNewContext(source, { sampleRate: rate, Float32Array: FloatArray,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => posted.push(value) }; } },
    registerProcessor(name, implementation) { assert.equal(name, 'freqx-voice-presets'); Processor = implementation; }
  });
  return { processor: new Processor({ processorOptions: options }), posted };
}
function tone(frequency, seconds = 1, amplitude = 0.1) {
  return Float32Array.from({ length: Math.ceil(rate * seconds / 128) * 128 }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / rate));
}
function render(processor, samples) {
  const input = new Float32Array(128), output = new Float32Array(128), result = new Float32Array(samples.length);
  const inputs = [[input]], outputs = [[output]];
  for (let offset = 0; offset < samples.length; offset += 128) {
    input.set(samples.subarray(offset, offset + 128));
    assert.equal(processor.process(inputs, outputs), true);
    result.set(output, offset);
  }
  return result;
}
function power(samples, frequency) {
  let real = 0, imaginary = 0;
  const begin = 8192, size = samples.length - begin;
  for (let index = begin; index < samples.length; index++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index - begin) / size);
    const phase = 2 * Math.PI * frequency * index / rate;
    real += samples[index] * window * Math.cos(phase); imaginary += samples[index] * window * Math.sin(phase);
  }
  return (real * real + imaginary * imaginary) / (size * size);
}
const rms = samples => Math.sqrt(samples.slice(8192).reduce((sum, value) => sum + value * value, 0) / (samples.length - 8192));

test('six shipped presets are available without constructing an engine or audio graph', () => {
  assert.deepEqual(Array.from(presets, preset => preset.id), ['anime', 'deep', 'robot', 'helium', 'monster', 'radio']);
  assert.ok(Object.isFrozen(presets));
});

test('character presets move microphone pitch in the advertised direction without changing duration', () => {
  const original = 330, input = tone(original);
  for (const id of ['anime', 'deep', 'helium', 'monster']) {
    const preset = presets.find(value => value.id === id), { processor } = fixture(preset);
    const output = render(processor, input), expected = original * 2 ** (preset.semitones / 12);
    let peak = 0, frequency = 0;
    for (let candidate = expected - 12; candidate <= expected + 12; candidate += 0.5) {
      const value = power(output, candidate); if (value > peak) { peak = value; frequency = candidate; }
    }
    assert.equal(output.length, input.length);
    // Overlapping grains spread energy into nearby sidebands; these character
    // effects should remain within half a semitone of the requested pitch.
    assert.ok(Math.abs(frequency / expected - 1) < 0.03, `${id}: expected ${expected.toFixed(1)} Hz, got ${frequency.toFixed(1)} Hz`);
    assert.ok(peak > power(output, original) * 20, `${id} must shift speech, not leave a dry dominant voice`);
    assert.ok(rms(output) > 0.005, `${id} must produce audible output`);
  }
});

test('Robot adds ring-modulated sidebands and Radio limits low and high frequencies', () => {
  const robot = render(fixture(presets.find(value => value.id === 'robot')).processor, tone(440));
  assert.ok(power(robot, 395) > power(robot, 440) * 3);
  assert.ok(power(robot, 485) > power(robot, 440) * 3);
  const radio = presets.find(value => value.id === 'radio');
  const levels = [80, 1000, 12000].map(frequency => rms(render(fixture(radio).processor, tone(frequency))));
  assert.ok(levels[0] < levels[1] * 0.4, 'Radio attenuates bass');
  assert.ok(levels[2] < levels[1] * 0.5, 'Radio attenuates high frequencies');
});

test('rendering allocates no typed buffers and all presets bound invalid or loud input', () => {
  let rendering = false;
  const FloatArray = new Proxy(Float32Array, { construct(target, args) {
    assert.equal(rendering, false, 'No typed-buffer allocation in the render callback'); return new target(...args);
  } });
  const input = new Float32Array(128), output = new Float32Array(128), inputs = [[input]], outputs = [[output]];
  for (const preset of presets) {
    const { processor } = fixture(preset, FloatArray); rendering = true;
    for (let block = 0; block < 50; block++) {
      input.fill(block % 2 ? 10 : -10); input[3] = NaN; input[8] = Infinity;
      processor.process(inputs, outputs);
      assert.ok(output.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
    }
    rendering = false;
  }
});

test('stopping a preset discards audio, becomes silent, and ignores further input', () => {
  const { processor } = fixture(presets[0]); render(processor, tone(330, 0.3));
  processor.port.onmessage({ data: { type: 'stop' } });
  const output = new Float32Array(128).fill(1);
  assert.equal(processor.process([[new Float32Array(128).fill(1)]], [[output]]), false);
  assert.ok(output.every(value => value === 0)); assert.ok(processor.ring.every(value => value === 0));
});

test('loader caches its packaged module, cancels late startup, and reports processor failures', async () => {
  let moduleLoads = 0, finish;
  const nodes = [];
  const context = { sampleRate: rate, audioWorklet: { addModule: url => {
    assert.equal(url, 'file:///freqx/audio/voice-presets-worklet.mjs'); moduleLoads++;
    return new Promise(resolve => { finish = resolve; });
  } } };
  class Node {
    constructor() { this.port = { postMessage() {} }; this.handlers = {}; nodes.push(this); }
    addEventListener(name, callback) { this.handlers[name] = callback; } disconnect() { this.disconnected = true; }
  }
  const realm = { ...globals, AudioWorkletNode: Node, DOMException };
  vm.runInNewContext(loader, realm);
  const signal = new AbortController(), pending = realm.FreqxVoicePresets.create(context, { signal: signal.signal });
  signal.abort(); finish(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(nodes.length, 0);
  let failure;
  const session = await realm.FreqxVoicePresets.create(context, { presetId: 'deep', onError: error => { failure = error; } });
  assert.equal(moduleLoads, 1); nodes[0].handlers.processorerror();
  assert.ok(failure); assert.equal(nodes[0].disconnected, true); session.close();
  await assert.rejects(realm.FreqxVoicePresets.create(context, { presetId: 'missing' }), /available/);
});
