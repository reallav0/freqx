'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyze } = require('../audio/loudness.js');
const { config, validateConfig } = require('../runtime/desktop-config.cjs');

function worklet(name, options = {}, rate = 48000) {
  const processors = new Map(), messages = [];
  class Processor { constructor() { this.port = { postMessage: value => messages.push(value) }; } }
  const context = vm.createContext({ AudioWorkletProcessor: Processor, sampleRate: rate,
    registerProcessor: (key, value) => processors.set(key, value) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../audio/mix-worklet.mjs'), 'utf8'), context);
  const Constructor = processors.get(name);
  const processor = new Constructor({ processorOptions: options });
  const parameters = Object.fromEntries((Constructor.parameterDescriptors || []).map(entry => [entry.name, new Float32Array([entry.defaultValue])]));
  return { processor, parameters, messages };
}
function render(fixture, input, seconds, rate = 48000, sidechain) {
  const frames = Math.ceil(seconds * rate / 128) * 128;
  const result = [new Float32Array(frames), new Float32Array(frames)];
  const output = [new Float32Array(128), new Float32Array(128)];
  const left = new Float32Array(128), right = new Float32Array(128), mic = new Float32Array(128);
  const inputs = [[left, right], sidechain === undefined ? [] : [mic]], outputs = [output];
  for (let offset = 0; offset < frames; offset += 128) {
    for (let frame = 0; frame < 128; frame++) {
      const value = typeof input === 'function' ? input(offset + frame) : input;
      left[frame] = value; right[frame] = -value * 0.5;
      mic[frame] = typeof sidechain === 'function' ? sidechain(offset + frame) : sidechain || 0;
    }
    assert.equal(fixture.processor.process(inputs, outputs, fixture.parameters), true);
    result[0].set(output[0], offset); result[1].set(output[1], offset);
  }
  return result;
}
function clip(amplitude, seconds = 2, rate = 48000, channels = 1) {
  const data = Array.from({ length: channels }, () => new Float32Array(Math.round(seconds * rate)));
  for (let frame = 0; frame < data[0].length; frame++) {
    const value = (typeof amplitude === 'function' ? amplitude(frame / rate) : amplitude) * Math.sin(2 * Math.PI * 1000 * frame / rate);
    for (const channel of data) channel[frame] = value;
  }
  return { sampleRate: rate, length: data[0].length, numberOfChannels: channels, getChannelData: index => data[index] };
}
const immediate = { yieldControl: async () => {} };

test('300% mic defaults validate while unsupported ranges fail', () => {
  const value = structuredClone(config);
  value.audio.defaults.micGain = 3;
  validateConfig(value);
  const invalid = structuredClone(value); invalid.audio.defaults.micGain = 3.01;
  assert.throws(() => validateConfig(invalid), /Invalid desktop configuration/);
  assert.equal(config.audio.defaults.voicePriority, false);
  assert.equal(config.audio.defaults.matchClipLoudness, false);
});

test('Voice Priority follows mic-only input, smooths attack, holds and restores clips', () => {
  const fixture = worklet('freqx-voice-priority', config.audio.voicePriority);
  fixture.parameters.enabled[0] = 1;
  const attack = render(fixture, 0.25, 0.4, 48000, 0.05)[0];
  assert.ok(attack[0] > 0.24, 'attack must not instantly jump to reduction');
  assert.ok(Math.abs(attack.at(-1) - 0.25 * 10 ** (-12 / 20)) < 0.0001);
  assert.ok(fixture.messages.some(message => message.active));
  const hold = render(fixture, 0.25, 0.1, 48000, 0)[0];
  assert.ok(hold.at(-1) < 0.07, 'brief speech pauses retain reduction');
  const release = render(fixture, 0.25, 2.5, 48000, 0)[0];
  assert.ok(release.at(-1) > 0.249);
  assert.equal(fixture.messages.at(-1).active, false);
  // Loud soundboard audio alone cannot activate its own sidechain.
  render(fixture, 0.8, 0.5, 48000, 0);
  assert.equal(fixture.processor.hold, 0);
});

test('disabled Voice Priority and a disconnected microphone restore unity', () => {
  for (const disconnected of [true, false]) {
    const fixture = worklet('freqx-voice-priority');
    fixture.parameters.enabled[0] = 1;
    render(fixture, 0.2, 0.3, 48000, 0.1);
    if (!disconnected) fixture.parameters.enabled[0] = 0;
    const result = render(fixture, 0.2, 3, 48000, disconnected ? undefined : 0.1);
    assert.ok(Math.abs(result[0].at(-1) - 0.2) < 0.0001);
    assert.equal(fixture.processor.hold, 0);
    assert.equal(fixture.messages.at(-1).active, false);
  }
});

test('peak limiter catches amplified transients and preserves linked stereo balance', () => {
  for (const rate of [44100, 48000, 96000]) {
    const fixture = worklet('freqx-peak-limiter', { ceilingDb: -1, lookaheadMs: 3, channels: 2 }, rate);
    const result = render(fixture, frame => frame % 4096 === 1000 ? 3 : 0.1, 0.4, rate);
    const ceiling = 10 ** (-1 / 20);
    for (let frame = 0; frame < result[0].length; frame++) {
      assert.ok(Number.isFinite(result[0][frame]));
      assert.ok(Math.abs(result[0][frame]) <= ceiling + 1e-6);
      assert.ok(Math.abs(result[1][frame] + result[0][frame] * 0.5) < 1e-6);
    }
    assert.ok(result[0].some(value => value > 0.8), 'transients are limited rather than lost');
    assert.ok(fixture.processor.count <= fixture.processor.queueSize);
  }
});

test('peak limiter preserves quiet samples with bounded lookahead and rejects nonfinite PCM', () => {
  const fixture = worklet('freqx-peak-limiter', { lookaheadMs: 3 });
  const result = render(fixture, frame => frame === 0 ? 0.2 : frame === 200 ? NaN : 0, 0.02)[0];
  assert.equal(result.findIndex(value => value !== 0), 144);
  assert.ok(Math.abs(result[144] - 0.2) < 1e-6);
  assert.ok(result.every(Number.isFinite));
});

test('K-weighted loudness matches differently mastered clips and mono/stereo playback', async () => {
  for (const amplitude of [0.04, 0.08, 0.4]) {
    const result = await analyze(clip(amplitude), immediate);
    assert.ok(Math.abs(result.lufs + 20 - 20 * Math.log10(amplitude / 0.1)) < 0.15, JSON.stringify(result));
    assert.ok(Math.abs(result.lufs + 20 * Math.log10(result.gain) + 18) < 0.01);
  }
  const mono = await analyze(clip(0.1), immediate), stereo = await analyze(clip(0.1, 2, 48000, 2), immediate);
  assert.ok(Math.abs(mono.lufs - stereo.lufs) < 1e-6, 'mono duplicated into stereo must sound as loud as dual mono');
  for (const rate of [22050, 44100, 96000]) {
    const result = await analyze(clip(0.1, 2, rate), immediate);
    assert.ok(Math.abs(result.lufs - mono.lufs) < 0.15, `sample rate ${rate}: ${result.lufs}`);
  }
});

test('loudness handles silence, short effects, peak headroom and bounded boosts', async () => {
  for (const amplitude of [0, 1e-9]) {
    const result = await analyze(clip(amplitude), immediate);
    assert.equal(result.gain, 1); assert.equal(result.lufs, null);
  }
  const short = await analyze(clip(0.1, 0.025), immediate);
  assert.ok(Number.isFinite(short.lufs) && short.gain > 0);
  const quiet = await analyze(clip(0.0001), immediate);
  assert.ok(quiet.gain <= 10 ** (12 / 20) + 1e-8);
  const transient = clip(0.01); transient.getChannelData(0)[100] = 0.98;
  const result = await analyze(transient, immediate);
  assert.ok(result.peak * result.gain <= 10 ** (-1 / 20) + 1e-8);
});

test('quad and 5.1 loudness match the actual Web Audio stereo speaker downmix', async () => {
  const quad = clip(0.1, 2, 48000, 4);
  quad.getChannelData(2).fill(0); quad.getChannelData(3).fill(0);
  const quadResult = await analyze(quad, immediate);
  const stereoHalf = await analyze(clip(0.05, 2, 48000, 2), immediate);
  assert.ok(Math.abs(quadResult.lufs - stereoHalf.lufs) < 1e-6);
  const surround = clip(0.1, 2, 48000, 6);
  for (const channel of [0, 1, 3, 4, 5]) surround.getChannelData(channel).fill(0);
  const center = await analyze(surround, immediate);
  const stereoCenter = await analyze(clip(0.1 * Math.SQRT1_2, 2, 48000, 2), immediate);
  assert.ok(Math.abs(center.lufs - stereoCenter.lufs) < 1e-6);
  surround.getChannelData(2).fill(0); surround.getChannelData(3).fill(0.9);
  const lfe = await analyze(surround, immediate);
  assert.equal(lfe.gain, 1); assert.equal(lfe.lufs, null); assert.equal(lfe.peak, 0);
});

test('loudness analyzes trimmed region, gates silence and yields without mutating audio', async () => {
  const buffer = clip(time => time < 1 ? 0.04 : 0.4);
  const before = buffer.getChannelData(0).slice();
  let yields = 0;
  const quiet = await analyze(buffer, { trimEnd: 1, yieldControl: async () => { yields++; } });
  const loud = await analyze(buffer, { ...immediate, trimStart: 1 });
  assert.ok(quiet.gain / loud.gain > 9.9);
  assert.ok(yields > 0);
  assert.deepEqual(buffer.getChannelData(0), before);
  const padded = await analyze(clip(time => time < 2 ? 0.1 : 0, 8), immediate);
  const reference = await analyze(clip(0.1), immediate);
  assert.ok(Math.abs(padded.lufs - reference.lufs) < 0.4);
});
