'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { isPackagedApp } = require('./app-mode.cjs');
const { config: desktopConfig } = require('./desktop-config.cjs');


function trustedBase(value, development = false) {
  const url = new URL(value);
  const local = development && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid trusted API configuration.');
  return url.origin;
}
class SecureCredentialStore {
  constructor({ directory, safeStorage }) { this.directory = directory; this.safeStorage = safeStorage; this.filename = path.join(directory, 'auth-session.bin'); }
  async available() {
    return Boolean(this.safeStorage && await this.safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(this.safeStorage.getSelectedStorageBackend()));
  }
  async save(refreshToken) {
    if (!await this.available()) throw new Error('OS credential protection is unavailable.');
    if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) throw new Error('Invalid session credential.');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Unsafe credential directory.');
    const temporary = path.join(this.directory, `auth-session-${randomUUID()}.tmp`);
    try {
      const encrypted = await this.safeStorage.encryptStringAsync(refreshToken);
      await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.filename);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async read() {
    const stat = await fs.lstat(this.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > desktopConfig.auth.credentialBytes || !await this.available()) throw new Error('Stored session cannot be read securely.');
    const decrypted = await this.safeStorage.decryptStringAsync(await fs.readFile(this.filename));
    if (!decrypted || typeof decrypted.result !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(decrypted.result)) throw new Error('Stored session is invalid.');
    if (decrypted.shouldReEncrypt) await this.save(decrypted.result);
    return decrypted.result;
  }
  async clear() { await fs.unlink(this.filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

class AuthClient {
  constructor({ apiBaseUrl, development, store, fetchImpl = fetch }) {
    this.base = trustedBase(apiBaseUrl, development);
    this.store = store; this.fetch = fetchImpl; this.accessToken = null; this.user = null; this.expiresAt = 0;
    this.operations = Promise.resolve();
  }
  serialized(callback) {
    const operation = this.operations.then(callback);
    this.operations = operation.catch(() => {});
    return operation;
  }
  async request(route, body, authenticated = false, method) {
    // Callers inside this module provide route constants; the renderer has no
    // generic request method and cannot choose endpoints or override headers.
    const response = await this.fetch(this.base + route, { method: method || (body === undefined ? 'GET' : 'POST'),
      redirect: 'error', signal: AbortSignal.timeout(desktopConfig.auth.requestTimeoutMs),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated ? { Authorization: `Bearer ${this.accessToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 204) return null;
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > desktopConfig.auth.responseBytes) throw new Error('Unexpected API response size.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { throw new Error('Unexpected API response.'); }
    if (!response.ok) {
      const code = typeof result.error?.code === 'string' ? result.error.code : 'API_ERROR';
      const message = { INVALID_CREDENTIALS: 'Email or password is incorrect.', SESSION_INVALID: 'Please sign in again.',
        RATE_LIMITED: 'Please try again later.', REGISTRATION_UNAVAILABLE: 'Registration could not be completed with those details.',
        VALIDATION_FAILED: 'Please check your account details.', CODE_INVALID: 'Code is invalid or expired.',
        VERIFICATION_REQUIRED: 'Verify your email address or phone number before uploading.',
        UPLOAD_QUOTA: 'Your upload quota has been reached.', UPLOAD_INVALID: 'The audio file is invalid or exceeds upload limits.',
        STORAGE_UNAVAILABLE: 'Cloud uploads are not available yet.',
        AUTH_BUSY: 'Please try again later.' }[code] || 'The account request failed.';
      if (authenticated && response.status === 401 && ['SESSION_INVALID', 'UNAUTHENTICATED'].includes(code)) {
        this.accessToken = null; this.user = null; this.expiresAt = 0; await this.store.clear();
      }
      throw Object.assign(new Error(message), { status: response.status, code });
    }
    return result;
  }
  async accept(result) {
    if (!result || typeof result.accessToken !== 'string' || result.accessToken.length > 2048 ||
      result.expiresIn !== 900 || !result.user || typeof result.user.id !== 'string' ||
      !/^[A-Za-z0-9_-]{64}$/.test(result.refreshToken)) throw new Error('Unexpected session response.');
    try { await this.store.save(result.refreshToken); }
    catch (error) {
      await this.request('/api/auth/logout', { refreshToken: result.refreshToken }).catch(() => {});
      this.accessToken = null; this.user = null; this.expiresAt = 0;
      await this.store.clear(); throw error;
    }
    this.accessToken = result.accessToken; this.user = result.user; this.expiresAt = Date.now() + 900000;
    return { user: this.user };
  }
  signin(kind, input) {
    return this.serialized(async () => {
      if (!['login', 'signup'].includes(kind)) throw new Error('Invalid sign-in operation.');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['email', 'password', 'username', 'displayName', 'deviceName'].includes(key)) ||
        Object.values(input).some(value => typeof value !== 'string' || value.length > 254)) throw new Error('Invalid account details.');
      if (!await this.store.available()) throw new Error('OS credential protection is unavailable.');
      const previous = await this.store.read();
      const session = await this.request(`/api/auth/${kind}`, input);
      if (previous) await this.request('/api/auth/logout', { refreshToken: previous }).catch(() => {});
      return this.accept(session);
    });
  }
  async restore() {
    if (this.accessToken && Date.now() < this.expiresAt - desktopConfig.auth.refreshEarlyMs) return { user: this.user };
    const refreshToken = await this.store.read();
    if (!refreshToken) return { user: null };
    try { return await this.accept(await this.request('/api/auth/refresh', { refreshToken })); }
    catch (error) {
      if (error.status === 401) {
        this.accessToken = null; this.user = null; this.expiresAt = 0;
        await this.store.clear(); return { user: null };
      }
      throw error; // Network failure preserves the encrypted credential.
    }
  }
  status() { return this.serialized(() => this.restore()); }
  startOAuth(provider, openBrowser) {
    return this.serialized(async () => {
      if (!['discord', 'google'].includes(provider)) throw new Error('Invalid login provider.');
      if (!await this.store.available()) throw new Error('OS credential protection is unavailable.');
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const result = await this.request(`/api/auth/oauth/${provider}/attempt`, { challenge });
      if (!result || !/^[a-f0-9-]{36}$/.test(result.attemptId)) throw new Error('Invalid OAuth attempt.');
      const url = new URL(result.browserUrl);
      if (url.origin !== this.base || url.pathname !== `/api/auth/${provider}` || url.searchParams.get('attempt') !== result.attemptId ||
        [...url.searchParams.keys()].length !== 1 || url.hash || url.username || url.password) throw new Error('Invalid OAuth browser URL.');
      this.oauthAttempt = { id: result.attemptId, verifier, expiresAt: Date.now() + desktopConfig.auth.oauthAttemptTimeoutMs };
      await openBrowser(url.href);
      return { user: this.user, message: 'Complete login in your browser, then return to FreqX.' };
    });
  }
  finishOAuth(raw) {
    return this.serialized(async () => {
      const input = parseOAuthCallback(raw);
      const attempt = this.oauthAttempt;
      if (!input || !attempt || input.attemptId !== attempt.id || Date.now() >= attempt.expiresAt) throw new Error('Unsolicited OAuth callback.');
      this.oauthAttempt = null;
      const result = await this.request('/api/auth/oauth/exchange', { ...input, verifier: attempt.verifier });
      const previous = await this.store.read();
      if (previous) await this.request('/api/auth/logout', { refreshToken: previous }).catch(() => {});
      return this.accept(result);
    });
  }
  emailAction(kind, input = {}) {
    return this.serialized(async () => {
      const routes = { verify: '/api/auth/email/verify', resend: '/api/auth/email/resend', forgot: '/api/auth/password/forgot', reset: '/api/auth/password/reset' };
      if (!routes[kind] || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['email', 'code', 'password'].includes(key)) ||
        Object.values(input).some(value => typeof value !== 'string' || value.length > 254)) throw new Error('Invalid account details.');
      const authenticated = ['verify', 'resend'].includes(kind);
      if (authenticated) {
        await this.restore();
        if (!this.accessToken) throw Object.assign(new Error('Please sign in again.'), { code: 'SESSION_INVALID' });
      }
      await this.request(routes[kind], input, authenticated);
      if (kind === 'verify') this.user = (await this.request('/api/users/me', undefined, true)).user;
      if (kind === 'reset') { this.accessToken = null; this.user = null; this.expiresAt = 0; await this.store.clear(); }
      return { user: this.user, message: { verify: 'Email verified.', resend: 'If eligible, a verification email will be sent.',
        forgot: 'If eligible, a reset email will be sent. Enter its code below.', reset: 'Password reset. Log in with your new password.' }[kind] };
    });
  }
  phoneAction(kind, input) {
    return this.serialized(async () => {
      if (!['request', 'verify'].includes(kind) || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['phoneNumber', 'code'].includes(key)) || Object.values(input).some(value => typeof value !== 'string' || value.length > 32)) throw new Error('Invalid phone details.');
      const result = await this.request(`/api/auth/phone/${kind === 'request' ? 'request-code' : 'verify'}`, input);
      if (kind === 'request') return { user: this.user, message: 'If eligible, a verification code will be sent.' };
      const previous = await this.store.read();
      if (previous) await this.request('/api/auth/logout', { refreshToken: previous }).catch(() => {});
      return this.accept(result);
    });
  }
  cloudAction(kind, input, chooseFile) {
    return this.serialized(async () => {
      await this.restore();
      if (!this.accessToken) throw new Error('Please sign in first.');
      const validId = require('./catalog-id').valid;
      if (kind === 'list') return { user: this.user, cloud: await this.request(`/api/sounds?scope=mine&limit=${desktopConfig.catalog.pageSize}`, undefined, true) };
      if (kind === 'delete') {
        if (!validId(input)) throw new Error('Invalid sound ID.');
        await this.request('/api/sounds/' + encodeURIComponent(input), undefined, true, 'DELETE');
        return { user: this.user, message: 'Cloud sound deleted.' };
      }
      if (kind !== 'upload' || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['title', 'description', 'category', 'visibility'].includes(key)) ||
        typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 ||
        Object.values(input).some(value => typeof value !== 'string' || value.length > 2000) ||
        !['public', 'private'].includes(input.visibility)) throw new Error('Invalid sound details.');
      const filename = await chooseFile();
      if (!filename) return { user: this.user, message: 'Upload cancelled.' };
      const handle = await fs.open(filename, 'r'); let bytes;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 12 || stat.size > desktopConfig.auth.uploadBytes) throw Object.assign(new Error('Audio must be between 12 bytes and 24 MiB.'), { code: 'UPLOAD_INVALID' });
        bytes = Buffer.alloc(stat.size); const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== bytes.length || (await handle.stat()).size !== stat.size) throw new Error('Audio file changed while being read.');
      } finally { await handle.close(); }
      const extension = path.extname(filename).slice(1).toLowerCase();
      const formats = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac' };
      if (!formats[extension]) throw new Error('Unsupported audio format.');
      const authorization = await this.request('/api/uploads', { ...input, originalFilename: `original.${extension}`, mimeType: formats[extension], fileSize: bytes.length }, true);
      const url = new URL(authorization.uploadUrl);
      if (url.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.username || url.password || url.port || url.hash ||
        !url.pathname.includes(`/quarantine/${this.user.id}/${authorization.uploadId}/original.${extension}`) ||
        authorization.headers?.['Content-Type'] !== formats[extension] || authorization.headers?.['Content-Length'] !== String(bytes.length) || authorization.expiresIn !== 120) throw new Error('Invalid upload authorization.');
      const response = await this.fetch(url.href, { method: 'PUT', headers: { 'Content-Type': formats[extension], 'Content-Length': String(bytes.length) }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(desktopConfig.auth.uploadTimeoutMs) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Audio upload failed.');
      await this.request('/api/uploads/' + authorization.uploadId + '/complete', {}, true);
      return { user: this.user, message: 'Audio uploaded. Validation is pending.', cloud: await this.request(`/api/sounds?scope=mine&limit=${desktopConfig.catalog.pageSize}`, undefined, true) };
    });
  }
  accountAction(kind, input) {
    return this.serialized(async () => {
      await this.restore(); if (!this.accessToken) throw new Error('Please sign in first.');
      if (kind === 'profile') {
        if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['username','displayName'].includes(key)) || Object.values(input).some(value => typeof value !== 'string' || value.length > 80)) throw new Error('Invalid profile.');
        const result = await this.request('/api/users/me', input, true, 'PATCH'); this.user = result.user; return result;
      }
      if (kind === 'password') {
        if (!input || typeof input.currentPassword !== 'string' || typeof input.password !== 'string' || Object.keys(input).some(key => !['currentPassword', 'password'].includes(key)) || input.password.length > 128 || input.currentPassword.length > 128) throw new Error('Invalid password details.');
        await this.request('/api/auth/password/change', input, true);
        await this.store.clear(); this.accessToken = null; this.user = null; this.expiresAt = 0;
        return { user: null, message: 'Password changed. All devices were logged out.' };
      }
      const validId = require('./catalog-id').valid;
      if (kind === 'sync') {
        if (!Array.isArray(input) || input.length > desktopConfig.auth.favoritesBatchSize || !input.every(validId)) throw new Error('Invalid favorite IDs.');
        return { user: this.user, ...await this.request('/api/favorites/sync', { ids: input }, true) };
      }
      if (kind === 'favorite') {
        if (!input || !validId(input.id) || typeof input.favorite !== 'boolean' || Object.keys(input).some(key => !['id', 'favorite'].includes(key))) throw new Error('Invalid favorite.');
        await this.request('/api/favorites/' + encodeURIComponent(input.id), input.favorite ? {} : undefined, true, input.favorite ? 'POST' : 'DELETE');
        return { user: this.user };
      }
      throw new Error('Invalid account operation.');
    });
  }
  logout(all = false) {
    return this.serialized(async () => {
      let revocationPending = false;
      try {
        if (all) { await this.restore(); if (this.accessToken) await this.request('/api/auth/logout-all', {}, true); }
        else {
          const refreshToken = await this.store.read();
          if (refreshToken) await this.request('/api/auth/logout', { refreshToken });
        }
      } catch { revocationPending = true; }
      finally { this.accessToken = null; this.user = null; this.expiresAt = 0; await this.store.clear(); }
      return { user: null, revocationPending };
    });
  }
}

function parseOAuthCallback(raw) {
  if (typeof raw !== 'string' || raw.length > 512 || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  let url; try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'freqx:' || url.hostname !== 'auth' || url.pathname !== '/callback' || url.username || url.password || url.port || url.hash ||
    [...url.searchParams.keys()].length !== 2 || !/^[a-f0-9-]{36}$/.test(url.searchParams.get('attempt')) ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code'))) return null;
  return { attemptId: url.searchParams.get('attempt'), code: url.searchParams.get('code') };
}
function registerAuthIpc({ ipcMain, getWindow, app, safeStorage, shell, dialog }) {
  let client;
  function getClient() {
    if (!client) {
      const config = desktopConfig.network;
      const development = !isPackagedApp(app);
      client = new AuthClient({ apiBaseUrl: development && process.env.FREQX_API_BASE_URL || config.apiBaseUrl,
        development, store: new SecureCredentialStore({ directory: app.getPath('userData'), safeStorage }) });
    }
    return client;
  }
  for (const [channel, operation] of Object.entries({
    'auth:status': () => getClient().status(), 'auth:login': input => getClient().signin('login', input),
    'auth:signup': input => getClient().signin('signup', input), 'auth:logout': () => getClient().logout(),
    'auth:logout-all': () => getClient().logout(true),
    'auth:email-verify': input => getClient().emailAction('verify', input),
    'auth:email-resend': () => getClient().emailAction('resend'),
    'auth:password-forgot': input => getClient().emailAction('forgot', input),
    'auth:password-reset': input => getClient().emailAction('reset', input),
    'auth:oauth-start': provider => getClient().startOAuth(provider, url => shell.openExternal(url)),
    'auth:phone-request': input => getClient().phoneAction('request', input),
    'auth:phone-verify': input => getClient().phoneAction('verify', input),
    'cloud:list': () => getClient().cloudAction('list'),
    'cloud:delete': id => getClient().cloudAction('delete', id),
    'account:profile': input => getClient().accountAction('profile', input),
    'account:password': input => getClient().accountAction('password', input),
    'account:favorites-sync': input => getClient().accountAction('sync', input),
    'account:favorite': input => getClient().accountAction('favorite', input),
    'cloud:upload': input => getClient().cloudAction('upload', input, async () => {
      const result = await dialog.showOpenDialog(getWindow(), { title: 'Upload an audio file', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3','wav','ogg','opus','m4a','flac','aac'] }] });
      return result.canceled ? null : result.filePaths[0];
    })
  })) {
    ipcMain.handle(channel, async (event, input) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted auth IPC sender.');
      try { return await operation(input); }
      catch (error) { return { user: client?.user || null, error: error.code ? error.message : 'Account service or secure storage is unavailable. Please try again.' }; }
    });
  }
  const callback = async raw => {
    try {
      const result = await getClient().finishOAuth(raw);
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('auth:state', result);
    } catch { /* Unsolicited/expired callbacks never become imports or credentials. */ }
  };
  callback.client = getClient;
  return callback;
}
module.exports = { SecureCredentialStore, AuthClient, trustedBase, registerAuthIpc, parseOAuthCallback };
