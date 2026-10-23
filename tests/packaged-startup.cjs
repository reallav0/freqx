// Starts the actual release executable and production main/preload/renderer.
// Pause before main.js to isolate its profile, registry and audio hardware.
// Usage: node tests/packaged-startup.cjs [--exe dist/win-unpacked/freqx.exe]
// Optional live update check/download (never runs the installer): --updates
// Offline production update popup/verification/confirmation smoke: --update-notice
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
  const checkVoicePresets = process.argv.includes('--voice-presets');
  const checkReplay = process.argv.includes('--replay');
  const checkUpdates = process.argv.includes('--updates');
  const checkUpdateNotice = process.argv.includes('--update-notice');
  if (checkUpdates && checkUpdateNotice) throw new Error('Run live updates and the offline popup smoke separately.');
  const noticeSnapshotSource = expected => `(async () => {
    const deadline = Date.now() + 5000;
    let state;
    do {
      state = await window.soundmuncher.updateStatus();
      const action = document.getElementById('updateNoticeAction');
      const painted = ${JSON.stringify(expected)} === 'downloaded' ? action?.textContent === 'Restart and install' && !action.disabled
        : ${JSON.stringify(expected)} === 'downloading' ? document.getElementById('updateNoticePercent')?.textContent === '37%' : true;
      if (state.status === ${JSON.stringify(expected)} && document.getElementById('updateNotice')?.open && painted) {
        return { status: state.status, open: true, title: document.getElementById('updateNoticeTitle').textContent,
          percent: document.getElementById('updateNoticePercent').textContent, action: document.getElementById('updateNoticeAction').textContent,
          disabled: document.getElementById('updateNoticeAction').disabled };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error('Expected update popup phase: ' + ${JSON.stringify(expected)} + '; actual: ' + JSON.stringify(state));
  })()`;
  const noticeActionSource = confirming => `(async () => {
    const button = document.getElementById('updateNoticeAction'), status = document.getElementById('updateNoticeStatus');
    button.click();
    const deadline = Date.now() + 5000;
    while (!${confirming ? '/restarting/i' : '/cancel/i'}.test(status.textContent)) {
      if (Date.now() > deadline) throw new Error('Update popup action timed out: ' + status.textContent);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { text: status.textContent, open: document.getElementById('updateNotice').open, disabled: button.disabled };
  })()`;
  const updateSmokeSource = `(async () => {
    const deadline = Date.now() + 180000;
    let state;
    do {
      state = await window.soundmuncher.updateStatus();
      if (['downloaded', 'none', 'error', 'unsupported'].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 100));
    return { ...state, installVisible: !document.getElementById('installUpdate').hidden, text: document.getElementById('updateState').textContent };
  })()`;
  const replaySmokeSource = `(async () => {
    const element = id => document.getElementById(id);
    const until = async predicate => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Replay smoke timed out: ' + element('replayFeedback').textContent);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    element('replayTab').click();
    await until(() => Array.from(element('replaySource').options).some(option => option.value === 'mix:') && !element('replaySource').disabled);
    element('replaySource').value = 'mix:';
    element('replaySource').dispatchEvent(new Event('change', { bubbles: true }));
    element('replayBuffer').value = '15';
    element('replayStart').click();
    await until(() => !element('replayCapture').disabled);
    const recording = !element('replayTabBadge').hidden;
    await new Promise(resolve => setTimeout(resolve, 400));
    element('replayCapture').click();
    await until(() => !element('replayPlay').disabled);
    element('replayStart').click();
    await until(() => element('replayTabBadge').hidden);
    const beforeTrim = Number(element('replayOut').value);
    element('replayIn').value = '0.05';
    element('replayIn').dispatchEvent(new Event('change', { bubbles: true }));
    element('replayTrim').click();
    const duration = Number(element('replayOut').value);
    element('replayName').value = 'Replay smoke';
    const board = element('replayBoard').value;
    element('replaySave').click();
    await until(() => element('replayFeedback').textContent.includes('Saved Replay smoke'));
    const item = importedLibraryItems.find(item => getSoundMetadata(item).name === 'Replay smoke');
    return { recording, beforeTrim, duration, board, metadata: item && getSoundMetadata(item), item, stopped: element('replayTabBadge').hidden };
  })()`;
  const presetSmokeSource = `(async () => {
    const options = Array.from(document.getElementById('aiVoiceSelect').options, option => option.textContent);
    const mode = voiceConversionSettings.mode;
    document.getElementById('aiVoiceToggle').checked = true;
    document.getElementById('aiVoiceToggle').dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (voiceConversionStatus !== 'active' || !voiceConversionSession)) {
      if (voiceConversionFaulted) throw new Error(aiVoiceState.textContent);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const result = { options, mode, active: voiceConversionStatus === 'active', worklet: voiceConversionSession?.node instanceof AudioWorkletNode };
    document.getElementById('aiVoiceToggle').checked = false;
    document.getElementById('aiVoiceToggle').dispatchEvent(new Event('change', { bubbles: true }));
    return result;
  })()`;
  const argument = process.argv.indexOf('--exe');
  const devArgument = process.argv.indexOf('--dev-script');
  const developmentScript = devArgument < 0 ? null : process.argv[devArgument + 1];
  if (developmentScript !== null && !['dev', 'start'].includes(developmentScript)) throw new Error('Use --dev-script dev or start.');
  if ((checkUpdates || checkUpdateNotice) && developmentScript) throw new Error('Update smoke checks require a packaged Windows executable.');
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
  // A slow startup can reach the automatic update timer in any smoke mode.
  env.LOCALAPPDATA = path.join(directory, 'update-cache');
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
  const deadline = Date.now() + (checkUpdates ? 210000 : 40000);
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
      const { app, BrowserWindow, dialog } = require('electron');
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
      let updateDownload, updateConfirmation = 1;
      let noticeUpdater;
      const updateEvents = [], updateErrors = [], updateInstallRequests = [], updatePrompts = [];
      if (${checkUpdates || checkUpdateNotice}) {
        const { autoUpdater } = require('electron-updater');
        if (${checkUpdateNotice}) {
          noticeUpdater = autoUpdater;
          autoUpdater.checkForUpdates = async () => ({});
        }
        // Exercise detection, download, verification and production install IPC,
        // while leaving the installed application and its normal cache untouched.
        autoUpdater.quitAndInstall = (...args) => updateInstallRequests.push(args);
        for (const name of ['checking-for-update', 'update-available', 'download-progress', 'update-downloaded', 'update-not-available']) {
          autoUpdater.on(name, info => {
            if (name !== 'download-progress' || updateEvents.at(-1) !== name) updateEvents.push(name);
            if (name === 'update-downloaded') updateDownload = info;
          });
        }
        autoUpdater.on('error', error => updateErrors.push({ code: error.code, message: error.message }));
        const originalMessageBox = dialog.showMessageBox;
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1);
          if (options.buttons?.[0] !== 'Restart and install') return originalMessageBox.apply(dialog, args);
          updatePrompts.push({ defaultId: options.defaultId, cancelId: options.cancelId, response: updateConfirmation });
          return { response: updateConfirmation };
        };
      }
      let replayNativeStarts = 0;
      if (${checkReplay}) {
        const { ReplayCaptureService } = require('./runtime/replay-capture.cjs');
        ReplayCaptureService.prototype.list = async () => ({ ok: true, processCaptureSupported: true, sources: [] });
        ReplayCaptureService.prototype.start = async () => {
          replayNativeStarts++; throw new Error('Native Replay capture disabled in startup smoke test.');
        };
      }
      let voiceEngineRequests = 0;
      if (${checkVoicePresets}) {
        const { VoiceConversionService } = require('./runtime/voice-conversion.cjs');
        for (const name of ['list', 'start', 'frame']) VoiceConversionService.prototype[name] = async () => {
          voiceEngineRequests++; throw new Error('Built-in preset requested the optional AI engine.');
        };
      }
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
            if (${checkVoicePresets}) {
              state.voicePresets = await window.webContents.executeJavaScript(${JSON.stringify(presetSmokeSource)});
              state.voiceEngineRequests = voiceEngineRequests;
            }
            if (${checkReplay}) {
              state.replay = await window.webContents.executeJavaScript(${JSON.stringify(replaySmokeSource)});
              state.replay.nativeStarts = replayNativeStarts;
              const savedPath = state.replay.item?.path;
              if (!savedPath || !path.resolve(savedPath).startsWith(profile + path.sep)) throw new Error('Replay must save inside the isolated profile.');
              const bytes = fs.readFileSync(savedPath);
              require('./runtime/replay-capture.cjs').validateReplayWav(bytes);
              state.replay.bytes = bytes.length;
            }
            if (${checkUpdates}) {
              state.update = await window.webContents.executeJavaScript(${JSON.stringify(updateSmokeSource)});
              if (state.update.status === 'downloaded') {
                const file = updateDownload?.downloadedFile;
                if (!file || !path.resolve(file).startsWith(path.join(directory, 'update-cache') + path.sep)) throw new Error('Update escaped its isolated cache.');
                await require('./runtime/update-client.cjs').verifyDownload(updateDownload);
                state.update.bytes = fs.statSync(file).size;
                state.update.canceled = await window.webContents.executeJavaScript('window.soundmuncher.installUpdate()');
                if (updateInstallRequests.length) throw new Error('Cancel launched an installer.');
                updateConfirmation = 0;
                state.update.confirmed = await window.webContents.executeJavaScript('window.soundmuncher.installUpdate()');
              }
              Object.assign(state.update, { events: updateEvents, errors: updateErrors, installRequests: updateInstallRequests, prompts: updatePrompts });
            }
            if (${checkUpdateNotice}) {
              // A fresh isolated profile opens the setup walkthrough. Finish
              // that dialog before expecting the queued update notice to open.
              await window.webContents.executeJavaScript("document.getElementById('closeWalkthrough').click()");
              const version = (Number(app.getVersion().split('.')[0]) + 1) + '.0.0';
              const filename = 'FreqX-Setup-' + version + '.exe';
              const downloadedFile = path.join(directory, filename);
              const bytes = Buffer.from('Inert installer fixture. Never executed.');
              fs.writeFileSync(downloadedFile, bytes);
              const info = { version, downloadedFile, files: [{ url: filename, sha512: require('node:crypto').createHash('sha512').update(bytes).digest('base64') }] };
              noticeUpdater.emit('update-available', info);
              state.updateNotice = { version, available: await window.webContents.executeJavaScript(${JSON.stringify(noticeSnapshotSource('available'))}) };
              noticeUpdater.emit('download-progress', { percent: 37 });
              state.updateNotice.downloading = await window.webContents.executeJavaScript(${JSON.stringify(noticeSnapshotSource('downloading'))});
              noticeUpdater.emit('update-downloaded', info);
              state.updateNotice.downloaded = await window.webContents.executeJavaScript(${JSON.stringify(noticeSnapshotSource('downloaded'))});
              state.updateNotice.canceled = await window.webContents.executeJavaScript(${JSON.stringify(noticeActionSource(false))});
              if (updateInstallRequests.length) throw new Error('Cancel launched an installer.');
              updateConfirmation = 0;
              state.updateNotice.confirmed = await window.webContents.executeJavaScript(${JSON.stringify(noticeActionSource(true))});
              Object.assign(state.updateNotice, { errors: updateErrors, installRequests: updateInstallRequests, prompts: updatePrompts });
            }
            clearInterval(timer);
            await new Promise(resolve => setTimeout(resolve, 500));
            fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ ...state, failures, packaged: app.isPackaged, defaultApp: process.defaultApp === true, profile: app.getPath('userData'), hidden: !window.isVisible(), metadataHasBuild: !!require('./package.json').build }));
            app.quit();
          } catch (error) {
            failures.push(error.stack || error.message);
            clearInterval(timer);
            fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ failures }));
            app.quit();
          }
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
    assert.deepEqual(report.failures, []);
    assert.equal(report.defaultApp, Boolean(developmentScript));
    assert.equal(report.packaged && !report.defaultApp, !developmentScript);
    assert.equal(report.metadataHasBuild, Boolean(developmentScript));
    assert.equal(report.profile, path.join(directory, developmentScript ? 'freqx-dev' : 'profile'));
    assert.equal(report.bridge, 'function');
    assert.equal(report.silent, true);
    assert.equal(report.initialized, true);
    assert.equal(report.hidden, true);
    if (checkVoicePresets) {
      assert.deepEqual(report.voicePresets.options, ['Anime girl', 'Deep man', 'Robot', 'Helium', 'Monster', 'Radio']);
      assert.equal(report.voicePresets.mode, 'builtin');
      assert.equal(report.voicePresets.active, true);
      assert.equal(report.voicePresets.worklet, true);
      assert.equal(report.voiceEngineRequests, 0);
      console.log('PASS packaged presets appear and run through production main/preload/renderer without an AI engine.');
    }
    if (checkReplay) {
      assert.equal(report.replay.recording, true);
      assert.equal(report.replay.stopped, true);
      assert.equal(report.replay.nativeStarts, 0);
      assert.ok(report.replay.duration > .01 && report.replay.duration < report.replay.beforeTrim);
      assert.equal(report.replay.metadata.name, 'Replay smoke');
      assert.equal(report.replay.metadata.board, report.replay.board);
      assert.ok(report.replay.bytes > 44 + 480 * 4);
      console.log('PASS packaged Replay records the synthetic mix, trims and saves a valid WAV through production main/preload/renderer.');
    }
    if (checkUpdates) {
      assert.equal(report.update.status, 'downloaded', JSON.stringify(report.update));
      assert.equal(report.update.installVisible, true);
      assert.match(report.update.text, /verified.*restart/i);
      assert.ok(report.update.bytes > 0);
      assert.deepEqual(report.update.errors, []);
      assert.ok(report.update.events.includes('checking-for-update'));
      assert.ok(report.update.events.includes('update-available'));
      assert.ok(report.update.events.includes('update-downloaded'));
      assert.equal(report.update.canceled.ok, false);
      assert.equal(report.update.confirmed.ok, true);
      assert.deepEqual(report.update.installRequests, [[false, true]]);
      assert.deepEqual(report.update.prompts.map(prompt => prompt.response), [1, 0]);
      assert.ok(report.update.prompts.every(prompt => prompt.defaultId === 1 && prompt.cancelId === 1));
      console.log(`PASS automatic update ${report.update.currentVersion} -> ${report.update.latestVersion}: real download (${report.update.bytes} bytes), checksum and restart prompt. Installer execution intercepted.`);
    }
    if (checkUpdateNotice) {
      for (const phase of ['available', 'downloading', 'downloaded']) {
        assert.equal(report.updateNotice[phase].open, true);
        assert.ok(report.updateNotice[phase].title.includes(report.updateNotice.version));
      }
      assert.equal(report.updateNotice.available.disabled, true);
      assert.equal(report.updateNotice.downloading.percent, '37%');
      assert.equal(report.updateNotice.downloaded.action, 'Restart and install');
      assert.equal(report.updateNotice.downloaded.disabled, false);
      assert.equal(report.updateNotice.canceled.open, true);
      assert.equal(report.updateNotice.canceled.disabled, false);
      assert.equal(report.updateNotice.confirmed.disabled, true);
      assert.deepEqual(report.updateNotice.errors, []);
      assert.deepEqual(report.updateNotice.installRequests, [[false, true]]);
      assert.deepEqual(report.updateNotice.prompts.map(prompt => prompt.response), [1, 0]);
      console.log('PASS packaged update popup crosses production main/preload/renderer: available, progress, checksum verification, restart/cancel confirmation. Installer execution intercepted.');
    }
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
