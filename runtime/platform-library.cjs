'use strict';
const { createHash } = require('node:crypto');
const { config: desktopConfig } = require('./desktop-config.cjs');
const { valid } = require('./catalog-id');
const { downloadBytes, DEFAULT_HOSTS } = require('./remote-download.cjs');

const extensions = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac' };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function text(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

function catalogQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['search', 'category', 'cursor'].includes(key))) throw new Error('Invalid library filters.');
  const parameters = new URLSearchParams({ limit: String(desktopConfig.catalog.pageSize) });
  for (const [key, limit] of [['search', 200], ['category', 64], ['cursor', 256]]) {
    if (input[key] === undefined) continue;
    if (!text(input[key], limit)) throw new Error('Invalid library filters.');
    const value = input[key].trim();
    if (value) parameters.set(key, value);
  }
  return parameters;
}

function publicSound(sound) {
  if (!sound || !valid(sound.id) || !text(sound.title, 120) || !sound.title.trim()
      || !Object.hasOwn(extensions, sound.mimeType)
      || sound.category != null && !text(sound.category, 64)
      || sound.description != null && !text(sound.description, 2000)
      || sound.sizeBytes != null && (!Number.isSafeInteger(sound.sizeBytes) || sound.sizeBytes < 1 || sound.sizeBytes > desktopConfig.catalog.remoteSoundBytes)) {
    throw new Error('Invalid sound metadata.');
  }
  return {
    id: sound.id, title: sound.title, description: sound.description || '', category: sound.category || 'Uncategorized',
    duration: Number.isFinite(sound.duration) && sound.duration > 0 && sound.duration <= desktopConfig.catalog.maxDurationSeconds ? sound.duration : 0,
    sizeBytes: sound.sizeBytes || 0, mimeType: sound.mimeType,
    tags: [], waveform: [], source: 'FreqX platform', format: extensions[sound.mimeType].toUpperCase()
  };
}

class PlatformLibrary {
  constructor({ getClient, fallback, download = downloadBytes, development = !process.versions.electron || process.defaultApp === true }) {
    this.getClient = getClient;
    this.fallback = fallback;
    this.download = download;
    this.development = development;
    this.active = false;
    this.statsPromise = null;
    this.remoteIds = new Set();
    this.fallbackIds = new Set();
  }

  async getStats() {
    if (!this.statsPromise) {
      this.statsPromise = this.getClient().request('/api/catalog/stats').then(result => {
        if (!Number.isSafeInteger(result?.totalSounds) || result.totalSounds < 0) throw new Error('Invalid library total.');
        return result.totalSounds;
      }).catch(error => { this.statsPromise = null; throw error; });
    }
    return this.statsPromise;
  }

  async getFallbackCatalog() {
    const catalog = await this.fallback.getCatalog();
    this.fallbackIds = new Set(catalog.sounds.map(sound => sound.id));
    this.active = false;
    return { ...catalog, paginated: false, nextCursor: null, totalSounds: catalog.sounds.length };
  }

  async getCatalog(input) {
    const parameters = catalogQuery(input);
    if (desktopConfig.catalog.mode === 'bundled' || this.development && process.env.FREQX_LIBRARY_BUNDLED === '1') return this.getFallbackCatalog();
    // Refresh the count when starting the library again; reuse it for filters/pages.
    if (!parameters.has('search') && !parameters.has('category') && !parameters.has('cursor')) this.statsPromise = null;
    try {
      // One page per request keeps startup independent of the complete catalog size.
      const [result, totalSounds] = await Promise.all([
        this.getClient().request('/api/sounds?' + parameters),
        this.getStats().catch(() => null)
      ]);
      if (!result || !Array.isArray(result.sounds) || result.sounds.length > desktopConfig.catalog.pageSize
          || result.nextCursor != null && (!text(result.nextCursor, 256) || !result.nextCursor.trim()
            || result.nextCursor === parameters.get('cursor') || !result.sounds.length)) throw new Error('Invalid catalog page.');
      const sounds = result.sounds.map(publicSound);
      if (new Set(sounds.map(sound => sound.id)).size !== sounds.length) throw new Error('Duplicate catalog sound.');
      for (const sound of sounds) this.remoteIds.add(sound.id);
      this.active = true;
      return { sounds, nextCursor: result.nextCursor || null, totalSounds, paginated: true, source: 'remote', sourceLabel: 'FREQX COMMUNITY' };
    } catch (error) {
      // A failed continuation must leave the current API page available for retry.
      if (parameters.has('cursor')) throw error;
      return this.getFallbackCatalog();
    }
  }

  async read(id) {
    if (!valid(id)) throw new Error('Invalid sound ID.');
    const client = this.getClient();
    return client.serialized(async () => {
      // A network failure preserves encrypted credentials; public reads remain usable.
      await client.restore().catch(() => {});
      const authenticated = Boolean(client.accessToken);
      const route = '/api/sounds/' + encodeURIComponent(id);
      const raw = (await client.request(route, undefined, authenticated))?.sound;
      const sound = publicSound(raw);
      if (sound.id !== id || !uuid.test(raw.soundId)) throw new Error('Invalid sound metadata.');
      const authorization = await client.request(route + '/download', undefined, authenticated);
      if (!authorization || typeof authorization.downloadUrl !== 'string'
          || authorization.sizeBytes != null && (!Number.isSafeInteger(authorization.sizeBytes) || authorization.sizeBytes < 1 || authorization.sizeBytes > desktopConfig.catalog.remoteSoundBytes)
          || authorization.sha256 != null && (typeof authorization.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(authorization.sha256))) throw new Error('Invalid sound download.');
      const url = new URL(authorization.downloadUrl);
      const hosts = DEFAULT_HOSTS.includes(url.hostname) ? DEFAULT_HOSTS : /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ? [url.hostname] : [];
      const bytes = await this.download(url.href, desktopConfig.catalog.remoteSoundBytes, { allowedHosts: hosts, maxRedirects: 0, timeoutMs: desktopConfig.network.platformAudioTimeoutMs });
      if (authorization.sizeBytes != null && bytes.length !== authorization.sizeBytes
          || authorization.sha256 && createHash('sha256').update(bytes).digest('hex') !== authorization.sha256) throw new Error('Sound integrity check failed.');
      return { sound: { ...sound, filename: `${raw.soundId}.${extensions[sound.mimeType]}` }, bytes };
    });
  }

  usesFallback(id) {
    return this.fallbackIds.has(id) && !this.remoteIds.has(id);
  }

  async preview(id) {
    if (!valid(id)) throw new Error('Invalid sound ID.');
    if (this.usesFallback(id)) return this.fallback.getPreview(id);
    const { sound, bytes } = await this.read(id);
    return { id, mimeType: sound.mimeType, bytes: Uint8Array.from(bytes) };
  }

  async withSound(id, callback) {
    if (!valid(id)) throw new Error('Invalid sound ID.');
    if (this.usesFallback(id)) return this.fallback.withSound(id, callback);
    const { sound, bytes } = await this.read(id);
    return this.fallback.withBytes(sound, bytes, callback);
  }
}
module.exports = { PlatformLibrary };
