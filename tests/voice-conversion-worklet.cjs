'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../audio/voice-conversion-worklet.mjs'), 'utf8');
const blockSize = 7680;

function fixture() {
  let Processor;
  const posted = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage(message, transfer = []) { posted.push(structuredClone(message, { transfer })); } };
    }
  }
  vm.runInNewContext(source, { AudioWorkletProcessor, Float32Array, sampleRate: 48000,
    registerProcessor(name, implementation) { assert.equal(name, 'freqx-voice-conversion'); Processor = implementation; } });
  const processor = new Processor();
  function quantum(value = 0) {
    const output = new Float32Array(128);
    const running = processor.process([[new Float32Array(128).fill(value)]], [[output]]);
    return { output, running };
  }
  function block(value = 0) {
    const output = new Float32Array(blockSize);
    let running;
    for (let offset = 0; offset < blockSize; offset += 128) {
      const result = quantum(value);
      output.set(result.output, offset); running = result.running;
    }
    return { output, running };
  }
  const converted = (sequence, value) => processor.port.onmessage({ data: { type: 'output', sequence, samples: new Float32Array(blockSize).fill(value) } });
  return { processor, posted, quantum, block, converted,
    requests: () => posted.filter(message => message.type === 'input'), errors: () => posted.filter(message => message.type === 'error') };
}

test('live microphone audio stays muted until converted audio arrives', () => {
  const subject = fixture();
  assert.ok(subject.block(0.75).output.every(value => value === 0), 'natural microphone samples must never bypass conversion');
  assert.equal(subject.requests()[0].sequence, 1);
  assert.ok(subject.requests()[0].samples.every(value => value === 0.75));
  subject.converted(1, 0.25);
  assert.ok(subject.block(0.8).output.every(value => value === 0.25), 'only the converted voice reaches playback');
});

test('capture sequence and converted playback preserve block order', () => {
  const subject = fixture();
  subject.block(0.1); subject.block(0.2);
  subject.converted(1, 0.3); subject.converted(2, 0.4);
  assert.ok(subject.block().output.every(value => Math.abs(value - 0.3) < 1e-6));
  assert.ok(subject.block().output.every(value => Math.abs(value - 0.4) < 1e-6));
  assert.deepEqual(subject.requests().map(frame => frame.sequence), [1, 2, 3, 4]);
});

test('a stalled engine cannot accumulate more than three microphone blocks', () => {
  const subject = fixture();
  for (let index = 0; index < 3; index++) assert.equal(subject.block(0.8).running, true);
  const stopped = subject.block(0.8);
  assert.equal(stopped.running, false);
  assert.ok(stopped.output.every(value => value === 0));
  assert.equal(subject.requests().length, 3);
  assert.equal(subject.errors().length, 1);
  subject.block(0.8);
  assert.equal(subject.requests().length, 3, 'failure stops further microphone transmission');
});

test('out-of-order converted audio fails muted instead of replaying the wrong words', () => {
  const subject = fixture();
  subject.block(); subject.block();
  subject.converted(2, 0.9);
  assert.equal(subject.quantum(0.7).running, false);
  assert.ok(subject.quantum(0.7).output.every(value => value === 0));
  assert.equal(subject.errors().length, 1);
});

test('stop discards queued audio and ignores late conversion replies', () => {
  const subject = fixture();
  subject.block(0.5); subject.block(0.5);
  subject.converted(1, 0.9);
  subject.processor.port.onmessage({ data: { type: 'stop' } });
  subject.converted(2, 0.9);
  const stopped = subject.block(0.5);
  assert.equal(stopped.running, false);
  assert.ok(stopped.output.every(value => value === 0));
  assert.equal(subject.requests().length, 2);
  assert.equal(subject.errors().length, 0, 'late replies after stop are harmless');
});
