/*
 * Real Electron UI and audio-routing checks for the in-app Discover library.
 * Uses the production preload, CSP, context isolation and sandbox. Only desktop
 * IPC operations and device endpoints are fixtures. Original bundled audio is
 * decoded by Chromium, imports are copied to an isolated on-disk library, and
 * every AudioContext uses a silent sink. No hardware or user profile is touched.
 * Run: node tests/discover-library.cjs [--app-root PATH]
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 150000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function run() {
  process.env.FREQX_LIBRARY_BUNDLED = '1';
  const { app, BrowserWindow, ipcMain } = require('electron');
  ipcMain.handle('app:update-status', () => ({ status: 'idle' }));
  const argumentIndex = process.argv.indexOf('--app-root');
  const appRoot = argumentIndex < 0 ? root : path.resolve(process.argv[argumentIndex + 1]);
  const { PublicLibrary } = require(path.join(appRoot, 'runtime', 'public-library.cjs'));
  const publicLibrary = new PublicLibrary({ appRoot });
  const output = path.join(root, 'output', 'discover-library');
  fs.mkdirSync(output, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(output, 'run-'));
  const importedDirectory = path.join(runDirectory, 'imported-audio');
  fs.mkdirSync(importedDirectory);
  app.setPath('userData', path.join(runDirectory, 'profile'));
  app.setPath('sessionData', path.join(runDirectory, 'session'));
  app.setPath('crashDumps', path.join(runDirectory, 'dumps'));
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.on('window-all-closed', () => {});
  const checks = [], errors = [], requests = [], crashes = [];
  let win, initialized = false, completed = false, catalogFailure = false, previewFailure = false, previewDelay = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  function check(name, pass, detail) {
    checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!pass) throw new Error(name);
  }
  async function until(code, name, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(code)) return;
      await pause(25);
    }
    throw new Error(`Timed out waiting for ${name}`);
  }
  async function listImportedFiles() {
    return fs.readdirSync(importedDirectory).map(name => {
      const filePath = path.join(importedDirectory, name);
      return { path: filePath, name, sizeBytes: fs.statSync(filePath).size, fileUrl: pathToFileURL(filePath).href };
    });
  }
  function fixtureHandler(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted fixture sender.');
      return handler(...args);
    });
  }
  fixtureHandler('app:report-crash', report => { crashes.push(report); return report; });
  fixtureHandler('auth:status', () => ({ user: null }));
  fixtureHandler('app-settings:get', () => ({ keepRunningInTray: false, launchOnStartup: false }));
  fixtureHandler('app-settings:set', settings => ({ settings }));
  fixtureHandler('audio:list-output-devices', () => []);
  fixtureHandler('audio:list-imported-files', listImportedFiles);
  fixtureHandler('audio:external-imports-ready', () => { initialized = true; });
  fixtureHandler('keybinds:register-global', () => ({ failed: [] }));
  fixtureHandler('app:check-for-updates', () => ({ updateAvailable: false, currentVersion: '1.7.0' }));
  fixtureHandler('audio:import-files', () => ({ canceled: true, imported: [] }));
  fixtureHandler('audio:remove-imported-file', filePath => {
    if (path.dirname(filePath) !== importedDirectory) throw new Error('Outside fixture library.');
    fs.unlinkSync(filePath); return { ok: true };
  });
  for (const channel of ['audio:send-test-tone', 'audio:open-library-folder', 'app:open-website']) fixtureHandler(channel, () => ({ ok: true }));
  fixtureHandler('library:catalog', async () => {
    if (catalogFailure) throw new Error('Fixture catalog unavailable.');
    return publicLibrary.getCatalog();
  });
  fixtureHandler('library:preview', async id => {
    if (previewDelay) await pause(previewDelay);
    if (previewFailure) throw new Error('Fixture preview unavailable.');
    return publicLibrary.getPreview(id);
  });
  fixtureHandler('library:import', async id => {
    return publicLibrary.withSound(id, async sound => {
    const destination = path.join(importedDirectory, sound.filename);
    fs.copyFileSync(sound.filePath, destination);
    return { imported: [{ path: destination }], skipped: [], metadata: { [destination]: { name: sound.title, catalogId: sound.id } } };
    });
  });

  async function createWindow() {
    initialized = false;
    if (win && !win.isDestroyed()) win.destroy();
    win = new BrowserWindow({ show: false, width: 1240, height: 820, webPreferences: {
      preload: path.join(appRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, backgroundThrottling: false, partition: 'persist:discover-fixture',
    } });
    win.removeMenu();
    const session = win.webContents.session;
    session.setPermissionRequestHandler((_, __, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    let blockRenderer = true;
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      requests.push(details.url);
      callback({ cancel: /^https?:/i.test(details.url) || (blockRenderer && details.url.endsWith('/renderer.js')) });
    });
    win.webContents.on('console-message', event => {
      if (event.level === 'error' && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(event.message);
    });
    win.webContents.on('render-process-gone', (_, details) => errors.push(`Renderer exited: ${JSON.stringify(details)}`));
    await win.loadFile(path.join(appRoot, 'index.html'));
    // Install device-only fixtures before loading the unchanged app renderer.
    await evaluate(`(${installRendererFixtures.toString()})()`);
    blockRenderer = false;
    await evaluate(`new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'renderer.js'; script.onload = resolve; script.onerror = reject; document.body.append(script); })`);
    const started = Date.now();
    while (!initialized && Date.now() - started < 15000) await pause(25);
    check('renderer initializes with production security settings and no device access', initialized && crashes.length === 0);
  }
  async function screenshot(name) {
    await pause(100);
    fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  }
  async function measurePreview() {
    return evaluate(`(async () => {
      const local = audioContext.createAnalyser(), mix = audioContext.createAnalyser();
      appPlaybackGainNode.connect(local); compressorNode.connect(mix);
      const data = new Float32Array(2048), energy = [0, 0];
      for (let index = 0; index < 8; index++) {
        await new Promise(resolve => setTimeout(resolve, 15));
        [local, mix].forEach((node, position) => { node.getFloatTimeDomainData(data); energy[position] += data.reduce((sum, sample) => sum + sample * sample, 0) / data.length; });
      }
      appPlaybackGainNode.disconnect(local); compressorNode.disconnect(mix);
      return energy.map(value => Math.sqrt(value / 8));
    })()`);
  }

  try {
    await app.whenReady();
    await createWindow();
    check('renderer has no Node access and bridge exposes narrow library methods', await evaluate(`typeof require === 'undefined' && typeof process === 'undefined' && ['getPublicLibrary', 'previewPublicSound', 'importPublicSound'].every(name => typeof soundmuncher[name] === 'function')`));
    check('Soundboard is the default page', await evaluate(`document.getElementById('soundboardTab').getAttribute('aria-selected') === 'true' && document.getElementById('discoverPage').hidden`));
    await evaluate(`document.getElementById('discoverTab').click()`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 6`, 'six bundled sounds');
    check('Discover opens as the selected tab', await evaluate(`document.getElementById('discoverTab').getAttribute('aria-selected') === 'true' && !document.getElementById('discoverPage').hidden && document.getElementById('soundboardPage').hidden`));
    await screenshot('discover-desktop.png');
    await evaluate(`const search = document.getElementById('discoverSearch'); search.value = 'glass'; search.dispatchEvent(new Event('input', { bubbles: true }));`);
    check('search filters real catalog titles', await evaluate(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 1 && !!document.querySelector('#discoverGrid [data-sound-id="glass-chime"]')`));
    await evaluate(`document.getElementById('discoverSearch').value = 'no matching sound 9274'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    check('no-results state offers reset', await evaluate(`!document.getElementById('discoverEmpty').hidden && !document.getElementById('discoverReset').hidden`));
    await evaluate(`document.getElementById('discoverReset').click()`);
    check('reset restores all sounds', await evaluate(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 6 && !document.getElementById('discoverSearch').value`));
    const category = await evaluate(`Array.from(document.querySelectorAll('#discoverCategories [data-category]')).find(button => button.dataset.category !== 'all')?.dataset.category`);
    await evaluate(`document.querySelector('#discoverCategories [data-category=' + CSS.escape(${JSON.stringify(category)}) + ']').click()`);
    const categoryCatalog = await publicLibrary.getCatalog();
    const expectedIds = categoryCatalog.sounds.filter(sound => sound.category === category).map(sound => sound.id).sort();
    const categoryIds = await evaluate(`Array.from(document.querySelectorAll('#discoverGrid [data-sound-id]'), card => card.dataset.soundId).sort()`);
    check('category filter matches catalog categories', expectedIds.length > 0 && JSON.stringify(expectedIds) === JSON.stringify(categoryIds), { category, ids: categoryIds });
    await evaluate(`document.querySelector('#discoverCategories [data-category="all"]').click(); document.getElementById('discoverSort').value = 'duration'; document.getElementById('discoverSort').dispatchEvent(new Event('change', { bubbles: true }));`);
    const sortedIds = await evaluate(`Array.from(document.querySelectorAll('#discoverGrid [data-sound-id]'), card => card.dataset.soundId)`);
    const durations = sortedIds.map(id => categoryCatalog.sounds.find(sound => sound.id === id).duration);
    check('duration sort orders actual clip lengths', durations.every((duration, index) => !index || duration >= durations[index - 1]), durations);
    await evaluate(`document.querySelector('[data-sound-id="signal-sweep"] .discover-preview').click()`);
    await until('!!discoverPreviewSource', 'audible local preview');
    const signal = await measurePreview();
    check('preview reaches local monitor and never reaches shared mix', signal[0] > 0.0001 && signal[1] < 0.000001, { localRms: signal[0], mixRms: signal[1] });
    check('preview leaves soundboard players and microphone untouched', await evaluate('activeSoundNodes.size === 0 && !micStream'));
    await evaluate(`document.getElementById('stopAllSounds').click()`);
    check('Stop all stops preview even with no soundboard audio', await evaluate('!discoverPreviewSource && !discoverPreviewGain'));
    await evaluate(`document.querySelector('[data-sound-id="signal-sweep"] .discover-preview').click()`);
    await until('!!discoverPreviewSource', 'second preview');
    await evaluate(`document.getElementById('soundboardTab').click()`);
    check('leaving Discover stops preview', await evaluate('!discoverPreviewSource && !discoverPreviewGain'));
    await evaluate(`document.getElementById('discoverTab').click()`);
    previewDelay = 300;
    await evaluate(`document.querySelector('[data-sound-id="signal-sweep"] .discover-preview').click(); document.getElementById('stopAllSounds').click();`);
    await pause(450);
    check('Stop all cancels a preview still loading', await evaluate('!discoverPreviewSource'));
    previewDelay = 0;
    await evaluate(`document.getElementById('toggleSoundPlayback').click(); document.querySelector('[data-sound-id="signal-sweep"] .discover-preview').click();`);
    await pause(150);
    check('preview respects disabled local playback', await evaluate('!isSoundPlaybackEnabled && !discoverPreviewSource'));
    await evaluate(`document.getElementById('toggleSoundPlayback').click()`);
    await evaluate(`document.getElementById('discoverBoard').value = 'Game night'; document.getElementById('discoverBoard').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-sound-id="fm-ping"] .discover-add').click();`);
    await until(`importedLibraryItems.length === 1`, 'added catalog sound');
    check('Add writes a playable file and stores selected-board metadata', fs.readdirSync(importedDirectory).length === 1 && await evaluate(`getSoundMetadata(importedLibraryItems[0]).board === 'Game night' && getSoundMetadata(importedLibraryItems[0]).catalogId === 'fm-ping'`));
    check('already-added sound cannot be imported twice', await evaluate(`document.querySelector('[data-sound-id="fm-ping"] .discover-add').disabled`));
    await evaluate(`window.__originalDecode = audioContext.decodeAudioData.bind(audioContext);
      window.__releaseDecode = null;
      window.__decodeGate = new Promise(resolve => { __releaseDecode = resolve; });
      audioContext.decodeAudioData = async (...args) => { await __decodeGate; return __originalDecode(...args); };
      clearImportedAudioBufferCache();
      window.__pendingSound = playImportedSound(importedLibraryItems[0]);
      stopAllSounds(); __releaseDecode();`);
    await evaluate('__pendingSound');
    check('Stop all prevents a sound from starting after real audio decoding', await evaluate('activeSoundNodes.size === 0 && pendingSoundStarts.size === 0'));
    await evaluate(`clearImportedAudioBufferCache();
      libraryMetadata[importedLibraryItems[0].path].playbackMode = 'once';
      window.__decodeGate = new Promise(resolve => { __releaseDecode = resolve; });
      window.__pendingSounds = Promise.all([playImportedSound(importedLibraryItems[0]), playImportedSound(importedLibraryItems[0])]);
      __releaseDecode();`);
    await evaluate('__pendingSounds');
    check('play once starts a single real audio source after rapid presses', await evaluate('activeSoundNodes.size === 1 && pendingSoundStarts.size === 0'));
    await evaluate(`stopAllSounds(); audioContext.decodeAudioData = __originalDecode;
      libraryMetadata[importedLibraryItems[0].path].playbackMode = 'overlap';`);
    await screenshot('discover-added.png');
    await createWindow();
    check('added sound and board assignment survive app reload', await evaluate(`importedLibraryItems.length === 1 && getSoundMetadata(importedLibraryItems[0]).board === 'Game night' && getSoundMetadata(importedLibraryItems[0]).catalogId === 'fm-ping'`));
    await evaluate(`document.getElementById('discoverTab').click()`);
    await evaluate(`document.getElementById('discoverBoard').value = 'Game night'; document.getElementById('discoverBoard').dispatchEvent(new Event('change', { bubbles: true }));`);
    await until(`document.querySelector('[data-sound-id="fm-ping"] .discover-add')?.disabled`, 'persisted duplicate state');
    check('duplicate state survives reload', true);
    win.setContentSize(900, 620);
    await pause(100);
    const dimensions = await evaluate(`({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, content: document.getElementById('discoverPage').getBoundingClientRect().width })`);
    check('Discover fits the minimum window width', dimensions.scroll <= dimensions.client, dimensions);
    await screenshot('discover-minimum-window.png');
    await evaluate(`appPreferences.uiTheme = 'daylight'; applyAppPreferences()`);
    check('Discover follows the existing theme preference', await evaluate(`document.body.dataset.theme === 'daylight' && getComputedStyle(document.body).colorScheme === 'light'`));
    await screenshot('discover-daylight.png');
    check('no catalog or audio network request is needed', !requests.some(url => /^https?:/i.test(url)), requests.filter(url => /^https?:/i.test(url)));
    check('no runtime errors or crash reports', errors.length === 0 && crashes.length === 0, { errors, crashes });
    completed = true;
  } catch (error) {
    errors.push(error.stack || String(error));
    console.error(error);
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, crashes, requests, runDirectory }, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(completed && checks.every(check => check.pass) && errors.length === 0 && crashes.length === 0 ? 0 : 1);
  }
}

function installRendererFixtures() {
  window.__discoverTest = { contexts: [], captures: 0 };
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = new Proxy(NativeAudioContext, {
    construct(target, args) {
      const context = new target({ ...args[0], sinkId: { type: 'none' } });
      __discoverTest.contexts.push(context);
      return context;
    },
  });
  NativeAudioContext.prototype.setSinkId = async () => {};
  const devices = [
    { deviceId: 'fixture-mic', kind: 'audioinput', label: 'Fixture microphone', groupId: 'mic' },
    { deviceId: 'fixture-cable', kind: 'audiooutput', label: 'CABLE Input (Fixture)', groupId: 'cable' },
    { deviceId: 'fixture-headphones', kind: 'audiooutput', label: 'Fixture headphones', groupId: 'headphones' },
  ];
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => devices });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
    __discoverTest.captures++;
    throw new DOMException('Microphone intentionally denied in the library UI test.', 'NotAllowedError');
  } });
  if (!localStorage.getItem('discover-test:initialized')) {
    localStorage.clear();
    localStorage.setItem('discover-test:initialized', 'true');
    localStorage.setItem('soundmuncher:walkthrough-complete:v1', 'true');
    localStorage.setItem('soundmuncher:mixer-settings', JSON.stringify({
      micGain: 0.71, soundGain: 0.63, masterGain: 0.81, soundPlayback: true, voiceIsolation: false,
      inputDeviceId: 'fixture-mic', outputDeviceId: 'fixture-cable', localPlaybackDeviceId: 'fixture-headphones',
    }));
    localStorage.setItem('soundmuncher:library-metadata', JSON.stringify({ boards: ['Main', 'Game night'], sounds: {} }));
  }
}
