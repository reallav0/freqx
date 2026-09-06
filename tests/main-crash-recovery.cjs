/*
 * Run: node tests/main-crash-recovery.cjs
 * Executes the production main.js against an in-memory Electron/OS fixture.
 * It never starts Electron, loads native addons, touches a user profile, or
 * opens a microphone/output device. Timers are advanced explicitly so recovery
 * cannot accidentally navigate during Electron's renderer-death callback.
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const checks = [];

function fixture(options = {}) {
  const calls = {
    nativeLoads: [], starts: 0, restarts: [], stops: [], recoveries: [],
    exits: [], quits: 0, windows: [], writes: [], sends: [],
  };
  const timers = [];
  let timerClock = 0;
  const pendingReady = [];
  let isReady = false;
  const settingsPath = path.join(root, 'fixture-profile', 'settings.json');
  const files = new Map([[settingsPath, JSON.stringify(options.settings || {})]]);
  const recovery = {
    start() { calls.starts++; return true; },
    requestRestart(reason) { calls.restarts.push(reason); return true; },
    stop(reason) { calls.stops.push(reason); },
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    commandLine: { appendSwitch() {}, hasSwitch() { return false; } },
    getPath(name) { return path.join(root, name === 'userData' ? 'fixture-profile' : `fixture-${name}`); },
    setPath() {}, getAppPath() { return root; },
    disableHardwareAcceleration() {}, requestSingleInstanceLock() { return options.lock !== false; },
    hasSingleInstanceLock() { return options.lock !== false; },
    isReady() { return isReady; },
    whenReady() { return new Promise(resolve => pendingReady.push(resolve)); },
    getName() { return 'freqx'; }, getVersion() { return metadata.version; },
    setAppUserModelId() {}, setAsDefaultProtocolClient() {}, setLoginItemSettings() {},
    getLoginItemSettings() { return {}; },
    quit() { calls.quits++; app.emit('before-quit'); app.emit('will-quit'); },
    exit(code) { calls.exits.push(code); },
    relaunch() { throw new Error('main.js must use its recovery coordinator'); },
  });
  class BrowserWindow extends EventEmitter {
    constructor(windowOptions) {
      super();
      this.options = windowOptions;
      this.visible = windowOptions.show !== false;
      this.hiddenCalls = 0;
      this.showCalls = 0;
      this.focusCalls = 0;
      this.loaded = [];
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {}, isDestroyed: () => this.destroyed,
        getURL: () => this.url || '',
        send: (...args) => calls.sends.push(args),
      });
      calls.windows.push(this);
    }
    static getAllWindows() { return calls.windows.filter(window => !window.destroyed); }
    removeMenu() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    show() { this.showCalls++; this.visible = true; }
    hide() { this.hiddenCalls++; this.visible = false; }
    focus() { this.focusCalls++; }
    restore() { this.visible = true; }
    loadFile(fileName) {
      this.loaded.push(fileName);
      this.url = pathToFileURL(path.resolve(root, fileName)).href;
      if (options.rejectInitialLoad && this.loaded.length === 1) {
        return Promise.reject(Object.assign(new Error('Fixture index load failed'), options.rejectInitialLoad));
      }
      return Promise.resolve().then(() => this.webContents.emit('did-finish-load'));
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }
  const ipcHandlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, handler) => ipcHandlers.set(name, handler);
  const fakeProcess = Object.assign(new EventEmitter(), {
    platform: 'win32', arch: 'x64', pid: 8123,
    argv: [path.join(root, 'fixture-freqx.exe'), ...(options.argv || [])],
    env: { ...(options.env || {}) }, versions: { electron: '36.9.5', node: '22.19.0', chrome: '136' },
    execPath: path.join(root, 'fixture-freqx.exe'),
    cwd: () => root, uptime: () => 120, exit: code => calls.exits.push(code),
  });
  const fakeFs = {
    existsSync(fileName) { return files.has(fileName); },
    readFileSync(fileName) {
      if (!files.has(fileName)) throw Object.assign(new Error('Fixture file absent'), { code: 'ENOENT' });
      return files.get(fileName);
    },
    mkdirSync() {},
    writeFileSync(fileName, value) { files.set(fileName, String(value)); calls.writes.push({ fileName, value: String(value) }); },
    appendFileSync(fileName, value) { files.set(fileName, (files.get(fileName) || '') + value); calls.writes.push({ fileName, value: String(value) }); },
  };
  const electron = {
    app, BrowserWindow, Tray, ipcMain,
    Menu: { buildFromTemplate: value => value },
    crashReporter: { start() {} },
    nativeImage: { createFromPath: () => ({ resize() { return this; } }) },
    globalShortcut: { unregisterAll() {}, unregister() {}, register() { return true; } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    shell: { showItemInFolder() {}, openPath: async () => '', openExternal: async () => {} },
    dialog: {},
  };
  function addTimer(callback, delay = 0, ...args) {
    const timer = { callback: () => callback(...args), due: timerClock + delay, cancelled: false, unref() { return this; } };
    timers.push(timer);
    return timer;
  }
  const pureBuiltins = new Set(['path', 'url', 'stream', 'stream/promises', 'crypto', 'os']);
  const context = vm.createContext({
    __dirname: root, __filename: path.join(root, 'main.js'),
    process: fakeProcess, Buffer, URL, console, module: { exports: {} }, exports: {},
    setTimeout: addTimer, setImmediate: callback => addTimer(callback),
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
    clearImmediate: timer => { if (timer) timer.cancelled = true; },
    require(name) {
      if (name === 'electron') return electron;
      if (name === './package.json') return metadata;
      if (name === './runtime/crash-recovery.cjs') return {
        createCrashRecovery(...args) { calls.recoveries.push(args); return recovery; },
      };
      if (name === 'fs' || name === 'node:fs') return fakeFs;
      if (name === 'naudiodon' || name === 'uiohook-napi') {
        calls.nativeLoads.push(name);
        throw new Error('Native addons are forbidden in this fixture');
      }
      const builtin = name.replace(/^node:/, '');
      if (pureBuiltins.has(builtin)) return require(`node:${builtin}`);
      if (['child_process', 'dns', 'net', 'https'].includes(builtin)) return new Proxy({}, {
        get(target, method) { return () => { throw new Error(`Unexpected ${builtin}.${String(method)} in isolated fixture`); }; },
      });
      throw new Error(`Unexpected production dependency ${name}`);
    },
  });
  vm.runInContext(mainSource, context, { filename: 'main.js' });
  return {
    app, calls, context, process: fakeProcess,
    get window() { return calls.windows.at(-1); },
    async ready() {
      isReady = true;
      pendingReady.splice(0).forEach(resolve => resolve());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    async flushTimers() {
      for (let round = 0; timers.length && round < 50; round++) {
        const batch = timers.splice(0);
        for (const timer of batch) if (!timer.cancelled) timer.callback();
        await Promise.resolve();
      }
      assert.equal(timers.length, 0, 'fixture timers must settle');
    },
    async advanceTimers(milliseconds) {
      const deadline = timerClock + milliseconds;
      for (let count = 0; count < 100; count++) {
        const next = timers.filter(timer => !timer.cancelled && timer.due <= deadline).sort((left, right) => left.due - right.due)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        timerClock = next.due;
        next.callback();
        await Promise.resolve();
      }
      timerClock = deadline;
      assert.ok(!timers.some(timer => !timer.cancelled && timer.due <= deadline), 'fixture timers must settle');
    },
    invoke(name, payload) {
      const handler = ipcHandlers.get(name);
      assert.ok(handler, `IPC handler ${name} exists`);
      return handler({ sender: this.window.webContents, senderFrame: { url: this.window.url } }, payload);
    },
  };
}

async function check(name, callback) {
  await callback();
  checks.push(name);
  console.log(`PASS ${name}`);
}

function assertNotRecoveredSynchronously(subject) {
  assert.equal(subject.calls.restarts.length, 0, 'restart is deferred out of Electron event callback');
  assert.equal(subject.window.hiddenCalls, 0, 'window access is deferred out of renderer-death callback');
  assert.equal(subject.window.showCalls, 0, 'failure must not show a crash window');
  assert.deepEqual(subject.window.loaded, ['index.html'], 'failure must not navigate during renderer teardown');
}

async function main() {
  await check('primary instance starts one safeguard', async () => {
    const subject = fixture();
    await subject.ready();
    assert.equal(subject.calls.recoveries.length, 1);
    assert.equal(subject.calls.starts, 1);
    assert.equal(subject.window.options.show, true);
    assert.deepEqual(subject.calls.nativeLoads, [], 'ordinary startup must not load unused native audio');
  });

  await check('single-instance loser starts no watchdog or native addon', async () => {
    const subject = fixture({ lock: false, env: { FREQX_ENABLE_NATIVE_KEY_HOOK: '1' } });
    await subject.ready();
    assert.equal(subject.calls.starts, 0);
    assert.equal(subject.calls.recoveries.length, 0);
    assert.deepEqual(subject.calls.nativeLoads, []);
    assert.equal(subject.calls.windows.length, 0);
    assert.equal(subject.calls.quits, 1);
  });

  await check('renderer-death burst produces one deferred hidden restart', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1073741819 });
    subject.window.webContents.emit('did-fail-load', {}, -2, 'Failed', subject.window.url, true);
    subject.window.webContents.emit('preload-error', {}, path.join(root, 'preload.js'), new Error('Fixture preload failure'));
    assertNotRecoveredSynchronously(subject);
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 1);
    assert.equal(subject.window.visible, false);
    assert.deepEqual(subject.window.loaded, ['index.html']);
  });

  await check('a damaged native window cannot block recovery', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.hide = () => { throw new Error('Fixture native window failure'); };
    subject.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 1);
  });

  await check('aborted navigation and subframe load errors do not restart', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', subject.window.url, true);
    subject.window.webContents.emit('did-fail-load', {}, -2, 'Failed', subject.window.url, false);
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 0);
    assert.deepEqual(subject.window.loaded, ['index.html']);
  });

  for (const eventName of ['uncaughtException', 'unhandledRejection']) {
    await check(`main ${eventName} restarts without continuing in a crash screen`, async () => {
      const subject = fixture();
      await subject.ready();
      subject.process.emit(eventName, new Error(`Fixture ${eventName}`));
      assertNotRecoveredSynchronously(subject);
      await subject.flushTimers();
      assert.equal(subject.calls.restarts.length, 1);
      assert.equal(subject.window.visible, false);
      assert.deepEqual(subject.window.loaded, ['index.html']);
    });
  }

  await check('fatal main failure before ready can recover without constructing a window', async () => {
    const subject = fixture();
    subject.process.emit('uncaughtException', new Error('Fixture early startup failure'));
    assert.equal(subject.calls.restarts.length, 0);
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 1);
    assert.equal(subject.calls.windows.length, 0);
  });

  await check('fatal renderer IPC requests recovery', async () => {
    const subject = fixture();
    await subject.ready();
    await subject.invoke('app:report-crash', { type: 'renderer-error', name: 'Error', message: 'Fixture renderer error' });
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 1);
    assert.equal(subject.window.visible, false);
  });

  await check('initial load promise failure requests recovery', async () => {
    const subject = fixture({ rejectInitialLoad: true });
    await subject.ready();
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 1);
    assert.deepEqual(subject.window.loaded, ['index.html']);
  });

  await check('aborted load promise does not request recovery', async () => {
    const subject = fixture({ rejectInitialLoad: { code: 'ERR_ABORTED', errno: -3 } });
    await subject.ready();
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 0);
    assert.deepEqual(subject.window.loaded, ['index.html']);
  });

  await check('the supplied recoverable audio/video/network service exits only log warnings', async () => {
    const subject = fixture();
    await subject.ready();
    for (const serviceName of ['audio.mojom.AudioService', 'video_capture.mojom.VideoCaptureService', 'audio.mojom.AudioService', 'video_capture.mojom.VideoCaptureService', 'network.mojom.NetworkService']) {
      subject.app.emit('child-process-gone', {}, { type: 'Utility', reason: 'killed', exitCode: 1073807364, serviceName });
    }
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 0);
    assert.equal(subject.window.visible, true);
    const logs = subject.calls.writes.map(write => write.value).join('\n');
    assert.equal((logs.match(/electron-service-exit/g) || []).length, 5);
    assert.ok(!logs.includes('electron-child-process-gone'));
  });

  await check('clean renderer exit does not restart', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await subject.flushTimers();
    assert.equal(subject.calls.restarts.length, 0);
  });

  await check('intentional quit disarms and cancels a pending recovery', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    subject.app.emit('before-quit', {});
    await subject.flushTimers();
    assert.ok(subject.calls.stops.length > 0);
    assert.equal(subject.calls.restarts.length, 0);
  });

  await check('Windows session-end disarms and cancels a pending recovery', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    subject.window.emit('session-end', { reasons: ['shutdown'] });
    await subject.flushTimers();
    assert.ok(subject.calls.stops.length > 0);
    assert.equal(subject.calls.restarts.length, 0);
  });

  await check('temporary renderer stall does not trigger recovery', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.emit('unresponsive');
    await subject.advanceTimers(14999);
    assert.equal(subject.calls.restarts.length, 0);
    subject.window.emit('responsive');
    await subject.advanceTimers(15000);
    assert.equal(subject.calls.restarts.length, 0);
    assert.equal(subject.window.visible, true);
  });

  await check('sustained renderer stall triggers one recovery after the grace period', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.emit('unresponsive');
    subject.window.emit('unresponsive');
    await subject.advanceTimers(14999);
    assert.equal(subject.calls.restarts.length, 0);
    await subject.advanceTimers(1);
    assert.equal(subject.calls.restarts.length, 1);
    assert.equal(subject.window.visible, false);
    assert.deepEqual(subject.window.loaded, ['index.html']);
  });

  await check('closing a stalled window clears its pending recovery timer', async () => {
    const subject = fixture();
    await subject.ready();
    subject.window.emit('unresponsive');
    subject.window.emit('closed');
    await subject.advanceTimers(15000);
    assert.equal(subject.calls.restarts.length, 0);
  });

  await check('recovered launch stays hidden even with a deep link and visible setting', async () => {
    const subject = fixture({ argv: ['--recovered', 'freqx://import-sound?url=https%3A%2F%2Fexample.com%2Fa.wav'], settings: { startHidden: false } });
    await subject.ready();
    assert.equal(subject.window.options.show, false);
    assert.equal(subject.window.visible, false);
    assert.equal(subject.window.showCalls, 0);
  });

  await check('a duplicate recovery launch does not reveal the running window', async () => {
    const subject = fixture({ argv: ['--hidden'] });
    await subject.ready();
    subject.app.emit('second-instance', {}, [process.execPath, '--recovered', 'freqx://import-sound?url=https%3A%2F%2Fexample.com%2Fa.wav']);
    assert.equal(subject.window.visible, false);
    assert.equal(subject.window.showCalls, 0);
    subject.app.emit('second-instance', {}, [process.execPath]);
    assert.equal(subject.window.visible, true, 'a subsequent manual launch still opens the app');
    assert.equal(subject.window.focusCalls, 1);
  });

  console.log(`\n${checks.length} main-process recovery checks passed.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
