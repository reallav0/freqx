'use strict';
// Real preload IPC + reference worklet, synthetic native PCM, silent outputs.
// No physical capture, user profile or sound output is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else {
  void run();
}
async function run() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const profile = path.join(root, 'output/reference-desktop/profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('in-process-gpu');
  app.on('window-all-closed', () => {});
  const rootArgument = process.argv.indexOf('--app-root');
  const appRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : process.argv.includes('--packaged') ? path.join(root, 'output/voice-isolation-build/win-unpacked/resources/app.asar') : root;
  const sessions = new Map();
  let win, nextId = 1, acknowledgements = 0, checks = 0, phase = 0;
  function stop(id) { const timer = sessions.get(id); if (timer) clearInterval(timer); sessions.delete(id); }
  ipcMain.handle('auth:status', () => ({ user: null }));
  ipcMain.handle('audio:reference-start', (event, endpointId) => {
    const id = String(nextId++), rate = endpointId === '44100' ? 44100 : 48000;
    const timer = setInterval(() => {
      if (event.sender.isDestroyed()) { stop(id); return; }
      const samples = new Float32Array(rate / 100);
      for (let i = 0; i < samples.length; i++) { samples[i] = .25 * Math.sin(phase); phase += 2 * Math.PI * 1000 / rate; }
      event.sender.send('audio:reference-data', { id, type: 'pcm', samples });
    }, 10);
    sessions.set(id, timer);
    return { id, endpointId, label: 'Synthetic headphones', sampleRate: rate };
  });
  ipcMain.handle('audio:reference-stop', (event, id) => stop(id));
  ipcMain.handle('audio:reference-cancel', () => { for (const id of sessions.keys()) stop(id); });
  ipcMain.on('audio:reference-ack', () => acknowledgements++);
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const check = (name, pass) => { assert.ok(pass, name); checks++; console.log('PASS ' + name); };
  try {
    await app.whenReady();
    win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(appRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, partition: 'reference-desktop-test'
    } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: /\/renderer\.js$/.test(details.url) || /^https?:/.test(details.url) }));
    await win.loadFile(path.join(appRoot, 'index.html'));
    await evaluate(`(() => {
      const NativeContext = AudioContext;
      window.AudioContext = new Proxy(NativeContext, { construct(target, args) { return new target({ ...args[0], sinkId: { type: 'none' } }); } });
      window.__cspFailures = [];
      document.addEventListener('securitypolicyviolation', event => __cspFailures.push(event.violatedDirective));
    })()`);
    check('real preload exposes reference IPC without exposing Node', await evaluate('typeof soundmuncher.startReference === "function" && typeof require === "undefined" && LoopbackReference.supported'));
    for (const rate of [48000, 44100]) {
      const measurement = await evaluate(`(async () => {
        window.__track = await LoopbackReference.acquire({ endpointId: '${rate}' });
        if (!__track) return { failed: true };
        window.__context = new AudioContext({ sampleRate: 48000 });
        const source = __context.createMediaStreamSource(new MediaStream([__track]));
        window.__analyser = __context.createAnalyser(); __analyser.fftSize = 2048;
        source.connect(__analyser); await __context.resume();
        await new Promise(resolve => setTimeout(resolve, 300));
        const buffer = new Float32Array(2048); __analyser.getFloatTimeDomainData(buffer);
        const rms = Math.sqrt(buffer.reduce((sum, v) => sum + v * v, 0) / buffer.length);
        return { rms, details: LoopbackReference.details(__track) };
      })()`);
      check(`${rate} Hz native PCM crosses preload IPC and reaches the 48 kHz reference stream`, measurement.rms > .10 && measurement.rms < .23 && measurement.details.sampleRate === rate);
      await evaluate('LoopbackReference.release(__track); __context.close()');
      await new Promise(resolve => setTimeout(resolve, 100));
      check('release stops processed reference track and native capture session', await evaluate('__track.readyState === "ended"') && sessions.size === 0);
    }
    await evaluate('LoopbackReference.acquire({ endpointId: "48000" }).then(track => { window.__track = track; })');
    const liveId = [...sessions.keys()][0]; stop(liveId);
    win.webContents.send('audio:reference-data', { id: liveId, type: 'ended', reason: 'Synthetic unplug' });
    await new Promise(resolve => setTimeout(resolve, 100));
    check('native disconnection ends the browser reference track', await evaluate('__track.readyState === "ended"'));
    check('real preload acknowledges PCM packets and production CSP accepts the worklet', acknowledgements > 10 && await evaluate('__cspFailures.length === 0'));
    win.destroy();
    console.log(`Passed ${checks} playback-reference desktop checks.`);
    app.exit(0);
  } catch (error) {
    for (const id of sessions.keys()) stop(id);
    console.error(error.stack); win?.destroy(); app.exit(1);
  }
}
