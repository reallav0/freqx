'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { bump } = require('../scripts/release-version.cjs');
const { getReleaseState, prepareRelease } = require('../scripts/release-state.cjs');
const { generate } = require('../scripts/release-artifacts.cjs');
const { createUpdateClient, verifyDownload } = require('../runtime/update-client.cjs');
test('Windows distribution builds the setup installer only', () => {
  const { build } = require('../package.json');
  assert.deepEqual(build.win.target, ['nsis']);
  assert.equal(build.portable, undefined);
});
test('release checksums exclude leftover portable builds while retaining updater files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-release-artifacts-'));
  try {
    await fs.mkdir(path.join(directory, 'audio/vendor/deepfilter'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '2.0.4' }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version: '44.5.1' } } }));
    await fs.writeFile(path.join(directory, 'audio/vendor/deepfilter/manifest.json'), JSON.stringify({ files: {} }));
    await fs.writeFile(path.join(directory, 'SBOM.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', components: [] }));
    for (const filename of ['FreqX-Setup-2.0.4.exe', 'FreqX-Setup-2.0.4.exe.blockmap', 'latest.yml', 'FreqX-Portable-2.0.4.exe']) await fs.writeFile(path.join(directory, filename), filename);
    assert.deepEqual(generate(directory, directory), ['FreqX-Setup-2.0.4.exe', 'FreqX-Setup-2.0.4.exe.blockmap', 'SBOM.cdx.json', 'latest.yml']);
    const sums = await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
    assert.ok(sums.includes('FreqX-Setup-2.0.4.exe')); assert.ok(!sums.includes('Portable'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('release lookup treats a missing release as a successful unpublished state', () => {
  const run = args => {
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    assert.ok(args.includes('owner=reallav0')); assert.ok(args.includes('name=freqx')); assert.ok(args.includes('tag=v2.0.3'));
    return JSON.stringify({ data: { repository: { release: null } } });
  };
  assert.deepEqual(getReleaseState('reallav0/freqx', 'v2.0.3', run), { exists: false, published: false });
});
test('release lookup distinguishes drafts from published releases', () => {
  for (const isDraft of [true, false]) {
    const run = () => JSON.stringify({ data: { repository: { release: { isDraft } } } });
    assert.deepEqual(getReleaseState('reallav0/freqx', 'v2.0.3', run), { exists: true, published: !isDraft });
  }
});
test('release lookup fails on CLI errors, GraphQL errors and malformed responses', () => {
  for (const message of ['authentication failed', 'network unavailable', 'rate limit exceeded']) {
    assert.throws(() => getReleaseState('reallav0/freqx', 'v2.0.3', () => { throw new Error(message); }), new RegExp(message));
  }
  for (const response of [{ errors: [{ message: 'denied' }], data: { repository: { release: null } } }, { data: { repository: null } }, {}, { data: { repository: {} } }, { data: { repository: { release: { isDraft: 'false' } } } }]) {
    assert.throws(() => getReleaseState('reallav0/freqx', 'v2.0.3', () => JSON.stringify(response)), /lookup failed|invalid release/);
  }
  assert.throws(() => getReleaseState('reallav0/freqx', 'v2.0.3', () => 'not JSON'), SyntaxError);
});
test('release preparation creates only missing drafts and refuses published artifacts', () => {
  for (const release of [null, { isDraft: true }, { isDraft: false }]) {
    const commands = [];
    const run = args => { commands.push(args); return JSON.stringify({ data: { repository: { release } } }); };
    if (release?.isDraft === false) assert.throws(() => prepareRelease('reallav0/freqx', 'v2.0.3', run), /already published/);
    else prepareRelease('reallav0/freqx', 'v2.0.3', run);
    assert.equal(commands.length, release === null ? 2 : 1);
    if (release === null) assert.deepEqual(commands[1], ['release', 'create', 'v2.0.3', '--repo', 'reallav0/freqx', '--verify-tag', '--draft', '--generate-notes', '--title', 'FreqX v2.0.3']);
  }
});
test('release preparation stops on lookup and draft creation failures', () => {
  let calls = 0;
  assert.throws(() => prepareRelease('reallav0/freqx', 'v2.0.3', () => { calls++; throw new Error('lookup unavailable'); }), /lookup unavailable/);
  assert.equal(calls, 1);
  assert.throws(() => prepareRelease('reallav0/freqx', 'v2.0.3', args => {
    if (args[0] === 'api') return JSON.stringify({ data: { repository: { release: null } } });
    throw new Error('creation denied');
  }), /creation denied/);
});
test('runtime update feed matches the release publisher independently of build metadata', () => {
  const metadata = require('../package.json');
  assert.deepEqual(require('../runtime/desktop-config.cjs').config.updater.feed, metadata.build.publish);
  assert.ok(metadata.build.files.includes('runtime/**/*'), 'runtime update configuration ships in releases');
});
test('patch release updates both authoritative versions and rejects inconsistent locks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-release-test-'));
  try {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.4.2' }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '1.4.2', packages: { '': { version: '1.4.2' } } }));
    assert.equal(bump(directory), '1.4.3'); assert.equal(bump(directory), '1.4.4');
    const lock = JSON.parse(await fs.readFile(path.join(directory, 'package-lock.json'))); assert.equal(lock.packages[''].version, '1.4.4');
    lock.version = 'broken'; await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    assert.throws(() => bump(directory), /inconsistent/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('update verification rejects missing checksums and altered installer bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-update-test-'));
  try {
    const filename = path.join(directory, 'FreqX-Setup-1.8.1.exe'); const bytes = Buffer.from('fixture executable bytes');
    await fs.writeFile(filename, bytes);
    const info = { version: '1.8.1', downloadedFile: filename, files: [{ url: path.basename(filename), sha512: createHash('sha512').update(bytes).digest('base64') }] };
    await verifyDownload(info);
    await assert.rejects(verifyDownload({ ...info, files: [] }), /checksum/);
    await fs.writeFile(filename, 'tampered'); await assert.rejects(verifyDownload(info), /checksum/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('updater uses trusted configuration, blocks unverified installation and contains network failure', async () => {
  const updater = new EventEmitter(); let configuration; let installs = 0;
  updater.setFeedURL = input => { configuration = input; }; updater.quitAndInstall = () => { installs++; };
  updater.checkForUpdates = async () => { throw new Error('network error including a sensitive URL'); };
  const client = createUpdateClient({ app: { isPackaged: true, getVersion: () => '1.8.0' }, getWindow: () => null, updater, config: { provider: 'github', owner: 'reallav0', repo: 'freqx' } });
  if (process.platform === 'win32') {
    assert.equal(configuration.provider, 'github'); assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal((await client.check()).ok, false); assert.ok(!JSON.stringify(client.status()).includes('sensitive'));
    updater.emit('update-downloaded', { files: [] }); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(client.install().ok, false); assert.equal(installs, 0);
});

test('background download failure is contained without delaying Check and a verified retry installs only once', { skip: process.platform !== 'win32', timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-update-retry-'));
  try {
    const filename = path.join(directory, 'FreqX-Setup-2.0.9.exe'), bytes = Buffer.from('isolated installer fixture');
    await fs.writeFile(filename, bytes);
    const info = { version: '2.0.9', downloadedFile: filename, files: [{ url: path.basename(filename), sha512: createHash('sha512').update(bytes).digest('base64') }] };
    const updater = new EventEmitter(), states = []; let installs = 0, rejectDownload, verified;
    updater.setFeedURL = () => {}; updater.quitAndInstall = (...args) => { assert.deepEqual(args, [false, true]); installs++; };
    updater.checkForUpdates = async () => {
      updater.emit('checking-for-update'); updater.emit('update-available', info);
      return { downloadPromise: new Promise((resolve, reject) => { rejectDownload = reject; }) };
    };
    const client = createUpdateClient({ app: { isPackaged: true, getVersion: () => '2.0.8' },
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, state) => { states.push(state); if (state.status === 'downloaded') verified?.(); } } }),
      updater, config: { provider: 'github', owner: 'reallav0', repo: 'freqx' } });
    assert.equal((await client.check()).status, 'available', 'Check must resolve while the download is still pending');
    assert.equal(client.install().ok, false);
    // Real electron-updater returns downloadPromise separately from its check.
    // The rejection must be observed even without an accompanying error event.
    rejectDownload(new Error('Fixture download failed with private details'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.status().status, 'error'); assert.equal(states.at(-1).status, 'error');
    assert.ok(!JSON.stringify(client.status()).includes('private details'));
    assert.equal(client.install().ok, false); assert.equal(installs, 0);
    updater.checkForUpdates = async () => {
      updater.emit('checking-for-update'); updater.emit('update-available', info);
      setImmediate(() => updater.emit('update-downloaded', info));
      return { downloadPromise: Promise.resolve([filename]) };
    };
    const downloaded = new Promise(resolve => { verified = resolve; });
    assert.equal((await client.check()).ok, true);
    await downloaded;
    assert.equal(client.status().status, 'downloaded'); assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(client.install().ok, true); assert.equal(client.install().ok, false); assert.equal(installs, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('late checksum verification cannot authorize installation after a newer failure', async () => {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = path.join(__dirname, '../runtime/update-client.cjs'), source = await fs.readFile(filename, 'utf8'), localRequire = createRequire(filename);
  const bytes = Buffer.from('gated verified installer'), sha512 = createHash('sha512').update(bytes).digest('base64');
  for (const failure of ['error', 'new-download']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const isolatedFs = { promises: { lstat: async () => ({ size: bytes.length, isFile: () => true, isSymbolicLink: () => false }) },
      createReadStream: async function* () { await gate; yield bytes; } };
    const loaded = { exports: {} };
    vm.runInNewContext(source, { module: loaded, Buffer, URL, process: { platform: 'win32' },
      require: name => name === 'node:fs' ? isolatedFs : localRequire(name) });
    const updater = new EventEmitter(); let installs = 0;
    updater.setFeedURL = () => {}; updater.quitAndInstall = () => { installs++; };
    const client = loaded.exports.createUpdateClient({ app: { isPackaged: true, getVersion: () => '2.0.8' }, getWindow: () => null,
      updater, config: { provider: 'github', owner: 'reallav0', repo: 'freqx' } });
    updater.emit('update-downloaded', { version: '2.0.9', downloadedFile: path.join(os.tmpdir(), 'FreqX-Setup-2.0.9.exe'), files: [{ url: 'FreqX-Setup-2.0.9.exe', sha512 }] });
    await new Promise(resolve => setImmediate(resolve));
    if (failure === 'error') updater.emit('error', new Error('Newer update failed.'));
    else {
      updater.emit('update-available', { version: '2.0.10' });
      updater.emit('update-downloaded', { version: '2.0.10', downloadedFile: path.join(os.tmpdir(), 'FreqX-Setup-2.0.10.exe'), files: [] });
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.status().status, 'error');
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.status().status, 'error', `${failure}: stale verification must not replace the newer error`);
    assert.equal(client.install().ok, false); assert.equal(installs, 0);
  }
});

test('automatic checks run at startup and periodically, preserve active downloads, retry failures and stop cleanly', { skip: process.platform !== 'win32' }, async () => {
  const tasks = new Set(), updater = new EventEmitter(); let checks = 0, fail = false;
  const timers = {
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; tasks.add(timer); return timer; },
    clearTimeout(timer) { tasks.delete(timer); }
  };
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {
    checks++; updater.emit('checking-for-update');
    if (fail) throw new Error('Offline');
    updater.emit('update-not-available'); return {};
  };
  const client = createUpdateClient({ app: { isPackaged: true, getVersion: () => '2.0.8' }, getWindow: () => null,
    updater, config: { provider: 'github', owner: 'reallav0', repo: 'freqx' } });
  const runNext = async delay => {
    const timer = tasks.values().next().value; assert.equal(timer.delay, delay);
    tasks.delete(timer); timer.callback(); await new Promise(resolve => setImmediate(resolve));
  };
  const startup = 5000, interval = 6 * 60 * 60 * 1000;
  const stop = client.startChecks(timers); assert.equal(checks, 0);
  await runNext(startup); assert.equal(checks, 1);
  await runNext(interval); assert.equal(checks, 2);
  updater.emit('update-available', { version: '2.0.9' });
  await runNext(interval); assert.equal(checks, 2, 'periodic checks cannot invalidate an available update');
  updater.emit('download-progress', { percent: 50 });
  await runNext(interval); assert.equal(checks, 2, 'periodic checks cannot restart an active download');
  updater.emit('error', new Error('Download interrupted')); fail = true;
  await runNext(interval); assert.equal(checks, 3); assert.equal(client.status().status, 'error');
  fail = false; await runNext(interval); assert.equal(checks, 4); assert.equal(client.status().status, 'none');
  stop(); stop(); assert.equal(tasks.size, 0);
  const stopAgain = client.startChecks(timers); client.startChecks(timers);
  assert.equal(tasks.size, 1, 'starting twice replaces the previous schedule');
  stopAgain(); assert.equal(tasks.size, 1, 'an older stop handle cannot cancel a newer schedule');
  client.startChecks(timers)(); assert.equal(tasks.size, 0);
});

test('automatic checks do not create timers in source or portable builds', () => {
  const timers = { setTimeout() { throw new Error('Unsupported updates must stay idle.'); }, clearTimeout() {} };
  for (const options of [{ isPackaged: false, portable: false }, { isPackaged: true, portable: true }]) {
    const client = createUpdateClient({ app: { isPackaged: options.isPackaged, getVersion: () => '2.0.8' },
      getWindow: () => null, updater: null, portable: options.portable });
    const stop = client.startChecks(timers); stop();
    assert.equal(client.status().status, 'idle');
  }
});

test('a closing renderer cannot crash the updater or discard its latest state', { skip: process.platform !== 'win32' }, async () => {
  const updater = new EventEmitter(); let closed = false, deliveries = 0;
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => { updater.emit('checking-for-update'); updater.emit('update-not-available'); return {}; };
  const client = createUpdateClient({ app: { isPackaged: true, getVersion: () => '2.0.8' },
    getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => closed,
      send() { deliveries++; throw new Error('Renderer closed before delivery.'); } } }),
    updater, config: { provider: 'github', owner: 'reallav0', repo: 'freqx' } });
  assert.equal((await client.check()).status, 'none'); assert.equal(deliveries, 2);
  closed = true; updater.emit('update-available', { version: '2.0.9' });
  assert.equal(client.status().status, 'available'); assert.equal(client.status().latestVersion, '2.0.9');
  assert.equal(deliveries, 2, 'destroyed contents are never sent more notifications');
});
