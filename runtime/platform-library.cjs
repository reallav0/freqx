'use strict';
const { createHash } = require('node:crypto');
const { valid } = require('./catalog-id');
const { downloadBytes, DEFAULT_HOSTS } = require('./remote-download.cjs');
const extensions = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac' };
class PlatformLibrary {
  constructor({ getClient, fallback }) { this.getClient = getClient; this.fallback = fallback; this.active = false; }
  async getCatalog() {
    if (process.env.FREQX_LIBRARY_BUNDLED === '1') return this.fallback.getCatalog();
    try {
      const client = this.getClient(); const sounds = []; let cursor;
      for (let page = 0; page < 50; page++) {
        const result = await client.request('/api/sounds?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        if (!Array.isArray(result.sounds) || result.sounds.length > 100) throw new Error('Invalid catalog.');
        for (const sound of result.sounds) {
          if (!valid(sound.id) || typeof sound.title !== 'string' || sound.title.length > 120 || !extensions[sound.mimeType]) throw new Error('Invalid sound.');
          sounds.push({ ...sound, tags: [], waveform: [], source: 'FreqX platform', format: extensions[sound.mimeType].toUpperCase() });
        }
        cursor = result.nextCursor; if (!cursor) break;
        if (typeof cursor !== 'string' || cursor.length > 256 || page === 49) throw new Error('Catalog exceeds its limit.');
      }
      if (!sounds.length) throw new Error('Catalog is not populated.');
      this.active = true; return { sounds, source: 'remote', sourceLabel: 'FREQX COMMUNITY' };
    } catch { this.active = false; return this.fallback.getCatalog(); }
  }
  async read(id) {
    if (!valid(id)) throw new Error('Invalid sound ID.');
    const client = this.getClient();
    return client.serialized(async () => {
      // A network failure preserves encrypted credentials; public reads remain usable.
      await client.restore().catch(() => {});
      const authenticated = Boolean(client.accessToken);
      const route = '/api/sounds/' + encodeURIComponent(id);
      const sound = (await client.request(route, undefined, authenticated)).sound;
      const authorization = await client.request(route + '/download', undefined, authenticated);
      if (!sound || sound.id !== id || !extensions[sound.mimeType]) throw new Error('Invalid sound metadata.');
      const url = new URL(authorization.downloadUrl);
      const hosts = DEFAULT_HOSTS.includes(url.hostname) ? DEFAULT_HOSTS : /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ? [url.hostname] : [];
      const bytes = await downloadBytes(url.href, 25165824, { allowedHosts: hosts, maxRedirects: 0, timeoutMs: 30000 });
      if (authorization.sizeBytes !== null && bytes.length !== authorization.sizeBytes ||
        authorization.sha256 && createHash('sha256').update(bytes).digest('hex') !== authorization.sha256) throw new Error('Sound integrity check failed.');
      return { sound: { ...sound, filename: `${sound.soundId}.${extensions[sound.mimeType]}` }, bytes };
    });
  }
  async preview(id) {
    try { const { sound, bytes } = await this.read(id); return { id, mimeType: sound.mimeType, bytes: Uint8Array.from(bytes) }; }
    catch (error) { if (this.active) throw error; return this.fallback.getPreview(id); }
  }
  async withSound(id, callback) {
    let value;
    try { value = await this.read(id); }
    catch (error) { if (this.active) throw error; return this.fallback.withSound(id, callback); }
    return this.fallback.withBytes(value.sound, value.bytes, callback);
  }
}
module.exports = { PlatformLibrary };
