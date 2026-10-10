'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { PlatformLibrary } = require('../runtime/platform-library.cjs');
const example = { id: 'catalog-soundbuttonsworld-ff44289b-768b-490b-a997-8f29f1814c6f', soundId: 'fffa92b8-7899-4c8f-af61-31e4f7230fff', title: 'New sound', category: 'Creativity Soundboard', description: '', mimeType: 'audio/mpeg', sizeBytes: null, duration: null };
function fixture(request, extra = {}) {
  const fallback = { getCatalog: async () => ({ source: 'bundled', sounds: [{ id: 'fm-ping' }] }), ...extra.fallback };
  const client = { request, serialized: callback => callback(), restore: async () => {}, ...extra.client };
  return { client, library: new PlatformLibrary({ getClient: () => client, fallback, development: false, ...extra.options }) };
}

test('42k platform catalog loads one page, preserves opaque IDs and forwards nextCursor on demand', async () => {
  const calls = [];
  const { library } = fixture(async route => {
    calls.push(route);
    if (route === '/api/catalog/stats') return { totalSounds: 41448 };
    const query = new URL(route, 'https://api.freqx.app').searchParams;
    return { sounds: [{ ...example, ...(query.has('cursor') ? { id: '8a92d186-1c51-4435-8614-0f3f09cbb627' } : {}) }], nextCursor: query.has('cursor') ? null : 'next+page/=' };
  });
  const first = await library.getCatalog();
  assert.equal(first.sounds.length, 1);
  assert.equal(first.sounds[0].id, example.id);
  assert.equal(first.totalSounds, 41448);
  assert.equal(first.paginated, true);
  assert.equal(first.nextCursor, 'next+page/=');
  assert.deepEqual(calls, ['/api/sounds?limit=100', '/api/catalog/stats']);
  assert.equal(first.sounds[0].duration, 0);
  assert.equal(first.sounds[0].sizeBytes, 0);
  assert.ok(!('soundId' in first.sounds[0]));
  const next = await library.getCatalog({ cursor: first.nextCursor });
  assert.equal(next.nextCursor, null);
  assert.equal(next.sounds[0].id, '8a92d186-1c51-4435-8614-0f3f09cbb627');
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2], 'https://api.freqx.app').searchParams.get('cursor'), first.nextCursor);
});

test('server search and category filters survive pagination without leaking query parameters', async () => {
  const calls = [];
  const { library } = fixture(async route => {
    calls.push(route);
    return route === '/api/catalog/stats' ? { totalSounds: 42000 } : { sounds: [], nextCursor: null };
  });
  const result = await library.getCatalog({ search: '  bruh & scope=mine  ', category: 'Movies Soundboard', cursor: 'opaque+cursor' });
  assert.equal(result.source, 'remote');
  assert.equal(result.sounds.length, 0);
  assert.equal(result.totalSounds, 42000);
  const parameters = new URL(calls[0], 'https://api.freqx.app').searchParams;
  assert.equal(parameters.get('search'), 'bruh & scope=mine');
  assert.equal(parameters.get('category'), 'Movies Soundboard');
  assert.equal(parameters.get('cursor'), 'opaque+cursor');
  assert.equal(parameters.has('scope'), false);
});

test('starting an unfiltered catalog again refreshes the total without recounting every page', async () => {
  let count = 41448;
  const { library } = fixture(async route => route === '/api/catalog/stats' ? { totalSounds: count++ } : { sounds: [example], nextCursor: 'next' });
  assert.equal((await library.getCatalog()).totalSounds, 41448);
  assert.equal((await library.getCatalog({ search: 'bruh' })).totalSounds, 41448);
  assert.equal((await library.getCatalog()).totalSounds, 41449);
});

test('invalid renderer filters fail before any network or fallback access', async () => {
  const { library } = fixture(async () => assert.fail('Network called'));
  for (const input of [null, [], 'search', { search: {} }, { search: 'a'.repeat(201) }, { category: 'a'.repeat(65) }, { cursor: 'a'.repeat(257) }, { category: 'a\n' }, { url: 'https://example.com' }, { scope: 'mine' }]) {
    await assert.rejects(library.getCatalog(input), /Invalid library filters/);
  }
});

test('empty server search results remain empty and do not switch catalogs', async () => {
  const { library } = fixture(async route => route === '/api/catalog/stats' ? { totalSounds: 41448 } : { sounds: [], nextCursor: null });
  assert.deepEqual((await library.getCatalog({ search: 'missing-search' })).sounds, []);
  assert.equal(library.active, true);
});

test('unavailable or malformed stats do not hide working API sounds and can be retried', async () => {
  for (const stats of [null, { totalSounds: -1 }, { totalSounds: '41448' }]) {
    let attempts = 0;
    const { library } = fixture(async route => {
      if (route === '/api/catalog/stats') return ++attempts === 1 ? stats : { totalSounds: 41448 };
      return { sounds: [example], nextCursor: null };
    });
    assert.equal((await library.getCatalog()).totalSounds, null);
    const retried = await library.getCatalog();
    assert.equal(retried.totalSounds, 41448);
    assert.equal(retried.source, 'remote');
  }
});

test('first-page failures use fallback but continuation failures preserve API playback routing', async () => {
  const { library, client } = fixture(async route => route === '/api/catalog/stats' ? { totalSounds: 41448 } : { sounds: [example], nextCursor: 'next' });
  await library.getCatalog();
  client.request = async () => { throw new Error('offline'); };
  await assert.rejects(library.getCatalog({ cursor: 'next' }), /offline/);
  assert.equal(library.active, true);
  const fallback = await library.getCatalog();
  assert.equal(fallback.paginated, false);
  assert.equal(fallback.totalSounds, 1);
  assert.equal(library.active, false);
  // A remote card from an earlier page must never play an unrelated legacy fallback.
  await assert.rejects(library.preview(example.id), /offline/);
});

test('malformed catalog pages, unsafe sounds and repeated cursors fail safely', async () => {
  for (const result of [null, { sounds: [example], nextCursor: {} }, { sounds: [], nextCursor: 'next' }, { sounds: [example], nextCursor: 'a'.repeat(257) }, { sounds: [{ ...example, id: '../unsafe' }] }, { sounds: [example, example] }, { sounds: [{ ...example, mimeType: 'text/html' }] }]) {
    const { library } = fixture(async route => route === '/api/catalog/stats' ? { totalSounds: 42000 } : result);
    assert.equal((await library.getCatalog()).source, 'bundled');
  }
  const { library } = fixture(async route => route === '/api/catalog/stats' ? { totalSounds: 42000 } : { sounds: [example], nextCursor: 'same' });
  await assert.rejects(library.getCatalog({ cursor: 'same' }), /Invalid catalog page/);
});

test('platform preview and import use authorized bytes and UUID filenames for new catalog IDs', async () => {
  const bytes = Buffer.from('mp3-fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  let imported;
  const { library } = fixture(async (route, body, authenticated) => {
    requests.push({ route, authenticated });
    if (route.endsWith('/download')) return { downloadUrl: 'https://audio.freqx.app/sound.mp3', sizeBytes: bytes.length, sha256: digest };
    return { sound: example };
  }, {
    client: { restore: async () => { throw new Error('No credentials'); } },
    options: { download: async (url, limit, options) => {
      assert.equal(url, 'https://audio.freqx.app/sound.mp3');
      assert.equal(options.maxRedirects, 0);
      assert.ok(options.allowedHosts.includes('audio.freqx.app'));
      return bytes;
    } },
    fallback: { withBytes: async (sound, data, callback) => { imported = sound; assert.equal(data, bytes); return callback(sound); } }
  });
  const preview = await library.preview(example.id);
  assert.equal(preview.mimeType, 'audio/mpeg');
  assert.deepEqual(Buffer.from(preview.bytes), bytes);
  await library.withSound(example.id, sound => assert.equal(sound.id, example.id));
  assert.equal(imported.filename, example.soundId + '.mp3');
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.authenticated === false));
  assert.ok(requests.every(request => request.route.startsWith('/api/sounds/' + example.id)));
});

test('mismatched audio checksums and unsafe import filenames are rejected', async () => {
  for (const [sound, authorization, expected] of [
    [example, { downloadUrl: 'https://audio.freqx.app/sound.mp3', sizeBytes: null, sha256: '0'.repeat(64) }, /integrity/],
    [{ ...example, soundId: '../unsafe' }, {}, /metadata/],
    [example, { downloadUrl: 'https://audio.freqx.app/sound.mp3', sizeBytes: -1 }, /Invalid sound download/]
  ]) {
    const { library } = fixture(async route => route.endsWith('/download') ? authorization : { sound }, { options: { download: async () => Buffer.from('mp3') } });
    await assert.rejects(library.preview(example.id), expected);
    await assert.rejects(library.withSound(example.id, () => assert.fail('Import called')), expected);
  }
});

test('known fallback sounds can preview and import without calling the unavailable API', async () => {
  const { library } = fixture(async () => { throw new Error('offline'); }, {
    fallback: { getPreview: async id => ({ id }), withSound: async (id, callback) => callback({ id }) }
  });
  await library.getCatalog();
  assert.deepEqual(await library.preview('fm-ping'), { id: 'fm-ping' });
  assert.equal(await library.withSound('fm-ping', sound => sound.id), 'fm-ping');
});

test('packaged catalogs ignore the development-only bundled environment override', async () => {
  const previous = process.env.FREQX_LIBRARY_BUNDLED;
  process.env.FREQX_LIBRARY_BUNDLED = '1';
  try {
    const fallback = { getCatalog: async () => ({ source: 'bundled', sounds: [] }) };
    const getClient = () => ({ request: async route => route === '/api/catalog/stats' ? { totalSounds: 41448 } : { sounds: [{ id: 'existing-id', title: 'Existing', mimeType: 'audio/wav' }] } });
    const release = new PlatformLibrary({ getClient, fallback, development: false });
    assert.equal((await release.getCatalog()).source, 'remote');
    const development = new PlatformLibrary({ getClient, fallback, development: true });
    assert.equal((await development.getCatalog()).source, 'bundled');
    const { PublicLibrary } = require('../runtime/public-library.cjs');
    const appRoot = require('node:path').resolve(__dirname, '..');
    assert.equal((await new PublicLibrary({ appRoot, development: false }).readConfig()).mode, 'remote');
    assert.equal((await new PublicLibrary({ appRoot, development: true }).readConfig()).mode, 'bundled');
  } finally {
    if (previous === undefined) delete process.env.FREQX_LIBRARY_BUNDLED;
    else process.env.FREQX_LIBRARY_BUNDLED = previous;
  }
});
