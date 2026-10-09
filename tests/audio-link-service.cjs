'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AudioLinkService, validateNormalizedWav, localFileName } = require('../runtime/audio-link-service.cjs');

function wave() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
function deferred() {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-link-test-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const library = path.join(directory, 'library'), temporary = path.join(directory, 'tmp');
  await fs.mkdir(library);
  let count = 0;
  const service = new AudioLinkService({ download: async () => ({ bytes: Buffer.from('encoded'), filename: 'audio.mp3' }),
    decode: async () => wave(), tempRoot: temporary,
    reserve: async filename => { const destinationPath = path.join(library, `${count++}-${filename}`); return { destinationPath, handle: await fs.open(destinationPath, 'wx') }; },
    item: filename => ({ path: filename }), ...overrides });
  return { service, library, temporary };
}

test('normalized output has a fixed PCM format and rejects parser-supplied structures or trailing payloads', () => {
  assert.deepEqual(validateNormalizedWav(wave()), wave());
  for (const bytes of [Buffer.concat([wave(), Buffer.from('<script>')]), [], {}, Buffer.alloc(44), Buffer.from('MZ executable')]) assert.throws(() => validateNormalizedWav(bytes), /validation failed/);
  for (const [offset, value] of [[20, 3], [22, 8], [24, 96000], [28, 100], [34, 32], [40, 10]]) {
    const bytes = wave(); bytes.writeUInt32LE(value, offset); assert.throws(() => validateNormalizedWav(bytes), /validation failed/);
  }
  assert.equal(localFileName('../CON.mp3'), 'audio-CON.wav');
  assert.equal(localFileName('payload.html'), 'payload.wav');
});

test('link imports save only normalized WAV and clean the downloaded source after success or decode failure', async t => {
  let rejectDecode = false;
  const { service, library, temporary } = await fixture(t, { decode: async () => { if (rejectDecode) throw new Error('bad media'); return wave(); } });
  const first = await service.import('https://fixture.invalid/a', { owner: {} });
  assert.equal(first.imported.length, 1);
  assert.deepEqual(await fs.readFile(first.imported[0].path), wave());
  assert.deepEqual(await fs.readdir(temporary), []);
  rejectDecode = true;
  await assert.rejects(service.import('https://fixture.invalid/b', { owner: {} }), /bad media/);
  assert.equal((await fs.readdir(library)).length, 1);
  assert.deepEqual(await fs.readdir(temporary), []);
});

test('downloads serialize, duplicate UI submits fail, and owner cancellation skips a queued download', async t => {
  const gate = deferred(), started = [];
  const { service } = await fixture(t, { download: async url => { started.push(url); if (url.endsWith('/first')) await gate.promise; return { bytes: Buffer.from('encoded'), filename: 'audio.mp3' }; } });
  const firstOwner = {}, secondOwner = {};
  const first = service.import('https://fixture.invalid/first', { owner: firstOwner });
  const second = service.import('https://fixture.invalid/second', { owner: secondOwner });
  await assert.rejects(service.import('https://fixture.invalid/duplicate', { owner: firstOwner }), /already importing/);
  assert.equal(started.length, 1);
  service.cancelOwner(secondOwner);
  const canceled = assert.rejects(second, error => error.code === 'ABORT_ERR');
  gate.resolve();
  await first; await canceled;
  assert.deepEqual(started, ['https://fixture.invalid/first']);
  assert.equal(service.jobs.size, 0);
});

test('canceling during decode removes temporary input and never reserves a library item', async t => {
  const gate = deferred(), entered = deferred(); let reserved = false;
  const { service, temporary } = await fixture(t, { decode: async () => { entered.resolve(); await gate.promise; return wave(); }, reserve: async () => { reserved = true; throw new Error('should never reserve'); } });
  const owner = {};
  const operation = service.import('https://fixture.invalid/a', { owner });
  await entered.promise; service.cancelOwner(owner); gate.resolve();
  await assert.rejects(operation, error => error.code === 'ABORT_ERR');
  assert.equal(reserved, false);
  assert.deepEqual(await fs.readdir(temporary), []);
});

test('startup removes only owned staging directories left by a prior crash', async t => {
  const { service, temporary } = await fixture(t);
  await fs.mkdir(path.join(temporary, 'link-abandoned'), { recursive: true });
  await fs.writeFile(path.join(temporary, 'link-abandoned', 'source.audio'), 'untrusted bytes');
  await fs.mkdir(path.join(temporary, 'keep-directory'));
  await fs.writeFile(path.join(temporary, 'keep.txt'), 'preserve');
  await service.import('https://fixture.invalid/a', { owner: {} });
  assert.deepEqual((await fs.readdir(temporary)).sort(), ['keep-directory', 'keep.txt']);
  assert.equal(await fs.readFile(path.join(temporary, 'keep.txt'), 'utf8'), 'preserve');
});
