'use strict';
// Production preload/UI/IPC and sandbox decoder; only HTTPS transport and
// hardware devices are fixtures. No profile, real endpoint or audio file is committed.
// node tests/audio-links-electron.cjs [--app-root PATH_TO_APP_ASAR] [--input-file PATH ...]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 150000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else run().catch(error => { console.error(error); require('electron').app.exit(1); });

function section(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end <= start) throw new Error(`Missing production section ${from}`);
  return source.slice(start, end);
}
async function run() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const argument = process.argv.indexOf('--app-root');
  const appRoot = argument < 0 ? root : path.resolve(process.argv[argument + 1]);
  const { AudioLinkService, decodeToWave, validateNormalizedWav, LIMITS } = require(path.join(appRoot, 'runtime', 'audio-link-service.cjs'));
  const { downloadAudioLink } = require(path.join(appRoot, 'runtime', 'audio-link.cjs'));
  const main = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
  const output = path.join(root, 'output', 'audio-links'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'run-'));
  const library = path.join(directory, 'library'), temporary = path.join(directory, 'temporary'); fs.mkdirSync(library);
  app.setPath('userData', path.join(directory, 'profile'));
  app.setPath('sessionData', path.join(directory, 'session'));
  app.setPath('crashDumps', path.join(directory, 'dumps'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.on('window-all-closed', () => {});
  const checks = [], errors = [], validators = [], requests = [];
  let win, initialized = false, completed = false, delay = 0, imported = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  function check(name, pass, detail) {
    checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!pass) throw new Error(name);
  }
  async function until(code, name, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!(await evaluate(code))) { if (Date.now() > deadline) throw new Error(`Timed out: ${name}`); await pause(25); }
  }
  const tone = createWave(48000 * 2);
  const platformTitle = '<script>window.__platformScript=true</script>';
  const safeWindow = new Proxy(BrowserWindow, { construct(target, args) {
    const validator = new target(...args);
    const record = { window: validator, session: validator.webContents.session, preferences: validator.webContents.getLastWebPreferences() };
    validators.push(record);
    validator.webContents.on('did-finish-load', () => {
      record.probe = validator.webContents.executeJavaScript(`({node: typeof require, bridge: typeof soundmuncher, remoteScript: !!window.__remoteScript})`).then(value => { record.environment = value; });
    });
    return validator;
  } });
  const service = new AudioLinkService({ appRoot, BrowserWindow: safeWindow, session, tempRoot: temporary,
    download: (url, { signal }) => downloadAudioLink(url, { signal,
      resolvePlatform: async () => ({ url: 'https://r1---sn-fixture.googlevideo.com/tone.wav', title: platformTitle }),
      download: async (value, _limit, options) => {
      if (delay) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delay); options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Canceled', 'AbortError')); }, { once: true }); });
      const parsed = new URL(value), bad = parsed.pathname.endsWith('/malware.wav');
      const headers = { 'content-type': 'audio/wav' };
      options.validateResponse(headers); options.onComplete(headers, parsed);
      return bad ? Buffer.from('<script>window.__remoteScript=true</script>') : tone;
    } }),
    reserve: async filename => { const destinationPath = path.join(library, `${imported++}-${filename}`); return { destinationPath, handle: await fs.promises.open(destinationPath, 'wx') }; },
    item: filename => ({ path: filename, name: path.basename(filename), fileUrl: pathToFileURL(filename).href, sizeBytes: fs.statSync(filename).size }),
  });
  const context = vm.createContext({ ipcMain, audioLinkService: service, mainWindow: null, URL,
    getRendererUrl: name => pathToFileURL(path.join(appRoot, name)).href,
    assertTrustedIpcSender: event => { if (!event.senderFrame?.url?.startsWith(pathToFileURL(appRoot).href)) throw new Error('Untrusted renderer.'); },
  });
  vm.runInContext(section(main, 'function stripUrlState(', 'function isTrustedRendererUrl(')
    + section(main, 'function createExternalImportError(', 'function readProtocolTextParam(')
    + section(main, 'function createExternalImportSource(', 'function getExternalImportLabel(')
    + section(main, '  const linkSender = event => {', "  ipcMain.handle('audio:reference-devices'")
    + section(main, 'async function importAudioFromProtocolRequest(', 'function getSettingsPath('), context);
  function handle(channel, action) {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted fixture sender.');
      return action(...args);
    });
  }
  const listFiles = () => fs.readdirSync(library).map(filename => service.item(path.join(library, filename)));
  handle('app:update-status', () => ({ status: 'idle' }));
  handle('auth:status', () => ({ user: null })); handle('app-settings:get', () => ({ keepRunningInTray: false, launchOnStartup: false }));
  handle('audio:list-output-devices', () => []); handle('audio:list-imported-files', listFiles);
  handle('audio:reference-devices', () => []);
  handle('audio:external-imports-ready', () => { initialized = true; }); handle('keybinds:register-global', () => ({ failed: [] }));
  handle('library:catalog', () => ({ sounds: [], categories: [], unavailable: false }));
  handle('app:report-crash', report => { errors.push(report); return report; });
  async function createWindow() {
    initialized = false;
    if (win && !win.isDestroyed()) win.destroy();
    win = new BrowserWindow({ show: false, width: 1240, height: 820, webPreferences: {
      preload: path.join(appRoot, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, backgroundThrottling: false, partition: 'persist:audio-link-fixture',
    } });
    context.mainWindow = win;
    const owner = win.webContents;
    owner.on('destroyed', () => service.cancelOwner(owner));
    let blockRenderer = true;
    owner.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    owner.session.setPermissionCheckHandler(() => false);
    owner.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      requests.push(details.url); callback({ cancel: /^https?:/.test(details.url) || (blockRenderer && details.url.endsWith('/renderer.js')) });
    });
    owner.on('console-message', event => { if (event.level === 'error' && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(event.message); });
    await win.loadFile(path.join(appRoot, 'index.html'));
    await evaluate(`(${installRendererFixtures.toString()})()`);
    blockRenderer = false;
    await evaluate(`new Promise((resolve, reject) => { const script = document.createElement('script'); script.src='renderer.js'; script.onload=resolve; script.onerror=reject; document.body.append(script); })`);
    const deadline = Date.now() + 10000;
    while (!initialized && Date.now() < deadline) await pause(25);
    check('production preload, CSP and renderer initialize without audio devices', initialized && errors.length === 0, errors);
  }
  async function submit(url) {
    await evaluate(`document.getElementById('openAudioLink').click(); document.getElementById('audioLinkUrl').value=${JSON.stringify(url)}; document.getElementById('audioLinkForm').requestSubmit();`);
  }
  try {
    await app.whenReady(); await createWindow();
    await evaluate(`document.getElementById('boardSelect').value='Game night'; document.getElementById('boardSelect').dispatchEvent(new Event('change')); document.getElementById('openAudioLink').click()`);
    check('link dialog uses URL input and keyboard focus', await evaluate(`document.activeElement.id==='audioLinkUrl' && !audioLinkOverlay.hidden`));
    await win.webContents.capturePage(); // Wake the hidden window's compositor before the saved capture.
    await pause(100);
    fs.writeFileSync(path.join(directory, 'audio-link-dialog.png'), (await win.webContents.capturePage()).toPNG());
    await submit('https://audio.freqx.app/tone.wav?token=do-not-save');
    await until('!pendingAudioLink && importedLibraryItems.length===1 && activeSoundNodes.size===1', 'import and mixer playback');
    check('downloaded audio is normalized to local PCM16 WAV', fs.readdirSync(library).length === 1 && validateNormalizedWav(fs.readFileSync(listFiles()[0].path)).length === tone.length);
    check('import captures the selected board and playback uses the soundboard mixer only', await evaluate(`getSoundMetadata(importedLibraryItems[0]).board==='Game night' && !!soundGainNode && !micStream && !micIsolationSession && activeSoundNodes.size===1`));
    const energy = await evaluate(`(async () => {
      const data=new Float32Array(2048); let mix=0,mic=0;
      for(let i=0;i<6;i++) { await new Promise(resolve=>setTimeout(resolve,15));
        levelAnalyser.getFloatTimeDomainData(data); mix+=data.reduce((sum,value)=>sum+value*value,0)/data.length;
        micGateAnalyser.getFloatTimeDomainData(data); mic+=data.reduce((sum,value)=>sum+value*value,0)/data.length;
      } return {mix:Math.sqrt(mix/6),mic:Math.sqrt(mic/6)};
    })()`);
    check('linked sound reaches the actual shared mix while the mic branch stays silent', energy.mix > 0.0001 && energy.mic < 0.000001, energy);
    const sandbox = validators[0]; await sandbox.probe;
    check('media decoding uses a disposable isolated sandbox with no Node or app bridge', sandbox.preferences.sandbox && sandbox.preferences.contextIsolation && !sandbox.preferences.nodeIntegration && !sandbox.preferences.preload && sandbox.environment.node === 'undefined' && sandbox.environment.bridge === 'undefined' && sandbox.window.isDestroyed(), { sandbox: sandbox.preferences.sandbox, contextIsolation: sandbox.preferences.contextIsolation, environment: sandbox.environment });
    check('source URL and query are absent from saved settings and library metadata', !(await evaluate(`JSON.stringify(localStorage)`)).includes('do-not-save'));
    await evaluate('stopAllSounds()');
    await submit('https://audio.freqx.app/malware.wav');
    await until('!pendingAudioLink', 'malware rejection');
    check('HTML disguised as audio cannot execute or enter the library', fs.readdirSync(library).length === 1 && await evaluate(`!window.__remoteScript && !audioLinkOverlay.hidden && audioLinkStatus.textContent.length>0 && activeSoundNodes.size===0`));
    const bad = await evaluate(`window.soundmuncher.importAudioLink('file:///C:/Windows/system.ini')`);
    check('unsafe schemes are rejected by the production main import path', bad.ok === false && fs.readdirSync(library).length === 1);
    for (const action of ['cancelAudioLink', 'closeAudioLink', 'stopAllSounds']) {
      delay = 500;
      await submit('https://audio.freqx.app/cancel.wav');
      await until('!!pendingAudioLink', 'pending download');
      await evaluate(`document.getElementById(${JSON.stringify(action)}).click()`);
      await until('!pendingAudioLink', 'canceled download'); await pause(550);
      check(`${action} cancels downloading and cannot start delayed playback`, fs.readdirSync(library).length === 1 && await evaluate('activeSoundNodes.size===0'));
    }
    delay = 0;
    const proto = await context.importAudioFromProtocolRequest({ sourceUrl: 'https://audio.freqx.app/protocol.wav', filename: 'external.mp3', title: 'Shared tone', board: 'Main' });
    check('freqx protocol imports share normalization and preserve title and board', proto.ok && proto.imported[0].name.endsWith('.wav') && proto.metadata[proto.imported[0].path].name === 'Shared tone' && proto.metadata[proto.imported[0].path].board === 'Main');
    await createWindow();
    check('linked sounds and board metadata survive reload', await evaluate(`importedLibraryItems.length===2 && getSoundMetadata(importedLibraryItems.find(item=>item.name.includes('tone'))).board==='Game night'`));
    win.setContentSize(900, 620); await evaluate('openAudioLink()'); await pause(100);
    check('link dialog fits the minimum app window', await evaluate(`document.documentElement.scrollWidth<=document.documentElement.clientWidth && audioLinkForm.getBoundingClientRect().right<=innerWidth`));
    fs.writeFileSync(path.join(directory, 'audio-link-minimum-window.png'), (await win.webContents.capturePage()).toPNG());
    await submit('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await until('!pendingAudioLink && importedLibraryItems.length===3', 'platform title import');
    check('platform titles are rendered as text and cannot create scripts', await evaluate(`!window.__platformScript && !document.querySelector('#importedList script') && importedLibraryItems.some(item=>getSoundMetadata(item).name===${JSON.stringify(platformTitle)}) && Array.from(document.querySelectorAll('#importedList .imported-name')).some(node=>node.textContent===${JSON.stringify(platformTitle)})`));
    await evaluate('stopAllSounds()');
    check('temporary downloaded input is removed and no validator window remains', fs.readdirSync(temporary).length === 0 && validators.every(entry => entry.window.isDestroyed()));
    check('no remote page or script runs in the renderer', !requests.some(url => /^https?:/.test(url) && !url.startsWith('https://fonts.')) && errors.length === 0, errors);
    // Exercise actual Chromium decoder rejection, independent of signature checks.
    const undecodable = path.join(directory, 'invalid.audio'); fs.writeFileSync(undecodable, '<script>window.__remoteScript=true</script>');
    let rejected = false;
    try { await decodeToWave({ BrowserWindow: safeWindow, session, appRoot, filePath: undecodable, signal: new AbortController().signal }); } catch { rejected = true; }
    check('isolated decoder rejects malformed media and releases its window', rejected && validators.at(-1).window.isDestroyed());
    const stalledWindow = new Proxy(safeWindow, { construct(target, args) {
      const validator = new target(...args);
      validator.loadFile = () => new Promise(() => {}); // Controlled stalled decoder startup.
      return validator;
    } });
    const abort = new AbortController();
    const canceledDecode = decodeToWave({ BrowserWindow: stalledWindow, session, appRoot, filePath: undecodable, signal: abort.signal });
    abort.abort(); let canceled = false;
    try { await canceledDecode; } catch (error) { canceled = error.code === 'ABORT_ERR'; }
    check('canceling decoder startup destroys its isolated window', canceled && validators.at(-1).window.isDestroyed());
    const started = Date.now(); let timeout = false;
    try { await decodeToWave({ BrowserWindow: stalledWindow, session, appRoot, filePath: undecodable, signal: new AbortController().signal, timeoutMs: 50 }); } catch (error) { timeout = /timed out/.test(error.userMessage); }
    check('stalled decoder deadline is bounded and releases its isolated window', timeout && Date.now() - started < 2000 && validators.at(-1).window.isDestroyed());
    const inputFiles = process.argv.flatMap((arg, index) => arg === '--input-file' ? [process.argv[index + 1]] : []);
    for (const [index, input] of inputFiles.entries()) {
      if (!input || input.startsWith('--')) throw new Error('--input-file requires a local audio path.');
      const source = path.resolve(input);
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size <= 0 || stat.size > LIMITS.inputBytes) throw new Error('Input file exceeds the import size limit.');
      const ownedTemporary = fs.mkdtempSync(path.join(directory, 'input-'));
      if (path.dirname(ownedTemporary) !== directory || !/^input-[a-zA-Z0-9_-]+$/.test(path.basename(ownedTemporary))) throw new Error('Unsafe test cleanup path.');
      const staged = path.join(ownedTemporary, 'source.audio');
      const started = Date.now();
      try {
        fs.copyFileSync(source, staged);
        const bytes = validateNormalizedWav(await decodeToWave({ BrowserWindow: safeWindow, session, appRoot, filePath: staged, signal: new AbortController().signal }));
        const channels = bytes.readUInt16LE(22), sampleRate = bytes.readUInt32LE(24), duration = (bytes.length - 44) / (channels * 2 * sampleRate);
        let energy = 0;
        for (let p = 44; p < bytes.length; p += 2) energy += (bytes.readInt16LE(p) / 32768) ** 2;
        const rms = Math.sqrt(energy / ((bytes.length - 44) / 2));
        const normalized = path.join(directory, `input-${index}-normalized.wav`);
        fs.writeFileSync(normalized, bytes);
        check(`explicit input ${path.basename(source)} decodes to bounded audible 48 kHz PCM16 WAV`, sampleRate === 48000 && channels <= 2 && duration > 0 && duration <= LIMITS.durationSeconds && rms > 0.00001 && validators.at(-1).window.isDestroyed(), { inputBytes: stat.size, outputBytes: bytes.length, channels, sampleRate, durationSeconds: duration, rms, elapsedMs: Date.now() - started, normalized });
      } finally {
        fs.rmSync(ownedTemporary, { recursive: true, force: true });
      }
      check(`explicit input ${path.basename(source)} staging is removed`, !fs.existsSync(ownedTemporary));
    }
    check('every decoder receives its own ephemeral session and all validator windows are released', new Set(validators.map(entry => entry.session)).size === validators.length && validators.every(entry => entry.window.isDestroyed()));
    completed = true;
  } finally {
    service.stopAll();
    if (win && !win.isDestroyed()) win.destroy();
    for (const entry of validators) if (!entry.window.isDestroyed()) entry.window.destroy();
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ appRoot, completed, checks, errors }, null, 2));
    console.log(`Results: ${directory}`);
    app.exit(completed ? 0 : 1);
  }
}
function createWave(frames) {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(7000 * Math.sin(i * 2 * Math.PI * 440 / 48000)), 44 + i * 2);
  return bytes;
}
function installRendererFixtures() {
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = new Proxy(NativeAudioContext, { construct(target, args) { return new target({ ...args[0], sinkId: { type: 'none' } }); } });
  NativeAudioContext.prototype.setSinkId = async () => {};
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [
    { deviceId: 'fixture-mic', kind: 'audioinput', label: 'Fixture microphone' },
    { deviceId: 'fixture-cable', kind: 'audiooutput', label: 'CABLE Input (Fixture)' },
    { deviceId: 'fixture-headphones', kind: 'audiooutput', label: 'Fixture headphones' },
  ] });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('Fixture mic denied', 'NotAllowedError'); } });
  if (!localStorage.getItem('audio-link-test:initialized')) {
    localStorage.clear(); localStorage.setItem('audio-link-test:initialized', 'true');
    localStorage.setItem('soundmuncher:walkthrough-complete:v1', 'true');
    localStorage.setItem('soundmuncher:library-metadata', JSON.stringify({ boards: ['Main', 'Game night'], sounds: {} }));
    localStorage.setItem('soundmuncher:mixer-settings', JSON.stringify({ voiceIsolation: false, soundPlayback: true, inputDeviceId: 'fixture-mic', outputDeviceId: 'fixture-cable', localPlaybackDeviceId: 'fixture-headphones' }));
  }
}
