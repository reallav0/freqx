'use strict';
// Production functions with controlled async boundaries; no Electron or audio hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { config: desktopConfig } = require('../runtime/desktop-config.cjs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const isolationSource = fs.readFileSync(path.join(root, 'audio/mic-isolation.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function section(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing production section: ${from}`);
  return source.slice(start, end);
}

test('developer UI and sound defaults apply only when saved preferences are missing', () => {
  const config = structuredClone(desktopConfig);
  Object.assign(config.ui.preferences, { compactMode: true, uiTheme: 'daylight', padTheme: 'candy' });
  Object.assign(config.ui.soundDefaults, { volume: 0.9, trimStart: 0.25, trimEnd: 0.5, fadeIn: 0.4, fadeOut: 0.3, favorite: true, pinned: true });
  require('../runtime/desktop-config.cjs').validateConfig(config);
  let stored;
  const context = vm.createContext({ desktopConfig: config, defaultBoardName: config.ui.defaultBoardName,
    defaultAppPreferences: config.ui.preferences, appPreferences: null, appPreferencesStorageKey: 'preferences',
    window: { localStorage: { getItem: () => stored }, FreqxCatalogId: require('../runtime/catalog-id.js') }
  });
  vm.runInContext(section(rendererSource, 'function sanitizeBoardName(', 'function getSoundMetadata('), context);
  vm.runInContext(section(rendererSource, 'function loadAppPreferences(', 'function applyAppPreferences('), context);
  context.loadAppPreferences();
  assert.equal(context.appPreferences.compactMode, true);
  assert.equal(context.appPreferences.uiTheme, 'daylight');
  const defaults = context.normalizeSoundMetadata({ name: 'Sound' });
  for (const key of ['volume', 'trimStart', 'trimEnd', 'fadeIn', 'fadeOut', 'favorite', 'pinned']) assert.equal(defaults[key], config.ui.soundDefaults[key]);
  stored = JSON.stringify({ compactMode: false, uiTheme: 'midnight', padTheme: 'mono' });
  context.loadAppPreferences();
  assert.equal(context.appPreferences.compactMode, false);
  assert.equal(context.appPreferences.uiTheme, 'midnight');
  const saved = context.normalizeSoundMetadata({ name: 'Sound' }, { volume: 0, trimStart: 0, fadeIn: 0, favorite: false, pinned: false });
  assert.equal(saved.volume, 0);
  assert.equal(saved.trimStart, 0);
  assert.equal(saved.fadeIn, 0);
  assert.equal(saved.favorite, false);
  assert.equal(saved.pinned, false);
});

test('favorites sync reports success and failure back to the account dialog', async () => {
  for (const failure of [false, true]) {
    const handlers = new Map();
    const reports = [];
    const libraryMetadata = {};
    let saved = false;
    const context = vm.createContext({ desktopConfig,
      window: {
        addEventListener: (name, handler) => handlers.set(name, handler),
        soundmuncher: { syncFavorites: async ids => {
          assert.deepEqual(Array.from(ids), ['cloud-tone']);
          if (failure) throw new Error('Network unavailable');
          return { user: { id: 'user-1' }, ids: ['cloud-tone'] };
        } },
      },
      importedLibraryItems: [
        { path: 'local.wav', metadata: { favorite: true } },
        { path: 'cloud.wav', metadata: { favorite: true, catalogId: 'cloud-tone' } },
      ],
      getSoundMetadata: item => item.metadata,
      libraryMetadata,
      saveLibraryMetadata: () => { saved = true; },
      renderImportedLibrary: () => {},
      setLibraryState: () => {},
    });
    vm.runInContext(section(rendererSource, 'let cloudAccountUserId = null;', 'function openSettings('), context);
    handlers.get('freqx-account-state')({ detail: { userId: 'user-1' } });
    await handlers.get('freqx-favorites-sync')({ detail: { complete: result => reports.push(result) } });
    assert.equal(reports.length, 1, 'The dialog receives one completion');
    if (failure) {
      assert.match(reports[0].error, /local favorites are preserved/);
      assert.equal(saved, false);
    } else {
      assert.equal(reports[0].user.id, 'user-1');
      assert.match(reports[0].message, /Favorites synced/);
      assert.equal(saved, true);
      assert.equal(libraryMetadata['cloud.wav'].favorite, true);
    }
  }
});

async function temporaryDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freqx-desktop-races-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('freqx-desktop-races-'));
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function importFixture(directory, promises) {
  const context = vm.createContext({ desktopConfig,
    fs: { ...fs, promises: { ...fs.promises, ...promises } }, path, process, pathToFileURL,
    app: { getPath: () => directory }, isSupportedAudioPath: name => path.extname(name) === '.wav',
  });
  vm.runInContext(
    section(mainSource, 'async function importAudioFilePaths(', 'function registerAudioIpc(')
    + section(mainSource, 'function getLibraryDirectory(', 'if (hasSingleInstanceLock) {'), context);
  return context;
}

test('concurrent same-name imports preserve both real files and their contents', async t => {
  const directory = await temporaryDirectory(t);
  const sourcePaths = await Promise.all(['first', 'second'].map(async name => {
    const folder = path.join(directory, name);
    await fs.promises.mkdir(folder);
    const filename = path.join(folder, 'sound.wav');
    await fs.promises.writeFile(filename, name);
    return filename;
  }));
  const gate = deferred();
  const destinations = [];
  const context = importFixture(directory, {
    copyFile: async (...args) => {
      destinations.push(args[1]);
      if (destinations.length === 2) gate.resolve();
      if (destinations.length <= 2) await gate.promise;
      return fs.promises.copyFile(...args);
    },
  });
  const results = await Promise.all(sourcePaths.map(filename => context.importAudioFilePaths([filename])));
  assert.equal(destinations[0], destinations[1], 'Force an actual destination collision');
  assert.ok(results.every(result => result.imported.length === 1 && result.skipped.length === 0));
  const imported = results.map(result => result.imported[0].path);
  assert.notEqual(imported[0], imported[1]);
  assert.deepEqual(await Promise.all(imported.map(filename => fs.promises.readFile(filename, 'utf8'))), ['first', 'second']);
});

test('protocol reservation retries a collision without claiming or deleting another import', async t => {
  const directory = await temporaryDirectory(t);
  const context = importFixture(directory);
  const library = context.getLibraryDirectory();
  const existing = path.join(library, 'sound.wav');
  let collided = false;
  // Another importer wins after the filename check, before exclusive open.
  context.fs.promises.open = async (filename, flags) => {
    if (!collided) {
      collided = true;
      await fs.promises.writeFile(filename, 'other import');
    }
    return fs.promises.open(filename, flags);
  };
  const reservation = await context.reserveLibraryDestination(library, 'sound.wav');
  assert.notEqual(reservation.destinationPath, existing);
  const stream = reservation.handle.createWriteStream();
  await require('node:stream/promises').pipeline(require('node:stream').Readable.from(['download']), stream);
  await reservation.handle.close();
  assert.equal(await fs.promises.readFile(existing, 'utf8'), 'other import');
  assert.equal(await fs.promises.readFile(reservation.destinationPath, 'utf8'), 'download');
});

test('a failed protocol download removes only its own file after a reservation collision', async t => {
  const directory = await temporaryDirectory(t);
  const context = importFixture(directory);
  const library = context.getLibraryDirectory();
  const existing = path.join(library, 'sound.wav');
  let collided = false;
  context.fs.promises.open = async (filename, flags) => {
    if (!collided) {
      collided = true;
      await fs.promises.writeFile(filename, 'keep this import');
    }
    return fs.promises.open(filename, flags);
  };
  Object.assign(context, {
    Transform: require('node:stream').Transform,
    pipeline: require('node:stream/promises').pipeline,
    parseRemoteAudioUrl: value => new URL(value), publicDnsLookup() {},
    getHeaderText: value => String(value || ''), normalizeContentTypeHeader: value => value,
    getExternalImportFileName: () => 'sound.wav', isAllowedRemoteAudioResponse: () => true,
    normalizeExternalImportError: error => error,
    createExternalImportError: message => new Error(message),
    maxRemoteAudioBytes: 1024, maxRemoteAudioRedirects: 5, remoteAudioRequestTimeoutMs: 30000,
    packageMetadata: { name: 'freqx' },
    https: { get(_url, _options, callback) {
      const request = new (require('node:events').EventEmitter)();
      request.setTimeout = () => {};
      queueMicrotask(() => {
        const response = require('node:stream').Readable.from((async function* () {
          yield Buffer.from('partial audio');
          throw new Error('download interrupted');
        })());
        response.statusCode = 200;
        response.headers = { 'content-type': 'audio/wav' };
        callback(response);
      });
      return request;
    } },
  });
  context.app.getVersion = () => '1.8.0';
  vm.runInContext(section(mainSource, 'function createByteLimitTransform(', 'async function importAudioFromProtocolRequest('), context);
  await assert.rejects(context.downloadRemoteAudioToLibrary({ sourceUrl: 'https://fixture.invalid/sound.wav' }), /download interrupted/);
  assert.deepEqual(await fs.promises.readdir(library), ['sound.wav']);
  assert.equal(await fs.promises.readFile(existing, 'utf8'), 'keep this import');
});

function playbackFixture(mode, { delayedEngine = false } = {}) {
  const decode = deferred();
  const engine = deferred();
  const starts = [];
  const messages = [];
  let decodes = 0;
  const makeNode = () => {
    const listeners = new Map();
    return {
      playbackRate: {}, connect() {}, disconnect() {},
      addEventListener: (name, callback) => listeners.set(name, callback),
      start() { starts.push(this); },
      stop() { this.stopped = true; },
      end() { listeners.get('ended')?.(); },
    };
  };
  const audioContext = {
    currentTime: 0, createBufferSource: makeNode,
    createGain: () => ({ ...makeNode(), gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }),
  };
  const item = { path: 'fixture.wav', name: 'Fixture' };
  const context = vm.createContext({ desktopConfig,
    audioContext: delayedEngine ? null : audioContext, activeSoundNodes: new Set(), pendingSoundStarts: new Set(),
    getSoundMetadata: () => ({ name: 'Fixture', playbackMode: mode, trimStart: 0, trimEnd: 0, volume: 1, fadeIn: 0, fadeOut: 0 }),
    decodeImportedAudio: () => { decodes++; return decode.promise; }, soundGainNode: {},
    discoverUi: null, nowPlaying: {}, importedLibraryItems: [item], syncSoundPlaybackVisuals() {},
    setLibraryState: message => messages.push(message),
  });
  context.setupMixer = async () => { await engine.promise; context.audioContext = audioContext; };
  vm.runInContext(section(rendererSource, 'function trackSoundNode(', 'function setRouteState('), context);
  return { context, item, decode, engine, starts, messages, decodes: () => decodes, play: () => context.playImportedSound(item) };
}

test('Stop all cancels loading playback while allowing a subsequent press', async () => {
  const fixture = playbackFixture('overlap');
  const cancelled = fixture.play();
  fixture.context.stopAllSounds();
  const subsequent = fixture.play();
  fixture.decode.resolve({ duration: 1 });
  await Promise.all([cancelled, subsequent]);
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.context.pendingSoundStarts.size, 0);
  fixture.context.stopAllSounds();
  assert.equal(fixture.starts[0].stopped, true);
});

test('Stop all during engine startup cancels playback before decoding', async () => {
  const fixture = playbackFixture('overlap', { delayedEngine: true });
  const pending = fixture.play();
  fixture.context.stopAllSounds();
  fixture.engine.resolve();
  await pending;
  assert.equal(fixture.decodes(), 0);
  assert.equal(fixture.starts.length, 0);
});

test('play once reserves pending playback and becomes available after ending', async () => {
  const fixture = playbackFixture('once', { delayedEngine: true });
  const first = fixture.play();
  await fixture.play();
  fixture.engine.resolve();
  fixture.decode.resolve({ duration: 1 });
  await first;
  await fixture.play();
  assert.equal(fixture.decodes(), 1);
  assert.equal(fixture.starts.length, 1);
  fixture.starts[0].end();
  await fixture.play();
  assert.equal(fixture.starts.length, 2);
});

test('restart replaces pending playback; loop toggles pending and active playback', async () => {
  const restart = playbackFixture('restart');
  const previous = restart.play();
  const replacement = restart.play();
  restart.decode.resolve({ duration: 1 });
  await Promise.all([previous, replacement]);
  assert.equal(restart.starts.length, 1);
  const loop = playbackFixture('loop');
  const pending = loop.play();
  await loop.play();
  loop.decode.resolve({ duration: 1 });
  await pending;
  assert.equal(loop.starts.length, 0);
  await loop.play();
  assert.equal(loop.starts[0].loop, true);
  await loop.play();
  assert.equal(loop.starts[0].stopped, true);
});

test('overlap still allows simultaneous sounds; decode errors release play-once reservations', async () => {
  const overlap = playbackFixture('overlap');
  const pending = [overlap.play(), overlap.play()];
  overlap.decode.resolve({ duration: 1 });
  await Promise.all(pending);
  assert.equal(overlap.starts.length, 2);
  const once = playbackFixture('once');
  const failed = once.play();
  once.decode.reject(new Error('invalid audio'));
  await failed;
  once.context.decodeImportedAudio = async () => ({ duration: 1 });
  await once.play();
  assert.equal(once.starts.length, 1);
  assert.equal(once.context.pendingSoundStarts.size, 0);
});

function isolationFixture(t, { failAssets = false, deferModel = false, needsRawCapture = false } = {}) {
  const aec = deferred();
  const loopback = deferred();
  const moduleLoad = deferred();
  moduleLoad.resolve();
  const edges = [];
  const worklets = [];
  const released = [];
  const rawCapture = deferred();
  let captureRequests = 0;
  const referenceTrack = { readyState: 'live', addEventListener() {}, removeEventListener() {} };
  const track = { readyState: 'live', addEventListener() {}, removeEventListener() {} };
  const rawEvents = new Map();
  const rawTrack = { readyState: 'live', label: 'Physical mic', getSettings: () => ({ echoCancellation: false }),
    addEventListener: (name, callback) => rawEvents.set(name, callback), removeEventListener: name => rawEvents.delete(name),
    stop() { this.readyState = 'ended'; }
  };
  const rawStream = { getAudioTracks: () => [rawTrack], getTracks: () => [rawTrack] };
  if (needsRawCapture) {
    track.label = 'Physical mic';
    track.getSettings = () => ({ deviceId: 'physical', echoCancellation: true });
    track.applyConstraints = async constraints => { if (!constraints.echoCancellation.exact) throw new Error('Cannot switch existing capture AEC'); };
  }
  const stream = { getAudioTracks: () => [track] };
  const makeNode = name => ({
    name, connect(target) { edges.push([name, target.name]); return target; },
    disconnect() {}, addEventListener() {}, removeEventListener() {},
  });
  class Context {
    constructor() {
      this.sampleRate = 48000; this.state = 'running';
      this.audioWorklet = { addModule: url => url.includes('aec-worklet') ? aec.promise : moduleLoad.promise };
    }
    addEventListener() {} removeEventListener() {}
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamDestination() { return { ...makeNode('destination'), stream: { getTracks: () => [{ stop() {} }] } }; }
    createMediaStreamSource(input) { return makeNode(input === stream ? 'mic' : input === rawStream ? 'raw-mic' : 'reference'); }
  }
  class Worklet {
    constructor(context, name) {
      Object.assign(this, makeNode(name));
      worklets.push(this);
      this.port = {
        onmessage: null, close() {}, postMessage: message => {
          if (message.type === 'destroy') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'destroyed' } }));
        },
      };
      if (name === 'freqx-aec' || (name === 'freqx-voice-isolation' && !deferModel)) queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } }));
    }
  }
  const events = new Map();
  const window = {
    addEventListener: (name, callback) => events.set(name, callback),
    FreqxDesktopConfig: { current: desktopConfig, ready: Promise.resolve(desktopConfig) },
    LoopbackReference: { acquire: () => loopback.promise, release: value => released.push(value) },
  };
  const context = vm.createContext({ desktopConfig,
    window, document: { currentScript: { src: 'file:///audio/mic-isolation.js' } }, URL, Uint8Array,
    AudioContext: Context, AudioWorkletNode: Worklet,
    WebAssembly: { validate: () => true, compile: async () => ({}) },
    fetch: async () => {
      if (failAssets) throw new Error('asset missing');
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    navigator: { mediaDevices: { getUserMedia: () => { captureRequests++; return rawCapture.promise; } } },
    setTimeout, clearTimeout, setInterval, clearInterval, DOMException, console: { warn() {}, info() {} },
  });
  vm.runInContext(isolationSource, context);
  t.after(() => events.get('pagehide')?.());
  return { aec, loopback, edges, worklets, released, referenceTrack, rawCapture, rawTrack, rawStream, track, rawEvents,
    get captureRequests() { return captureRequests; }, create: options => window.MicVoiceIsolation.create(stream, options) };
}

test('isolation waits for delayed AEC setup before connecting mic and reference', async t => {
  const fixture = isolationFixture(t);
  fixture.loopback.resolve(fixture.referenceTrack);
  let completed = false;
  const pending = fixture.create().then(session => { completed = true; return session; });
  await tick();
  assert.equal(completed, false);
  fixture.aec.resolve();
  const session = await pending;
  assert.ok(fixture.edges.some(([from, to]) => from === 'mic' && to === 'freqx-aec'));
  assert.ok(fixture.edges.some(([from, to]) => from === 'reference' && to === 'freqx-aec'));
  assert.ok(!fixture.edges.some(([from, to]) => from === 'mic' && to === 'freqx-voice-isolation'));
  session.close();
  assert.deepEqual(fixture.released, [fixture.referenceTrack]);
});

test('isolation also waits when model readiness arrives after the graph is built', async t => {
  const fixture = isolationFixture(t, { deferModel: true });
  fixture.loopback.resolve(fixture.referenceTrack);
  fixture.aec.resolve();
  let completed = false;
  const pending = fixture.create().then(session => { completed = true; return session; });
  await tick();
  assert.equal(completed, false);
  fixture.worklets[0].port.onmessage({ data: { type: 'ready' } });
  const session = await pending;
  assert.ok(fixture.edges.some(([from, to]) => from === 'mic' && to === 'freqx-aec'));
  session.close();
});

test('failed AEC setup releases loopback and keeps DeepFilterNet usable', async t => {
  const fixture = isolationFixture(t);
  fixture.loopback.resolve(fixture.referenceTrack);
  const pending = fixture.create();
  await tick();
  fixture.aec.reject(new Error('AEC module unavailable'));
  const session = await pending;
  assert.ok(fixture.edges.some(([from, to]) => from === 'mic' && to === 'freqx-voice-isolation'));
  assert.deepEqual(fixture.released, [fixture.referenceTrack]);
  session.close();
  assert.equal(fixture.released.length, 1);
});

test('asset failure releases a loopback capture that arrives after startup rejects', async t => {
  const fixture = isolationFixture(t, { failAssets: true });
  await assert.rejects(fixture.create(), /asset missing/);
  fixture.loopback.resolve(fixture.referenceTrack);
  await tick();
  assert.deepEqual(fixture.released, [fixture.referenceTrack]);
  assert.equal(fixture.worklets.length, 0);
});

test('cancellation releases late loopback captures and stops delayed AEC setup', async t => {
  for (const cancelDuringAec of [false, true]) {
    const fixture = isolationFixture(t);
    const controller = new AbortController();
    const pending = fixture.create({ signal: controller.signal });
    // Configuration readiness is an async boundary before capture is acquired.
    await tick();
    if (cancelDuringAec) {
      fixture.loopback.resolve(fixture.referenceTrack);
      await tick();
    }
    controller.abort();
    await assert.rejects(pending, /canceled/);
    fixture.loopback.resolve(fixture.referenceTrack);
    fixture.aec.resolve();
    await tick();
    assert.deepEqual(fixture.released, [fixture.referenceTrack]);
    assert.ok(!fixture.edges.some(([from]) => from === 'mic'));
  }
});

test('model failure during delayed AEC setup rejects startup and releases the capture', async t => {
  const fixture = isolationFixture(t);
  fixture.loopback.resolve(fixture.referenceTrack);
  const pending = fixture.create();
  await tick();
  fixture.worklets[0].port.onmessage({ data: { type: 'error', message: 'model failed' } });
  await assert.rejects(pending, /model failed/);
  fixture.aec.resolve();
  await tick();
  assert.deepEqual(fixture.released, [fixture.referenceTrack]);
  assert.ok(!fixture.edges.some(([from]) => from === 'mic'));
});

test('AEC3 owns unprocessed capture when the protected microphone cannot switch AEC', async t => {
  const fixture = isolationFixture(t, { needsRawCapture: true });
  fixture.loopback.resolve(fixture.referenceTrack); fixture.aec.resolve(); fixture.rawCapture.resolve(fixture.rawStream);
  const session = await fixture.create();
  assert.equal(session.inputSettings.echoCancellation, false);
  assert.ok(fixture.edges.some(([from, to]) => from === 'raw-mic' && to === 'freqx-aec'));
  fixture.rawEvents.get('ended')();
  assert.equal(session.diagnostics.engine, 'Chromium AEC');
  assert.ok(fixture.edges.some(([from, to]) => from === 'mic' && to === 'freqx-voice-isolation'));
  assert.equal(fixture.rawTrack.readyState, 'ended');
  assert.equal(fixture.track.readyState, 'live');
  session.close();
});
test('cancel during raw capture acquisition releases the late stream and never routes it', async t => {
  const fixture = isolationFixture(t, { needsRawCapture: true });
  fixture.loopback.resolve(fixture.referenceTrack); fixture.aec.resolve();
  const controller = new AbortController(); const pending = fixture.create({ signal: controller.signal });
  await tick(); assert.equal(fixture.captureRequests, 1);
  controller.abort(); await assert.rejects(pending, /canceled/);
  fixture.rawCapture.resolve(fixture.rawStream); await tick();
  assert.equal(fixture.rawTrack.readyState, 'ended');
  assert.equal(fixture.track.readyState, 'live');
  assert.ok(!fixture.edges.some(([from]) => from === 'raw-mic'));
});
test('denied unprocessed capture falls back to the protected microphone and releases reference', async t => {
  const fixture = isolationFixture(t, { needsRawCapture: true });
  fixture.loopback.resolve(fixture.referenceTrack); fixture.aec.resolve();
  const pending = fixture.create(); await tick(); fixture.rawCapture.reject(new Error('Permission denied'));
  const session = await pending;
  assert.equal(session.diagnostics.engine, 'Chromium AEC');
  assert.deepEqual(fixture.released, [fixture.referenceTrack]);
  assert.ok(fixture.edges.some(([from, to]) => from === 'mic' && to === 'freqx-voice-isolation'));
  session.close();
});
test('reference ending during raw capture acquisition cannot activate AEC3 with a dead reference', async t => {
  const fixture = isolationFixture(t, { needsRawCapture: true });
  fixture.loopback.resolve(fixture.referenceTrack); fixture.aec.resolve();
  const pending = fixture.create(); await tick();
  fixture.referenceTrack.readyState = 'ended'; fixture.rawCapture.resolve(fixture.rawStream);
  const session = await pending;
  assert.equal(session.diagnostics.engine, 'Chromium AEC');
  assert.equal(fixture.rawTrack.readyState, 'ended');
  assert.ok(!fixture.edges.some(([from, to]) => from === 'raw-mic' && to === 'freqx-aec'));
  session.close();
});
