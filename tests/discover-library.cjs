/*
 * Real Electron UI and audio-routing checks for the in-app Discover library.
 * Uses the production preload, CSP, context isolation and sandbox. Only desktop
 * IPC operations and device endpoints are fixtures. Bundled or live API audio is
 * decoded by Chromium, imports are copied to an isolated on-disk library, and
 * every AudioContext uses a silent sink. No hardware or user profile is touched.
 * Run: node tests/discover-library.cjs [--app-root PATH] [--live]
 * --live uses anonymous API reads and an isolated local import directory.
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
  const live = process.argv.includes('--live');
  if (live) delete process.env.FREQX_LIBRARY_BUNDLED;
  else process.env.FREQX_LIBRARY_BUNDLED = '1';
  const { app, BrowserWindow, ipcMain } = require('electron');
  ipcMain.handle('app:update-status', () => ({ status: 'idle' }));
  const argumentIndex = process.argv.indexOf('--app-root');
  const appRoot = argumentIndex < 0 ? root : path.resolve(process.argv[argumentIndex + 1]);
  const { PublicLibrary } = require(path.join(appRoot, 'runtime', 'public-library.cjs'));
  const publicLibrary = new PublicLibrary({ appRoot });
  const { PlatformLibrary } = require(path.join(appRoot, 'runtime', 'platform-library.cjs'));
  const { AuthClient } = require(path.join(appRoot, 'runtime', 'auth-client.cjs'));
  const { config: desktopConfig } = require(path.join(appRoot, 'runtime', 'desktop-config.cjs'));
  const liveClient = live ? new AuthClient({ apiBaseUrl: desktopConfig.network.apiBaseUrl, development: false, store: { read: async () => null } }) : null;
  const liveLibrary = live ? new PlatformLibrary({ getClient: () => liveClient, fallback: publicLibrary, development: false }) : null;
  const output = path.join(root, 'output', live ? 'discover-library-live' : 'discover-library');
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
  let paginatedFixture = false, pageFailure = false;
  const catalogRequests = [], websiteDestinations = [], liveCatalogs = [];
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
  fixtureHandler('audio:reference-devices', () => []);
  fixtureHandler('audio:list-imported-files', listImportedFiles);
  fixtureHandler('audio:external-imports-ready', () => { initialized = true; });
  fixtureHandler('keybinds:register-global', () => ({ failed: [] }));
  fixtureHandler('app:check-for-updates', () => ({ updateAvailable: false, currentVersion: '1.7.0' }));
  fixtureHandler('audio:import-files', () => ({ canceled: true, imported: [] }));
  fixtureHandler('audio:remove-imported-file', filePath => {
    if (path.dirname(filePath) !== importedDirectory) throw new Error('Outside fixture library.');
    fs.unlinkSync(filePath); return { ok: true };
  });
  for (const channel of ['audio:send-test-tone', 'audio:open-library-folder']) fixtureHandler(channel, () => ({ ok: true }));
  fixtureHandler('app:open-website', destination => { websiteDestinations.push(destination); return { ok: true }; });
  fixtureHandler('library:catalog', async (options = {}) => {
    if (catalogFailure) throw new Error('Fixture catalog unavailable.');
    if (live) {
      catalogRequests.push({ ...options });
      const catalog = await liveLibrary.getCatalog(options);
      liveCatalogs.push(catalog);
      return catalog;
    }
    const catalog = await publicLibrary.getCatalog();
    if (!paginatedFixture) return catalog;
    catalogRequests.push({ ...options });
    if (options.search === 'signal') await pause(400);
    if (pageFailure && options.cursor) throw new Error('Fixture page unavailable.');
    const filtered = catalog.sounds.filter(sound =>
      (!options.category || sound.category === options.category) &&
      (!options.search || `${sound.title} ${sound.description} ${sound.tags.join(' ')}`.toLowerCase().includes(options.search.toLowerCase())));
    const offset = options.cursor ? Number(options.cursor.replace('fixture-', '')) : 0;
    return { sounds: filtered.slice(offset, offset + 2), nextCursor: offset + 2 < filtered.length ? `fixture-${offset + 2}` : null,
      totalSounds: 41448, paginated: true, source: 'remote', sourceLabel: 'FREQX COMMUNITY' };
  });
  fixtureHandler('library:preview', async id => {
    if (previewDelay) await pause(previewDelay);
    if (previewFailure) throw new Error('Fixture preview unavailable.');
    return live ? liveLibrary.preview(id) : publicLibrary.getPreview(id);
  });
  fixtureHandler('library:import', async id => {
    return (liveLibrary || publicLibrary).withSound(id, async sound => {
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
    // Wake the hidden window's compositor before saving the updated frame.
    win.webContents.invalidate();
    await win.webContents.capturePage();
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
  async function verifyLive() {
    await evaluate(`document.getElementById('discoverTab').click()`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length > 0 && !document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'live catalog first page', 30000);
    const first = liveCatalogs[0];
    check('live browsing uses the paginated public API and catalog stats total', first.source === 'remote' && first.paginated && first.sounds.length > 0 && first.nextCursor && first.totalSounds >= 40000 && catalogRequests.length === 1 && await evaluate(`document.getElementById('discoverCount').textContent.includes(${JSON.stringify(first.totalSounds.toLocaleString())})`), { totalSounds: first.totalSounds, firstPage: first.sounds.length });
    for (let attempt = 0; attempt < 3 && liveCatalogs.length < 2; attempt++) {
      await evaluate(`document.getElementById('discoverLoadMore').click()`);
      await until(`!document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'live next page', 30000);
    }
    const second = liveCatalogs[1];
    const firstIds = new Set(first.sounds.map(sound => sound.id));
    check('live Load more follows nextCursor and appends new sounds', second?.source === 'remote' && catalogRequests[1]?.cursor === first.nextCursor && second.sounds.some(sound => !firstIds.has(sound.id)) && await evaluate(`document.querySelectorAll('#discoverGrid [data-sound-id]').length > ${Math.min(first.sounds.length, desktopConfig.ui.discoverPageSize)}`), { secondPage: second?.sounds.length });
    await evaluate(`document.getElementById('discoverSearch').value = 'bruh'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(`!document.getElementById('discoverPage').hasAttribute('aria-busy') && document.querySelectorAll('#discoverGrid [data-sound-id]').length > 0`, 'live search', 30000);
    const searched = liveCatalogs.at(-1);
    check('live search requests matching sounds from the complete catalog', searched.source === 'remote' && catalogRequests.at(-1).search === 'bruh' && !catalogRequests.at(-1).cursor && searched.sounds.some(sound => sound.title.toLowerCase().includes('bruh')), { resultsLoaded: searched.sounds.length });
    const category = searched.sounds[0].category;
    await evaluate(`document.querySelector('#discoverCategories [data-category=' + CSS.escape(${JSON.stringify(category)}) + ']').click()`);
    await until(`!document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'live category filter', 30000);
    check('live category filter combines with search on the API', liveCatalogs.at(-1).source === 'remote' && liveCatalogs.at(-1).sounds.length > 0 && liveCatalogs.at(-1).sounds.every(sound => sound.category === category) && catalogRequests.at(-1).category === category && catalogRequests.at(-1).search === 'bruh', { category });
    await evaluate(`document.getElementById('discoverSearch').value = ${JSON.stringify(`freqx-live-no-matching-sound-${Date.now()}`)}; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(`!document.getElementById('discoverEmpty').hidden`, 'live empty search', 30000);
    check('live empty search presents a reset without falling back to bundled audio', liveCatalogs.at(-1).source === 'remote' && liveCatalogs.at(-1).sounds.length === 0 && await evaluate(`!document.getElementById('discoverReset').hidden`));
    await evaluate(`document.getElementById('discoverReset').click()`);
    await until(`!document.getElementById('discoverPage').hasAttribute('aria-busy') && document.querySelectorAll('#discoverGrid [data-sound-id]').length > 0`, 'live filter reset', 30000);
    check('live reset starts an unfiltered cursor sequence', catalogRequests.at(-1).search === '' && catalogRequests.at(-1).category === '' && !catalogRequests.at(-1).cursor);
    await evaluate(`document.getElementById('discoverSearch').value = 'bruh'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(`!document.getElementById('discoverPage').hasAttribute('aria-busy') && document.querySelectorAll('#discoverGrid [data-sound-id]').length > 0`, 'live sound for playback', 30000);
    const sounds = liveCatalogs.at(-1).sounds;
    const visibleIds = await evaluate(`Array.from(document.querySelectorAll('#discoverGrid [data-sound-id]'), card => card.dataset.soundId)`);
    const visibleSounds = sounds.filter(sound => visibleIds.includes(sound.id));
    const sound = visibleSounds.find(sound => sound.title.toLowerCase() === 'bruh') || visibleSounds.find(sound => sound.duration > .3 && sound.duration < 5) || visibleSounds[0];
    await evaluate(`document.querySelector('[data-sound-id=' + CSS.escape(${JSON.stringify(sound.id)}) + '] .discover-preview').click()`);
    await until('!!discoverPreviewSource', 'live audio decoding and preview', 30000);
    const signal = await measurePreview();
    check('live catalog audio decodes in Chromium and reaches only the local monitor', signal[0] > .0001 && signal[1] < .000001 && await evaluate('activeSoundNodes.size === 0 && !micStream'), { id: sound.id, localRms: signal[0], mixRms: signal[1] });
    await evaluate(`document.getElementById('stopAllSounds').click(); document.getElementById('discoverBoard').value = 'Game night'; document.getElementById('discoverBoard').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-sound-id=' + CSS.escape(${JSON.stringify(sound.id)}) + '] .discover-add').click();`);
    await until('importedLibraryItems.length === 1', 'live audio import', 30000);
    const imported = fs.readdirSync(importedDirectory);
    check('live sound imports a nonempty local audio file and preserves board metadata', imported.length === 1 && fs.statSync(path.join(importedDirectory, imported[0])).size > 0 && await evaluate(`getSoundMetadata(importedLibraryItems[0]).catalogId === ${JSON.stringify(sound.id)} && getSoundMetadata(importedLibraryItems[0]).board === 'Game night' && document.querySelector('[data-sound-id=' + CSS.escape(${JSON.stringify(sound.id)}) + '] .discover-add').disabled`), { id: sound.id, file: imported[0] });
    await evaluate(`window.__livePlayback = playImportedSound(importedLibraryItems[0]);`);
    await evaluate('__livePlayback');
    check('imported live audio plays from the local soundboard', await evaluate('activeSoundNodes.size === 1'));
    await evaluate('stopAllSounds()');
    await screenshot('discover-live.png');
    check('live verification uses anonymous API access with no renderer network requests', liveClient.accessToken === null && !requests.some(url => /^https?:/i.test(url)));
    check('live browsing and audio produce no renderer errors or crash reports', errors.length === 0 && crashes.length === 0, { errors, crashes });
  }

  try {
    await app.whenReady();
    await createWindow();
    if (live) { await verifyLive(); completed = true; return; }
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
    await evaluate(`document.getElementById('openWebsiteLink').click(); document.getElementById('discoverWebsite').click(); document.getElementById('openAccount').click(); document.getElementById('accountWebsite').click(); document.getElementById('closeAccount').click();`);
    await pause(100);
    check('website links use trusted home, soundboard and account destinations', JSON.stringify(websiteDestinations) === JSON.stringify(['home', 'soundboard', 'account']), websiteDestinations);

    paginatedFixture = true;
    await createWindow();
    await evaluate(`document.getElementById('discoverTab').click()`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 2 && !document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'first remote page');
    check('remote browsing fetches one page and displays catalog stats total', catalogRequests.length === 1 && await evaluate(`document.getElementById('discoverCount').textContent.includes('41,448') && !document.getElementById('discoverLoadMore').hidden && document.getElementById('discoverSortLabel').textContent === 'Sort loaded'`));
    pageFailure = true;
    await evaluate(`document.getElementById('discoverLoadMore').click()`);
    await until(`document.getElementById('discoverFeedback').textContent.includes('Fixture page unavailable')`, 'page failure feedback');
    check('page failure preserves loaded cards and offers retry', await evaluate(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 2 && !document.getElementById('discoverLoadMore').disabled && document.getElementById('discoverLoadMore').textContent === 'Try loading more'`));
    pageFailure = false;
    await evaluate(`document.getElementById('discoverLoadMore').click()`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 4`, 'retried remote page');
    check('cursor retry uses the same nextCursor', catalogRequests[1].cursor === 'fixture-2' && catalogRequests[2].cursor === 'fixture-2', catalogRequests.slice(1));
    await evaluate(`document.getElementById('discoverLoadMore').click()`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 6 && document.getElementById('discoverLoadMore').hidden`, 'last remote page');
    check('browsing appends every cursor page without duplicates', catalogRequests[3].cursor === 'fixture-4' && await evaluate(`new Set(Array.from(document.querySelectorAll('#discoverGrid [data-sound-id]'), card => card.dataset.soundId)).size === 6`));
    const knownCategoryCount = await evaluate(`document.querySelectorAll('#discoverCategories [data-category]').length`);
    await evaluate(`document.getElementById('discoverSearch').value = 'signal'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await pause(300);
    await evaluate(`document.getElementById('discoverSearch').value = 'glass'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 1 && !!document.querySelector('#discoverGrid [data-sound-id="glass-chime"]') && !document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'newer search result');
    await pause(150);
    check('search reaches the server and stale responses cannot replace newer results', catalogRequests.some(query => query.search === 'signal') && catalogRequests.at(-1).search === 'glass' && await evaluate(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 1 && !!document.querySelector('#discoverGrid [data-sound-id="glass-chime"]')`), catalogRequests.slice(-2));
    const glassCategory = categoryCatalog.sounds.find(sound => sound.id === 'glass-chime').category;
    await evaluate(`document.querySelector('#discoverCategories [data-category=' + CSS.escape(${JSON.stringify(glassCategory)}) + ']').click()`);
    await until(`!document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'combined search and category');
    check('category filters and search are sent together without the previous cursor', catalogRequests.at(-1).category === glassCategory && catalogRequests.at(-1).search === 'glass' && !catalogRequests.at(-1).cursor, catalogRequests.at(-1));
    await evaluate(`document.getElementById('discoverSearch').value = 'no matching sound 9274'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(`!document.getElementById('discoverEmpty').hidden`, 'empty server search');
    check('empty server search keeps category choices and offers filter reset', await evaluate(`!document.getElementById('discoverReset').hidden && document.querySelectorAll('#discoverCategories [data-category]').length === ${knownCategoryCount}`));
    await evaluate(`document.getElementById('discoverReset').click()`);
    await until(`document.querySelectorAll('#discoverGrid [data-sound-id]').length === 2 && !document.getElementById('discoverPage').hasAttribute('aria-busy')`, 'reset remote filters');
    check('remote reset starts a fresh unfiltered page', catalogRequests.at(-1).search === '' && catalogRequests.at(-1).category === '' && !catalogRequests.at(-1).cursor, catalogRequests.at(-1));
    await evaluate(`document.getElementById('discoverSearch').value = 'glass'; document.getElementById('discoverSearch').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(`!!document.querySelector('#discoverGrid [data-sound-id="glass-chime"]')`, 'remote preview card');
    await evaluate(`document.querySelector('[data-sound-id="glass-chime"] .discover-preview').click()`);
    await until('!!discoverPreviewSource', 'paged sound preview');
    check('a paged catalog sound decodes and starts local preview', await evaluate('!!discoverPreviewSource && activeSoundNodes.size === 0 && !micStream'));
    await evaluate(`document.getElementById('stopAllSounds').click(); document.getElementById('discoverBoard').value = 'Game night'; document.getElementById('discoverBoard').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-sound-id="glass-chime"] .discover-add').click();`);
    await until(`importedLibraryItems.length === 2`, 'paged sound import');
    check('a paged sound imports with its catalog identity and chosen board', fs.readdirSync(importedDirectory).length === 2 && await evaluate(`importedLibraryItems.some(item => getSoundMetadata(item).catalogId === 'glass-chime' && getSoundMetadata(item).board === 'Game night')`));
    await evaluate(`window.__pagedSound = importedLibraryItems.find(item => getSoundMetadata(item).catalogId === 'glass-chime'); window.__pagedPlayback = playImportedSound(__pagedSound);`);
    await evaluate('__pagedPlayback');
    check('an imported paged sound plays from the local library', await evaluate('activeSoundNodes.size === 1'));
    await evaluate('stopAllSounds()');
    await screenshot('discover-paginated.png');
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
