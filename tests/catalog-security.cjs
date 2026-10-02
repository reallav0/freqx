'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { valid, MAX_LENGTH } = require('../runtime/catalog-id.js');
const { PublicLibrary } = require('../runtime/public-library.cjs');

test('main and browser use the same catalog ID rule, preserving long legacy IDs', async () => {
  const browser = {};
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../runtime/catalog-id.js'), 'utf8'), browser);
  for (const id of ['a'.repeat(49), 'a'.repeat(MAX_LENGTH), '8a92d186-1c51-4435-8614-0f3f09cbb627', 'fm-ping']) {
    assert.equal(valid(id), true);
    assert.equal(browser.FreqxCatalogId.valid(id), true);
  }
  for (const id of ['a'.repeat(MAX_LENGTH + 1), '../x', 'a/b', '-bad', 'bad-', '', null]) {
    assert.equal(valid(id), false);
    assert.equal(browser.FreqxCatalogId.valid(id), false);
  }
});

test('temporary imports clean up success, exceptions, cancellation and interrupted work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-import-test-'));
  const service = new PublicLibrary({ appRoot: path.resolve(__dirname, '..'), tempRoot: root });
  const stale = path.join(root, 'import-abandoned');
  await fs.mkdir(stale);
  await fs.writeFile(path.join(stale, 'partial.mp3'), 'partial');
  await fs.writeFile(path.join(root, 'unrelated.txt'), 'preserve');
  service.readSound = async (id, options = {}) => {
    options.signal?.throwIfAborted();
    return { sound: { id, filename: `${id}.mp3`, tags: [], waveform: [] }, bytes: Buffer.from('audio'), filePath: null };
  };
  try {
    await service.withSound('a'.repeat(100), async result => { await fs.access(result.filePath); });
    assert.deepEqual(await fs.readdir(root), ['unrelated.txt']);
    await assert.rejects(service.withSound('test', () => { throw new Error('import failed'); }), /import failed/);
    assert.deepEqual(await fs.readdir(root), ['unrelated.txt']);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.getSound('test', { signal: controller.signal }));
    assert.deepEqual(await fs.readdir(root), ['unrelated.txt']);
    await assert.rejects(service.removeTempDirectory(path.dirname(root)), /Unsafe/);
    const imported = await service.getSound('test');
    await service.releaseSound(imported);
    await service.releaseSound(imported);
    assert.deepEqual(await fs.readdir(root), ['unrelated.txt']);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('freqx-import-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
