'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { PublicLibrary } = require('../runtime/public-library.cjs');
const appRoot = path.resolve(__dirname, '..');

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-public-library-'));
  try {
    await fs.mkdir(path.join(directory, 'runtime'));
    await fs.mkdir(path.join(directory, 'assets'));
    await fs.writeFile(path.join(directory, 'runtime/public-library.json'), JSON.stringify({ mode: 'bundled', catalogUrl: '', audioBaseUrl: '' }));
    await fs.cp(path.join(appRoot, 'assets/library'), path.join(directory, 'assets/library'), { recursive: true });
    const catalogPath = path.join(directory, 'assets/library/catalog.json');
    const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    const save = () => fs.writeFile(catalogPath, JSON.stringify(catalog));
    await run({ directory, catalogPath, catalog, save, service: new PublicLibrary({ appRoot: directory, tempRoot: path.join(directory, 'imports') }) });
  } finally {
    // The only recursive cleanup target is our own freshly allocated directory.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('freqx-public-library-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

test('bundled catalog provides six usable original WAV previews without leaking paths', async () => {
  await fixture(async ({ directory, service }) => {
    const catalog = await service.getCatalog();
    assert.equal(catalog.source, 'bundled');
    assert.equal(catalog.remoteConfigured, false);
    assert.equal(catalog.sounds.length, 6);
    for (const sound of catalog.sounds) {
      assert.equal(sound.source, 'Freqx originals');
      assert.equal(sound.waveform.length, 32);
      assert.ok(sound.duration < 2);
      assert.ok(!('filePath' in sound));
      assert.ok(!('sha256' in sound));
      const preview = await service.getPreview(sound.id);
      assert.equal(preview.mimeType, 'audio/wav');
      assert.ok(preview.bytes instanceof Uint8Array);
      assert.equal(preview.bytes.length, sound.sizeBytes);
      const imported = await service.getSound(sound.id);
      assert.equal(imported.filePath, path.join(directory, 'assets/library', `${sound.id}.wav`));
      assert.equal(imported.filename, `${sound.id}.wav`);
    }
  });
});

test('shipped public catalog loads remote sounds from the packaged catalog file', async () => {
  const library = new PublicLibrary({ appRoot });
  const catalog = await library.getCatalog();
  assert.equal(catalog.source, 'remote');
  assert.equal(catalog.sourceLabel, 'Public library');
  assert.equal(catalog.remoteConfigured, true);
  assert.ok(catalog.sounds.length > 1000);
  const first = catalog.sounds[0];
  assert.ok(first.title.length > 0);
  assert.equal(first.format, 'MP3');
  assert.equal(first.category, 'Anime');
  assert.ok(!('filePath' in first));
  assert.ok(!('sha256' in first));
});

test('renderer metadata cannot mutate cached catalog state', async () => {
  await fixture(async ({ service }) => {
    const first = await service.getCatalog();
    first.sounds[0].title = 'Changed';
    first.sounds[0].tags[0] = 'Changed';
    first.sounds[0].waveform[0] = 0.99;
    const second = await service.getCatalog();
    assert.equal(second.sounds[0].title, 'FM ping');
    assert.equal(second.sounds[0].tags[0], 'bright');
    assert.notEqual(second.sounds[0].waveform[0], 0.99);
  });
});

test('preview and import reject path traversal, URLs, wrong types, and unknown IDs', async () => {
  const library = new PublicLibrary({ appRoot });
  for (const id of ['../fm-ping', '..\\fm-ping', 'C:\\private.wav', '/etc/passwd', 'https://example.com/a.wav', 'file:///C:/private.wav', 'fm-ping.wav', 'unknown-sound', '__proto__', '', null, {}, ['fm-ping'], 1]) {
    await assert.rejects(library.getPreview(id), /Unknown library sound/);
    await assert.rejects(library.getSound(id), /Unknown library sound/);
  }
});

test('catalog paths are ignored; only strictly validated IDs derive filenames', async () => {
  await fixture(async ({ catalog, save, service, directory }) => {
    catalog.sounds[0].filePath = '../../outside.wav';
    catalog.sounds[0].filename = '../../outside.wav';
    catalog.sounds[0].url = 'https://example.com/outside.wav';
    await save();
    const sound = await service.getSound('fm-ping');
    assert.equal(sound.filePath, path.join(directory, 'assets/library/fm-ping.wav'));
    assert.ok(!('url' in sound));
  });
});

test('non-https and disallowed remote endpoints are ignored and bundled is used', async () => {
  await fixture(async ({ directory, service }) => {
    await fs.writeFile(path.join(directory, 'runtime/public-library.json'), JSON.stringify({ mode: 'remote', catalogUrl: 'http://example.com/catalog.json', audioBaseUrl: 'ftp://example.com' }));
    const catalog = await service.getCatalog();
    assert.equal(catalog.source, 'bundled');
    assert.equal(catalog.remoteConfigured, false);
    assert.equal(catalog.sounds.length, 6);
  });
});

function fakeResponse(buffer, contentType) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-length') return String(buffer.length);
        if (key === 'content-type') return contentType;
        return null;
      }
    },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
}

test('validated remote catalog and audio are fetched without leaking paths or URLs', async () => {
  await fixture(async ({ directory, service }) => {
    await fs.writeFile(path.join(directory, 'runtime/public-library.json'), JSON.stringify({
      mode: 'remote',
      catalogUrl: 'https://audio.freqx.app/sound1.json',
      audioBaseUrl: 'https://audio.freqx.app'
    }));
    const remoteCatalog = [{
      title: 'Test-sound',
      category: 'Test',
      storageKey: 'soundboard/test-sound.mp3',
      audioUrl: 'https://audio.freqx.app/soundboard/test-sound.mp3'
    }];
    service.download = async (url) => {
      const href = String(url);
      if (href.endsWith('/sound1.json')) return Buffer.from(JSON.stringify(remoteCatalog));
      if (href.endsWith('/soundboard/test-sound.mp3')) return Buffer.from('fake-mp3-bytes');
      throw new Error(`Unexpected URL ${href}`);
    };
    try {
      const catalog = await service.getCatalog();
      assert.equal(catalog.source, 'remote');
      assert.equal(catalog.sourceLabel, 'Public library');
      assert.equal(catalog.remoteConfigured, true);
      assert.equal(catalog.sounds.length, 1);
      assert.equal(catalog.sounds[0].title, 'Test sound');
      assert.equal(catalog.sounds[0].format, 'MP3');
      assert.equal(catalog.sounds[0].duration, 0);
      const preview = await service.getPreview('test-sound');
      assert.equal(preview.mimeType, 'audio/mpeg');
      assert.equal(preview.bytes.length, 14);
      const imported = await service.getSound('test-sound');
      assert.ok(!('url' in imported));
      assert.equal(imported.filename, 'test-sound.mp3');
      assert.ok(!imported.filePath.startsWith(path.join(directory, 'assets')));
      await fs.access(imported.filePath);
    } finally {
      await service.prepareImports();
      for (const entry of await fs.readdir(service.resolvedTempRoot)) {
        await service.removeTempDirectory(path.join(service.resolvedTempRoot, entry));
      }
    }
  });
});

test('remote failures fall back to the packaged catalog and audio', async () => {
  await fixture(async ({ directory, service }) => {
    await fs.writeFile(path.join(directory, 'runtime/public-library.json'), JSON.stringify({
      mode: 'remote',
      catalogUrl: 'https://audio.freqx.app/sound1.json',
      audioBaseUrl: 'https://audio.freqx.app'
    }));
    service.download = async () => { throw new Error('offline'); };
    try {
      const catalog = await service.getCatalog();
      assert.equal(catalog.source, 'bundled');
      assert.equal(catalog.sounds.length, 6);
      const imported = await service.getSound('fm-ping');
      assert.equal(imported.filePath, path.join(directory, 'assets/library/fm-ping.wav'));
    } finally {
      // No temporary files are created by bundled fallback.
    }
  });
});

test('malformed and oversized catalogs fail safely and failed reads can be retried', async () => {
  await fixture(async ({ catalogPath, save, service }) => {
    await fs.writeFile(catalogPath, '{');
    await assert.rejects(service.getCatalog(), /Invalid library catalog JSON/);
    await fs.writeFile(catalogPath, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    await assert.rejects(service.getCatalog(), /size limit/);
    await save();
    assert.equal((await service.getCatalog()).sounds.length, 6);
  });
});

test('duplicate IDs and unsafe IDs are rejected before asset reads', async () => {
  await fixture(async ({ catalog, save, service }) => {
    catalog.sounds[1].id = catalog.sounds[0].id;
    await save();
    await assert.rejects(service.getCatalog(), /Invalid or duplicate library sound ID/);
    catalog.sounds[1].id = '../private';
    await save();
    await assert.rejects(service.getCatalog(), /Invalid or duplicate library sound ID/);
  });
});

test('tampered and oversized audio is rejected for both preview and import', async () => {
  await fixture(async ({ directory, service }) => {
    const asset = path.join(directory, 'assets/library/fm-ping.wav');
    const bytes = await fs.readFile(asset);
    bytes[100] ^= 1;
    await fs.writeFile(asset, bytes);
    await assert.rejects(service.getPreview('fm-ping'), /integrity check/);
    await assert.rejects(service.getSound('fm-ping'), /integrity check/);
    await fs.writeFile(asset, Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(service.getPreview('fm-ping'), /size limit/);
  });
});

test('invalid WAV cannot pass format validation even with a matching manifest checksum', async () => {
  await fixture(async ({ directory, catalog, save, service }) => {
    const asset = path.join(directory, 'assets/library/fm-ping.wav');
    const bytes = await fs.readFile(asset);
    bytes.writeUInt16LE(99, 20);
    catalog.sounds[0].sha256 = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(asset, bytes);
    await save();
    await assert.rejects(service.getPreview('fm-ping'), /Unsupported library audio format/);
  });
});

test('missing assets report failure without corrupting other previews', async () => {
  await fixture(async ({ directory, service }) => {
    await fs.unlink(path.join(directory, 'assets/library/fm-ping.wav'));
    await assert.rejects(service.getPreview('fm-ping'), /ENOENT/);
    assert.ok((await service.getPreview('soft-click')).bytes.length > 44);
  });
});
