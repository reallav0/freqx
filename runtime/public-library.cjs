'use strict';

// Read-only public library. It ships a bundled catalog/audio fallback and can
// also load a validated public R2 catalog plus per-sound audio. The renderer
// receives metadata and bytes only; never filesystem paths, URLs, or
// credentials. Remote endpoints are HTTPS-only and host-allowlisted.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { valid: validId } = require('./catalog-id.js');
const { downloadBytes, parseRemoteUrl } = require('./remote-download.cjs');

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_SOUND_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_SOUND_BYTES = 24 * 1024 * 1024;

const MIME_BY_EXT = Object.freeze({
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac'
});

function fail(message) {
  const error = new Error(message);
  error.code = 'PUBLIC_LIBRARY_UNAVAILABLE';
  throw error;
}

function requireText(value, limit, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`Invalid library ${field}.`);
  }
  return value;
}

function humanizeTitle(value) {
  return String(value == null ? '' : value)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromId(id) {
  return humanizeTitle(id).replace(/\b\w/g, character => character.toUpperCase());
}

function validRemoteUrl(value) {
  try { return parseRemoteUrl(value).href; } catch { return ''; }
}

function basename(key) {
  return String(key == null ? '' : key).split('/').pop() || '';
}

function deriveRemoteId(entry) {
  const base = basename(entry.storageKey);
  const slug = base
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (validId(slug)) return slug;
  const seed = String(entry.audioUrl || entry.storageKey || entry.title || '');
  return `sound-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function deriveRemoteFilename(entry, id) {
  const candidate = basename(entry.storageKey) || basename(entry.audioUrl);
  if (candidate && candidate.length <= 220 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(candidate)) return candidate;
  return `${id}.mp3`;
}

function publicRecord(sound) {
  return {
    id: sound.id,
    title: sound.title,
    category: sound.category,
    tags: [...sound.tags],
    duration: sound.duration,
    sizeBytes: sound.sizeBytes,
    description: sound.description,
    source: sound.source,
    format: sound.format,
    waveform: [...sound.waveform]
  };
}

async function readBounded(filePath, limit) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) fail('Library asset exceeds its size limit or is not a file.');
  const buffer = await fs.readFile(filePath);
  if (!buffer.length || buffer.length > limit || buffer.length !== stat.size) fail('Library asset changed while being read.');
  return buffer;
}

function parseJson(buffer, label) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { fail(`Invalid library ${label} JSON.`); }
}

class PublicLibrary {
  constructor({ appRoot, download = downloadBytes, tempRoot } = {}) {
    if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) fail('Library requires an absolute application root.');
    this.appRoot = path.resolve(appRoot);
    this.assetRoot = path.join(this.appRoot, 'assets', 'library');
    this.catalogPromise = null;
    this.config = null;
    this.download = download;
    this.tempRoot = tempRoot || path.join(os.tmpdir(), `freqx-imports-${createHash('sha256').update(this.appRoot).digest('hex').slice(0, 16)}`);
    this.tempReady = null;
    this.temporarySounds = new WeakMap();
  }

  async readConfig() {
    const config = parseJson(await readBounded(path.join(this.appRoot, 'runtime', 'public-library.json'), 4096), 'configuration');
    const bundled = config?.mode === 'bundled' || process.env.FREQX_LIBRARY_BUNDLED === '1';
    const catalogFile = (typeof config?.catalogFile === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.catalogFile))
      ? config.catalogFile
      : 'sound1.json';
    return {
      mode: bundled ? 'bundled' : 'remote',
      catalogFile,
      catalogUrl: validRemoteUrl(config?.catalogUrl),
      audioBaseUrl: validRemoteUrl(config?.audioBaseUrl)
    };
  }

  async loadCatalog() {
    if (!this.catalogPromise) {
      this.catalogPromise = this.loadCatalogInternal().catch(error => {
        this.catalogPromise = null;
        throw error;
      });
    }
    return this.catalogPromise;
  }

  async loadCatalogInternal() {
    this.config = await this.readConfig();
    if (this.config.mode !== 'bundled') {
      if (this.config.catalogUrl) {
        try {
          const byId = await this.readRemoteCatalog(this.config.catalogUrl);
          return { byId, source: 'remote', sourceLabel: 'Public library' };
        } catch {
          // Fall through to the local public catalog or the bundled originals.
        }
      }
      try {
        const byId = await this.readLocalPublicCatalog(this.config.catalogFile);
        return { byId, source: 'remote', sourceLabel: 'Public library' };
      } catch {
        // Fall through to the packaged originals.
      }
    }
    const byId = await this.readBundledCatalog();
    return { byId, source: 'bundled', sourceLabel: 'Freqx originals' };
  }

  normalizeCatalog(catalog, { remote = false } = {}) {
    const entries = Array.isArray(catalog)
      ? catalog
      : (catalog && catalog.version === 1 && Array.isArray(catalog.sounds) ? catalog.sounds : null);
    if (!entries || entries.length > 5000) fail('Invalid library catalog.');

    const byId = new Map();
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') fail('Invalid library catalog.');

      const id = remote ? deriveRemoteId(raw) : raw.id;
      if (!validId(id) || byId.has(id)) fail('Invalid or duplicate library sound ID.');

      const rawTitle = (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim() : titleFromId(id);
      const title = requireText(humanizeTitle(rawTitle), 120, 'title');
      const category = requireText(raw.category || 'Uncategorized', 48, 'category');
      const description = typeof raw.description === 'string' ? requireText(raw.description, 300, 'description') : '';
      const source = requireText(raw.source || (remote ? 'Public library' : 'Freqx originals'), 80, 'source');

      let tags = [];
      if (Array.isArray(raw.tags)) {
        if (raw.tags.length > 8) fail('Invalid library tags.');
        tags = raw.tags.map(tag => requireText(tag, 40, 'tag'));
      }

      let duration = 0;
      let sizeBytes = 0;
      let sha256 = null;
      let waveform = [];
      if (remote) {
        if (Number.isFinite(raw.duration) && raw.duration > 0 && raw.duration <= 300) duration = raw.duration;
        if (Number.isInteger(raw.sizeBytes) && raw.sizeBytes > 0 && raw.sizeBytes <= MAX_REMOTE_SOUND_BYTES) sizeBytes = raw.sizeBytes;
        if (typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256)) sha256 = raw.sha256;
        if (Array.isArray(raw.waveform) && raw.waveform.length === 32 && raw.waveform.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
          waveform = [...raw.waveform];
        }
      } else {
        if (!Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 60) fail('Invalid library duration.');
        if (!Number.isInteger(raw.sizeBytes) || raw.sizeBytes < 1 || raw.sizeBytes > MAX_SOUND_BYTES) fail('Invalid library sound size.');
        if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) fail('Invalid library sound checksum.');
        if (!Array.isArray(raw.waveform) || raw.waveform.length !== 32 || raw.waveform.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
          fail('Invalid library waveform.');
        }
        duration = raw.duration;
        sizeBytes = raw.sizeBytes;
        sha256 = raw.sha256;
        waveform = [...raw.waveform];
      }

      const filename = remote ? deriveRemoteFilename(raw, id) : `${id}.wav`;
      const audioUrl = remote ? validRemoteUrl(raw.audioUrl) : '';
      if (remote && !audioUrl) fail('Invalid library sound URL.');
      const format = (path.extname(filename).slice(1) || 'audio').toUpperCase();

      byId.set(id, Object.freeze({
        id,
        title,
        category,
        description,
        source,
        tags,
        duration,
        sizeBytes,
        sha256,
        waveform,
        filename,
        audioUrl,
        format
      }));
    }
    return byId;
  }

  async readRemoteCatalog(url) {
    const bytes = await this.download(url, MAX_CATALOG_BYTES);
    return this.normalizeCatalog(parseJson(bytes, 'catalog'), { remote: true });
  }

  async readLocalPublicCatalog(fileName) {
    const bytes = await readBounded(path.join(this.appRoot, 'runtime', fileName), MAX_CATALOG_BYTES);
    return this.normalizeCatalog(parseJson(bytes, 'catalog'), { remote: true });
  }

  async readBundledCatalog() {
    const catalog = parseJson(await readBounded(path.join(this.assetRoot, 'catalog.json'), MAX_CATALOG_BYTES), 'catalog');
    return this.normalizeCatalog(catalog, { remote: false });
  }

  async getCatalog() {
    const { byId, source, sourceLabel } = await this.loadCatalog();
    return {
      source,
      sourceLabel,
      remoteConfigured: source === 'remote',
      sounds: [...byId.values()].map(publicRecord)
    };
  }

  async readSound(id, { signal } = {}) {
    signal?.throwIfAborted();
    if (!validId(id)) fail('Unknown library sound.');
    const { byId } = await this.loadCatalog();
    const sound = byId.get(id);
    if (!sound) fail('Unknown library sound.');

    if (sound.audioUrl) {
      const bytes = await this.download(sound.audioUrl, MAX_REMOTE_SOUND_BYTES, { signal });
      if ((sound.sizeBytes && bytes.length !== sound.sizeBytes)
          || (sound.sha256 && createHash('sha256').update(bytes).digest('hex') !== sound.sha256)) {
        fail('Library asset failed its integrity check.');
      }
      return { sound, bytes };
    }

    const filename = `${sound.id}.wav`;
    const filePath = path.join(this.assetRoot, filename);
    const [realRoot, realFile] = await Promise.all([fs.realpath(this.assetRoot), fs.realpath(filePath)]);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.') {
      fail('Library asset is outside its directory.');
    }
    const bytes = await readBounded(filePath, MAX_SOUND_BYTES);
    if (bytes.length !== sound.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== sound.sha256) {
      fail('Library asset failed its integrity check.');
    }
    if (bytes.length < 46 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
        bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.toString('ascii', 36, 40) !== 'data' ||
        bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 ||
        bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 48000 || bytes.readUInt32LE(28) !== 96000 ||
        bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.readUInt32LE(40) !== bytes.length - 44 ||
        (bytes.length - 44) % 2 || Math.abs((bytes.length - 44) / 96000 - sound.duration) > 1 / 48000) {
      fail('Unsupported library audio format.');
    }
    return { sound, filename, filePath, bytes };
  }

  async getPreview(id, options) {
    const { sound, bytes } = await this.readSound(id, options);
    const extension = path.extname(sound.filename).toLowerCase();
    return {
      id: sound.id,
      mimeType: MIME_BY_EXT[extension] || 'audio/mpeg',
      bytes: Uint8Array.from(bytes)
    };
  }

  async prepareImports() {
    if (!this.tempReady) this.tempReady = (async () => {
      const root = typeof this.tempRoot === 'function' ? this.tempRoot() : this.tempRoot;
      if (!path.isAbsolute(root)) fail('Invalid temporary import directory.');
      this.resolvedTempRoot = path.resolve(root);
      await fs.mkdir(this.resolvedTempRoot, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.resolvedTempRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Unsafe temporary import directory.');
      // The application holds a single-instance lock. Sweep only our own
      // direct temporary children before this instance creates new imports.
      for (const entry of await fs.readdir(this.resolvedTempRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^import-[A-Za-z0-9_-]+$/.test(entry.name)) {
          await this.removeTempDirectory(path.join(this.resolvedTempRoot, entry.name));
        }
      }
    })();
    return this.tempReady;
  }

  async removeTempDirectory(directory) {
    if (path.dirname(directory) !== this.resolvedTempRoot || !/^import-[A-Za-z0-9_-]+$/.test(path.basename(directory))) {
      fail('Unsafe temporary import cleanup.');
    }
    const entry = await fs.lstat(directory).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (entry?.isSymbolicLink()) fail('Unsafe temporary import cleanup.');
    if (entry) await fs.rm(directory, { recursive: true, force: true });
  }

  async releaseSound(result) {
    const directory = this.temporarySounds.get(result);
    if (directory) {
      await this.removeTempDirectory(directory);
      this.temporarySounds.delete(result);
    }
  }

  async withSound(id, callback, options) {
    const result = await this.getSound(id, options);
    try { return await callback(result); }
    finally { await this.releaseSound(result); }
  }
  async withBytes(sound, bytes, callback) {
    if (!validId(sound.id) || !/^[a-f0-9-]{36}\.(?:wav|mp3|ogg|opus|m4a|flac|aac)$/.test(sound.filename) || !Buffer.isBuffer(bytes) || bytes.length > MAX_REMOTE_SOUND_BYTES) fail('Invalid platform sound.');
    await this.prepareImports();
    const directory = await fs.mkdtemp(path.join(this.resolvedTempRoot, 'import-'));
    try {
      const filePath = path.join(directory, sound.filename);
      await fs.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
      return await callback({ ...sound, filePath });
    } finally { await this.removeTempDirectory(directory); }
  }

  async getSound(id, options = {}) {
    const { sound, bytes, filePath } = await this.readSound(id, options);
    let finalPath = filePath;
    let directory;
    if (!finalPath) {
      await this.prepareImports();
      options.signal?.throwIfAborted();
      directory = await fs.mkdtemp(path.join(this.resolvedTempRoot, 'import-'));
      finalPath = path.join(directory, sound.filename);
      try {
        await fs.writeFile(finalPath, bytes, { flag: 'wx', mode: 0o600, signal: options.signal });
        options.signal?.throwIfAborted();
      } catch (error) {
        await this.removeTempDirectory(directory);
        throw error;
      }
    }
    const result = { ...publicRecord(sound), filePath: finalPath, filename: sound.filename };
    if (directory) this.temporarySounds.set(result, directory);
    return result;
  }
}

module.exports = { PublicLibrary };
