'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AuthClient, registerAuthIpc, trustedBase, parseOAuthCallback } = require('../runtime/auth-client.cjs');

test('branded source launches use the local API while packaged launches ignore its override', () => {
  const defaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
  const previousBase = process.env.FREQX_API_BASE_URL;
  try {
    process.env.FREQX_API_BASE_URL = 'http://127.0.0.1:43210';
    for (const development of [true, false]) {
      Object.defineProperty(process, 'defaultApp', { value: development, configurable: true });
      const handler = registerAuthIpc({ ipcMain: { handle() {} }, getWindow: () => null,
        app: { isPackaged: true, getPath: () => 'unused-fixture-profile' }, safeStorage: null });
      assert.equal(handler.client().base, development ? process.env.FREQX_API_BASE_URL : require('../runtime/desktop-config.cjs').config.network.apiBaseUrl);
    }
    Object.defineProperty(process, 'defaultApp', { value: true, configurable: true });
    const updater = require('../runtime/update-client.cjs').createUpdateClient({
      app: { isPackaged: true, getVersion: () => '1.8.0' }, getWindow: () => null,
      updater: { setFeedURL() { throw new Error('Development must not configure production updates.'); } }
    });
    assert.equal(updater.install().ok, false);
  } finally {
    if (defaultApp) Object.defineProperty(process, 'defaultApp', defaultApp); else delete process.defaultApp;
    if (previousBase === undefined) delete process.env.FREQX_API_BASE_URL; else process.env.FREQX_API_BASE_URL = previousBase;
  }
});

test('auth IPC blocks other windows and child frames before constructing a client', async () => {
  const handlers = new Map();
  const mainFrame = {};
  const webContents = { mainFrame };
  registerAuthIpc({ ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, getWindow: () => ({ webContents }), app: {}, safeStorage: null });
  for (const callback of handlers.values()) {
    await assert.rejects(callback({ sender: {}, senderFrame: mainFrame }), /Untrusted/);
    await assert.rejects(callback({ sender: webContents, senderFrame: {} }), /Untrusted/);
  }
});

test('cloud upload confines authorization to R2, bounds files and never returns upload credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-upload-test-'));
  const filename = path.join(directory, 'sample.wav'); await fs.writeFile(filename, Buffer.alloc(32));
  const userId = '8a92d186-1c51-4435-8614-0f3f09cbb627';
  const uploadId = '8a92d186-1c51-4435-8614-0f3f09cbb628';
  let destination = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/quarantine/${userId}/${uploadId}/original.wav?signature=fixture`;
  let transferred = 0;
  const client = new AuthClient({ apiBaseUrl: 'https://api.freqx.app', store: {}, fetchImpl: async (url, options) => {
    if (options.method === 'PUT') { transferred++; assert.equal(options.redirect, 'error'); assert.equal(options.body.length, 32); return new Response(null, { status: 200 }); }
    if (url.endsWith('/api/uploads')) return Response.json({ uploadUrl: destination, uploadId, expiresIn: 120, headers: { 'Content-Type': 'audio/wav', 'Content-Length': '32' } });
    if (url.endsWith('/complete')) return Response.json({ status: 'uploaded' }, { status: 202 });
    return Response.json({ sounds: [] });
  } });
  client.accessToken = 'memory-only'; client.user = { id: userId }; client.expiresAt = Date.now() + 900000;
  try {
    const details = { title: 'Test', visibility: 'private' };
    const result = await client.cloudAction('upload', details, async () => filename);
    assert.equal(transferred, 1); assert.ok(!JSON.stringify(result).includes('signature')); assert.ok(!JSON.stringify(result).includes('memory-only'));
    destination = 'http://127.0.0.1/admin';
    await assert.rejects(client.cloudAction('upload', details, async () => filename), /authorization/); assert.equal(transferred, 1);
    assert.equal((await client.cloudAction('upload', details, async () => null)).message, 'Upload cancelled.');
    const handle = await fs.open(filename, 'r+'); await handle.truncate(25165825); await handle.close();
    await assert.rejects(client.cloudAction('upload', details, async () => filename), /24 MiB/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('OAuth callbacks require exact protocol, attempt and single-use code parameters', async () => {
  const attempt = '8a92d186-1c51-4435-8614-0f3f09cbb627';
  const url = `freqx://auth/callback?attempt=${attempt}&code=${'a'.repeat(43)}`;
  assert.equal(parseOAuthCallback(url).attemptId, attempt);
  for (const input of [url + '&code=other', url + '#fragment', url.replace('freqx:', 'https:'), url.replace('/callback', '/else'), url.replace('auth/', 'user@auth/'), 'freqx://auth/callback']) assert.equal(parseOAuthCallback(input), null);
  const client = new AuthClient({ apiBaseUrl: 'https://api.freqx.app', store: {} });
  await assert.rejects(client.finishOAuth(url), /Unsolicited/);
});
test('API credentials are retained on network failure and cleared on session revocation', async () => {
  const token = 'a'.repeat(64);
  let credential = token;
  const store = { read: async () => credential, clear: async () => { credential = null; } };
  const client = new AuthClient({ apiBaseUrl: 'https://api.freqx.app', store,
    fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(client.status(), /offline/);
  assert.equal(credential, token);
  client.fetch = async () => new Response(JSON.stringify({ error: { code: 'SESSION_INVALID' } }), { status: 401 });
  assert.deepEqual(await client.status(), { user: null });
  assert.equal(credential, null);
});
test('offline logout clears local credentials and accurately reports pending server revocation', async () => {
  let credential = 'a'.repeat(64);
  const store = { read: async () => credential, clear: async () => { credential = null; } };
  const client = new AuthClient({ apiBaseUrl: 'https://api.freqx.app', store, fetchImpl: async () => { throw new Error('offline'); } });
  client.accessToken = 'in-memory'; client.user = { id: 'fixture' };
  assert.deepEqual(await client.logout(), { user: null, revocationPending: true });
  assert.equal(credential, null); assert.equal(client.accessToken, null); assert.equal(client.user, null);
});
test('incorrect current password does not discard a valid authenticated desktop session', async () => {
  let cleared = false;
  const client = new AuthClient({ apiBaseUrl: 'https://api.freqx.app', store: { clear: async () => { cleared = true; } },
    fetchImpl: async () => Response.json({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401 }) });
  client.accessToken = 'in-memory'; client.user = { id: 'fixture' };
  await assert.rejects(client.request('/api/auth/password/change', {}, true), { code: 'INVALID_CREDENTIALS' });
  assert.equal(cleared, false); assert.equal(client.accessToken, 'in-memory');
});
test('oversized API responses abort and failed secure persistence revokes the new session', async () => {
  let revoked = false;
  const store = { save: async () => { throw new Error('secure storage failed'); }, clear: async () => {} };
  const client = new AuthClient({ apiBaseUrl: 'https://api.freqx.app', store,
    fetchImpl: async () => new Response('a'.repeat(131073)) });
  await assert.rejects(client.request('/api/users/me'), /size/);
  client.fetch = async (url, options) => { revoked = url.endsWith('/api/auth/logout') && options.redirect === 'error'; return new Response(null, { status: 204 }); };
  await assert.rejects(client.accept({ user: { id: 'fixture' }, expiresIn: 900, accessToken: 'access', refreshToken: 'a'.repeat(64) }), /storage failed/);
  assert.equal(revoked, true); assert.equal(client.accessToken, null);
  for (const value of ['file:///tmp/foo', 'http://evil.example', 'https://api.freqx.app/path', 'https://api.freqx.app#x']) assert.throws(() => trustedBase(value, true));
});
