'use strict';
// Opt-in test against a real, separately started VCClient. Synthetic voiced
// harmonics only: no microphone, output endpoint, user profile, or audio device.
// node tests/voice-conversion-live.cjs --port 18000 [--voices 0,2]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VoiceConversionService, SAMPLE_RATE, BLOCK_SIZE } = require('../runtime/voice-conversion.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeWave(filename, frames) {
  const count = frames.reduce((sum, frame) => sum + frame.length, 0), bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24); bytes.writeUInt32LE(SAMPLE_RATE * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  let offset = 44;
  for (const frame of frames) for (const sample of frame) { bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), offset); offset += 2; }
  fs.writeFileSync(filename, bytes);
}
async function run() {
  const index = process.argv.indexOf('--port');
  if (index < 0) throw new Error('Start a compatible local RVC engine, then supply --port. This check never starts an engine or downloads voices.');
  const port = Number(process.argv[index + 1]), voiceIndex = process.argv.indexOf('--voices');
  const service = new VoiceConversionService(), owner = { isDestroyed: () => false };
  const listed = await service.list({ port }); assert.equal(listed.ok, true, listed.error);
  const requested = voiceIndex < 0 ? listed.voices.slice(0, 2).map(voice => voice.id) : process.argv[voiceIndex + 1].split(',');
  assert.ok(requested.length >= 2, 'At least two installed RVC voices are required.');
  const output = path.join(__dirname, '../output/voice-conversion-live'); fs.mkdirSync(output, { recursive: true });
  const results = [];
  try {
    for (const id of requested) {
      const voice = listed.voices.find(voice => voice.id === id); assert.ok(voice, 'Requested voice is installed: ' + id);
      const started = await service.start(owner, { port, voiceId: id, pitch: 0 }); assert.equal(started.ok, true, started.error);
      const times = [], frames = []; let energy = 0, difference = 0;
      for (let sequence = 1; sequence <= 32; sequence++) {
        const begun = Date.now(), samples = new Float32Array(BLOCK_SIZE);
        for (let index = 0; index < BLOCK_SIZE; index++) {
          const time = ((sequence - 1) * BLOCK_SIZE + index) / SAMPLE_RATE;
          const fundamental = 145 + 8 * Math.sin(time * Math.PI * 2 / 3);
          const phase = 2 * Math.PI * fundamental * time;
          samples[index] = (0.06 * Math.sin(phase) + 0.025 * Math.sin(2 * phase) + 0.015 * Math.sin(4 * phase)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2.5 * time));
        }
        const converted = await service.frame(owner, { id: started.id, sequence, samples }); assert.equal(converted.ok, true, converted.error);
        assert.equal(converted.samples.length, BLOCK_SIZE); assert.ok(converted.samples.every(Number.isFinite));
        times.push(converted.processingMs); frames.push(converted.samples);
        for (let index = 0; index < BLOCK_SIZE; index++) { energy += converted.samples[index] ** 2; difference += (converted.samples[index] - samples[index]) ** 2; }
        await pause(Math.max(0, BLOCK_SIZE / SAMPLE_RATE * 1000 - (Date.now() - begun)));
      }
      service.stop(owner, started.id);
      assert.ok(energy > 0.001, 'The actual voice model produces non-silent audio.');
      assert.ok(difference > 0.1, 'The actual engine converts rather than passing through input.');
      const sorted = [...times].sort((a, b) => a - b);
      results.push({ id, name: voice.name, frames: frames.length, rms: Math.sqrt(energy / (frames.length * BLOCK_SIZE)), meanMs: times.reduce((a, b) => a + b) / times.length, p95Ms: sorted[Math.floor(sorted.length * 0.95)], blockMs: BLOCK_SIZE / SAMPLE_RATE * 1000 });
      writeWave(path.join(output, `voice-${id}.wav`), frames);
      console.log('PASS real RVC conversion: ' + JSON.stringify(results.at(-1)));
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, voices: results }, null, 2));
  } finally { service.stopAll(); }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  const vm = require('node:vm'), { pathToFileURL } = require('node:url');
  const rootIndex = process.argv.indexOf('--app-root');
  const appRoot = rootIndex < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootIndex + 1]);
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const voiceIndex = process.argv.indexOf('--voices');
  const directory = path.resolve(__dirname, '../output/voice-conversion-live');
  app.setPath('userData', path.join(directory, 'electron-profile'));
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const { VoiceConversionService: ActualService, validPort } = require(path.join(appRoot, 'runtime/voice-conversion.cjs'));
  const service = new ActualService();
  let win;
  try {
    await app.whenReady();
    const installed = await service.list({ port }); assert.equal(installed.ok, true, installed.error);
    const voiceId = voiceIndex < 0 ? installed.voices[0]?.id : process.argv[voiceIndex + 1].split(',')[0];
    assert.ok(voiceId, 'An installed RVC voice is required.');
    const html = path.join(directory, 'electron.html'), pageUrl = pathToFileURL(html).href;
    fs.writeFileSync(html, `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; worker-src 'self'"><script src="${pathToFileURL(path.join(appRoot, 'audio/voice-conversion.js')).href}"></script>`);
    win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(appRoot, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const failures = [];
    win.webContents.on('preload-error', (_event, _file, error) => failures.push(error.message));
    win.webContents.on('console-message', details => { if (details.level === 'error') failures.push(details.message); });
    const context = vm.createContext({ mainWindow: win, ipcMain, shell, voiceConversionService: service, validVoiceEnginePort: validPort,
      assertTrustedIpcSender: event => assert.equal(event.senderFrame.url, pageUrl), stripUrlState: url => url, getRendererUrl: () => pageUrl });
    const source = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('function assertVoiceConversionSender('), source.indexOf('function assertAutoPttSender(')), context);
    vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('voice-conversion:list'"), source.indexOf("  ipcMain.handle('audio:import-link'")), context);
    await win.loadFile(html);
    const report = await win.webContents.executeJavaScript(`(async () => { try {
      if (typeof require !== 'undefined') throw new Error('Renderer has Node access.');
      const context = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
      await context.resume();
      let session;
      try {
        const outcome = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Real desktop conversion timed out.')), 15000);
          let count = 0, energy = 0;
          const analyser = context.createAnalyser(); analyser.fftSize = 2048;
          const samples = new Float32Array(2048);
          FreqxVoiceConversion.create(context, { bridge: soundmuncher, port: ${port}, voiceId: ${JSON.stringify(voiceId)}, pitch: 0,
            onError: error => { clearTimeout(timeout); reject(error); },
            onDiagnostics: diagnostics => {
              analyser.getFloatTimeDomainData(samples);
              for (const value of samples) energy += value * value;
              if (++count === 24) { clearTimeout(timeout); resolve({ blocks: count, rms: Math.sqrt(energy / (count * samples.length)), processingMs: diagnostics.processingMs, silentSink: true }); }
            }
          }).then(value => {
            session = value;
            const oscillator = context.createOscillator(), gain = context.createGain();
            oscillator.frequency.value = 165; gain.gain.value = 0.08;
            oscillator.connect(gain); gain.connect(session.node); session.node.connect(analyser); analyser.connect(context.destination); oscillator.start();
          }, error => { clearTimeout(timeout); reject(error); });
        });
        return await outcome;
      } finally { session?.close(); await context.close(); }
    } catch (error) { return { error: error?.stack || error?.message || String(error) }; } })()`);
    assert.equal(report.error, undefined, report.error); assert.deepEqual(failures, []);
    assert.ok(report.rms > 0.0001, 'Real worklet receives converted audio through sandboxed production preload.');
    fs.writeFileSync(path.join(directory, 'electron-results.json'), JSON.stringify({ passed: true, ...report }, null, 2));
    console.log('PASS real Electron preload + IPC + RVC + audio worklet: ' + JSON.stringify(report));
    service.stopAll(); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); service.stopAll(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1);
  }
}

if (process.versions.electron) {
  void runElectron();
} else {
  run().then(() => {
    const { spawnSync } = require('node:child_process'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Real desktop conversion failed with exit code ' + result.status);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
