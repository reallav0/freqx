// Starts the actual release executable and production main/preload/renderer.
// Pause before main.js to isolate its profile, registry and audio hardware.
// Usage: node tests/packaged-startup.cjs [--exe dist/FreqX-Portable-1.8.0.exe]
// Local stack: --dev-script dev --api-base http://127.0.0.1:3000 --expect-sound ID
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const argument = process.argv.indexOf('--exe');
  const devArgument = process.argv.indexOf('--dev-script');
  const developmentScript = devArgument < 0 ? null : process.argv[devArgument + 1];
  if (developmentScript !== null && !['dev', 'start'].includes(developmentScript)) throw new Error('Use --dev-script dev or start.');
  const apiArgument = process.argv.indexOf('--api-base');
  const apiBase = apiArgument < 0 ? null : process.argv[apiArgument + 1];
  if (apiBase !== null) {
    const url = new URL(apiBase);
    if (!developmentScript || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The stack smoke test requires a development script and loopback HTTP API origin.');
  }
  const soundArgument = process.argv.indexOf('--expect-sound');
  const expectedSound = soundArgument < 0 ? null : process.argv[soundArgument + 1];
  if (soundArgument >= 0 && (!apiBase || !require('../runtime/catalog-id').valid(expectedSound))) throw new Error('Expected sound requires a local API and valid sound ID.');
  const executable = path.resolve(root, argument < 0 ? 'dist/win-unpacked/freqx.exe' : process.argv[argument + 1]);
  const output = path.join(root, 'output', 'packaged-startup');
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'run-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PORTABLE_EXECUTABLE_FILE;
  delete env.PORTABLE_EXECUTABLE_DIR;
  if (apiBase) { env.FREQX_API_BASE_URL = apiBase; delete env.FREQX_LIBRARY_BUNDLED; }
  const log = fs.openSync(path.join(directory, 'electron.log'), 'a');
  const flags = [`--inspect-brk=127.0.0.1:${port}`, '--hidden', '--use-fake-device-for-media-stream'];
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (developmentScript && !fs.existsSync(npmCli)) throw new Error('The installed Node runtime has no npm CLI beside it.');
  const child = spawn(developmentScript ? process.execPath : executable, developmentScript ? [npmCli, 'run', developmentScript, '--', ...flags] : flags, {
    cwd: root, env, windowsHide: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  let socket;
  let command;
  const deadline = Date.now() + 40000;
  const reportPath = path.join(directory, 'report.json');
  try {
    let endpoint;
    while (!endpoint) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Executable exited before debugger connection: ${child.exitCode}`);
      if (Date.now() > deadline) throw new Error('Timed out connecting to release main process.');
      try {
        const entries = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        endpoint = entries[0]?.webSocketDebuggerUrl;
      } catch { /* The portable launcher must extract its runtime first. */ }
      if (!endpoint) await pause(100);
    }
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    let onPaused;
    const paused = new Promise(resolve => { onPaused = resolve; });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Debugger.paused') onPaused(message.params);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    });
    command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Debugger timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await command('Debugger.enable');
    await command('Runtime.runIfWaitingForDebugger');
    const frame = await Promise.race([paused, pause(10000).then(() => { throw new Error('Release did not pause before startup.'); })]);
    const injection = `(() => {
      ${developmentScript ? `const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'main.js'))});` : ''}
      const fs = require('node:fs');
      const path = require('node:path');
      const { app, BrowserWindow } = require('electron');
      const directory = ${JSON.stringify(directory)};
      const profile = path.join(directory, ${JSON.stringify(developmentScript ? 'freqx-dev' : 'profile')});
      fs.mkdirSync(profile, { recursive: true });
      const blankPage = path.join(directory, 'blank.html');
      fs.writeFileSync(blankPage, '<!doctype html><title>Startup fixture</title>');
      app.setPath('userData', profile);
      if (${Boolean(developmentScript)}) app.setPath('appData', directory);
      app.setPath('sessionData', path.join(profile, 'session'));
      app.setPath('crashDumps', path.join(profile, 'dumps'));
      // A native crash must not let the watchdog relaunch outside this fixture.
      process.env.PORTABLE_EXECUTABLE_FILE = path.join(directory, 'disabled-restart.exe');
      // Source launches correctly ignore the portable executable override.
      // Exhaust their isolated restart budget for the duration of this smoke test.
      const { MAX_AUTOMATIC_RESTARTS } = require('./runtime/recovery-policy.cjs');
      fs.mkdirSync(path.join(profile, 'crash-logs'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'crash-logs', 'restart-history.json'), JSON.stringify({ version: 1, restarts: Array(MAX_AUTOMATIC_RESTARTS).fill(Date.now()) }));
      fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ launchOnStartup: false, startHidden: false, keepRunningInTray: false }));
      app.setLoginItemSettings = () => {};
      app.setAsDefaultProtocolClient = () => false;
      const { LoopbackService } = require('./runtime/loopback-reference.cjs');
      LoopbackService.prototype.list = async () => [];
      LoopbackService.prototype.start = async () => { throw new Error('Native capture disabled in startup smoke test.'); };
      const failures = [];
      process.on('uncaughtException', error => failures.push(error.stack));
      process.on('unhandledRejection', error => failures.push(error?.stack || String(error)));
      const originalLoad = BrowserWindow.prototype.loadFile;
      BrowserWindow.prototype.loadFile = async function(...args) {
        const contents = this.webContents;
        contents.setAudioMuted(true);
        contents.on('preload-error', (_, filename, error) => failures.push('preload: ' + error.message));
        contents.on('render-process-gone', (_, details) => failures.push('renderer: ' + JSON.stringify(details)));
        // Start the renderer before awaiting debugger commands for that renderer.
        await originalLoad.call(this, blankPage);
        contents.debugger.attach('1.3');
        await contents.debugger.sendCommand('Page.enable');
        await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source:
          'window.__startupSilentHardware = true; const NativeContext = window.AudioContext; window.AudioContext = new Proxy(NativeContext, { construct(target, args) { return new target({ ...args[0], sinkId: { type: "none" } }); } }); NativeContext.prototype.setSinkId = async function() {};'
        });
        return originalLoad.apply(this, args);
      };
      globalThis.__freqxStartupSmoke = { app };
      app.whenReady().then(() => {
        let evaluating = false;
        const timer = setInterval(async () => {
          const window = BrowserWindow.getAllWindows()[0];
          if (evaluating || !window || window.webContents.isLoading() || !window.webContents.getURL().endsWith('/index.html')) return;
          evaluating = true;
          try {
            const state = await window.webContents.executeJavaScript('({ title: document.title, silent: window.__startupSilentHardware === true, bridge: typeof window.soundmuncher?.getAppSettings, initialized: typeof isMicCaptureEnabled !== "undefined" && isMicCaptureEnabled && isMixToOutputEnabled, input: typeof micStream !== "undefined" ? micStream?.getAudioTracks()[0]?.label : null })');
            if (!state.initialized || !state.input) return;
            if (${Boolean(apiBase)}) {
              state.catalog = await window.webContents.executeJavaScript('window.soundmuncher.getPublicLibrary()');
            }
            clearInterval(timer);
            await new Promise(resolve => setTimeout(resolve, 500));
            fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ ...state, failures, packaged: app.isPackaged, defaultApp: process.defaultApp === true, profile: app.getPath('userData'), hidden: !window.isVisible(), metadataHasBuild: !!require('./package.json').build }));
            app.quit();
          } catch (error) { failures.push(error.message); }
          finally { evaluating = false; }
        }, 100);
      });
      return 'isolated';
    })()`;
    const injected = await command('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrames[0].callFrameId, expression: injection, returnByValue: true });
    if (injected.exceptionDetails) throw new Error(JSON.stringify(injected.exceptionDetails));
    assert.equal(injected.result.value, 'isolated');
    await command('Debugger.resume');
    while (!fs.existsSync(reportPath)) {
      if (child.exitCode !== null) throw new Error(`Release exited before renderer initialized: ${child.exitCode}`);
      if (Date.now() > deadline) throw new Error(`Timed out waiting for production renderer. See ${directory}`);
      await pause(100);
    }
    const report = JSON.parse(fs.readFileSync(reportPath));
    assert.equal(report.defaultApp, Boolean(developmentScript));
    assert.equal(report.packaged && !report.defaultApp, !developmentScript);
    assert.equal(report.metadataHasBuild, Boolean(developmentScript));
    assert.equal(report.profile, path.join(directory, developmentScript ? 'freqx-dev' : 'profile'));
    assert.equal(report.bridge, 'function');
    assert.equal(report.silent, true);
    assert.equal(report.initialized, true);
    assert.equal(report.hidden, true);
    assert.deepEqual(report.failures, []);
    if (apiBase) {
      assert.equal(report.catalog?.source, 'remote', 'Actual main process must retrieve the API catalog rather than fallback.');
      assert.ok(report.catalog.sounds.length > 0);
      if (expectedSound) assert.ok(report.catalog.sounds.some(sound => sound.id === expectedSound), 'Expected API sound must cross the real main/preload boundary.');
      console.log(`PASS actual main/preload/renderer retrieves the local API catalog (${report.catalog.sounds.length} sounds).`);
    }
    console.log(developmentScript ? `PASS npm run ${developmentScript} starts actual main in an isolated profile.` : `PASS actual release starts with stripped build metadata: ${path.basename(executable)}`);
    console.log(`PASS production preload and renderer initialize with synthetic microphone and silent audio sinks: ${report.input}`);
    console.log(`Report: ${reportPath}`);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      try { await command('Runtime.evaluate', { expression: 'globalThis.__freqxStartupSmoke ? globalThis.__freqxStartupSmoke.app.quit() : process.exit(1)' }); } catch { /* App may already have quit. */ }
      socket.close();
    }
    for (let count = 0; child.exitCode === null && count < 40; count++) await pause(100);
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
