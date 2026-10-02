'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlatformLibrary } = require('../runtime/platform-library.cjs');
test('platform catalog preserves IDs and pagination while keeping its original fallback', async () => {
  const previous = process.env.FREQX_LIBRARY_BUNDLED; delete process.env.FREQX_LIBRARY_BUNDLED;
  const fallback = { getCatalog: async () => ({ source: 'bundled', sounds: [{ id: 'fm-ping' }] }) };
  let calls = 0;
  const client = { request: async route => {
    calls++; assert.ok(route.startsWith('/api/sounds?limit=100'));
    return calls === 1 ? { sounds: [{ id: 'long-existing-id', title: 'Existing sound', mimeType: 'audio/mpeg' }], nextCursor: 'cursor' }
      : { sounds: [{ id: '8a92d186-1c51-4435-8614-0f3f09cbb627', title: 'New sound', mimeType: 'audio/wav' }], nextCursor: null };
  } };
  try {
    const library = new PlatformLibrary({ getClient: () => client, fallback });
    const catalog = await library.getCatalog(); assert.equal(catalog.sounds.length, 2); assert.equal(catalog.sounds[0].id, 'long-existing-id'); assert.equal(library.active, true);
    client.request = async () => { throw new Error('offline'); };
    assert.equal((await library.getCatalog()).source, 'bundled'); assert.equal(library.active, false);
    client.request = async () => ({ sounds: [{ id: '../unsafe', title: 'Unsafe', mimeType: 'audio/mpeg' }] });
    assert.equal((await library.getCatalog()).source, 'bundled');
  } finally { if (previous === undefined) delete process.env.FREQX_LIBRARY_BUNDLED; else process.env.FREQX_LIBRARY_BUNDLED = previous; }
});
