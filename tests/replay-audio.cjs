'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { validateReplayWav, ReplayDecoder, ReplayCaptureService } = require('../runtime/replay-capture.cjs');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const loader = fs.readFileSync(path.join(__dirname, '../audio/replay-audio.js'), 'utf8');
const realm = { Float32Array, Uint8Array, DataView, URL, DOMException, location: { href: 'file:///freqx/index.html' } };
vm.runInNewContext(loader, realm); const { Editor } = realm.FreqxReplayAudio;
const clip = () => ({ sampleRate: 48000, channels: [Float32Array.from({ length: 48000 }, (_, i) => i / 48000), Float32Array.from({ length: 48000 }, (_, i) => -i / 48000)] });

test('trim and middle cuts preserve exact stereo samples, with reversible non-destructive history', () => {
  const original = clip(), editor = new Editor(original);
  editor.trim(.1, .9); assert.equal(editor.duration, .8); assert.equal(editor.render().channels[0][0], original.channels[0][4800]);
  editor.cut(.2, .4); assert.equal(editor.duration, .6);
  const output = editor.render(); assert.equal(output.channels[0][9600], original.channels[0][24000]); assert.equal(output.channels[1][9600], original.channels[1][24000]);
  editor.undo(); assert.equal(editor.duration, .8); editor.redo(); assert.equal(editor.duration, .6);
  editor.reset(); assert.equal(editor.duration, 1); assert.ok(editor.canUndo); assert.equal(original.channels[0].length, 48000);
  assert.throws(() => editor.cut(0, 1), /Keep/); assert.throws(() => editor.trim(NaN, 1), /valid/);
});

test('gain and fades are audible, bounded, and restored by undo/redo', () => {
  const editor = new Editor({ sampleRate: 48000, channels: [new Float32Array(48000).fill(.5)] });
  editor.setEffects({ gain: 3, fadeIn: .1, fadeOut: .1 }); const samples = editor.render().channels[0];
  assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0); assert.equal(samples[24000], 1); assert.ok(samples[100] > 0 && samples[100] < .1);
  editor.undo(); assert.equal(editor.effects.gain, 1); editor.redo(); assert.equal(editor.effects.gain, 3);
  assert.throws(() => editor.setEffects({ fadeIn: Infinity }), /Invalid/);
});

test('waveforms use actual audio peaks without canceling opposite stereo channels', () => {
  const editor = new Editor(clip()), wave = editor.waveform(100);
  assert.equal(wave.min.length, 100); assert.ok(wave.min[99] < -.99); assert.ok(wave.max[99] > .99);
  assert.throws(() => new Editor({ sampleRate: 48000, channels: [new Float32Array([NaN])] }), /replay/);
});

test('edited WAV export passes strict main-process validation and rejects forged lengths/formats', () => {
  const editor = new Editor(clip()); editor.trim(.1, .6); const bytes = editor.encode();
  assert.equal(validateReplayWav(bytes).length, 44 + 24000 * 4);
  for (const offset of [0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40]) { const invalid = bytes.slice(); invalid[offset] ^= 255; assert.throws(() => validateReplayWav(invalid), /Invalid/); }
  assert.throws(() => validateReplayWav(new Uint8Array(43)), /size/);
});

function worklet(options = {}, rate = 1000) {
  let Processor; const messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../audio/replay-worklet.mjs'), 'utf8'), { sampleRate: rate, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } }, registerProcessor: (_name, value) => { Processor = value; } });
  const processor = new Processor({ processorOptions: options });
  return { processor, messages, quantum(left = .1, right = -.2) { const output = [new Float32Array(128), new Float32Array(128)]; processor.process([[new Float32Array(128).fill(left), new Float32Array(128).fill(right)]], [output]); return output; },
    snapshot() {
      processor.port.onmessage({ data: { type: 'snapshot', id: 1, channels: [new Float32Array(processor.capacity), new Float32Array(processor.capacity)] } });
      while (processor.snapshotRequest) processor.process([[]], [[new Float32Array(128), new Float32Array(128)]]);
      const packet = messages.findLast(message => message.type === 'snapshot');
      packet.channels = packet.channels.map(channel => channel.subarray(0, packet.frameCount)); return packet;
    } };
}
test('rolling replay retains only the newest configured window and outputs silence', () => {
  const f = worklet({ seconds: 15, local: true });
  for (let block = 0; block < 150; block++) assert.ok(f.quantum(block / 200, -block / 200).every(channel => channel.every(value => value === 0)));
  const snapshot = f.snapshot(); assert.equal(snapshot.channels[0].length, 15000); assert.equal(snapshot.channels[0].at(-1), Math.fround(149 / 200));
  assert.ok(snapshot.channels[0][0] > 0); assert.equal(snapshot.channels[1][0], -snapshot.channels[0][0]);
  f.processor.port.onmessage({ data: { type: 'stop' } }); assert.ok(f.processor.left.every(value => value === 0)); assert.equal(f.processor.running, false);
});

test('desktop captures contain native audio only, never the microphone input', () => {
  const f = worklet({ native: true, local: false }); const samples = Float32Array.from({ length: 256 }, (_, index) => index % 2 ? -.4 : .3);
  f.processor.port.onmessage({ data: { type: 'native', samples, sequence: 1 } }); f.quantum(.9, .9);
  const snapshot = f.snapshot(); assert.ok(snapshot.channels[0].every(value => value === Math.fround(.3))); assert.ok(snapshot.channels[1].every(value => value === Math.fround(-.4)));
  assert.equal(f.messages[0].type, 'ack');
  f.processor.port.onmessage({ data: { type: 'native', samples: new Float32Array(2000), sequence: 2 } }); assert.equal(f.processor.running, false);
});

test('native PCM decoder sanitizes samples and rejects malformed or excessive packet lengths', () => {
  const packets = []; let resets = 0; const decoder = new ReplayDecoder(packet => packets.push(packet), () => resets++);
  const bytes = Buffer.alloc(20); bytes.writeUInt32LE(16); bytes.writeFloatLE(NaN, 4); bytes.writeFloatLE(2, 8); bytes.writeFloatLE(-.5, 12); bytes.writeFloatLE(0, 16);
  decoder.push(bytes.subarray(0, 7)); decoder.push(bytes.subarray(7)); assert.deepEqual([...packets[0]], [0, 1, -.5, 0]);
  decoder.push(Buffer.alloc(4)); assert.equal(resets, 1);
  const invalid = Buffer.alloc(4); invalid.writeUInt32LE(3848); assert.throws(() => decoder.push(invalid), /Invalid/);
});

function serviceFixture(t) {
  let listed; const children = [], sends = [];
  const service = new ReplayCaptureService({ appRoot: path.resolve(__dirname, '..'), exec: (_file, _args, _options, callback) => { listed = callback; }, spawnProcess: () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() {} }); children.push(child); return child;
  } });
  // Unit tests remain independent of prepared native binaries and host platform.
  service.list = async () => { if (listed === 'defer') await new Promise(resolve => { listed = resolve; }); return { ok: true, sources: [{ kind: 'desktop', id: 'desktop', label: 'Desktop' }] }; };
  const owner = { id: 1, isDestroyed: () => false, send: (_channel, packet) => sends.push(packet) };
  t.after(() => service.stopAll());
  return { service, owner, children, sends, defer: () => { listed = 'defer'; }, release: () => listed() };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('native capture validates source identity, cancels pending starts, and isolates owners', async t => {
  const f = serviceFixture(t); assert.equal((await f.service.start(f.owner, { kind: 'application', id: '../command' })).ok, false);
  f.defer(); const pending = f.service.start(f.owner, { kind: 'desktop', id: 'desktop' }); await tick(); f.service.stopOwner(f.owner); f.release(); assert.equal((await pending).ok, false); assert.equal(f.children.length, 0);
  const started = f.service.start(f.owner, { kind: 'desktop', id: 'desktop' }); await tick();
  f.children[0].stderr.write('{"type":"ready","sampleRate":48000,"channels":2,"kind":"desktop","id":"desktop"}\n'); const ready = await started; assert.equal(ready.ok, true);
  f.service.stop({ id: 2 }, ready.id); assert.equal(f.service.sessions.size, 1); f.service.stopOwner(f.owner); assert.equal(f.service.sessions.size, 0);
});
test('a frozen renderer cannot accumulate unbounded native audio delivery', async t => {
  const f = serviceFixture(t), pending = f.service.start(f.owner, { kind: 'desktop', id: 'desktop' }); await tick(); const child = f.children[0];
  child.stderr.write('{"type":"ready","sampleRate":48000,"channels":2,"kind":"desktop","id":"desktop"}\n'); await pending;
  const bytes = Buffer.alloc(3844); bytes.writeUInt32LE(3840);
  for (let index = 0; index < 33; index++) child.stdout.write(bytes);
  assert.equal(f.sends.filter(packet => packet.type === 'pcm').length, 32); assert.equal(f.service.sessions.size, 0); assert.match(f.sends.at(-1).reason, /stalled/);
});

test('replay IPC blocks child frames and other windows; validated saves write only the reserved library file', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), handlers = new Map(), listeners = new Map(), calls = [];
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'freqx-replay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = { mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false };
  const context = vm.createContext({ mainWindow: { webContents: owner }, fs, validateReplayWav,
    assertTrustedIpcSender: event => { if (!event.senderFrame?.url?.startsWith('file:///app/')) throw new Error('Untrusted'); },
    stripUrlState: value => value, getRendererUrl: () => owner.mainFrame.url,
    replayCaptureService: Object.fromEntries(['list', 'start', 'stop', 'stopOwner', 'ack'].map(name => [name, () => calls.push(name)])),
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, getLibraryDirectory: () => directory,
    reserveLibraryDestination: async (root, filename) => { assert.equal(root, directory); const destinationPath = path.join(root, filename); return { destinationPath, handle: await fs.promises.open(destinationPath, 'wx') }; },
    toLibraryItem: file => ({ path: file, sizeBytes: fs.statSync(file).size }),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) }
  });
  vm.runInContext(source.slice(source.indexOf('  const referenceSender ='), source.indexOf('  const linkSender =')), context);
  vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('replay:sources'"), source.indexOf('  const catalog = new PlatformLibrary')), context);
  for (const event of [{ sender: owner, senderFrame: { url: owner.mainFrame.url } }, { sender: { mainFrame: owner.mainFrame }, senderFrame: owner.mainFrame }]) {
    for (const handler of handlers.values()) await assert.rejects(async () => handler(event, {}), /main app frame/);
    for (const handler of listeners.values()) handler(event, 'id', 1);
  }
  assert.equal(calls.length, 0);
  const event = { sender: owner, senderFrame: owner.mainFrame }, bytes = new Editor(clip()).encode();
  const saved = await handlers.get('replay:save')(event, { name: 'Synthetic clip', bytes });
  assert.equal(saved.ok, true); assert.equal(saved.imported[0].path, path.join(directory, 'Synthetic clip.wav'));
  assert.equal(saved.imported[0].sizeBytes, bytes.length);
  const invalid = await handlers.get('replay:save')(event, { name: 'Invalid', bytes: new Uint8Array(10) }); assert.equal(invalid.ok, false);
  assert.equal(fs.existsSync(path.join(directory, 'Invalid.wav')), false);
  const exported = await handlers.get('replay:export')(event, { name: 'Export', bytes }); assert.equal(exported.canceled, true);
});
