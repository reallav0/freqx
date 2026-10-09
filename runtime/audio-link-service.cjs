'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { config } = require('./desktop-config.cjs');

const LIMITS = Object.freeze({ inputBytes: config.catalog.remoteSoundBytes, durationSeconds: config.catalog.maxDurationSeconds, decodedBytes: 128 * 1024 * 1024 });
const abortError = () => Object.assign(new Error('Link import canceled.'), { code: 'ABORT_ERR', userMessage: 'Link import canceled.' });
const failure = message => Object.assign(new Error(message), { userMessage: message });

function validateNormalizedWav(value) {
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw failure('Audio validation failed.');
  const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 46 || bytes.length > 44 + LIMITS.durationSeconds * 48000 * 2 * 2
      || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
      || bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.toString('ascii', 36, 40) !== 'data'
      || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(16) !== 16
      || bytes.readUInt16LE(20) !== 1 || ![1, 2].includes(bytes.readUInt16LE(22))
      || bytes.readUInt32LE(24) !== 48000 || bytes.readUInt16LE(34) !== 16
      || bytes.readUInt32LE(40) !== bytes.length - 44) throw failure('Audio validation failed.');
  const channels = bytes.readUInt16LE(22), frameBytes = channels * 2;
  if (bytes.readUInt16LE(32) !== frameBytes || bytes.readUInt32LE(28) !== 48000 * frameBytes
      || (bytes.length - 44) % frameBytes || (bytes.length - 44) / frameBytes / 48000 > LIMITS.durationSeconds) throw failure('Audio validation failed.');
  return bytes;
}

async function decodeToWave({ BrowserWindow, session, appRoot, filePath, signal, timeoutMs = 20000 }) {
  signal.throwIfAborted();
  const pagePath = path.join(appRoot, 'runtime', 'audio-link-validator.html');
  const allowed = new Set([pathToFileURL(pagePath).href, pathToFileURL(path.join(appRoot, 'runtime', 'audio-link-validator.js')).href, pathToFileURL(filePath).href]);
  const isolatedSession = session.fromPartition('freqx-audio-link-validator-' + randomUUID(), { cache: false });
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !allowed.has(details.url) }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false,
    spellcheck: false, devTools: false,
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) window.webContents.on(event, event => event.preventDefault());
  const onDownload = event => event.preventDefault();
  isolatedSession.on('will-download', onDownload);
  let timer, onAbort, onGone, onClosed;
  const interrupted = new Promise((_resolve, reject) => {
    onAbort = () => reject(abortError());
    onGone = () => reject(failure('This audio could not be decoded safely.'));
    onClosed = () => reject(failure('Audio validation was interrupted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    window.webContents.once('render-process-gone', onGone);
    window.once('closed', onClosed);
    timer = setTimeout(() => reject(failure('Audio validation timed out. Try a shorter clip.')), timeoutMs);
  });
  try {
    const decoded = await Promise.race([interrupted, (async () => {
      await window.loadFile(pagePath);
      signal.throwIfAborted();
      return window.webContents.executeJavaScript(`window.normalizeLinkedAudio(${JSON.stringify(pathToFileURL(filePath).href)}, ${JSON.stringify(LIMITS)})`);
    })()]);
    signal.throwIfAborted();
    return validateNormalizedWav(decoded);
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error.userMessage) throw error;
    throw failure('This link does not contain playable audio.');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    window.webContents.removeListener('render-process-gone', onGone);
    window.removeListener('closed', onClosed);
    if (!window.isDestroyed()) window.destroy();
    isolatedSession.removeListener('will-download', onDownload);
    isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (_details, callback) => callback({ cancel: true }));
    await isolatedSession.clearStorageData();
  }
}

function localFileName(filename) {
  const stem = path.basename(String(filename || 'linked-audio'), path.extname(String(filename || '')))
    .replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 90) || 'linked-audio';
  return `${/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(stem) ? 'audio-' : ''}${stem}.wav`;
}

class AudioLinkService {
  constructor({ download, BrowserWindow, session, appRoot, tempRoot, reserve, item, decode = decodeToWave }) {
    Object.assign(this, { download, BrowserWindow, session, appRoot, tempRoot, reserve, item, decode });
    this.queue = Promise.resolve();
    this.jobs = new Set();
    this.tempReady = null;
  }

  import(url, { owner, kind = 'ui', filename } = {}) {
    if (this.jobs.size >= 8 || (kind === 'ui' && [...this.jobs].some(job => job.owner === owner && job.kind === kind))) return Promise.reject(failure('A link is already importing. Please wait or cancel it.'));
    const job = { owner, kind, controller: new AbortController() };
    this.jobs.add(job);
    const operation = this.queue.then(() => this.run(url, job.controller.signal, filename)).catch(error => {
      if (job.controller.signal.aborted) throw abortError();
      throw error;
    });
    this.queue = operation.catch(() => {});
    return operation.finally(() => this.jobs.delete(job));
  }

  cancelOwner(owner) { for (const job of this.jobs) if (job.owner === owner) job.controller.abort(); }
  stopAll() { for (const job of this.jobs) job.controller.abort(); }

  prepareTemporaryRoot() {
    if (!this.tempReady) this.tempReady = (async () => {
      const root = path.resolve(typeof this.tempRoot === 'function' ? this.tempRoot() : this.tempRoot);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Temporary audio storage is unavailable.');
      // The single-instance application owns this directory. Remove only direct
      // staging children left by a prior crash; never follow symbolic links.
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const child = path.resolve(root, entry.name);
        if (entry.isDirectory() && /^link-[a-zA-Z0-9_-]+$/.test(entry.name) && path.dirname(child) === root) {
          const stat = await fs.lstat(child);
          if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(child, { recursive: true, force: true });
        }
      }
      return root;
    })();
    return this.tempReady;
  }

  async run(url, signal, preferredFilename) {
    signal.throwIfAborted();
    const downloaded = await this.download(url, { signal });
    signal.throwIfAborted();
    if (!Buffer.isBuffer(downloaded.bytes) || !downloaded.bytes.length || downloaded.bytes.length > LIMITS.inputBytes) throw failure('Audio download is too large.');
    const root = await this.prepareTemporaryRoot();
    const directory = await fs.mkdtemp(path.join(root, 'link-'));
    let reservation, committed = false;
    try {
      const filePath = path.join(directory, 'source.audio');
      await fs.writeFile(filePath, downloaded.bytes, { flag: 'wx', mode: 0o600, signal });
      const bytes = validateNormalizedWav(await this.decode({ BrowserWindow: this.BrowserWindow, session: this.session, appRoot: this.appRoot, filePath, signal }));
      signal.throwIfAborted();
      reservation = await this.reserve(localFileName(preferredFilename || downloaded.filename));
      await reservation.handle.writeFile(bytes, { signal });
      await reservation.handle.close();
      signal.throwIfAborted();
      const item = this.item(reservation.destinationPath);
      committed = true;
      return { ok: true, canceled: false, imported: [item], skipped: [], ...(downloaded.title ? { metadata: { [item.path]: { name: downloaded.title } } } : {}) };
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    } finally {
      if (reservation && !committed) {
        await reservation.handle.close().catch(() => {});
        await fs.unlink(reservation.destinationPath).catch(() => {});
      }
      // Only remove the directory created by this invocation, inside our root.
      if (path.dirname(directory) === root && /^link-[a-zA-Z0-9_-]+$/.test(path.basename(directory))) await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

module.exports = { AudioLinkService, decodeToWave, validateNormalizedWav, localFileName, LIMITS };
