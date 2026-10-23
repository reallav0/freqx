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
      node.port.addEventListener('message', event => entry.messages.push(event.data?.type === 'input'
        ? { type: 'input', sequence: event.data.sequence, sampleCount: event.data.samples?.length } : event.data));
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
      stats.captures.push({ constraints, stream, context, source, destination });
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
  stats.ptt = { begins: [], ends: [], refreshes: [], releases: 0, configurations: [] };
  stats.conversion = { starts: [], stops: [], frames: 0, lists: 0, active: new Set() };
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
    listAutoPttApps: async () => ({ apps: [{ processName: 'TestGame.exe', title: 'Test game' }] }),
    configureAutoPtt: async configuration => {
      stats.ptt.configurations.push(configuration); stats.ptt.onState?.({ status: configuration.enabled ? 'ready' : 'off' }); return { ok: true };
    },
    beginAutoPtt: async input => {
      stats.ptt.begins.push(input);
      if (stats.ptt.defer) await new Promise(resolve => { stats.ptt.finish = resolve; });
      return { ok: true, holding: true };
    },
    endAutoPtt: async id => { stats.ptt.ends.push(id); return { ok: true }; },
    refreshAutoPtt: ids => stats.ptt.refreshes.push(ids),
    releaseAutoPtt: () => { stats.ptt.releases++; },
    onAutoPttState: handler => { stats.ptt.onState = handler; return () => {}; },
    listVoiceConversionModels: async () => {
      stats.conversion.lists++;
      return { ok: true, voices: [{ id: '0', name: 'Fixture bright voice' }, { id: '1', name: 'Fixture deep voice' }] };
    },
    startVoiceConversion: async configuration => {
      const id = `fixture-conversion-${stats.conversion.starts.length + 1}`;
      stats.conversion.starts.push({ ...configuration, id });
      if (stats.conversion.defer) await new Promise(resolve => { stats.conversion.finish = resolve; });
      stats.conversion.active.add(id);
      return { ok: true, id, sampleRate: 48000, blockSize: 7680 };
    },
    convertVoiceFrame: async input => {
      stats.conversion.frames++;
      if (stats.conversion.fail) return { ok: false, error: 'Fixture conversion stopped.' };
      if (!stats.conversion.active.has(input.id)) return { ok: false, error: 'Session stopped.' };
      stats.conversion.lastInput = input.samples;
      const samples = new Float32Array(7680);
      for (let i = 0; i < samples.length; i++) samples[i] = 0.04 * Math.sin(2 * Math.PI * 960 * ((input.sequence - 1) * samples.length + i) / 48000);
      return { ok: true, id: input.id, sequence: input.sequence, samples, processingMs: 1 };
    },
    stopVoiceConversion: id => { stats.conversion.stops.push(id); if (id) stats.conversion.active.delete(id); else stats.conversion.active.clear(); },
    openVoiceConversionSetup: noop, openVoiceConversionGuide: noop,
  };
  if (fixture.replay) require('./replay-desktop.cjs').install(stats, output);
  if (fixture.updateNotice) require('./update-notice-desktop.cjs').install(stats);
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
    fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ settings, replay: process.argv.includes('--replay'), updateNotice: process.argv.includes('--update-notice') }));
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
    const nodes = { soundGainNode, voicePriorityNode, soundToMixGainNode, masterGainNode, compressorNode, mixLimiterNode, mixDestination, appPlaybackGainNode, localPlaybackLimiterNode, appPlaybackDestination, mixOutSource, mixOutGainNode, localOutSource, levelAnalyser, mixOutDestination: mixOutContext.destination, localOutDestination: localOutContext.destination };
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
    await createWindow({ voiceIsolation: false, ...(process.argv.includes('--voice-conversion') ? { voiceConversion: { mode: 'rvc' } } : {}) });
    if (process.argv.includes('--update-notice')) {
      await require('./update-notice-desktop.cjs').run({ evaluate, until, assert, pause, createWindow, getWindow: () => win, output });
    } else if (process.argv.includes('--replay')) {
      await require('./replay-desktop.cjs').run({ evaluate, until, assert, pause, getWindow: () => win, output });
    } else if (process.argv.includes('--baseline')) {
      const baseline = await evaluate(graphExpression);
      fs.writeFileSync(path.join(output, 'baseline-graph.json'), JSON.stringify(baseline, null, 2));
      assert('baseline mixer graph captured with protected output branches', baseline.edges.length === 13, baseline);
    } else if (process.argv.includes('--voice-presets')) {
      assert('fresh launch shows all six built-in presets with Anime girl selected and effects off', await evaluate(`voiceConversionSettings.mode==='builtin' && !voiceConversionSettings.enabled && !aiVoiceToggle.checked && aiVoiceSelect.value==='anime' && Array.from(aiVoiceSelect.options).map(o=>o.textContent).join('|')==='Anime girl|Deep man|Robot|Helium|Monster|Radio'`));
      assert('built-in mode hides engine setup and places presets above balance controls', await evaluate(`aiVoiceSetup.hidden && refreshAiVoicesButton.hidden && document.querySelector('.ai-voice-controls').nextElementSibling.classList.contains('mix-assist-controls')`));
      await pause(150);
      const baseline = await evaluate(graphExpression);
      await evaluate(`aiVoiceToggle.checked=true;aiVoiceToggle.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && !!voiceConversionSession','built-in worklet startup');
      assert('built-in preset runs in a real audio worklet with clean sidechain and no dry bypass', await evaluate(`(()=>{const id=__micTest.id(micSource),effect=__micTest.id(voiceConversionSession.node);return voiceConversionSession.node instanceof AudioWorkletNode && __micTest.edges.some(e=>e[0]===id&&e[1]===effect)&&__micTest.edges.some(e=>e[0]===id&&e[1]===__micTest.id(voicePriorityNode))&&!__micTest.edges.some(e=>e[0]===id&&e[1]===__micTest.id(micGainNode));})()`));
      await assertUnchanged('built-in effects preserve soundboard and outgoing mix connections', baseline);
      await evaluate(`(()=>{const capture=__micTest.captures.at(-1);window.__presetOsc=capture.context.createOscillator();__presetOsc.frequency.value=220;const gain=capture.context.createGain();gain.gain.value=.08;__presetOsc.connect(gain).connect(capture.destination);__presetOsc.start();window.__presetAnalyser=audioContext.createAnalyser();__presetAnalyser.fftSize=8192;voiceConversionSession.node.connect(__presetAnalyser);window.__measurePreset=()=>{const data=new Float32Array(__presetAnalyser.fftSize);__presetAnalyser.getFloatTimeDomainData(data);const bins=new Float32Array(__presetAnalyser.frequencyBinCount);__presetAnalyser.getFloatFrequencyData(bins);let peak=0;for(let i=1;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;return {rms:Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length),frequency:peak*audioContext.sampleRate/__presetAnalyser.fftSize};};})()`);
      await until('__measurePreset().rms>0.005','processed synthetic microphone');
      await pause(350);
      const anime = await evaluate('__measurePreset()');
      assert('Anime girl changes the synthetic microphone pitch', anime.rms > .005 && anime.frequency > 250, anime);
      await evaluate(`window.__oldPreset=voiceConversionSession;aiVoiceSelect.value='deep';aiVoiceSelect.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && voiceConversionSession!==__oldPreset','Deep man switch');
      await evaluate('voiceConversionSession.node.connect(__presetAnalyser)'); await pause(450);
      const deep = await evaluate('__measurePreset()');
      assert('Deep man replaces the previous effect and lowers microphone pitch', deep.rms > .005 && deep.frequency < 200 && await evaluate('!__micTest.edges.some(e=>e[0]===__micTest.id(__oldPreset.node))'), deep);
      for (const preset of ['robot','helium','monster','radio']) {
        await evaluate(`window.__oldPreset=voiceConversionSession;aiVoiceSelect.value='${preset}';aiVoiceSelect.dispatchEvent(new Event('change',{bubbles:true}));`);
        await until('voiceConversionStatus==="active" && voiceConversionSession!==__oldPreset',`${preset} preset switch`);
      }
      assert('every built-in selection starts without engine traffic', await evaluate(`voiceConversionSettings.presetId==='radio' && __micTest.conversion.lists===0 && __micTest.conversion.starts.length===0 && __micTest.conversion.frames===0 && __micTest.conversion.stops.length===0`));
      await evaluate(`(async()=>{await setSoundPlaybackEnabled(false);monitorAiVoiceToggle.checked=true;monitorAiVoiceToggle.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(100);
      assert('preset headphone preview is independent of clip Hear', await evaluate('!isSoundPlaybackEnabled && micMonitorGainNode.gain.value>.9'));
      await evaluate(`voicePitchSlider.value='-3';voicePitchSlider.dispatchEvent(new Event('input',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && voiceConversionPending===null && voiceConversionPitchTimer===null','preset pitch adjustment');
      assert('preset pitch adjustment persists as an offset', await evaluate('voiceConversionSettings.pitch===-3 && JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceConversion.pitch===-3'));
      await evaluate(`aiVoiceToggle.checked=false;aiVoiceToggle.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('voiceConversionSession===null && micMonitorGainNode.gain.value===0','preset Off audio automation');
      assert('Off restores natural microphone routing and closes headphone preview', await evaluate('voiceConversionSession===null && micMonitorGainNode.gain.value===0 && __micTest.edges.some(e=>e[0]===__micTest.id(micSource)&&e[1]===__micTest.id(micGainNode))'));
      await evaluate(`window.__nativePresets=FreqxVoicePresets;window.FreqxVoicePresets={...__nativePresets,create:async(...args)=>{const session=await __nativePresets.create(...args);window.__latePreset=session;await new Promise(resolve=>{window.__finishPreset=resolve;});return session;}};aiVoiceToggle.checked=true;aiVoiceToggle.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('typeof __finishPreset==="function"','deferred preset startup');
      await evaluate(`aiVoiceToggle.checked=false;aiVoiceToggle.dispatchEvent(new Event('change',{bubbles:true}));__finishPreset();window.FreqxVoicePresets=__nativePresets;void 0;`); await pause(100);
      assert('Off during startup discards a late preset without reconnecting it', await evaluate('voiceConversionSession===null && voiceConversionStatus==="off" && !__micTest.edges.some(e=>e[0]===__micTest.id(__latePreset.node))'));
      await evaluate(`aiVoiceToggle.checked=true;aiVoiceToggle.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && !!voiceConversionSession','preset restart');
      await evaluate(`window.__oldPreset=voiceConversionSession;inputDeviceSelect.value='fixture-mic-b';switchMicInput()`);
      await until('voiceConversionStatus==="active" && voiceConversionSession!==__oldPreset','replacement microphone effect');
      assert('microphone replacement closes the previous preset and keeps the selected effect', await evaluate('voiceConversionSettings.presetId==="radio" && !__micTest.edges.some(e=>e[0]===__micTest.id(__oldPreset.node))'));
      await evaluate('setMicCaptureEnabled(false)'); await pause(50);
      assert('Mic off closes built-in processing and monitoring', await evaluate('voiceConversionSession===null && micMonitorGainNode.gain.value===0'));
      await evaluate('saveMixerSettings()');
      const saved = await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings"))');
      await createWindow(saved);
      assert('built-in mode, preset, pitch and preview preference restore', await evaluate('voiceConversionSettings.mode==="builtin" && voiceConversionSettings.presetId==="radio" && voiceConversionSettings.enabled && voiceConversionSettings.pitch===-3 && voiceConversionSettings.monitor && aiVoiceSelect.value==="radio"'));
      await evaluate('setMicCaptureEnabled(true)'); await until('voiceConversionStatus==="active"','restored built-in effect');
      assert('restored built-in effects still make zero engine requests', await evaluate('__micTest.conversion.lists===0 && __micTest.conversion.starts.length===0 && __micTest.conversion.stops.length===0'));
      win.showInactive();
      for (const width of [1000,900]) {
        win.setSize(width,760); await pause(150);
        await evaluate(`document.querySelector('.mixer').scrollTop=0`); await pause(150);
        fs.writeFileSync(path.join(output,`voice-presets-${width}.png`),(await win.webContents.capturePage()).toPNG());
        assert(`preset controls and active status are visible at ${width}px`, await evaluate(`(()=>{const field=aiVoiceSelect.getBoundingClientRect(),status=aiVoiceState.getBoundingClientRect(),panel=document.querySelector('.mixer').getBoundingClientRect();return field.top>=panel.top&&status.bottom<=panel.bottom&&field.right<=panel.right;})()`));
      }
      win.hide();
      assert('built-in flow finishes without renderer or audio-thread errors', await evaluate('__micTest.crashes.length===0 && __micTest.worklets.every(w=>w.errors.length===0)'));
      await createWindow({voiceIsolation:false,voiceConversion:{enabled:false,voiceId:'',port:18000,pitch:0,monitor:false}});
      assert('untouched legacy off settings upgrade to visible built-in choices without engine requests', await evaluate('voiceConversionSettings.mode==="builtin" && !voiceConversionSettings.enabled && aiVoiceSelect.options.length===6 && aiVoiceSelect.value==="anime" && __micTest.conversion.lists===0 && __micTest.conversion.starts.length===0'));
      await createWindow({voiceIsolation:false,voiceConversion:{enabled:true,voiceId:'1',port:18000,pitch:0,monitor:false}});
      await until('voiceConversionStatus==="active"','legacy AI settings migration');
      assert('legacy AI preferences migrate to RVC and retain engine controls and voice', await evaluate('voiceConversionSettings.mode==="rvc" && voiceConversionSettings.voiceId==="1" && !aiVoiceSetup.hidden && !refreshAiVoicesButton.hidden && __micTest.conversion.starts.at(-1).voiceId==="1"'));
      await evaluate('__micTest.conversion.fail=true');
      await until('voiceConversionFaulted && voiceConversionStatus==="error"','RVC engine failure before mode switch');
      await evaluate(`voiceChangerMode.value='builtin';voiceChangerMode.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && !!voiceConversionSession','built-in recovery from RVC failure');
      assert('switching from failed RVC to a built-in preset restores effects without a toggle cycle or dry bypass', await evaluate('!voiceConversionFaulted && voiceConversionSettings.enabled && voiceConversionSettings.mode==="builtin" && __micTest.conversion.active.size===0 && !__micTest.edges.some(e=>e[0]===__micTest.id(micSource)&&e[1]===__micTest.id(micGainNode))'));
      await evaluate(`__micTest.conversion.fail=false;__micTest.conversion.defer=true;voiceChangerMode.value='rvc';voiceChangerMode.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('typeof __micTest.conversion.finish==="function"','pending RVC mode startup');
      await evaluate(`voiceChangerMode.value='builtin';voiceChangerMode.dispatchEvent(new Event('change',{bubbles:true}));__micTest.conversion.finish();__micTest.conversion.defer=false;`);
      await until('voiceConversionStatus==="active" && voiceConversionSettings.mode==="builtin"','built-in startup after pending RVC'); await pause(100);
      assert('switching to built-in cancels pending RVC and retires its late engine session', await evaluate('__micTest.conversion.active.size===0 && !!voiceConversionSession && !voiceConversionFaulted && __micTest.worklets.find(w=>w.node===voiceConversionSession.node).name==="freqx-voice-presets"'));
    } else if (process.argv.includes('--voice-conversion')) {
      assert('AI voice starts off without contacting an engine', await evaluate('!voiceConversionSettings.enabled && __micTest.conversion.starts.length===0 && __micTest.conversion.lists===0'));
      await pause(150);
      const baseline = await evaluate(graphExpression);
      await evaluate(`(async()=>{await refreshVoiceConversionVoices();voiceConversionSettings.enabled=true;await configureMicVoiceConversion();})()`);
      await until('voiceConversionStatus==="active" && __micTest.conversion.frames>=2','converted microphone audio');
      assert('an installed voice starts the real audio-thread conversion stage', await evaluate('voiceConversionSession.node instanceof AudioWorkletNode && __micTest.conversion.starts.at(-1).voiceId==="0"'));
      assert('clean microphone reaches voice detection and converter without a dry route to gain', await evaluate(`(()=>{const id=__micTest.id(micSource),converter=__micTest.id(voiceConversionSession.node);return __micTest.edges.some(e=>e[0]===id&&e[1]===converter)&&__micTest.edges.some(e=>e[0]===id&&e[1]===__micTest.id(voicePriorityNode))&&!__micTest.edges.some(e=>e[0]===id&&e[1]===__micTest.id(micGainNode));})()`));
      await assertUnchanged('AI voice preserves soundboard and outgoing mix connections', baseline);
      await evaluate(`(async()=>{await playImportedSound(importedLibraryItems[0]);})()`); await pause(400);
      assert('soundboard playback never reaches conversion input', await evaluate('activeSoundNodes.size===1 && __micTest.conversion.lastInput.every(v=>Math.abs(v)<0.000001)'));
      await evaluate('stopAllSounds()');
      await evaluate(`(async()=>{await setSoundPlaybackEnabled(false);voiceConversionSettings.monitor=true;updateVoiceConversionMonitor();})()`); await pause(100);
      assert('headphone voice preview works independently of clip Hear', await evaluate('!isSoundPlaybackEnabled && micMonitorGainNode.gain.value>0.9 && __micTest.edges.some(e=>e[0]===__micTest.id(micMonitorGainNode)&&e[1]===__micTest.id(localPlaybackLimiterNode))'));
      await evaluate(`voicePitchSlider.value='-5';voicePitchSlider.dispatchEvent(new Event('input',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && __micTest.conversion.starts.at(-1).pitch===-5','pitch change');
      assert('pitch changes replace the session and keep the selected model', await evaluate('__micTest.conversion.stops.includes("fixture-conversion-1") && __micTest.conversion.starts.at(-1).voiceId==="0"'));
      await evaluate(`aiVoiceSelect.value='1';aiVoiceSelect.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until('voiceConversionStatus==="active" && __micTest.conversion.starts.at(-1).voiceId==="1"','voice switch');
      assert('voice switching uses the newly selected installed model', true);
      await evaluate('__micTest.conversion.fail=true');
      await until('voiceConversionFaulted && voiceConversionStatus==="error"','failed conversion');
      await pause(120);
      assert('engine failure mutes microphone without a natural-voice bypass', await evaluate('voiceConversionSession===null && micMonitorGainNode.gain.value<0.01 && !__micTest.edges.some(e=>e[0]===__micTest.id(micSource)&&e[1]===__micTest.id(micGainNode)) && aiVoiceState.textContent.includes("muted")'));
      await evaluate(`voiceConversionSettings.enabled=false;configureMicVoiceConversion()`);
      assert('explicit Off restores the ordinary microphone path', await evaluate('!voiceConversionFaulted && __micTest.edges.some(e=>e[0]===__micTest.id(micSource)&&e[1]===__micTest.id(micGainNode))'));
      await evaluate(`__micTest.conversion.fail=false;__micTest.conversion.defer=true;voiceConversionSettings.enabled=true;void configureMicVoiceConversion();`);
      await until('!!__micTest.conversion.finish','pending model start');
      await evaluate(`(async()=>{voiceConversionSettings.enabled=false;await configureMicVoiceConversion();__micTest.conversion.finish();__micTest.conversion.defer=false;})()`); await pause(100);
      assert('Off cancels pending startup and retires late session IDs', await evaluate('__micTest.conversion.active.size===0 && voiceConversionSession===null && voiceConversionStatus==="off"'));
      await evaluate(`voiceConversionSettings.enabled=true;configureMicVoiceConversion()`);
      await until('voiceConversionStatus==="active"','restart before mic switch');
      const starts = await evaluate('__micTest.conversion.starts.length');
      await evaluate(`inputDeviceSelect.value='fixture-mic-b';switchMicInput()`);
      await until(`voiceConversionStatus==="active" && __micTest.conversion.starts.length>${starts}`,'new microphone conversion');
      assert('microphone replacement releases the old conversion session', await evaluate('__micTest.conversion.active.size===1'));
      await evaluate('setMicCaptureEnabled(false)');
      await pause(50);
      assert('Mic off closes conversion and headphone monitoring', await evaluate('__micTest.conversion.active.size===0 && voiceConversionSession===null && micMonitorGainNode.gain.value===0'), await evaluate('({active:__micTest.conversion.active.size,session:!!voiceConversionSession,gain:micMonitorGainNode.gain.value})'));
      await evaluate('saveMixerSettings()');
      const saved = await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings"))');
      await createWindow(saved);
      assert('voice selection, pitch, monitor, and enabled preference persist', await evaluate('voiceConversionSettings.enabled && voiceConversionSettings.voiceId==="1" && voiceConversionSettings.pitch===-5 && voiceConversionSettings.monitor'));
      await evaluate('setMicCaptureEnabled(true)'); await until('voiceConversionStatus==="active"','restored conversion');
      win.showInactive(); await pause(100);
      await evaluate(`document.querySelector('.ai-voice-controls').scrollIntoView({block:'center'})`); await pause(150);
      fs.writeFileSync(path.join(output,'ai-voice.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1000,760); await pause(100);
      await evaluate(`document.querySelector('.ai-voice-controls').scrollIntoView({block:'center'})`); await pause(100);
      fs.writeFileSync(path.join(output,'ai-voice-compact.png'),(await win.webContents.capturePage()).toPNG()); win.hide();
      assert('AI voice runs without renderer or audio-thread errors', await evaluate('__micTest.crashes.length===0 && __micTest.worklets.every(w=>w.errors.length===0)'));
    } else if (process.argv.includes('--auto-ptt')) {
      assert('auto PTT starts off with no automatic key request', await evaluate('!autoPushToTalkToggle.checked && __micTest.ptt.begins.length===0'));
      await evaluate(`(async()=>{await refreshAutoPttApps();autoPttTargetSelect.value='TestGame.exe';autoPttTargetSelect.dispatchEvent(new Event('change',{bubbles:true}));autoPushToTalkToggle.checked=true;autoPushToTalkToggle.dispatchEvent(new Event('change',{bubbles:true}));await autoPttConfigurationReady;})()`);
      assert('target app and talk key configure the native bridge', await evaluate('isAutoPushToTalkEnabled && __micTest.ptt.configurations.at(-1).targetProcess==="TestGame.exe" && __micTest.ptt.configurations.at(-1).key==="KeyV"'));
      await evaluate(`(async()=>{libraryMetadata[importedLibraryItems[0].path].playbackMode='overlap';await playImportedSound(importedLibraryItems[0]);await playImportedSound(importedLibraryItems[0]);})()`);
      assert('overlapping clips receive distinct PTT leases before sources start', await evaluate('activeSoundNodes.size===2 && __micTest.ptt.begins.length===2 && new Set(__micTest.ptt.begins.map(i=>i.id)).size===2 && Array.from(activeSoundNodes).every(e=>e.autoPttLease?.active)'));
      await until('activeSoundNodes.size===0','ordinary sound completion');
      assert('natural completion releases each lease exactly once', await evaluate('__micTest.ptt.ends.length===2 && new Set(__micTest.ptt.ends).size===2 && autoPttHeartbeatTimer===null'));
      await evaluate(`(async()=>{libraryMetadata[importedLibraryItems[0].path].playbackMode='loop';await playImportedSound(importedLibraryItems[0]);})()`);
      await pause(900);
      assert('loop playback refreshes its live lease while the app is hidden', await evaluate('__micTest.ptt.begins.at(-1).durationMs===0 && __micTest.ptt.refreshes.some(ids=>ids.includes(__micTest.ptt.begins.at(-1).id))'));
      await evaluate('stopAllSounds()');
      assert('Stop all releases PTT immediately and clears its heartbeat', await evaluate('activeSoundNodes.size===0 && autoPttLeases.size===0 && autoPttHeartbeatTimer===null && __micTest.ptt.ends.length===3'));
      await evaluate(`__micTest.ptt.defer=true;void(window.__pendingPtt=playImportedSound(importedLibraryItems[0]));`);
      await until('__micTest.ptt.begins.length===4','delayed native acquisition');
      await evaluate('stopAllSounds();__micTest.ptt.finish();__micTest.ptt.defer=false;__pendingPtt');
      assert('Stop during native acquisition cannot start late audio or leave a key lease', await evaluate('activeSoundNodes.size===0 && pendingSoundStarts.size===0 && autoPttLeases.size===0 && __micTest.ptt.ends.filter(id=>id===__micTest.ptt.begins.at(-1).id).length===1'));
      const beforePreview = await evaluate('__micTest.ptt.begins.length');
      await evaluate(`(async()=>{openSoundEditor(importedLibraryItems[0]);previewSoundEditor();await new Promise(r=>setTimeout(r,150));stopAllSounds();closeSoundEditor();await sendTestTone();stopAllSounds();})()`);
      assert('editor previews and test tones do not press the talk key', await evaluate('__micTest.ptt.begins.length')===beforePreview);
      await evaluate(`(async()=>{await setMixToOutputEnabled(false);await playImportedSound(importedLibraryItems[0]);stopAllSounds();await setMixToOutputEnabled(true);})()`);
      assert('monitor-only playback never activates automatic PTT', await evaluate('__micTest.ptt.begins.length')===beforePreview);
      await evaluate(`(async()=>{await playImportedSound(importedLibraryItems[0]);await setMixToOutputEnabled(false);})()`);
      assert('turning Mix off releases the key while clips continue locally', await evaluate('activeSoundNodes.size===1 && autoPttLeases.size===0 && autoPttHeartbeatTimer===null'));
      await evaluate('stopAllSounds();setMixToOutputEnabled(true)');
      await evaluate(`assignKeybind('blocked',{code:'KeyV'});`);
      assert('talk key cannot also become a sound trigger', await evaluate('!importedKeybinds.blocked && autoPttState.textContent.includes("auto push-to-talk key")'));
      await evaluate(`autoPttTargetSelect.value='TestGame.exe';configureAutoPttSettings()`);
      const saved = await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings"))');
      await createWindow(saved);
      assert('automatic PTT settings restore across launches', await evaluate('isAutoPushToTalkEnabled && selectedAutoPttTarget==="TestGame.exe" && selectedAutoPttKey==="KeyV"'));
      // A visible, unfocused fixture gives Chromium a fresh scrolled compositor frame.
      win.showInactive(); await pause(100);
      await evaluate(`document.querySelector('.auto-ptt-controls').scrollIntoView({block:'center'})`);
      await pause(150);
      fs.writeFileSync(path.join(output,'auto-ptt.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1000,760); await pause(100);
      await evaluate(`document.querySelector('.auto-ptt-controls').scrollIntoView({block:'center'})`); await pause(100);
      fs.writeFileSync(path.join(output,'auto-ptt-compact.png'),(await win.webContents.capturePage()).toPNG());
      win.hide();
      assert('PTT controls and playback finish with no renderer or DSP errors', await evaluate('__micTest.crashes.length===0 && __micTest.worklets.every(w=>w.errors.length===0)'));
    } else if (process.argv.includes('--mix-features')) {
      assert('mixer loads three limiters and one audio-thread sidechain', await evaluate('__micTest.worklets.filter(w=>w.name === "freqx-peak-limiter").length === 3 && __micTest.worklets.filter(w=>w.name === "freqx-voice-priority").length === 1'));
      assert('new balance controls start off and preserve the existing mic level', await evaluate('!voicePriorityToggle.checked && !matchClipLoudnessToggle.checked && Number(micGainSlider.value) === 0.71'));
      await evaluate(`micGainSlider.value='3';micGainSlider.dispatchEvent(new Event('input',{bubbles:true}));`);
      assert('300% gain applies after isolation and persists without clamping', await evaluate('micGainNode.gain.value > 0.71 && micGainValue.textContent === "300%" && JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).micGain === 3'));
      await evaluate(`window.__testOsc=audioContext.createOscillator();__testOsc.frequency.value=1000;
        window.__testOscGain=audioContext.createGain();__testOscGain.gain.value=.04;
        __testOsc.connect(__testOscGain).connect(micGainNode);__testOsc.start();
        window.__micAnalyser=audioContext.createAnalyser();__micAnalyser.fftSize=2048;micLimiterNode.connect(__micAnalyser);
        window.__readRms=async analyser=>{let power=0;const data=new Float32Array(2048);for(let n=0;n<8;n++){await new Promise(r=>setTimeout(r,20));analyser.getFloatTimeDomainData(data);for(const value of data)power+=value*value;}return Math.sqrt(power/(8*data.length));};
        micGainSlider.value='1';updateMixerGains();`);
      await pause(180);
      const normal = await evaluate('__readRms(__micAnalyser)');
      await evaluate('micGainSlider.value="3";micGainSlider.dispatchEvent(new Event("input",{bubbles:true}))');
      await pause(180);
      const boosted = await evaluate('__readRms(__micAnalyser)');
      assert('real audio microphone boost triples low-level amplitude', Math.abs(boosted / normal - 3) < 0.06, { normal, boosted });
      assert('mic meter shows the boosted voice independently of the full mix', await evaluate('updateMicLevelMeter();Number(micLevelTrack.getAttribute("aria-valuenow")) > -30 && micLevelValue.textContent !== "-inf dB"'));
      await evaluate('__testOscGain.gain.value=1.5');
      await pause(200);
      const peak = await evaluate('(()=>{const data=new Float32Array(2048);__micAnalyser.getFloatTimeDomainData(data);return Math.max(...data.map(Math.abs));})()');
      assert('real boosted microphone peaks stay under the limiter ceiling', peak > 0.7 && peak <= 10 ** (-1 / 20) + 0.001, { peak });
      await evaluate('__testOsc.stop();__testOscGain.disconnect();micLimiterNode.disconnect(__micAnalyser);');
      await evaluate(`(async()=>{window.__soundAnalysers=[appPlaybackGainNode,soundToMixGainNode,mixLimiterNode].map(node=>{const a=audioContext.createAnalyser();a.fftSize=2048;node.connect(a);return a;});
        voicePriorityToggle.checked=true;voicePriorityToggle.dispatchEvent(new Event('change',{bubbles:true}));
        await playImportedSound(importedLibraryItems[0]);})()`);
      await pause(300);
      const before = await measureSound();
      await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));__micTest.captures.at(-1).source.offset.value=.05;`);
      await until('voicePriorityState.dataset.active === "true"', 'ducking while page is hidden');
      await pause(200);
      const ducked = await measureSound();
      assert('Voice Priority attenuates the outgoing clips about 12 dB while minimized', Math.abs(20 * Math.log10(ducked[1] / before[1]) + 12) < 0.5, { before, ducked });
      assert('Voice Priority keeps the local soundboard monitor unchanged', Math.abs(ducked[0] / before[0] - 1) < 0.02);
      await evaluate('__micTest.captures.at(-1).source.offset.value=0');
      await pause(2400);
      const restored = await measureSound();
      assert('clips recover smoothly after speech ends', restored[1] / before[1] > 0.98 && await evaluate('voicePriorityState.dataset.active === "false"'));
      await evaluate(`voicePriorityStrength.value='strong';voicePriorityStrength.dispatchEvent(new Event('change',{bubbles:true}));
        __micTest.captures.at(-1).source.offset.value=.05;`);
      await pause(350);
      const strong = await measureSound();
      assert('Strong priority applies the selected 18 dB reduction', Math.abs(20 * Math.log10(strong[1] / before[1]) + 18) < 0.5);
      await evaluate('setMicCaptureEnabled(false)');
      await pause(2400);
      assert('mic off disables ducking and releases microphone tracks', await evaluate('!micStream && voicePriorityNode.parameters.get("enabled").value === 0 && __micTest.captures.at(-1).stream.getTracks().every(track=>track.readyState==="ended")'));
      const micOff = await measureSound();
      assert('mic off restores the outgoing clip volume', micOff[1] / before[1] > 0.98);
      await evaluate(`(async()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));stopAllSounds();
        matchClipLoudnessToggle.checked=true;matchClipLoudnessToggle.dispatchEvent(new Event('change',{bubbles:true}));
        await playImportedSound(importedLibraryItems[0]);})()`);
      await pause(80); // AudioParam scheduling takes effect on the next render quantum.
      const gain = await evaluate('Array.from(activeSoundNodes)[0].outputNode.gain.value');
      const expected = await evaluate(`(async()=>{const item=importedLibraryItems[0],meta=getSoundMetadata(item),buffer=await decodeImportedAudio(item);return meta.volume*(await FreqxLoudness.analyze(buffer,desktopConfig.audio.loudness)).gain;})()`);
      assert('board playback applies the measured loudness multiplier', Math.abs(gain - expected) < 0.0001 && Math.abs(gain - 0.2) > 0.01, { gain, expected });
      await evaluate(`(async()=>{stopAllSounds();openSoundEditor(importedLibraryItems[0]);soundEditorMatchLoudness.checked=false;saveSoundEditorButton.click();await playImportedSound(importedLibraryItems[0]);})()`);
      await pause(80);
      const optOut = await evaluate('({ gain:Array.from(activeSoundNodes)[0].outputNode.gain.value, meta:getSoundMetadata(importedLibraryItems[0]), stored:JSON.parse(localStorage.getItem("soundmuncher:library-metadata")) })');
      assert('per-sound opt-out preserves the manual volume and is saved', optOut.meta.matchLoudness === false && Math.abs(optOut.gain - optOut.meta.volume) < 0.0001 && optOut.stored.sounds[Object.keys(optOut.stored.sounds)[0]].matchLoudness === false);
      const downmix = await evaluate(`(async()=>{
        const results=[];
        for(const channels of [4,6]){
          const context=new OfflineAudioContext(2,4800,48000);
          await context.audioWorklet.addModule(new URL('audio/mix-worklet.mjs',location.href));
          const node=new AudioWorkletNode(context,'freqx-voice-priority',{
            numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit',channelInterpretation:'speakers'});
          const source=context.createBufferSource();source.buffer=context.createBuffer(channels,4800,48000);
          if(channels===4){source.buffer.getChannelData(0).fill(.1);source.buffer.getChannelData(1).fill(.1);}
          else source.buffer.getChannelData(2).fill(.1);
          source.connect(node,0,0);node.connect(context.destination);source.start();
          const output=await context.startRendering();results.push([output.getChannelData(0)[1000],output.getChannelData(1)[1000]]);
        }
        return results;
      })()`);
      assert('real worklet speaker downmix preserves quad fronts and 5.1 center audio',
        downmix[0].every(value=>Math.abs(value-.05)<1e-6) && downmix[1].every(value=>Math.abs(value-.1*Math.SQRT1_2)<1e-6), downmix);
      const saved = await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings"))');
      await createWindow(saved);
      assert('new balance preferences restore across launches including 300%', await evaluate('Number(micGainSlider.value)===3 && voicePriorityToggle.checked && voicePriorityStrength.value==="strong" && matchClipLoudnessToggle.checked'));
      await evaluate(`voicePriorityToggle.scrollIntoView({block:'center'});`);
      await pause(100);
      fs.writeFileSync(path.join(output, 'mix-features.png'), (await win.webContents.capturePage()).toPNG());
      assert('audio-thread processors complete without errors or renderer crashes', await evaluate('__micTest.crashes.length===0 && __micTest.worklets.every(w=>w.errors.length===0)'));
      await evaluate('micLimiterNode.dispatchEvent(new Event("processorerror"))');
      await until('audioContext.state==="suspended" && mixOutContext.state==="suspended" && localOutContext.state==="suspended"', 'failed DSP output suspension');
      assert('failed peak protection stops microphone tracks and exposes a restart message', await evaluate('mixerGraphFailed && !isMicCaptureEnabled && !micStream && !micSource && routeState.textContent.includes("Restart") && __micTest.captures.at(-1).stream.getTracks().every(t=>t.readyState==="ended")'));
      await evaluate('playImportedSound(importedLibraryItems[0])');
      assert('failed DSP cannot restart unprotected playback', await evaluate('activeSoundNodes.size===0 && pendingSoundStarts.size===0 && audioContext.state==="suspended"'));
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
      const expectedConnections = [['soundGainNode','voicePriorityNode'],['voicePriorityNode','soundToMixGainNode'],['soundGainNode','appPlaybackGainNode'],['soundToMixGainNode','masterGainNode'],['masterGainNode','compressorNode'],['compressorNode','mixLimiterNode'],['mixLimiterNode','mixDestination'],['mixLimiterNode','levelAnalyser'],['appPlaybackGainNode','localPlaybackLimiterNode'],['localPlaybackLimiterNode','appPlaybackDestination'],['mixOutSource','mixOutGainNode'],['mixOutGainNode','mixOutDestination'],['localOutSource','localOutDestination']];
      assert('existing soundboard and output routing remains intact', expectedConnections.every(([from,to]) => baseline.edges.some(edge => edge[0] === baseline.ids[from] && edge[1] === baseline.ids[to])));
      const beforeSignal = await measureSound();
      assert('soundboard fixtures reach local playback, mix branch and mixed output', beforeSignal.every(value => value > 0.005), beforeSignal);
      const sinksBefore = await evaluate('__micTest.sinks.length');
      await evaluate('voiceIsolationToggle.click()');
      await until('!!micIsolationSession', 'voice isolation session');
      await pause(200);
      assert('toggle enables local RNNoise on a dedicated 48 kHz context', await evaluate('(()=>{const worklets=__micTest.worklets.filter(w=>w.name==="freqx-voice-isolation");return worklets.length===1 && worklets[0].context.sampleRate===48000 && worklets[0].context!==audioContext && worklets[0].context!==mixOutContext && worklets[0].context!==localOutContext;})()'));
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
      await evaluate('window.__oldSession = micIsolationSession; window.__oldWorklet = __micTest.worklets.at(-1); voiceIsolationMode.value="off";voiceIsolationMode.dispatchEvent(new Event("change",{bubbles:true}))');
      await until('__oldWorklet.context.state === "closed"', 'disabled processor cleanup');
      assert('disabling restores raw microphone and releases processor output tracks', await evaluate('!micIsolationSession && micSource.mediaStream === micStream && __oldSession.stream.getTracks().every(track => track.readyState === "ended") && micStream === __originalMic && micStream.getTracks().every(track => track.readyState === "live")'));
      await assertUnchanged('disabling isolation preserves soundboard/output graph and settings', baseline);
      const offSignal = await measureSound();
      assert('disabling isolation preserves soundboard signal level', offSignal.every((value,index) => Math.abs(value/beforeSignal[index]-1) < 0.025), { before: beforeSignal, after: offSignal });
      assert('Off mode unchecks the toggle and saves preference without changing capture count', await evaluate('JSON.parse(localStorage.getItem("soundmuncher:mixer-settings")).voiceIsolation === false && __micTest.captures.length === __originalCaptureCount && !voiceIsolationToggle.checked && voiceIsolationMode.value === "off"'));
      // Supply a synthetic reference and delay the actual AEC module until the
      // neural worklet is ready. No display capture or physical device is used.
      await evaluate(`(async () => { window.__originalLoopbackReference = window.LoopbackReference;
        window.__aecBaseSession = await VoiceIsolation.create(micStream);
        window.__aecReference = micStream.getAudioTracks()[0].clone();
        window.__aecReleases = 0;
        window.LoopbackReference = { acquire: async () => __aecReference, release: track => { __aecReleases++; track.stop(); } };
        window.__aecContext = __micTest.worklets.at(-1).context;
        window.__aecAddModule = __aecContext.audioWorklet.addModule;
        window.__releaseAec = null;
        window.__aecGate = new Promise(resolve => { __releaseAec = resolve; });
        __aecContext.audioWorklet.addModule = async function(url) {
          if (url.includes('aec-worklet')) await __aecGate;
          return __aecAddModule.call(this, url);
        };
        window.__aecSession = null;
        void (window.__aecPending = VoiceIsolation.create(micStream, { referenceDeviceId: '' }).then(session => { __aecSession = session; })); })()`);
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
      await evaluate(`(async () => { await __aecSession.close(); await __aecBaseSession.close(); __aecContext.audioWorklet.addModule = __aecAddModule;
        void (window.LoopbackReference = __originalLoopbackReference); })()`);
      await until('__aecContext.state === "closed"', 'AEC session teardown');
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
      await until('__deviceOldWorklet.messages.some(message => message.type === "destroyed")', 'old device processor cleanup');
      assert('device switch cleans previous capture and isolates replacement microphone', await evaluate('__deviceOldMic.getTracks().every(track => track.readyState === "ended") && __deviceOldSession.stream.getTracks().every(track => track.readyState === "ended") && __micTest.captures.at(-1).constraints.audio.deviceId.exact === "fixture-mic-b" && micSource.mediaStream === micIsolationSession.stream'));
      await assertUnchanged('device switch preserves soundboard/output graph and settings', baseline);
      await evaluate('__micTest.captureError="NotAllowedError";inputDeviceSelect.value="fixture-mic-a";switchMicInput()');
      assert('permission rejection during microphone change leaves a recoverable Mic Off state', await evaluate('!isMicCaptureEnabled && !micStream && !micSource && !micIsolationSession && toggleMicCaptureButton.textContent === "Mic: Off" && __micTest.crashes.length === 0'));
      await assertUnchanged('microphone permission rejection leaves soundboard and output graph untouched', baseline);
      await evaluate('__micTest.captureError=null;setMicCaptureEnabled(true)');
      assert('microphone can recover after permission is granted without restarting', await evaluate('isMicCaptureEnabled && !!micIsolationSession && micSource.mediaStream === micIsolationSession.stream'));
      await evaluate('window.__endedMic=micStream;window.__endedSession=micIsolationSession;window.__endedWorklet=__micTest.worklets.at(-1);const endedTrack=micStream.getAudioTracks()[0];endedTrack.stop();endedTrack.dispatchEvent(new Event("ended"))');
      await until('__endedWorklet.context.state === "closed"', 'disconnected microphone cleanup');
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
      await until('__startingWorklet.context.state === "closed"', 'muted pending model cleanup');
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
      assert('processor reports a 48 kHz realtime frame pipeline with bounded algorithmic buffering', engine?.sampleRate === 48000 && engine?.frameSize === 480 && Math.abs(engine?.bufferLatencyMs - 448 / 48) < 0.001 && engine?.modelLatencyMs === 10, engine);
      await pause(1200);
      assert('debug readout reports processing cost and estimated added latency', await evaluate('voiceIsolationDebug.textContent.includes("ms/frame") && voiceIsolationDebug.textContent.includes("latency") && Number.isFinite(micIsolationSession.diagnostics.processingMs) && micIsolationSession.diagnostics.processingMs > 0 && micIsolationSession.diagnostics.estimatedLatencyMs >= 19 && micIsolationSession.diagnostics.estimatedLatencyMs < 30'));
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
