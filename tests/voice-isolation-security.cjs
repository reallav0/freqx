/*
 * Local DeepFilterNet smoke test under the application's production renderer
 * security settings. Chromium supplies a fake mic; silent Web Audio sinks and
 * an isolated temporary profile keep this test away from user devices/settings.
 * Run: node tests/voice-isolation-security.cjs [--packaged | --app-root PATH]
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 180000,
  });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
} else {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function run() {
  const { app, BrowserWindow } = require('electron');
  const output = path.join(root, 'output', 'voice-isolation-security');
  fs.mkdirSync(output, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(output, 'run-'));
  app.setPath('userData', path.join(runDirectory, 'profile'));
  app.setPath('sessionData', path.join(runDirectory, 'session'));
  app.setPath('crashDumps', path.join(runDirectory, 'dumps'));
  // Only rendering configuration differs from production, to run headlessly
  // inside a Windows test sandbox. Renderer sandbox and web security stay on.
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  const rootArgument = process.argv.indexOf('--app-root');
  const appRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1])
    : process.argv.includes('--packaged')
      ? path.join(root, 'output', 'voice-isolation-build', 'win-unpacked', 'resources', 'app.asar')
      : root;
  const checks = [];
  const requests = [];
  const errors = [];
  const permissions = [];
  let win;
  function check(name, pass, detail) {
    checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!pass) throw new Error(name);
  }
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  async function createWindow({ denyPermission = false, denyModel = false } = {}) {
    if (win && !win.isDestroyed()) win.destroy();
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, backgroundThrottling: false,
        partition: `voice-isolation-security-${Date.now()}-${checks.length}`,
      },
    });
    const session = win.webContents.session;
    session.setPermissionRequestHandler((contents, permission, callback) => {
      permissions.push({ permission, denied: denyPermission });
      callback(!denyPermission && contents === win.webContents && permission === 'media');
    });
    session.setPermissionCheckHandler((contents, permission) => !denyPermission && contents === win.webContents && permission === 'media');
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      requests.push({ url: details.url, resourceType: details.resourceType });
      // Load the real index.html, CSP and service directly from the checkout or
      // app.asar. Block only the unrelated app renderer (which requires IPC).
      const cancel = /^https?:/i.test(details.url) || details.url.endsWith('/renderer.js')
        || (denyModel && /\/df_bg\.wasm(?:[?#]|$)/.test(details.url));
      callback({ cancel });
    });
    win.webContents.on('console-message', event => {
      if (event.level === 'error' && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(event.message);
    });
    win.webContents.on('render-process-gone', (_, details) => errors.push(`Renderer exited: ${JSON.stringify(details)}`));
    await win.loadFile(path.join(appRoot, 'index.html'));
    await evaluate(`(() => {
      window.__voiceSecurity = { contexts: [], nodes: [], errors: [], csp: [] };
      document.addEventListener('securitypolicyviolation', event => __voiceSecurity.csp.push(event.violatedDirective));
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = new Proxy(NativeAudioContext, {
        construct(target, args) {
          const context = new target({ ...args[0], sinkId: { type: 'none' } });
          __voiceSecurity.contexts.push(context);
          return context;
        }
      });
      const NativeWorklet = window.AudioWorkletNode;
      window.AudioWorkletNode = new Proxy(NativeWorklet, {
        construct(target, args) {
          const node = new target(...args);
          __voiceSecurity.nodes.push({ node, name: args[1] });
          return node;
        }
      });
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        value: async () => { throw new DOMException('Fixture display capture unavailable.', 'NotAllowedError'); },
      });
    })()`);
  }

  try {
    await app.whenReady();
    await createWindow();
    const preferences = win.webContents.getLastWebPreferences();
    check('renderer keeps context isolation, sandbox and web security enabled', preferences.contextIsolation && preferences.sandbox && preferences.webSecurity && !preferences.nodeIntegration);
    check('service loads without renderer Node or a preload bridge', await evaluate('typeof require === "undefined" && typeof process === "undefined" && typeof soundmuncher === "undefined" && typeof VoiceIsolation?.create === "function"'));
    check('production CSP allows local WASM without JavaScript unsafe-eval', await evaluate(`(() => {const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content; return csp.includes("'wasm-unsafe-eval'") && !csp.includes("'unsafe-eval'");})()`));
    const capture = await evaluate(`(async () => {
      const constraints = VoiceIsolation.captureConstraints();
      window.__rawMic = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      return { constraints, settings: __rawMic.getAudioTracks()[0].getSettings(), label: __rawMic.getAudioTracks()[0].label };
    })()`);
    check('native getUserMedia requests all Chromium microphone processing disabled', capture.constraints.echoCancellation === false && capture.constraints.noiseSuppression === false && capture.constraints.autoGainControl === false, capture);
    check('native microphone keeps processing disabled even when its format differs', capture.settings.sampleRate > 0 && capture.settings.channelCount >= 1 && capture.settings.echoCancellation === false && capture.settings.noiseSuppression === false && capture.settings.autoGainControl === false, capture.settings);
    const started = await evaluate(`(async () => {
      const start = performance.now();
      window.__cleanMic = await VoiceIsolation.create(__rawMic, { mode: 'high-quality', onError: error => __voiceSecurity.errors.push(String(error)) });
      return { startupMs: Math.round(performance.now() - start), mode: __cleanMic.mode, state: __cleanMic.contextState, tracks: __cleanMic.stream.getAudioTracks().length, sampleRate: __voiceSecurity.contexts[0]?.sampleRate, outputSettings: __cleanMic.stream.getAudioTracks()[0].getSettings() };
    })()`);
    check('bundled DeepFilterNet starts in a secure renderer with a reusable mono stream', started.mode === 'high-quality' && started.state === 'running' && started.tracks === 1 && started.sampleRate === 48000, started);
    check('48 kHz processing context resamples capture and downmixes to mono', started.outputSettings.sampleRate === 48000 && started.outputSettings.channelCount === 1, started.outputSettings);
    check('Light mode changes live without replacing the input, output stream or audio context', await evaluate(`(() => {
      const before = __cleanMic.stream;
      const count = __voiceSecurity.contexts.length;
      __cleanMic.setMode('light');
      return __cleanMic.mode === 'light' && __cleanMic.stream === before && __voiceSecurity.contexts.length === count && __rawMic.getTracks().every(track => track.readyState === 'live');
    })()`));
    check('strength changes live with preexisting capture and stream', await evaluate(`(() => {
      const stream = __cleanMic.stream; __cleanMic.setStrength(0.72);
      return __cleanMic.strength === 0.72 && __cleanMic.stream === stream && __rawMic.getTracks().every(track => track.readyState === 'live');
    })()`));
    check('suspended processing context resumes without restarting capture', await evaluate(`(async () => {
      await __voiceSecurity.contexts[0].suspend();
      await __cleanMic.resume();
      return __cleanMic.contextState === 'running' && __rawMic.getTracks().every(track => track.readyState === 'live');
    })()`));
    await evaluate('new Promise(resolve => setTimeout(resolve, 600))');
    check('processor runs without errors or CSP violations', await evaluate('__voiceSecurity.errors.length === 0 && __voiceSecurity.csp.length === 0'), await evaluate('({errors:__voiceSecurity.errors,csp:__voiceSecurity.csp})'));
    check('disabling releases processed tracks while preserving the caller-owned microphone', await evaluate(`(async () => {
      await __cleanMic.close(); await __cleanMic.close();
      await new Promise(resolve => setTimeout(resolve, 200));
      return __cleanMic.stream.getTracks().every(track => track.readyState === 'ended') && __rawMic.getTracks().every(track => track.readyState === 'live') && __voiceSecurity.contexts.every(context => context.state === 'closed');
    })()`));
    const aecStarted = await evaluate(`(async () => {
      window.__originalReferenceApi = LoopbackReference;
      window.__referenceContext = new AudioContext({ sampleRate: 48000 });
      window.__referenceDestination = __referenceContext.createMediaStreamDestination();
      window.__referenceSignal = __referenceContext.createConstantSource();
      __referenceSignal.offset.value = 0; __referenceSignal.connect(__referenceDestination); __referenceSignal.start();
      await __referenceContext.resume();
      window.__aecReference = __referenceDestination.stream.getAudioTracks()[0].clone();
      window.LoopbackReference = { acquire: async () => __aecReference, release: track => track.stop(), details: () => ({ label: 'Synthetic playback' }) };
      window.__cleanMic = await VoiceIsolation.create(__rawMic, { referenceDeviceId: '' });
      return { engine: __cleanMic.diagnostics.engine, browserAec: __cleanMic.inputSettings.echoCancellation, reference: __cleanMic.diagnostics.referenceLabel };
    })()`);
    check('real AEC3 receives Chromium capture with browser echo cancellation disabled', aecStarted.engine === 'WebRTC AEC3' && aecStarted.browserAec === false && aecStarted.reference === 'Synthetic playback', aecStarted);
    await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
    check('AEC3 and its module imports run inside production CSP without remote access', await evaluate('__voiceSecurity.csp.length === 0 && __voiceSecurity.errors.length === 0') && requests.some(request => request.url.endsWith('/audio/aec3-engine.mjs')) && !requests.some(request => /^https?:/i.test(request.url)));
    check('reference disconnection keeps Chromium processing disabled while keeping DeepFilterNet live', await evaluate(`(async () => {
      __aecReference.stop(); __aecReference.dispatchEvent(new Event('ended'));
      await new Promise(resolve => setTimeout(resolve, 100));
      const valid = __rawMic.getAudioTracks()[0].getSettings().echoCancellation === false && __cleanMic.diagnostics.engine === 'No echo cancellation' && __cleanMic.stream.getAudioTracks()[0].readyState === 'live';
      await __cleanMic.close();
      return valid;
    })()`));
    check('AEC3 processor failure keeps Chromium processing disabled without ending microphone capture', await evaluate(`(async () => {
      window.__aecReference = __referenceDestination.stream.getAudioTracks()[0].clone();
      window.__cleanMic = await VoiceIsolation.create(__rawMic, { referenceDeviceId: '' });
      __voiceSecurity.nodes.filter(entry => entry.name === 'freqx-aec').at(-1).node.dispatchEvent(new Event('processorerror'));
      await new Promise(resolve => setTimeout(resolve, 100));
      const valid = __rawMic.getAudioTracks()[0].getSettings().echoCancellation === false && __cleanMic.diagnostics.engine === 'No echo cancellation' && __rawMic.getTracks().every(track => track.readyState === 'live');
      await __cleanMic.close();
      return valid;
    })()`));
    check('closing an active AEC3 session keeps Chromium processing disabled on the same microphone', await evaluate(`(async () => {
      window.__aecReference = __referenceDestination.stream.getAudioTracks()[0].clone();
      window.__cleanMic = await VoiceIsolation.create(__rawMic, { referenceDeviceId: '' });
      await __cleanMic.close();
      window.LoopbackReference = __originalReferenceApi;
      __referenceDestination.stream.getTracks().forEach(track => track.stop()); __referenceSignal.stop(); await __referenceContext.close();
      return __rawMic.getAudioTracks()[0].getSettings().echoCancellation === false && __aecReference.readyState === 'ended';
    })()`));
    check('reenabling starts on the same live microphone without an app restart', await evaluate(`(async () => {
      window.__cleanMic = await VoiceIsolation.create(__rawMic, { mode:'light' });
      const live = __cleanMic.mode === 'light' && __cleanMic.stream.getAudioTracks()[0].readyState === 'live';
      await __cleanMic.close(); __rawMic.getTracks().forEach(track => track.stop());
      return live;
    })()`));
    const modelRequests = requests.filter(request => /\/audio\/vendor\/(?:deepfilter\/df_bg|rnnoise\/rnnoise)\.wasm(?:[?#]|$)/.test(request.url));
    check('WASM and model load once from the application directory, entirely offline', modelRequests.length === 2 && modelRequests.every(request => request.url.startsWith('file:')) && !requests.some(request => /^https?:/i.test(request.url)), modelRequests);
    if (appRoot.endsWith('app.asar')) check('packaged assets resolve inside app.asar', modelRequests.every(request => request.url.includes('/app.asar/audio/vendor/')));
    check('local AudioWorklet module was loaded from the application', requests.some(request => request.url.includes('/audio/voice-isolation-worklet.mjs')));

    await createWindow({ denyModel: true });
    const unavailable = await evaluate(`(async () => {
      const raw = await navigator.mediaDevices.getUserMedia({ audio: VoiceIsolation.captureConstraints(), video:false });
      let message = '';
      try { await VoiceIsolation.create(raw, { mode: 'high-quality' }); } catch (error) { message = error.message; }
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = { message, rawLive: raw.getTracks().every(track => track.readyState === 'live'), contextsIdle: __voiceSecurity.contexts.every(context => context.state === 'closed') };
      raw.getTracks().forEach(track => track.stop());
      return result;
    })()`);
    check('missing packaged model rejects cleanly and keeps the raw microphone available for fallback', unavailable.message.length > 0 && unavailable.rawLive && unavailable.contextsIdle, unavailable);
    await createWindow({ denyPermission: true });
    const denied = await evaluate(`(async () => {
      try { await navigator.mediaDevices.getUserMedia({audio:VoiceIsolation.captureConstraints(),video:false}); return { denied:false }; }
      catch (error) { return { denied:error.name === 'NotAllowedError', name:error.name, contexts:__voiceSecurity.contexts.length }; }
    })()`);
    check('denied microphone permission fails without starting a processing context', denied.denied && denied.contexts === 0, denied);
    check('no renderer failures', errors.length === 0, errors);
    fs.writeFileSync(path.join(runDirectory, 'results.json'), JSON.stringify({ appRoot, checks, permissions, requests, errors, passed:true }, null, 2));
    console.log(`Passed ${checks.length} secure ${appRoot.endsWith('app.asar') ? 'packaged' : 'development'} voice-isolation checks. Results: ${path.join(runDirectory, 'results.json')}`);
    win.destroy();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(runDirectory, 'results.json'), JSON.stringify({ appRoot, checks, permissions, requests, errors, error:error.stack, passed:false }, null, 2));
    console.error(error.stack);
    console.error(`Results: ${path.join(runDirectory, 'results.json')}`);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
    throw error;
  }
}
