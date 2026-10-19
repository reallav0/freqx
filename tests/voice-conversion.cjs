'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { VoiceConversionService, requestJson, voicesFromInfo, voicesFromModern, BLOCK_SIZE } = require('../runtime/voice-conversion.cjs');
const owner = () => ({ isDestroyed: () => false });
const settings = { port: 18000, voiceId: '0', pitch: 0 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, modern = false) {
  const calls = [], client = owner();
  const slot = { slot_index: 0, slotIndex: 0, name: 'Fixture voice', voice_changer_type: 'RVC', voiceChangerType: 'RVC', model_file: 'voice.onnx', modelFile: 'voice.onnx', pitch_shift: 0 };
  let info = { status: 'OK', modelSlots: [slot], modelSlotIndex: 0, serverAudioStated: 0, inputSampleRate: 48000, outputSampleRate: 48000, passThrough: false, recordIO: 0, tran: 0 };
  let configuration = { current_slot_index: 0, voice_changer_input_mode: 'client', input_sample_rate: 48000, output_sample_rate: 48000, pass_through: false, recording_started: false };
  const request = async (port, endpoint, options = {}) => {
    calls.push({ port, endpoint, options });
    if (endpoint === '/api/slot-manager/slots') {
      if (!modern) throw Object.assign(new Error('Not found'), { statusCode: 404 });
      return [slot];
    }
    if (endpoint === '/info') return info;
    if (endpoint === '/update_settings') { const { key, val } = options.fields; info = { ...info, [key]: key === 'passThrough' ? val === 'true' : Number(val) }; return info; }
    if (endpoint === '/api/voice-changer-manager/information') return { local_voice_changer_interface_active: false };
    if (endpoint === '/api/configuration-manager/configuration') { if (options.method === 'PUT') configuration = options.json; return configuration; }
    if (endpoint === '/api/slot-manager/slots/0') { if (options.method === 'PUT') Object.assign(slot, options.json); return slot; }
    if (endpoint === '/test') return { timestamp: options.json.timestamp, changedVoiceBase64: Buffer.from(options.json.buffer, 'base64').toString('base64') };
    if (endpoint === '/api/voice-changer/convert_chunk') {
      const output = Buffer.alloc(BLOCK_SIZE * 4); for (let i = 0; i < BLOCK_SIZE; i++) output.writeFloatLE(0.25, i * 4); return output;
    }
    throw new Error('Unexpected fixture request: ' + endpoint);
  };
  const service = new VoiceConversionService({ request }); t.after(() => service.stopAll());
  return { service, client, calls, slot, request, begin: options => service.start(client, { ...settings, ...options }), frame: (id, sequence = 1, samples = new Float32Array(BLOCK_SIZE).fill(0.25)) => service.frame(client, { id, sequence, samples }) };
}

test('voice conversion is idle by default and only lists installed RVC models', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.service.list({ port: 18000 }), { ok: true, voices: [{ id: '0', name: 'Fixture voice' }] });
  const slots = [f.slot, { ...f.slot, voiceChangerType: 'Beatrice', voice_changer_type: 'Beatrice_v2', slotIndex: 1, slot_index: 1 }, { ...f.slot, slotIndex: 2, slot_index: 2, modelFile: '', model_file: '' }];
  assert.equal(voicesFromInfo({ status: 'OK', modelSlots: slots }).length, 1);
  assert.equal(voicesFromModern(slots).length, 1);
  assert.throws(() => voicesFromInfo({ modelSlots: [] }), /incompatible/);
  assert.throws(() => voicesFromModern({ slots: [] }), /compatible/);
});

test('invalid ports, remote addresses, model IDs and pitch never send requests', async t => {
  const f = fixture(t);
  for (const port of [0, 80, 65536, '18000', 'http://example.com', null]) assert.equal((await f.service.list({ port })).ok, false);
  for (const options of [{ voiceId: '../voice' }, { pitch: 13 }, { pitch: 0.5 }, { port: '18000' }]) assert.equal((await f.begin(options)).ok, false);
  assert.equal(f.calls.length, 0);
});

for (const modern of [false, true]) {
  test(`${modern ? 'modern' : 'legacy'} engine confirms converted-only 48 kHz audio and streams bounded mono frames`, async t => {
    const f = fixture(t, modern), started = await f.begin({ pitch: 3 });
    assert.equal(started.ok, true); assert.equal(started.blockSize, BLOCK_SIZE);
    const output = await f.frame(started.id);
    assert.equal(output.ok, true); assert.equal(output.samples.length, BLOCK_SIZE);
    assert.ok(Math.abs(output.samples[0] - 0.25) < 0.001);
    const frameRequest = f.calls.at(-1);
    if (modern) {
      assert.equal(frameRequest.options.binary, true); assert.match(frameRequest.options.headers['Content-Type'], /multipart\/form-data/);
      assert.equal(frameRequest.options.headers['x-timestamp'], '1');
    } else assert.equal(Buffer.from(frameRequest.options.json.buffer, 'base64').length, BLOCK_SIZE * 2);
    assert.ok(f.calls.every(call => call.port === 18000));
  });
}

test('the engine cannot silently retain passthrough, recording or a different sample rate', async t => {
  const f = fixture(t); f.service.request = async (...args) => {
    const response = await f.request(...args); return args[1] === '/info' && f.calls.filter(call => call.endpoint === '/info').length > 1 ? { ...response, passThrough: true } : response;
  };
  assert.equal((await f.begin()).ok, false); assert.equal(f.service.session, null);
});

test('modern model switching discards bounded startup buffers before admitting microphone frames', async t => {
  const f = fixture(t, true); let attempts = 0;
  f.service.request = async (...args) => {
    if (args[1] === '/api/voice-changer/convert_chunk' && ++attempts < 3) return Buffer.alloc((BLOCK_SIZE - 172) * 4);
    return f.request(...args);
  };
  const started = await f.begin(); assert.equal(started.ok, true); assert.equal(attempts, 3);
  assert.equal((await f.frame(started.id)).ok, true);
  f.service.request = async () => Buffer.alloc((BLOCK_SIZE - 172) * 4);
  assert.equal((await f.frame(started.id, 2)).ok, false, 'Real microphone output cannot be short');
  assert.equal(f.service.session, null);
});

test('modern warmup rejects persistently short, malformed, or non-finite output', async t => {
  const invalid = Buffer.alloc(BLOCK_SIZE * 4); invalid.writeFloatLE(NaN);
  for (const bytes of [Buffer.alloc(4), Buffer.alloc(3), invalid]) {
    const f = fixture(t, true); let attempts = 0;
    f.service.request = async (...args) => args[1] === '/api/voice-changer/convert_chunk' ? (++attempts, bytes) : f.request(...args);
    assert.equal((await f.begin()).ok, false); assert.equal(f.service.session, null); assert.ok(attempts <= 3);
  }
});

test('cancellation during model startup never creates a late session', async t => {
  const f = fixture(t); let release;
  f.service.request = async (...args) => { if (args[1] === '/info') await new Promise(resolve => { release = resolve; }); return f.request(...args); };
  const pending = f.begin(); await tick(); f.service.stopOwner(f.client); release();
  assert.equal((await pending).ok, false); assert.equal(f.service.session, null);
});

test('foreign owners cannot stream or stop another microphone session', async t => {
  const f = fixture(t), started = await f.begin(), foreign = owner();
  assert.equal((await f.service.frame(foreign, { id: started.id, sequence: 1, samples: new Float32Array(BLOCK_SIZE) })).ok, false);
  f.service.stop(foreign, started.id); assert.equal(f.service.session.id, started.id);
  assert.equal((await f.frame(started.id)).ok, true);
});

test('duplicate or concurrent frames abort the session rather than growing an input queue', async t => {
  const f = fixture(t); let release;
  f.service.request = (...args) => args[1] === '/test' ? new Promise(resolve => { release = resolve; }) : f.request(...args);
  const started = await f.begin(), pending = f.frame(started.id); await tick();
  assert.equal((await f.frame(started.id, 2)).ok, false); assert.equal(f.service.session, null);
  release({ timestamp: 1, changedVoiceBase64: Buffer.alloc(BLOCK_SIZE * 2).toString('base64') });
  assert.equal((await pending).ok, false);
});

test('invalid samples and non-finite converted audio mute and close conversion', async t => {
  for (const modern of [false, true]) {
    const f = fixture(t, modern), started = await f.begin();
    const samples = new Float32Array(BLOCK_SIZE); samples[10] = NaN;
    assert.equal((await f.frame(started.id, 1, samples)).ok, false); assert.equal(f.service.session, null);
  }
  const f = fixture(t, true), started = await f.begin();
  f.service.request = async () => { const bytes = Buffer.alloc(BLOCK_SIZE * 4); bytes.writeFloatLE(NaN); return bytes; };
  assert.equal((await f.frame(started.id)).ok, false); assert.equal(f.service.session, null);
});

test('legacy warmup cannot silently emit invalid buffers indefinitely', async t => {
  const f = fixture(t), started = await f.begin();
  f.service.request = async (_port, _path, options) => ({ timestamp: options.json.timestamp, changedVoiceBase64: Buffer.alloc(2).toString('base64') });
  for (let sequence = 1; sequence <= 8; sequence++) assert.equal((await f.frame(started.id, sequence)).ok, true);
  assert.equal((await f.frame(started.id, 9)).ok, false); assert.equal(f.service.session, null);
});

test('transport rejects redirects, oversized responses, and stalled local requests', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://example.com' }); response.end(); }
    else if (request.url === '/large') response.end('x'.repeat(512));
    else if (request.url !== '/stall') response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  assert.deepEqual(await requestJson(port, '/good'), { ok: true });
  await assert.rejects(requestJson(port, '/redirect'), /incompatible/);
  await assert.rejects(requestJson(port, '/large', { maxBytes: 100 }), /limit/);
  await assert.rejects(requestJson(port, '/stall', { timeoutMs: 30 }), /too long/);
});

test('voice conversion IPC blocks child frames and other windows before audio or setup requests', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handlers = new Map(), listeners = new Map(), calls = [];
  const client = { mainFrame: { url: 'file:///app/index.html' } };
  const context = vm.createContext({ mainWindow: { webContents: client },
    assertTrustedIpcSender: event => { if (!event.senderFrame?.url?.startsWith('file:///app/')) throw new Error('untrusted'); },
    stripUrlState: value => value, getRendererUrl: () => 'file:///app/index.html', validVoiceEnginePort: () => true,
    voiceConversionService: Object.fromEntries(['list', 'start', 'frame', 'stop', 'stopOwner'].map(name => [name, () => calls.push(name)])),
    shell: { openExternal: async url => calls.push(url) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
  });
  vm.runInContext(source.slice(source.indexOf('function assertVoiceConversionSender('), source.indexOf('function assertAutoPttSender(')), context);
  vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('voice-conversion:list'"), source.indexOf("  ipcMain.handle('audio:import-link'")), context);
  for (const event of [{ sender: client, senderFrame: { url: client.mainFrame.url } }, { sender: { mainFrame: client.mainFrame }, senderFrame: client.mainFrame }]) {
    for (const handler of handlers.values()) await assert.rejects(async () => handler(event, { port: 18000 }), /Blocked/);
    for (const handler of listeners.values()) handler(event);
  }
  assert.equal(calls.length, 0);
  for (const handler of handlers.values()) await handler({ sender: client, senderFrame: client.mainFrame }, { port: 18000 });
  assert.equal(calls.length, 5);
});
