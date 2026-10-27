'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { PhoneRemoteService, normalizeState, validateCommand, privateAddress } = require('../runtime/phone-remote.cjs');

const fixtureState = () => ({
  boards: ['Main', 'Reactions'], selectedBoard: '__all__', volume: .65,
  sounds: [
    { id: 'sound_1', title: 'Victory!', board: 'Main', color: '#ed3035', playing: false, favorite: true },
    { id: 'sound_2', title: '<script>alert(1)</script>', board: 'Reactions', color: '#abcdef', playing: false, favorite: false },
  ],
});

async function fixture(t, options = {}) {
  const commands = [];
  let clock = Date.now();
  const service = new PhoneRemoteService({
    networkInterfaces: () => ({ Test: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }),
    bindHost: '127.0.0.1', allowLoopback: true, now: () => clock,
    onCommand: async command => { commands.push(command); return { ok: true }; }, ...options,
  });
  t.after(() => service.stop());
  assert.equal(service.status().enabled, false);
  const status = await service.start();
  const origin = `http://127.0.0.1:${status.port}`;
  service.publish(fixtureState());
  const token = () => new URL(service.status().pairingUrl).hash.slice('#pair='.length);
  async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const client = http.request(origin + route, {
        method, headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      }, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          const resultHeaders = new Headers();
          for (const [name, values] of Object.entries(response.headers)) for (const value of Array.isArray(values) ? values : [values]) if (value !== undefined) resultHeaders.append(name, value);
          resolve({ status: response.statusCode, headers: resultHeaders, text, data: resultHeaders.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : undefined });
        });
      });
      client.setTimeout(5000, () => client.destroy(new Error('HTTP fixture timed out.')));
      client.on('error', reject); client.end(payload);
    });
  }
  async function pair() {
    const result = await request('/api/pair', { method: 'POST', body: { token: token() } });
    assert.equal(result.status, 200, result.text);
    return { ...result, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  return { service, status, origin, request, pair, token, commands, advance: ms => { clock += ms; } };
}

function stream(t, f, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get(f.origin + '/api/events', { headers: { Cookie: cookie, Origin: f.origin } });
    request.on('error', reject);
    t.after(() => request.destroy());
    request.on('response', response => {
      let text = '';
      const waiters = new Set();
      let ended = false;
      const check = () => { for (const waiter of [...waiters]) waiter(); };
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; check(); });
      response.on('end', () => { ended = true; check(); });
      response.on('close', () => { ended = true; check(); });
      response.on('error', () => { ended = true; check(); });
      resolve({
        response, request, get text() { return text; }, get ended() { return ended; },
        until(predicate) {
          return new Promise((done, fail) => {
            const timeout = setTimeout(() => { waiters.delete(checkOne); fail(new Error('Timed out waiting for remote event.')); }, 3000);
            function checkOne() { if (predicate(text, ended)) { clearTimeout(timeout); waiters.delete(checkOne); done(text); } }
            waiters.add(checkOne); checkOne();
          });
        },
      });
    });
  });
}

test('production networking accepts only canonical private IPv4 addresses', () => {
  for (const address of ['10.0.0.1', '192.168.1.20', '172.16.0.1', '172.31.255.254', '::ffff:192.168.0.8']) assert.equal(privateAddress(address), true, address);
  for (const address of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.1.1', '192.168.001.1', '192.168.1.999', '::1', 'localhost', null]) assert.equal(privateAddress(address), false, String(address));
  assert.equal(privateAddress('127.0.0.1', true), true);
});

test('no server runs until explicitly enabled; absent private networks give an actionable error', async t => {
  const service = new PhoneRemoteService({ networkInterfaces: () => ({ Public: [{ address: '8.8.8.8', family: 'IPv4', internal: false }] }) });
  t.after(() => service.stop());
  assert.equal(service.server, null);
  assert.equal(service.status().pairingUrl, '');
  await assert.rejects(service.start(), /private Wi-Fi or Ethernet/);
  assert.equal(service.status().enabled, false);
});

test('state and commands expose a strict audio-control schema', () => {
  const state = fixtureState();
  assert.deepEqual(normalizeState(state), state);
  for (const next of [
    { ...state, path: 'C:/private/file.wav' }, { ...state, volume: NaN }, { ...state, volume: 1.51 },
    { ...state, selectedBoard: 'Missing' }, { ...state, boards: ['__all__'] },
    { ...state, sounds: [...state.sounds, state.sounds[0]] },
    { ...state, sounds: [{ ...state.sounds[0], path: 'C:/private/file.wav' }] },
    { ...state, sounds: [{ ...state.sounds[0], id: '../file.wav' }] },
    { ...state, sounds: [{ ...state.sounds[0], color: 'url(https://example.com)' }] },
  ]) assert.throws(() => normalizeState(next));
  for (const input of [null, [], { type: 'play', soundId: 'missing' }, { type: 'play', soundId: 'sound_1', path: 'file.wav' }, { type: 'volume', value: '1' }, { type: 'volume', value: Infinity }, { type: 'board', board: 'missing' }, { type: 'exec', command: 'calc' }]) assert.throws(() => validateCommand(input, state));
});

test('serves only the phone webapp with restrictive browser headers', async t => {
  const f = await fixture(t);
  for (const [route, contentType] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const result = await f.request(route);
    assert.equal(result.status, 200);
    assert.ok(result.headers.get('content-type').startsWith(contentType));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-frame-options'), 'DENY');
    assert.match(result.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  for (const route of ['/main.js', '/preload.js', '/package.json', '/runtime/desktop-config.json', '/%2e%2e/main.js', '/?token=secret']) assert.equal((await f.request(route)).status, 404, route);
});

test('blocks foreign hosts, cross-site requests and unauthenticated controls', async t => {
  const f = await fixture(t);
  for (const route of ['/api/state', '/api/events']) assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request('/api/command', { method: 'POST', body: { type: 'stop-all' } })).status, 401);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.request('/', { headers })).status, 403);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: { token: f.token() }, headers: { Origin: '' } })).status, 403);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: { token: f.token() }, headers: { Origin: 'http://localhost:' + f.status.port } })).status, 403);
  assert.deepEqual(f.commands, []);
});

test('QR token stays in fragment; pairing grants an expiring HttpOnly session', async t => {
  const f = await fixture(t);
  const link = new URL(f.service.status().pairingUrl);
  assert.equal(link.search, ''); assert.match(link.hash, /^#pair=[\w-]{43}$/);
  assert.ok(!(await f.request('/')).text.includes(f.token()));
  const paired = await f.pair();
  assert.deepEqual(paired.data.state, fixtureState());
  assert.match(paired.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
  assert.equal(f.service.status().connectedPhones, 1);
  assert.deepEqual((await f.request('/api/state', { cookie: paired.cookie })).data.state, fixtureState());
});

test('invalid, expired and rotated pairing tokens cannot authorize phones', async t => {
  const f = await fixture(t);
  const oldToken = f.token();
  for (const token of ['', 'bad', 'x'.repeat(43)]) assert.equal((await f.request('/api/pair', { method: 'POST', body: { token } })).status, 401);
  f.advance(600001);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: { token: oldToken } })).status, 401);
  f.service.rotatePairing();
  assert.notEqual(f.token(), oldToken);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: { token: oldToken } })).status, 401);
  await f.pair();
});

test('pairing rotation keeps paired phones working, while session expiry revokes them', async t => {
  const f = await fixture(t, { sessionTtlMs: 1000 });
  const { cookie } = await f.pair();
  f.service.rotatePairing();
  assert.equal((await f.request('/api/state', { cookie })).status, 200);
  f.advance(1001);
  assert.equal((await f.request('/api/state', { cookie })).status, 401);
  assert.equal(f.service.status().connectedPhones, 0);
});

test('scanning the QR again replaces the same phone session without using extra slots', async t => {
  const f = await fixture(t);
  const first = await f.pair();
  const again = await f.request('/api/pair', { method: 'POST', cookie: first.cookie, body: { token: f.token() } });
  assert.equal(again.status, 200);
  assert.equal(f.service.status().connectedPhones, 1);
  assert.equal((await f.request('/api/state', { cookie: first.cookie })).status, 401);
  assert.notEqual(again.headers.get('set-cookie').split(';')[0], first.cookie);
});

test('controls dispatch only available sounds, boards and bounded volume values', async t => {
  const f = await fixture(t);
  const { cookie } = await f.pair();
  const commands = [{ type: 'play', soundId: 'sound_1' }, { type: 'volume', value: 1.5 }, { type: 'board', board: 'Reactions' }, { type: 'board', board: '__all__' }, { type: 'stop-all' }];
  for (const body of commands) assert.equal((await f.request('/api/command', { method: 'POST', cookie, body })).status, 200);
  assert.deepEqual(f.commands, commands);
  for (const body of [{ type: 'play', soundId: 'sound_1', filename: 'x' }, { type: 'play', soundId: 'not-known' }, { type: 'volume', value: -1 }, { type: 'volume', value: 2 }, { type: 'board', board: 'Unknown' }]) assert.equal((await f.request('/api/command', { method: 'POST', cookie, body })).status, 400);
  f.service.publish({ ...fixtureState(), sounds: [] });
  assert.equal((await f.request('/api/command', { method: 'POST', cookie, body: { type: 'play', soundId: 'sound_1' } })).status, 400);
  assert.deepEqual(f.commands, commands);
});

test('API reports desktop failure or missing acknowledgements instead of false success', async t => {
  const f = await fixture(t, { commandTimeoutMs: 30, onCommand: async () => ({ ok: false, error: 'Playback is disabled.' }) });
  const { cookie } = await f.pair();
  const send = () => f.request('/api/command', { method: 'POST', cookie, body: { type: 'stop-all' } });
  const failed = await send();
  assert.equal(failed.status, 409); assert.equal(failed.data.error, 'Playback is disabled.');
  f.service.onCommand = () => { throw new Error('Private internal details'); };
  const thrown = await send(); assert.equal(thrown.status, 409); assert.ok(!thrown.text.includes('Private internal'));
  f.service.onCommand = () => new Promise(() => {});
  const timed = await send(); assert.equal(timed.status, 409); assert.match(timed.data.error, /did not respond/);
});

test('stop-all remains available when pending clip starts fill the control slots', async t => {
  const waiting = [];
  const f = await fixture(t, { onCommand: command => command.type === 'stop-all' ? { ok: true } : new Promise(resolve => waiting.push(resolve)) });
  const { cookie } = await f.pair();
  const send = body => f.request('/api/command', { method: 'POST', cookie, body });
  const starts = Array.from({ length: 8 }, () => send({ type: 'play', soundId: 'sound_1' }));
  try {
    const deadline = Date.now() + 2000;
    while (waiting.length < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(waiting.length, 8);
    assert.equal((await send({ type: 'play', soundId: 'sound_1' })).status, 429);
    assert.equal((await send({ type: 'stop-all' })).status, 200);
  } finally { waiting.forEach(resolve => resolve({ ok: true })); await Promise.all(starts); }
});

test('JSON bodies, content types and pairing attempts are bounded', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: 'not-json' })).status, 400);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(3000) }) })).status, 413);
  let result;
  for (let index = 0; index < 13; index++) result = await f.request('/api/pair', { method: 'POST', body: { token: 'bad' } });
  assert.equal(result.status, 429);
  assert.equal(f.service.status().connectedPhones, 0);
});

test('SSE delivers initial and updated playback state without leaking file locations', async t => {
  const f = await fixture(t);
  const { cookie } = await f.pair();
  const live = await stream(t, f, cookie);
  assert.equal(live.response.statusCode, 200);
  await live.until(text => text.includes('Victory!'));
  const state = fixtureState(); state.volume = .25; state.sounds[0].playing = true;
  f.service.publish(state);
  await live.until(text => text.includes('"playing":true'));
  assert.ok(live.text.includes('"volume":0.25'));
  assert.doesNotMatch(live.text, /file:|C:\\|fileUrl|pairingToken|freqx_remote/);
});

test('large board updates survive normal stream backpressure', async t => {
  const f = await fixture(t);
  const { cookie } = await f.pair();
  const live = await stream(t, f, cookie);
  await live.until(text => text.includes('Victory!'));
  const sounds = Array.from({ length: 1800 }, (_, index) => ({ id: `sound_${index}`, title: `Sound ${index} ${'x'.repeat(100)}`, board: 'Main', color: '#ed3035', playing: false, favorite: false }));
  f.service.publish({ ...fixtureState(), sounds });
  await live.until(text => text.includes('Sound 1799'));
  assert.equal(live.ended, false);
  f.service.publish({ ...fixtureState(), volume: .12 });
  await live.until(text => text.includes('"volume":0.12'));
});

test('expired sessions receive no further streamed soundboard state', async t => {
  const f = await fixture(t, { sessionTtlMs: 1000 });
  const { cookie } = await f.pair();
  const live = await stream(t, f, cookie); await live.until(text => text.includes('Victory!'));
  f.advance(1001);
  f.service.publish({ ...fixtureState(), volume: .12 });
  await live.until((_text, ended) => ended);
  assert.ok(!live.text.includes('"volume":0.12'));
  assert.equal(f.service.status().connectedPhones, 0);
});

test('disconnecting a phone revokes its cookie and live stream', async t => {
  const f = await fixture(t);
  const { cookie } = await f.pair();
  const live = await stream(t, f, cookie); await live.until(text => text.includes('Victory!'));
  const result = await f.request('/api/disconnect', { method: 'POST', cookie, body: {} });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  await live.until((_text, ended) => ended);
  assert.equal((await f.request('/api/state', { cookie })).status, 401);
  assert.equal(f.service.status().connectedPhones, 0);
});

test('desktop disconnect-all revokes sessions and refreshes the pairing secret', async t => {
  const f = await fixture(t);
  const { cookie } = await f.pair(); const token = f.token();
  f.service.disconnectAll();
  assert.notEqual(f.token(), token);
  assert.equal((await f.request('/api/state', { cookie })).status, 401);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: { token } })).status, 401);
  assert.equal(f.service.status().connectedPhones, 0);
});

test('stopping closes live connections, clears state and starts a fresh session next time', async t => {
  const f = await fixture(t);
  const { cookie } = await f.pair(); const token = f.token();
  const live = await stream(t, f, cookie); await live.until(text => text.includes('Victory!'));
  await f.service.stop();
  await live.until((_text, ended) => ended);
  assert.deepEqual(f.service.state.sounds, []);
  assert.equal(f.service.status().pairingUrl, ''); assert.equal(f.service.status().connectedPhones, 0);
  const next = await f.service.start();
  assert.notEqual(new URL(next.pairingUrl).hash.slice('#pair='.length), token);
  const response = await fetch(`http://127.0.0.1:${next.port}/api/state`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 401);
});

test('stopping during startup settles both calls, releases the listener and allows a fresh start', { timeout: 3000 }, async t => {
  const service = new PhoneRemoteService({
    networkInterfaces: () => ({ Test: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }),
    bindHost: '127.0.0.1', allowLoopback: true,
  });
  t.after(() => service.stop());
  const starting = service.start();
  const canceledServer = service.server;
  const settled = await Promise.allSettled([starting, service.stop()]);
  assert.equal(settled[0].status, 'rejected');
  assert.match(settled[0].reason.message, /start canceled/);
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(service.status().enabled, false);
  assert.equal(canceledServer.listening, false);
  assert.equal(canceledServer.address(), null);
  assert.equal(service.sockets.size, 0);
  assert.equal(service.starting, false);
  const restarted = await service.start();
  assert.equal(restarted.enabled, true);
  assert.ok(restarted.port > 0);
  const response = await fetch(`http://127.0.0.1:${restarted.port}/`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  assert.equal(canceledServer.listening, false);
});

test('release configuration includes desktop controls and served mobile assets', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('runtime/**/*'));
  assert.ok(pkg.build.files.includes('phone-remote.js'));
  assert.ok(pkg.build.files.includes('phone-remote.css'));
  const fs = require('node:fs');
  for (const name of ['index.html', 'app.js', 'styles.css']) assert.ok(fs.existsSync(path.join(__dirname, '../runtime/phone-remote-web', name)));
});

test('phone IPC admits only the main app frame and untrusted publishing has no effects', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handlers = new Map(), listeners = new Map(), calls = [];
  const owner = { mainFrame: { url: 'file:///app/index.html' } };
  const context = vm.createContext({
    mainWindow: { webContents: owner },
    assertTrustedIpcSender: event => { if (!event.senderFrame?.url?.startsWith('file:///app/')) throw new Error('Untrusted'); },
    stripUrlState: value => value, getRendererUrl: () => owner.mainFrame.url,
    phoneRemoteService: {
      status: () => ({ enabled: true }), start: async () => { calls.push('start'); return { enabled: true }; },
      rotatePairing: () => { calls.push('rotate'); return {}; }, disconnectAll: () => { calls.push('disconnect'); return {}; },
      publish: state => calls.push(['publish', state]),
    },
    phoneRemoteDesktopStatus: status => status || { enabled: true }, stopPhoneRemote: () => { calls.push('stop'); return {}; },
    phoneRemoteCommands: new Map(), clearTimeout,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
  });
  vm.runInContext(source.slice(source.indexOf('  const referenceSender ='), source.indexOf('  const linkSender =')), context);
  vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('phone-remote:status'"), source.indexOf("  ipcMain.handle('voice-conversion:list'")), context);
  for (const event of [
    { sender: owner, senderFrame: { url: owner.mainFrame.url } },
    { sender: { mainFrame: owner.mainFrame }, senderFrame: owner.mainFrame },
    { sender: owner, senderFrame: { url: 'https://evil.example/' } },
  ]) {
    for (const handler of handlers.values()) await assert.rejects(async () => handler(event, {}), /main app frame|Untrusted/);
    for (const handler of listeners.values()) handler(event, { id: 'not-a-command', ok: true });
  }
  assert.deepEqual(calls, []);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  await handlers.get('phone-remote:start')(event, {});
  await assert.rejects(handlers.get('phone-remote:start')(event, { address: '127.0.0.1', port: 80 }), /Invalid/);
  listeners.get('phone-remote:publish')(event, fixtureState());
  assert.equal(calls[0], 'start'); assert.equal(calls[1][0], 'publish');
});
