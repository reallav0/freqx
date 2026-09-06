/*
 * Run with: node tests/mic-isolation.cjs
 * Uses the real renderer, Web Audio engine and local RNNoise worklet in a hidden
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
    crashes: [], captures: [], contexts: [], edges: [], sinks: [], worklets: [],
    initialized: false, nextId: 1, ids: new WeakMap(),
    id(value) { if (!this.ids.has(value)) this.ids.set(value, this.nextId++); return this.ids.get(value); },
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
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); source.stop(); context.close(); };
      }
      if (stats.delayCaptureMs) await new Promise(resolve => setTimeout(resolve, stats.delayCaptureMs));
      return stream;
    },
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
    const appRoot = process.argv.includes('--packaged')
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
      assert('persisted off preference loads', await evaluate('!voiceIsolationToggle.checked && !micIsolationSession'));
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
      await evaluate('window.__oldSession = micIsolationSession; window.__oldWorklet = __micTest.worklets[0]; voiceIsolationToggle.click()');
      await until('__oldWorklet.context.state === "closed"', 'disabled processor cleanup');
      assert('disabling restores raw microphone and releases processor output tracks', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && __oldSession.stream.getTracks().every(track => track.readyState === "ended") && micStream === __originalMic && micStream.getTracks().every(track => track.readyState === "live")'));
      await assertUnchanged('disabling isolation preserves soundboard/output graph and settings', baseline);
      const offSignal = await measureSound();
      assert('disabling isolation preserves soundboard signal level', offSignal.every((value,index) => Math.abs(value/beforeSignal[index]-1) < 0.025), { before: beforeSignal, after: offSignal });
      assert('disabled preference is saved without changing capture count', await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceIsolation === false && __micTest.captures.length === __originalCaptureCount'));
      await evaluate('window.__originalIsolationApi=MicVoiceIsolation;window.MicVoiceIsolation={create:async()=>{throw new Error("Fixture model unavailable")}};setVoiceIsolationEnabled(true)');
      assert('startup failure preserves raw mic and reports isolation unavailable', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && micStream === __originalMic && voiceIsolationState.textContent.includes("unavailable") && __micTest.captures.length === __originalCaptureCount'));
      await assertUnchanged('isolation startup failure leaves soundboard and outputs intact', baseline);
      await evaluate('window.MicVoiceIsolation=__originalIsolationApi;setVoiceIsolationEnabled(false)');
      await evaluate(`window.MicVoiceIsolation={create:async(...args)=>{
        const session=await __originalIsolationApi.create(...args);
        window.__staleSession=session;window.__staleWorklet=__micTest.worklets.at(-1);
        await new Promise(resolve=>setTimeout(resolve,180));return session;
      }};void(window.__pendingToggle=setVoiceIsolationEnabled(true));`);
      await until('!!window.__staleSession', 'delayed processor initialization');
      await evaluate('setVoiceIsolationEnabled(false)');
      await evaluate('__pendingToggle');
      await until('__staleWorklet.context.state === "closed"', 'superseded processor cleanup');
      assert('rapid on/off cannot reconnect a stale processor or replace raw capture', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && micStream === __originalMic && __staleSession.stream.getTracks().every(track=>track.readyState === "ended") && __micTest.captures.length === __originalCaptureCount && !voiceIsolationToggle.checked'));
      await assertUnchanged('rapid toggles preserve soundboard and output graph', baseline);
      await evaluate('window.MicVoiceIsolation=__originalIsolationApi;setVoiceIsolationEnabled(true)');
      // Exercise the actual event listener, including cleanup and raw-mic recovery.
      await evaluate('window.__failedSession=micIsolationSession;window.__failedWorklet=__micTest.worklets.at(-1);__failedWorklet.node.dispatchEvent(new ErrorEvent("processorerror",{message:"Fixture processor failure"}))');
      await until('__failedWorklet.context.state === "closed"', 'failed processor cleanup');
      assert('processor error releases isolation and reconnects original raw microphone', await evaluate('!micIsolationSession && micSource.mediaStream === __originalMic && micStream.getTracks().every(track=>track.readyState === "live") && __failedSession.stream.getTracks().every(track=>track.readyState === "ended") && voiceIsolationState.textContent.includes("unavailable")'));
      await assertUnchanged('processor failure leaves soundboard and outputs intact', baseline);
      await evaluate('setVoiceIsolationEnabled(true)');
      await evaluate('window.__mutedSession=micIsolationSession;window.__mutedWorklet=__micTest.worklets.at(-1);setMicCaptureEnabled(false)');
      await until('__mutedWorklet.context.state === "closed"', 'mute processor cleanup');
      assert('mic off stops raw and processed tracks and detaches mic source', await evaluate('!micStream && !micSource && !micIsolationSession && __originalMic.getTracks().every(track => track.readyState === "ended") && __mutedSession.stream.getTracks().every(track => track.readyState === "ended")'));
      await assertUnchanged('mic off leaves soundboard and output routes active', baseline);
      await evaluate('setMicCaptureEnabled(true)');
      assert('mic re-enable restores saved isolation', await evaluate('isMicCaptureEnabled && !!micIsolationSession && __micTest.captures.length === __originalCaptureCount+1'));
      await evaluate('window.__deviceOldMic=micStream;window.__deviceOldSession=micIsolationSession;window.__deviceOldWorklet=__micTest.worklets.at(-1);inputDeviceSelect.value="fixture-mic-b";switchMicInput()');
      await until('selectedInputDeviceId === "fixture-mic-b" && !!micIsolationSession && micStream !== __deviceOldMic', 'microphone device switch');
      await until('__deviceOldWorklet.context.state === "closed"', 'old device processor cleanup');
      assert('device switch cleans previous capture and isolates replacement microphone', await evaluate('__deviceOldMic.getTracks().every(track => track.readyState === "ended") && __deviceOldSession.stream.getTracks().every(track => track.readyState === "ended") && __micTest.captures.at(-1).constraints.audio.deviceId.exact === "fixture-mic-b" && micSource.mediaStream === micIsolationSession.stream'));
      await assertUnchanged('device switch preserves soundboard/output graph and settings', baseline);
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
      await until('__startingWorklet.context.state === "closed"', 'muted pending model cleanup');
      assert('Mic button immediately mutes during isolation startup', await evaluate('!isMicCaptureEnabled && !micStream && !micSource && !micIsolationSession && __startingSession.stream.getTracks().every(track=>track.readyState === "ended")'));
      await assertUnchanged('muting during model startup leaves soundboard/output graph untouched', baseline);
      await evaluate('void(window.MicVoiceIsolation=__originalIsolationApi)');
      const suppression = await evaluate(`(${measureNoise.toString()})()`);
      assert('real RNNoise worklet suppresses seeded microphone noise', suppression.outputRms > 0 && suppression.attenuationDb < -10 && suppression.errors.length === 0, suppression);
      assert('controller close is idempotent and never stops caller-owned input tracks', suppression.rawTrackStillLiveAfterClose && suppression.processedTrackEndedAfterClose);
      await createWindow({ voiceIsolation: true });
      assert('persisted enabled preference restores isolation on startup', await evaluate('voiceIsolationToggle.checked && !!micIsolationSession && micSource.mediaStream === micIsolationSession.stream'));
      await createWindow({});
      assert('first launch enables isolation by default', await evaluate('voiceIsolationToggle.checked && !!micIsolationSession'));
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
  const session = await MicVoiceIsolation.create(destination.stream, { onError: error => errors.push(String(error)) });
  const processed = context.createMediaStreamSource(session.stream);
  const clean = context.createAnalyser(); clean.fftSize = 2048;
  const silent = context.createGain(); silent.gain.value = 0;
  processed.connect(clean); clean.connect(silent); silent.connect(context.destination);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const data = new Float32Array(2048);
  let rawEnergy = 0, cleanEnergy = 0, measurements = 0;
  for (let index = 0; index < 80; index++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    raw.getFloatTimeDomainData(data); rawEnergy += data.reduce((sum,value) => sum + value * value, 0) / data.length;
    clean.getFloatTimeDomainData(data); cleanEnergy += data.reduce((sum,value) => sum + value * value, 0) / data.length;
    measurements++;
  }
  const inputRms = Math.sqrt(rawEnergy / measurements), outputRms = Math.sqrt(cleanEnergy / measurements);
  const result = { inputSampleRate: context.sampleRate, inputRms, outputRms, attenuationDb: 20 * Math.log10(outputRms / inputRms), errors };
  await session.close();
  await session.close();
  result.rawTrackStillLiveAfterClose = destination.stream.getTracks().every(track => track.readyState === 'live');
  result.processedTrackEndedAfterClose = session.stream.getTracks().every(track => track.readyState === 'ended');
  source.stop(); destination.stream.getTracks().forEach(track => track.stop());
  await context.close();
  return result;
}
