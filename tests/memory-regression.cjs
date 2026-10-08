/* Real renderer memory/lifecycle stress fixture; never uses a user profile or physical microphone. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'memory-regression');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 240000 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else if (process.type === 'renderer') installFixtures();
else run().catch(error => { console.error(error); require('electron').app.exit(1); });

function installFixtures() {
  const stats = window.__memoryTest = { crashes: [], contexts: [], worklets: [], captures: 0, initialized: false };
  const NativeContext = AudioContext;
  window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
    const context = new Target({ ...args[0], sinkId: { type: 'none' } });
    stats.contexts.push(new WeakRef(context));
    return context;
  } });
  NativeContext.prototype.setSinkId = async () => {};
  const NativeWorklet = AudioWorkletNode;
  window.AudioWorkletNode = new Proxy(NativeWorklet, { construct(Target, args) {
    const node = new Target(...args); stats.worklets.push(new WeakRef(node)); return node;
  } });
  const devices = [
    { deviceId: 'memory-mic', kind: 'audioinput', label: 'Fixture microphone', groupId: 'mic' },
    { deviceId: 'memory-headphones', kind: 'audiooutput', label: 'Fixture headphones', groupId: 'headphones' },
  ];
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => devices });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
    stats.captures++;
    const context = new AudioContext({ sampleRate: 48000 });
    const source = context.createConstantSource(); source.offset.value = 0;
    const destination = context.createMediaStreamDestination(); source.connect(destination); source.start(); await context.resume();
    const stream = destination.stream;
    for (const track of stream.getTracks()) {
      const stop = track.stop.bind(track); let stopped = false;
      track.stop = () => { if (stopped) return; stopped = true; stop(); source.stop(); source.disconnect(); void context.close(); };
    }
    return stream;
  } });
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    value: async () => { throw new DOMException('Fixture display capture unavailable.', 'NotAllowedError'); },
  });
  localStorage.clear();
  localStorage.setItem('soundmuncher:walkthrough-complete:v1', 'true');
  localStorage.setItem('soundmuncher:mixer-settings', JSON.stringify({ voiceIsolation: false, inputDeviceId: 'memory-mic', outputDeviceId: 'memory-headphones', localPlaybackDeviceId: 'memory-headphones' }));
  const noop = async () => ({ ok: true });
  window.soundmuncher = {
    appName: 'freqx', websiteUrl: 'https://freqx.app', reportCrash: async report => { stats.crashes.push(report); return report; },
    getAppSettings: async () => ({ keepRunningInTray: false, launchOnStartup: false }), setAppSettings: async settings => ({ settings }),
    listImportedFiles: async () => Array.from({ length: 40 }, (_, index) => ({ path: `fixture:${index}`, name: `Sound ${index}`, sizeBytes: 96044, fileUrl: require('node:url').pathToFileURL(path.join(output, 'tone.wav')).href })),
    registerGlobalKeybinds: async () => ({ failed: [] }), listOutputDevices: async () => [], importAudioFiles: async () => ({ canceled: true, files: [] }),
    removeImportedFile: noop, sendTestTone: noop, openLibraryFolder: noop, openWebsite: noop,
    externalImportsReady: async () => { stats.initialized = true; }, checkForUpdates: async () => ({ updateAvailable: false, currentVersion: '1.8.0' }),
    openUpdatePage: noop, reloadAfterCrash: noop, openCrashLog: noop, quitAfterCrash: noop,
    onGlobalKeybindTriggered: () => () => {}, onExternalImportStarted: () => () => {}, onExternalImportCompleted: () => () => {}, onFatalError: () => () => {},
  };
}

async function run() {
  console.log('memory fixture main starting');
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.on('window-all-closed', () => {});
  const wave = Buffer.alloc(44 + 48000 * 2); wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8);
  wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  fs.writeFileSync(path.join(output, 'tone.wav'), wave);
  await app.whenReady();
  console.log('memory fixture app ready');
  const win = new BrowserWindow({ show: false, width: 1200, height: 760, webPreferences: { preload: __filename, contextIsolation: false, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on('preload-error', (_, __, error) => console.error('preload error', error));
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_, callback) => callback({ cancel: true }));
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  await win.loadFile(path.join(root, 'index.html'));
  console.log('memory fixture page loaded');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  for (let i = 0; i < 100 && !(await evaluate('window.__memoryTest?.initialized')); i++) await pause(50);
  const snapshots = [];
  async function sample(label, collect = false) {
    if (collect) await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
    await pause(300);
    const runtime = await evaluate(`(() => ({ contextsCreated: __memoryTest.contexts.length, contextsRetained: __memoryTest.contexts.filter(ref => ref.deref()).length, contextsRunning: __memoryTest.contexts.filter(ref => ref.deref()?.state === 'running').length, workletsCreated: __memoryTest.worklets.length, workletsRetained: __memoryTest.worklets.filter(ref => ref.deref()).length, captures: __memoryTest.captures, crashes: __memoryTest.crashes.length, activeSounds: activeSoundNodes.size }))()`);
    const dom = await win.webContents.debugger.sendCommand('Memory.getDOMCounters');
    const metrics = (await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics;
    const memory = app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetMiB: Math.round(memory.workingSetSize / 1024), privateMiB: Math.round((memory.privateBytes || 0) / 1024) }));
    const value = { label, runtime, dom, heapMiB: Math.round(metrics.find(value => value.name === 'JSHeapUsedSize').value / 1048576 * 10) / 10, memory };
    snapshots.push(value); console.log(JSON.stringify(value)); return value;
  }
  const initial = await sample('initial', true);
  const cycles = Number(process.env.FREQX_MEMORY_CYCLES || 20);
  for (let batch = 0; batch < 3; batch++) {
    await evaluate(`(async () => { for(let i=0;i<${cycles};i++) { openSettingsButton.click(); uiThemeSelect.value=i%2?'midnight':'light'; uiThemeSelect.dispatchEvent(new Event('change')); closeSettingsButton.click(); toggleFavoritesViewButton.click(); toggleFavoritesViewButton.click(); await new Promise(resolve=>setTimeout(resolve,20)); } })()`);
    await sample(`ui-${(batch + 1) * cycles}`, true);
  }
  await evaluate('setVoiceIsolationMode("high-quality")'); await pause(400);
  await sample('isolation-start', true);
  for (let batch = 0; batch < 3; batch++) {
    await evaluate(`(async () => { for(let i=0;i<${cycles};i++) { await setVoiceIsolationMode('off'); await setVoiceIsolationMode('high-quality'); } })()`);
    const current = await sample(`isolation-${(batch + 1) * cycles}`, true);
    assert.ok(current.runtime.contextsRunning <= initial.runtime.contextsRunning + 1, 'Repeated modes must not accumulate live audio contexts');
    assert.equal(current.runtime.captures, initial.runtime.captures, 'Mode switches must reuse microphone capture');
    assert.equal(current.runtime.crashes, 0, 'No renderer failures during mode switching');
  }
  await evaluate('setVoiceIsolationMode("off")');
  const stopped = await sample('isolation-off', true);
  assert.ok(stopped.runtime.contextsRunning <= initial.runtime.contextsRunning, 'Off releases the isolation audio thread');
  if (process.argv.includes('--heap')) {
    const dump = fs.createWriteStream(path.join(output, 'renderer.heapsnapshot'));
    win.webContents.debugger.on('message', (_, method, params) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') dump.write(params.chunk); });
    await win.webContents.debugger.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false, exposeInternals: true });
    await new Promise(resolve => dump.end(resolve));
    await sample('after-snapshot', true);
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(snapshots, null, 2));
  win.destroy(); app.exit(0);
}
