'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PcmDecoder, LoopbackService } = require('../runtime/loopback-reference.cjs');
const root = require('node:path').resolve(__dirname, '..');
function frame(samples) {
  const out = Buffer.alloc(4 + samples.length * 4); out.writeUInt32LE(samples.length * 4);
  samples.forEach((v, i) => out.writeFloatLE(v, 4 + i * 4)); return out;
}
test('PCM decoder handles split headers/frames, silence, resets and non-finite data', () => {
  const packets = []; let resets = 0;
  const decoder = new PcmDecoder(pcm => packets.push([...pcm]), () => resets++);
  const bytes = Buffer.concat([frame([.25, -.5]), frame([]), frame([0, Infinity, NaN, 2])]);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(packets, [[.25, -.5], [0, 0, 0, 1]]); assert.equal(resets, 1);
  assert.equal(decoder.pending.length, 0);
});
test('PCM decoder rejects bogus lengths and oversized delivery before allocating', () => {
  for (const size of [3, 7684, 0xffffffff]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(size);
    assert.throws(() => new PcmDecoder(() => {}).push(header), /Invalid/);
  }
  assert.throws(() => new PcmDecoder(() => {}).push(Buffer.alloc(200000)), /backlog/);
});
function fixture() {
  const sent = [], children = [];
  const owner = { id: 10, isDestroyed: () => false, send: (channel, message) => sent.push({ channel, message }) };
  const other = { ...owner, id: 20 };
  const service = new LoopbackService({ appRoot: root, platform: 'win32',
    exec: (file, args, options, callback) => callback(null, JSON.stringify([
      { id: 'physical', label: 'Headphones', isDefault: true }, { id: 'cable', label: 'CABLE Input (VB-Audio)' }
    ])),
    spawnProcess: (file, args, options) => {
      assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
      assert.deepEqual(args, ['capture', 'physical']);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = () => { child.stopped = true; queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); };
      child.exitCode = null; child.kill = () => { child.killed = true; child.exitCode = 1; child.emit('exit', 1); };
      children.push(child);
      queueMicrotask(() => child.stderr.emit('data', Buffer.from(JSON.stringify({ type: 'ready', id: 'physical', sampleRate: 48000 }) + '\n')));
      return child;
    }
  });
  service.available = () => true;
  return { service, owner, other, sent, children };
}
test('reference capture refuses virtual or unknown endpoints', async () => {
  const f = fixture();
  await assert.rejects(f.service.start(f.owner, 'cable'), /physical/);
  await assert.rejects(f.service.start(f.owner, 'unknown'), /physical/);
  assert.equal(f.children.length, 0);
});
test('reference PCM and stop/ack are scoped to the owning renderer', async () => {
  const f = fixture(); const capture = await f.service.start(f.owner, 'physical');
  const child = f.children[0]; child.stdout.emit('data', frame([.25]));
  assert.equal(f.sent[0].message.id, capture.id);
  f.service.stop(f.other, capture.id); assert.equal(child.stopped, undefined);
  f.service.ack(f.other, capture.id);
  f.service.ack(f.owner, capture.id);
  f.service.stop(f.owner, capture.id); assert.equal(child.stopped, true);
  assert.equal(f.service.sessions.size, 0);
});
test('reference capture stops instead of queuing indefinitely when renderer stops acknowledging', async () => {
  const f = fixture(); await f.service.start(f.owner, ''); const child = f.children[0];
  for (let i = 0; i < 9; i++) child.stdout.emit('data', frame([.25]));
  assert.equal(f.sent.filter(p => p.message.type === 'pcm').length, 8);
  assert.match(f.sent.at(-1).message.reason, /stalled/);
  assert.equal(child.stopped, true); assert.equal(f.service.sessions.size, 0);
});
test('cancel during endpoint enumeration prevents a late helper from starting', async () => {
  const f = fixture(); let finish;
  f.service.list = () => new Promise(resolve => { finish = resolve; });
  const pending = f.service.start(f.owner, 'physical');
  f.service.stopOwner(f.owner);
  finish([{ id: 'physical', label: 'Headphones' }]);
  await assert.rejects(pending, /canceled/); assert.equal(f.children.length, 0);
});
test('restarting reference terminates the previous helper and ignores old packets', async () => {
  const f = fixture(); await f.service.start(f.owner, 'physical');
  const old = f.children[0]; const next = await f.service.start(f.owner, 'physical');
  assert.equal(old.stopped, true); old.stdout.emit('data', frame([.5]));
  assert.equal(f.sent.length, 0); assert.ok(f.service.sessions.has(next.id));
  f.service.stopAll(); assert.equal(f.children[1].stopped, true);
});
test('reference worklet queue resamples without unbounded growth and destroys itself', async () => {
  const messages = [];
  global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => messages.push(m) }; } };
  const { ReferenceProcessor } = await import('../audio/reference-worklet.mjs');
  const processor = new ReferenceProcessor({ processorOptions: { sampleRate: 44100 } });
  const pcm = new Float32Array(441).fill(.25), out = new Float32Array(128);
  for (let i = 0; i < 100; i++) {
    processor.port.onmessage({ data: { type: 'pcm', samples: pcm } });
    for (let j = 0; j < 4; j++) { processor.process([], [[out]]); assert.ok(out.every(v => Number.isFinite(v) && Math.abs(v) <= .25)); }
    assert.ok(processor.write - processor.read <= 4410);
  }
  processor.port.onmessage({ data: { type: 'reset' } });
  processor.process([], [[out]]); assert.ok(out.every(v => v === 0));
  processor.port.onmessage({ data: { type: 'destroy' } });
  assert.equal(processor.queue, null); assert.equal(processor.process([], [[out]]), false);
  delete global.AudioWorkletProcessor;
});
