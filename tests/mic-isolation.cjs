/*
 * Run with: node tests/mic-isolation.cjs
 * Uses the real renderer, Web Audio engine and local DeepFilterNet3 worklet in a hidden
 * Electron window with silent AudioContext sinks. Device routing and desktop IPC
 * are fixtures; no microphone, output device or user profile is accessed.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'mic-isolation');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else if (process.type === 'renderer') {
  installFixtures();
} else {
  runMain();
}

function installFixtures() {
  const { pathToFileURL } = require('node:url');
  const fixture = JSON.parse(fs.readFileSync(path.join(output, 'fixture.json'), 'utf8'));
  const stats = window.__micTest = {
    crashes: [], captures: [], captureAttempts: [], contexts: [], edges: [], sinks: [], worklets: [], assets: [],
    initialized: false, nextId: 1, ids: new WeakMap(),
    id(value) { if (!this.ids.has(value)) this.ids.set(value, this.nextId++); return this.ids.get(value); },
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    stats.assets.push(String(args[0]?.url || args[0]));
    return nativeFetch(...args);
  };
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = new Proxy(NativeAudioContext, {
    construct(target, args) {
      // A silent sink runs the real graph without writing to audio hardware.
      // WebContents.setAudioMuted(true) zeroes signals inside Chromium and would
      // make measurements invalid, so every context must have this sink instead.
      const context = new target({ ...args[0], sinkId: { type: 'none' } });
      stats.contexts.push(context);
      return context;
    },
  });
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function(destination, ...args) {
    const result = connect.call(this, destination, ...args);
    const edge = [stats.id(this), stats.id(destination), args[0] || 0, args[1] || 0];
    if (!stats.edges.some(value => JSON.stringify(value) === JSON.stringify(edge))) stats.edges.push(edge);
    return result;
  };
  AudioNode.prototype.disconnect = function(...args) {
    const result = disconnect.apply(this, args);
    stats.edges = stats.edges.filter(edge => !(edge[0] === stats.id(this) && (!args.length || typeof args[0] !== 'object' || edge[1] === stats.id(args[0]))));
    return result;
  };
  NativeAudioContext.prototype.setSinkId = async function(sinkId) {
    stats.sinks.push({ context: stats.id(this), sinkId });
  };
  const NativeWorkletNode = window.AudioWorkletNode;
  window.AudioWorkletNode = new Proxy(NativeWorkletNode, {
    construct(target, args) {
      const node = new target(...args);
      const entry = { node, context: args[0], name: args[1], messages: [], errors: [] };
      node.port.addEventListener('message', event => entry.messages.push(event.data));
      node.port.start();
      node.addEventListener('processorerror', event => entry.errors.push(event.message || 'processorerror'));
      stats.worklets.push(entry);
      return node;
    },
  });
  const devices = [
    { deviceId: 'fixture-mic-a', kind: 'audioinput', label: 'Fixture studio microphone', groupId: 'mic-a' },
    { deviceId: 'fixture-mic-b', kind: 'audioinput', label: 'Fixture headset microphone', groupId: 'mic-b' },
    { deviceId: 'fixture-cable', kind: 'audiooutput', label: 'CABLE Input (Fixture)', groupId: 'cable' },
    { deviceId: 'fixture-headphones', kind: 'audiooutput', label: 'Fixture headphones', groupId: 'headphones' },
  ];
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => devices });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    value: async constraints => {
      stats.captureAttempts.push(constraints);
      if (stats.captureError) throw new DOMException('Fixture microphone permission denied.', stats.captureError);
      const context = new AudioContext({ sampleRate: fixture.micSampleRate || 44100 });
      const destination = context.createMediaStreamDestination();
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(destination);
      source.start();
      await context.resume();
      const stream = destination.stream;
      stats.captures.push({ constraints, stream, context, source });
      for (const track of stream.getTracks()) {
        let echoCancellation = Boolean(constraints.audio.echoCancellation);
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), echoCancellation });
        track.applyConstraints = async update => { if (typeof update.echoCancellation?.exact === 'boolean') echoCancellation = update.echoCancellation.exact; };
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => { if (stopped) return; stopped = true; stop(); source.stop(); void context.close(); };
      }
      if (stats.delayCaptureMs) await new Promise(resolve => setTimeout(resolve, stats.delayCaptureMs));
      return stream;
    },
  });
  // The production loopback-reference helper calls getDisplayMedia for AEC.
  // This fixture has no system output to capture, so reject deterministically
  // and let VoiceIsolation exercise its DeepFilterNet-only fallback.
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    value: async () => { throw new DOMException('Fixture display capture unavailable.', 'NotAllowedError'); },
  });
  localStorage.clear();
  localStorage.setItem('soundmuncher:walkthrough-complete:v1', 'true');
  localStorage.setItem('soundmuncher:mixer-settings', JSON.stringify({
    micGain: 0.71, soundGain: 0.63, masterGain: 0.81, soundPlayback: true,
    inputDeviceId: 'fixture-mic-a', outputDeviceId: 'fixture-cable',
    localPlaybackDeviceId: 'fixture-headphones', ...fixture.settings,
  }));
  localStorage.setItem('soundmuncher:library-metadata', JSON.stringify({
    boards: ['Main'], sounds: { 'fixture:tone': { name: 'Isolation routing fixture', board: 'Main', volume: 0.2, playbackMode: 'loop' } },
  }));
  const noop = async () => ({ ok: true });
  window.soundmuncher = {
    appName: 'Freqx', websiteUrl: 'https://freqx.app',
    reportCrash: async report => { stats.crashes.push(report); return report; },
    getAppSettings: async () => ({ keepRunningInTray: false, launchOnStartup: false }),
    setAppSettings: async settings => ({ settings }),
    listImportedFiles: async () => [{ path: 'fixture:tone', name: 'Isolation routing fixture', board: 'Main', sizeBytes: 96044, fileUrl: pathToFileURL(path.join(output, 'tone.wav')).href }],
    registerGlobalKeybinds: async () => ({ failed: [] }),
    listOutputDevices: async () => [], importAudioFiles: async () => ({ canceled: true, files: [] }),
    removeImportedFile: noop, sendTestTone: noop, openLibraryFolder: noop, openWebsite: noop,
    externalImportsReady: async () => { stats.initialized = true; },
    checkForUpdates: async () => ({ updateAvailable: false, currentVersion: '1.6.0' }),
    openUpdatePage: noop, reloadAfterCrash: noop, openCrashLog: noop, quitAfterCrash: noop,
    onGlobalKeybindTriggered: () => () => {}, onExternalImportStarted: () => () => {},
    onExternalImportCompleted: () => () => {}, onFatalError: () => () => {},
  };
}

async function runMain() {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'isolated-profile'));
  app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const wave = Buffer.alloc(44 + 48000 * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8);
  wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22); wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  for (let index = 0; index < 48000; index++) wave.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * 1000 * index / 48000)), 44 + index * 2);
  fs.writeFileSync(path.join(output, 'tone.wav'), wave);
  const checks = [];
  const consoleErrors = [];
  let win;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  function assert(name, condition, detail) {
    const pass = Boolean(condition);
    checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!pass) throw new Error(name);
  }
  async function until(source, description, timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(source)) return;
      await pause(50);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }
  async function createWindow(settings = {}) {
    fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ settings }));
    if (win && !win.isDestroyed()) win.destroy();
    win = new BrowserWindow({ show: false, width: 1200, height: 760, webPreferences: {
      preload: __filename, contextIsolation: false, sandbox: false, nodeIntegration: false,
      backgroundThrottling: false, partition: `mic-isolation-${Date.now()}`,
    } });
    win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.on('console-message', (_, level, message) => { if (level >= 2) consoleErrors.push(message); });
    const rootArgument = process.argv.indexOf('--app-root');
    const appRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : process.argv.includes('--packaged')
      ? path.join(output, '..', 'voice-isolation-build', 'win-unpacked', 'resources', 'app.asar')
      : root;
    await win.loadFile(path.join(appRoot, 'index.html'));
    await until('window.__micTest?.initialized', 'renderer initialization');
    assert('renderer initializes with fixture microphone', await evaluate('isMicCaptureEnabled && !!micStream && __micTest.crashes.length === 0'));
  }
  const graphExpression = `(() => {
    const nodes = { soundGainNode, soundToMixGainNode, masterGainNode, compressorNode, mixDestination, appPlaybackGainNode, appPlaybackDestination, mixOutSource, mixOutGainNode, localOutSource, levelAnalyser, mixOutDestination: mixOutContext.destination, localOutDestination: localOutContext.destination };
    const ids = Object.fromEntries(Object.entries(nodes).map(([name,node]) => [name,__micTest.id(node)]));
    const protectedIds = new Set(Object.values(ids));
    return {
      ids, edges: __micTest.edges.filter(edge => protectedIds.has(edge[0])).sort((a,b) => a[0]-b[0] || a[1]-b[1]),
      contexts: [audioContext,mixOutContext,localOutContext].map(context => ({ id:__micTest.id(context), sampleRate:context.sampleRate, state:context.state })),
      gains: [soundGainNode,soundToMixGainNode,masterGainNode,appPlaybackGainNode,mixOutGainNode].map(node => node.gain.value),
      compressor: ['threshold','knee','ratio','attack','release'].map(key => compressorNode[key].value),
      selections: [selectedOutputDeviceId,selectedLocalPlaybackDeviceId],
      sourceStreamIds: [mixOutSource.mediaStream.id,localOutSource.mediaStream.id],
      settings: { soundGain:Number(soundGainSlider.value),masterGain:Number(masterGainSlider.value),soundPlayback:isSoundPlaybackEnabled },
    };
  })()`;
  async function assertUnchanged(name, baseline) {
    const current = await evaluate(graphExpression);
    assert(name, JSON.stringify(current) === JSON.stringify(baseline), { sameGraphAndParameters: JSON.stringify(current) === JSON.stringify(baseline) });
  }
  async function measureSound() {
    return evaluate(`(async () => {
      const sums = [0,0,0]; const data = new Float32Array(2048);
      for (let frame = 0; frame < 15; frame++) {
        await new Promise(resolve => setTimeout(resolve,20));
        __soundAnalysers.forEach((analyser,index) => {
          analyser.getFloatTimeDomainData(data);
          sums[index] += data.reduce((sum,value) => sum+value*value,0)/data.length;
        });
      }
      return sums.map(sum => Math.sqrt(sum/15));
    })()`);
  }
  try {
    await app.whenReady();
    await createWindow({ voiceIsolation: false });
    if (process.argv.includes('--baseline')) {
      const baseline = await evaluate(graphExpression);
      fs.writeFileSync(path.join(output, 'baseline-graph.json'), JSON.stringify(baseline, null, 2));
      assert('baseline mixer graph captured before integration', baseline.edges.length === 10, baseline);
    } else {
      assert('persisted off preference loads', await evaluate('!voiceIsolationToggle.checked && !micIsolationSession && voiceIsolationMode.value === "off"'));
      assert('microphone disables all Chromium processing', await evaluate(`__micTest.captures.every(({constraints}) => {
        const audio = constraints.audio;
        return constraints.video === false && audio.echoCancellation === false && audio.noiseSuppression === false && audio.autoGainControl === false
          && (audio.channelCount === 1 || audio.channelCount.ideal === 1)
          && (audio.sampleRate === 48000 || audio.sampleRate.ideal === 48000);
      })`));
      assert('VoiceIsolation is reusable without renderer Node integration', await evaluate('window.VoiceIsolation === window.MicVoiceIsolation && typeof VoiceIsolation.create === "function" && typeof window.require === "undefined"'));
      await evaluate(`window.__originalMic = micStream; window.__originalCaptureCount = __micTest.captures.length;
        window.__soundAnalysers = [appPlaybackGainNode,soundToMixGainNode,compressorNode].map(node => { const analyser=audioContext.createAnalyser(); analyser.fftSize=2048;node.connect(analyser);return analyser; });
        playImportedSound(importedLibraryItems[0]);`);
      await until('activeSoundNodes.size === 1', 'looping soundboard fixture');
      await pause(250);
      const baseline = await evaluate(graphExpression);
      const expectedConnections = [['soundGainNode','soundToMixGainNode'],['soundGainNode','appPlaybackGainNode'],['soundToMixGainNode','masterGainNode'],['masterGainNode','compressorNode'],['compressorNode','mixDestination'],['compressorNode','levelAnalyser'],['appPlaybackGainNode','appPlaybackDestination'],['mixOutSource','mixOutGainNode'],['mixOutGainNode','mixOutDestination'],['localOutSource','localOutDestination']];
      assert('existing soundboard and output routing remains intact', expectedConnections.every(([from,to]) => baseline.edges.some(edge => edge[0] === baseline.ids[from] && edge[1] === baseline.ids[to])));
      const beforeSignal = await measureSound();
      assert('soundboard fixtures reach local playback, mix branch and mixed output', beforeSignal.every(value => value > 0.005), beforeSignal);
      const sinksBefore = await evaluate('__micTest.sinks.length');
      await evaluate('voiceIsolationToggle.click()');
      await until('!!micIsolationSession', 'voice isolation session');
      await pause(200);
      assert('toggle enables local RNNoise on a dedicated 48 kHz context', await evaluate('__micTest.worklets.length === 1 && __micTest.worklets[0].context.sampleRate === 48000 && __micTest.worklets[0].context !== audioContext && __micTest.worklets[0].context !== mixOutContext && __micTest.worklets[0].context !== localOutContext'));
      assert('only mic source consumes processed stream', await evaluate('micSource.mediaStream === micIsolationSession.stream && micSource.mediaStream !== micStream && __micTest.edges.some(edge => edge[0] === __micTest.id(micSource) && edge[1] === __micTest.id(micGainNode))'));
      assert('toggle does not reacquire or stop physical input', await evaluate('micStream === __originalMic && __micTest.captures.length === __originalCaptureCount && micStream.getTracks().every(track => track.readyState === "live")'));
      assert('toggle does not call output routing APIs', await evaluate('__micTest.sinks.length') === sinksBefore);
      await assertUnchanged('enabling isolation preserves soundboard/output nodes, edges, sample rates, gains, compressor and destinations', baseline);
      const onSignal = await measureSound();
      assert('enabling isolation preserves soundboard signal level at all three routes', onSignal.every((value,index) => Math.abs(value/beforeSignal[index]-1) < 0.025), { before: beforeSignal, after: onSignal });
      assert('enabled preference is saved', await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceIsolation === true && voiceIsolationToggle.checked'));
      await evaluate('window.__modeCapture=micStream;voiceIsolationMode.value="high-quality";voiceIsolationMode.dispatchEvent(new Event("change",{bubbles:true}))');
      await until('micIsolationSession?.requestedMode === "high-quality"', 'High quality model startup');
      await evaluate('window.__modeSession=micIsolationSession;window.__modeWorklet=__micTest.worklets.at(-1);window.__modeWorkletCount=__micTest.worklets.length');
      assert('High quality loads locally without reopening microphone or changing soundboard graph', await evaluate('micStream === __modeCapture && __micTest.captures.length === __originalCaptureCount && micSource.mediaStream === __modeSession.stream && voiceIsolationToggle.checked'));
      assert('High quality preference is persisted', await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceIsolationMode === "high-quality"'));
      await evaluate('voiceIsolationStrength.value="0.67";voiceIsolationStrength.dispatchEvent(new Event("input",{bubbles:true}))');
      assert('strength slider updates the live session and saved preference', await evaluate('micIsolationSession.strength === 0.67 && JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceIsolationStrength === 0.67'));
      await assertUnchanged('changing isolation mode and strength leaves soundboard and outputs intact', baseline);
      await evaluate('setVoiceIsolationMode("light")');
      await until('__modeWorklet.messages.some(message=>message.type === "mode" && message.mode === "light")', 'Light processor acknowledgment');
      assert('Light reuses a loaded High quality session without reopening capture', await evaluate('micIsolationSession === __modeSession && micIsolationSession.mode === "light" && micSource.mediaStream === __modeSession.stream && __micTest.worklets.length === __modeWorkletCount && __micTest.captures.length === __originalCaptureCount && voiceIsolationMode.value === "light"'));
      await evaluate('__modeWorklet.context.suspend()');
      await until('__modeWorklet.context.state === "running"', 'suspended isolation context recovery');
      assert('context recovery preserves active microphone and processed stream', await evaluate('micIsolationSession === __modeSession && micSource.mediaStream === __modeSession.stream && __micTest.captures.length === __originalCaptureCount && __modeSession.stream.getTracks().every(track=>track.readyState === "live")'));
      await evaluate('micIsolationSession.resume()');
      await assertUnchanged('isolation context recovery leaves mixer and outputs intact', baseline);
      await evaluate('window.__oldSession = micIsolationSession; window.__oldWorklet = __micTest.worklets[0]; voiceIsolationMode.value="off";voiceIsolationMode.dispatchEvent(new Event("change",{bubbles:true}))');
      await until('__oldWorklet.context.state === "suspended"', 'disabled processor cleanup');
      assert('disabling restores raw microphone and releases processor output tracks', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && __oldSession.stream.getTracks().every(track => track.readyState === "ended") && micStream === __originalMic && micStream.getTracks().every(track => track.readyState === "live")'));
      await assertUnchanged('disabling isolation preserves soundboard/output graph and settings', baseline);
      const offSignal = await measureSound();
      assert('disabling isolation preserves soundboard signal level', offSignal.every((value,index) => Math.abs(value/beforeSignal[index]-1) < 0.025), { before: beforeSignal, after: offSignal });
      assert('Off mode unchecks the toggle and saves preference without changing capture count', await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceIsolation === false && __micTest.captures.length === __originalCaptureCount && !voiceIsolationToggle.checked && voiceIsolationMode.value === "off"'));
      // Supply a synthetic reference and delay the actual AEC module until the
      // neural worklet is ready. No display capture or physical device is used.
      await evaluate(`window.__originalLoopbackReference = window.LoopbackReference;
        window.__aecReference = micStream.getAudioTracks()[0].clone();
        window.__aecReleases = 0;
        window.LoopbackReference = { acquire: async () => __aecReference, release: track => { __aecReleases++; track.stop(); } };
        window.__aecContext = __oldWorklet.context;
        window.__aecAddModule = __aecContext.audioWorklet.addModule;
        window.__releaseAec = null;
        window.__aecGate = new Promise(resolve => { __releaseAec = resolve; });
        __aecContext.audioWorklet.addModule = async function(url) {
          if (url.includes('aec-worklet')) await __aecGate;
          return __aecAddModule.call(this, url);
        };
        window.__aecSession = null;
        void (window.__aecPending = VoiceIsolation.create(micStream, { referenceDeviceId: '' }).then(session => { __aecSession = session; }));`);
      // A running isolation context represents overlapping session startup;
      // Chromium does not deliver ready messages while its context is suspended.
      await evaluate('__aecContext.resume()');
      await until('__micTest.worklets.at(-1).name === "freqx-voice-isolation" && __micTest.worklets.at(-1).messages.some(message => message.type === "ready")', 'model readiness during delayed AEC load');
      assert('model readiness does not finish isolation before the AEC graph is ready', await evaluate('!__aecSession'));
      await evaluate('__releaseAec(); __aecPending');
      assert('real AEC worklet receives both mic and synthetic reference inputs', await evaluate(`(() => {
        const aec = __micTest.worklets.find(worklet => worklet.name === 'freqx-aec');
        const inputs = __micTest.edges.filter(edge => edge[1] === __micTest.id(aec.node));
        return inputs.length === 2 && inputs.some(edge => edge[3] === 0) && inputs.some(edge => edge[3] === 1);
      })()`));
      await evaluate(`__aecSession.close(); __aecContext.audioWorklet.addModule = __aecAddModule;
        void (window.LoopbackReference = __originalLoopbackReference);`);
      await until('__aecContext.state === "suspended"', 'AEC session teardown');
      assert('AEC teardown releases its reference while preserving caller-owned microphone', await evaluate('__aecReleases === 1 && __aecReference.readyState === "ended" && micStream.getAudioTracks()[0].readyState === "live"'));
      await assertUnchanged('delayed AEC startup and teardown preserve soundboard/output graph', baseline);
      await evaluate('window.__originalIsolationApi=MicVoiceIsolation;window.MicVoiceIsolation={create:async()=>{throw new Error("Fixture model unavailable")}};setVoiceIsolationEnabled(true)');
      assert('startup failure preserves raw mic and reports isolation unavailable', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && micStream === __originalMic && voiceIsolationState.textContent.includes("unavailable") && __micTest.captures.length === __originalCaptureCount'));
      await assertUnchanged('isolation startup failure leaves soundboard and outputs intact', baseline);
      await evaluate('window.MicVoiceIsolation=__originalIsolationApi;setVoiceIsolationEnabled(false)');
      await evaluate('(async()=>{const validate=WebAssembly.validate;try{WebAssembly.validate=()=>false;await setVoiceIsolationMode("high-quality")}finally{WebAssembly.validate=validate}})()');
      assert('unsupported SIMD falls back to Light while retaining requested High quality', await evaluate('micIsolationSession?.mode === "light" && selectedVoiceIsolationMode === "high-quality" && micStream.getTracks().every(track=>track.readyState === "live") && voiceIsolationState.textContent.includes("Using Light") && __micTest.captures.length === __originalCaptureCount'));
      await assertUnchanged('unsupported WASM SIMD leaves soundboard and outputs intact', baseline);
      await evaluate('setVoiceIsolationEnabled(true)');
      await evaluate('window.__closedContextSession=micIsolationSession;window.__closedContextWorklet=__micTest.worklets.at(-1);__closedContextWorklet.context.close()');
      await until('!micIsolationSession && micSource.mediaStream === micStream', 'closed isolation context fallback');
      assert('unexpected AudioContext closure restores microphone and releases processed tracks', await evaluate('__closedContextSession.stream.getTracks().every(track=>track.readyState === "ended") && micStream === __originalMic && micStream.getTracks().every(track=>track.readyState === "live") && voiceIsolationState.textContent.includes("unavailable")'));
      await assertUnchanged('unexpected isolation context closure leaves soundboard and outputs intact', baseline);
      await evaluate('setVoiceIsolationEnabled(false)');
      await evaluate(`window.MicVoiceIsolation={create:async(...args)=>{
        const session=await __originalIsolationApi.create(...args);
        window.__staleSession=session;window.__staleWorklet=__micTest.worklets.at(-1);
        await new Promise(resolve=>setTimeout(resolve,180));return session;
      }};void(window.__pendingToggle=setVoiceIsolationEnabled(true));`);
      await until('!!window.__staleSession', 'delayed processor initialization');
      await evaluate('setVoiceIsolationEnabled(false)');
      await evaluate('__pendingToggle');
      await until('__staleWorklet.context.state === "suspended"', 'superseded processor cleanup');
      assert('rapid on/off cannot reconnect a stale processor or replace raw capture', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && micStream === __originalMic && __staleSession.stream.getTracks().every(track=>track.readyState === "ended") && __micTest.captures.length === __originalCaptureCount && !voiceIsolationToggle.checked'));
      await assertUnchanged('rapid toggles preserve soundboard and output graph', baseline);
      await evaluate('window.MicVoiceIsolation=__originalIsolationApi;setVoiceIsolationEnabled(true)');
      // Exercise the actual event listener, including cleanup and raw-mic recovery.
      await evaluate('window.__failedSession=micIsolationSession;window.__failedWorklet=__micTest.worklets.at(-1);__failedWorklet.node.dispatchEvent(new ErrorEvent("processorerror",{message:"Fixture processor failure"}))');
      await until('__failedWorklet.context.state === "suspended"', 'failed processor cleanup');
      assert('processor error releases isolation and reconnects original raw microphone', await evaluate('!micIsolationSession && micSource.mediaStream === __originalMic && micStream.getTracks().every(track=>track.readyState === "live") && __failedSession.stream.getTracks().every(track=>track.readyState === "ended") && voiceIsolationState.textContent.includes("unavailable")'));
      await assertUnchanged('processor failure leaves soundboard and outputs intact', baseline);
      await evaluate('setVoiceIsolationEnabled(true)');
      await evaluate('window.__mutedSession=micIsolationSession;window.__mutedWorklet=__micTest.worklets.at(-1);setMicCaptureEnabled(false)');
      await until('__mutedWorklet.context.state === "suspended"', 'mute processor cleanup');
      assert('mic off stops raw and processed tracks and detaches mic source', await evaluate('!micStream && !micSource && !micIsolationSession && __originalMic.getTracks().every(track => track.readyState === "ended") && __mutedSession.stream.getTracks().every(track => track.readyState === "ended")'));
      await assertUnchanged('mic off leaves soundboard and output routes active', baseline);
      await evaluate('setMicCaptureEnabled(true)');
      assert('mic re-enable restores saved isolation', await evaluate('isMicCaptureEnabled && !!micIsolationSession && __micTest.captures.length === __originalCaptureCount+1'));
      await evaluate('window.__deviceOldMic=micStream;window.__deviceOldSession=micIsolationSession;window.__deviceOldWorklet=__micTest.worklets.at(-1);inputDeviceSelect.value="fixture-mic-b";switchMicInput()');
      await until('selectedInputDeviceId === "fixture-mic-b" && !!micIsolationSession && micStream !== __deviceOldMic', 'microphone device switch');
      await until('__deviceOldWorklet.messages.some(message => message.type === "destroyed")', 'old device processor cleanup');
      assert('device switch cleans previous capture and isolates replacement microphone', await evaluate('__deviceOldMic.getTracks().every(track => track.readyState === "ended") && __deviceOldSession.stream.getTracks().every(track => track.readyState === "ended") && __micTest.captures.at(-1).constraints.audio.deviceId.exact === "fixture-mic-b" && micSource.mediaStream === micIsolationSession.stream'));
      await assertUnchanged('device switch preserves soundboard/output graph and settings', baseline);
      await evaluate('__micTest.captureError="NotAllowedError";inputDeviceSelect.value="fixture-mic-a";switchMicInput()');
      assert('permission rejection during microphone change leaves a recoverable Mic Off state', await evaluate('!isMicCaptureEnabled && !micStream && !micSource && !micIsolationSession && toggleMicCaptureButton.textContent === "Mic: Off" && __micTest.crashes.length === 0'));
      await assertUnchanged('microphone permission rejection leaves soundboard and output graph untouched', baseline);
      await evaluate('__micTest.captureError=null;setMicCaptureEnabled(true)');
      assert('microphone can recover after permission is granted without restarting', await evaluate('isMicCaptureEnabled && !!micIsolationSession && micSource.mediaStream === micIsolationSession.stream'));
      await evaluate('window.__endedMic=micStream;window.__endedSession=micIsolationSession;window.__endedWorklet=__micTest.worklets.at(-1);const endedTrack=micStream.getAudioTracks()[0];endedTrack.stop();endedTrack.dispatchEvent(new Event("ended"))');
      await until('__endedWorklet.context.state === "suspended"', 'disconnected microphone cleanup');
      assert('ended microphone stops isolation and clears the capture state', await evaluate('!isMicCaptureEnabled && !micStream && !micSource && !micIsolationSession && __endedSession.stream.getTracks().every(track=>track.readyState === "ended") && toggleMicCaptureButton.textContent === "Mic: Off"'));
      await assertUnchanged('microphone disconnection leaves soundboard and outputs intact', baseline);
      await evaluate('setMicCaptureEnabled(false);__micTest.delayCaptureMs=180;window.__captureCountBeforeDelay=__micTest.captures.length;void(window.__lateCapture=setMicCaptureEnabled(true))');
      await until('__micTest.captures.length === __captureCountBeforeDelay+1', 'delayed microphone acquisition');
      await evaluate('setMicCaptureEnabled(false)');
      await evaluate('__lateCapture');
      await until('__micTest.captures.at(-1).context.state === "closed"', 'superseded raw capture cleanup');
      assert('mic off during device acquisition cannot restore capture or leave live tracks', await evaluate('!isMicCaptureEnabled && !micStream && !micSource && !micIsolationSession && __micTest.captures.at(-1).stream.getTracks().every(track=>track.readyState === "ended")'));
      await assertUnchanged('late microphone acquisition leaves soundboard/output graph untouched', baseline);
      await evaluate('__micTest.delayCaptureMs=0;stopAllSounds()');
      await evaluate(`window.MicVoiceIsolation={create:async(...args)=>{
        const session=await __originalIsolationApi.create(...args);
        window.__startingSession=session;window.__startingWorklet=__micTest.worklets.at(-1);
        await new Promise(resolve=>setTimeout(resolve,250));return session;
      }};void(window.__startingMic=setMicCaptureEnabled(true));`);
      await until('!!window.__startingSession', 'model startup after mic re-enable');
      assert('live mic shows On while isolation is still starting', await evaluate('isMicCaptureEnabled && toggleMicCaptureButton.textContent === "Mic: On" && !!micSource && !micIsolationSession'));
      await evaluate('toggleMicCaptureButton.click()');
      await evaluate('__startingMic');
      await until('__startingWorklet.context.state === "suspended"', 'muted pending model cleanup');
      assert('Mic button immediately mutes during isolation startup', await evaluate('!isMicCaptureEnabled && !micStream && !micSource && !micIsolationSession && __startingSession.stream.getTracks().every(track=>track.readyState === "ended")'));
      await assertUnchanged('muting during model startup leaves soundboard/output graph untouched', baseline);
      await evaluate('void(window.MicVoiceIsolation=__originalIsolationApi)');
      const suppression = await evaluate(`(${measureNoise.toString()})()`);
      // High attenuation can remove this noise-only fixture completely. Verify
      // frames were actually processed so a disconnected/silent node cannot pass.
      assert('real DeepFilterNet3 worklet produces finite PCM and suppresses seeded microphone noise', suppression.inputRms > 0.01 && suppression.outputRms >= 0 && suppression.attenuationDb < -10 && suppression.processedFrames > 150 && suppression.nonFiniteSamples === 0 && suppression.errors.length === 0, suppression);
      assert('controller close is idempotent and never stops caller-owned input tracks', suppression.rawTrackStillLiveAfterClose && suppression.processedTrackEndedAfterClose);
      await createWindow({ voiceIsolation: true });
      assert('legacy enabled preference restores Light isolation', await evaluate('voiceIsolationToggle.checked && !!micIsolationSession && micIsolationSession.mode === "light" && micSource.mediaStream === micIsolationSession.stream'));
      await createWindow({ voiceIsolation: true, voiceIsolationMode: 'strong' });
      assert('legacy Strong preference migrates to High quality on startup', await evaluate('voiceIsolationToggle.checked && !!micIsolationSession && micIsolationSession.requestedMode === "high-quality" && voiceIsolationMode.value === "high-quality" && micSource.mediaStream === micIsolationSession.stream'));
      await createWindow({});
      assert('first launch enables Light isolation by default', await evaluate('voiceIsolationToggle.checked && !!micIsolationSession && micIsolationSession.mode === "light" && voiceIsolationMode.value === "light"'));
      const assets = await evaluate('__micTest.assets.filter(url=>url.includes("/audio/"))');
      assert('default Light loads only local RNNoise without downloading the High quality model', assets.some(url=>/rnnoise\.wasm$/.test(url)) && !assets.some(url=>/df_bg\.wasm$/.test(url)) && assets.every(url=>url.startsWith('file:')) && (!process.argv.includes('--packaged') || assets.every(url=>url.includes('/resources/app.asar/audio/'))), assets);
      const engine = await evaluate('__micTest.worklets.at(-1).messages.find(message=>message.type === "ready")');
      assert('processor reports a 48 kHz realtime frame pipeline with bounded algorithmic buffering', engine?.sampleRate === 48000 && engine?.frameSize === 480 && engine?.bufferLatencyMs === 10 && engine?.modelLatencyMs === 10, engine);
      await pause(1200);
      assert('debug readout reports processing cost and estimated added latency', await evaluate('voiceIsolationDebug.textContent.includes("ms/frame") && voiceIsolationDebug.textContent.includes("latency") && Number.isFinite(micIsolationSession.diagnostics.processingMs) && micIsolationSession.diagnostics.processingMs > 0 && micIsolationSession.diagnostics.estimatedLatencyMs >= 20'));
      assert('no renderer crashes or AudioWorklet processor errors', await evaluate('__micTest.crashes.length === 0 && __micTest.worklets.every(worklet => worklet.errors.length === 0)'));
      await evaluate('document.getElementById("voiceIsolationToggle").scrollIntoView({block:"center"})');
      await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      fs.writeFileSync(path.join(output, 'voice-isolation.png'), (await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, consoleErrors, passed: true }, null, 2));
    console.log(`Passed ${checks.length} microphone isolation checks.`);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(0);
  } catch (error) {
    let rendererState;
    try { rendererState = await evaluate('({status:document.getElementById("voiceIsolationState")?.textContent,crashes:__micTest.crashes,worklets:__micTest.worklets.map(w=>({name:w.name,state:w.context.state,messages:w.messages,errors:w.errors}))})'); } catch {}
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, consoleErrors, error: error.stack, rendererState, passed: false }, null, 2));
    console.error(error.stack);
    if (rendererState) console.error(JSON.stringify(rendererState));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
}

async function measureNoise() {
  const context = new AudioContext({ sampleRate: 44100 });
  const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
  const samples = buffer.getChannelData(0);
  let seed = 0x12345678;
  for (let index = 0; index < samples.length; index++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    samples[index] = ((seed / 4294967296) * 2 - 1) * 0.07;
  }
  const source = context.createBufferSource();
  source.buffer = buffer; source.loop = true;
  const destination = context.createMediaStreamDestination();
  const raw = context.createAnalyser(); raw.fftSize = 2048;
  source.connect(destination); source.connect(raw); source.start();
  await context.resume();
  const errors = [];
  const session = await MicVoiceIsolation.create(destination.stream, { mode: "high-quality", strength: 1, compressor: false, onError: error => errors.push(String(error)) });
  const processed = context.createMediaStreamSource(session.stream);
  const clean = context.createAnalyser(); clean.fftSize = 2048;
  const silent = context.createGain(); silent.gain.value = 0;
  processed.connect(clean); clean.connect(silent); silent.connect(context.destination);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const data = new Float32Array(2048);
  let rawEnergy = 0, cleanEnergy = 0, measurements = 0, nonFiniteSamples = 0;
  for (let index = 0; index < 80; index++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    raw.getFloatTimeDomainData(data); rawEnergy += data.reduce((sum,value) => sum + value * value, 0) / data.length;
    clean.getFloatTimeDomainData(data); cleanEnergy += data.reduce((sum,value) => sum + value * value, 0) / data.length;
    nonFiniteSamples += data.reduce((count,value) => count + (Number.isFinite(value) ? 0 : 1), 0);
    measurements++;
  }
  const inputRms = Math.sqrt(rawEnergy / measurements), outputRms = Math.sqrt(cleanEnergy / measurements);
  const result = { inputSampleRate: context.sampleRate, inputRms, outputRms, attenuationDb: 20 * Math.log10(outputRms / inputRms), nonFiniteSamples, errors };
  const worklet = __micTest.worklets.at(-1);
  worklet.node.port.postMessage({ type: 'ping', id: 'noise-measurement' });
  await new Promise(resolve => setTimeout(resolve, 100));
  result.processedFrames = worklet.messages.find(message => message.type === 'pong' && message.id === 'noise-measurement')?.processedFrames || 0;
  await session.close();
  await session.close();
  result.rawTrackStillLiveAfterClose = destination.stream.getTracks().every(track => track.readyState === 'live');
  result.processedTrackEndedAfterClose = session.stream.getTracks().every(track => track.readyState === 'ended');
  source.stop(); destination.stream.getTracks().forEach(track => track.stop());
  await context.close();
  return result;
}
