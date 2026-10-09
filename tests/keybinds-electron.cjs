'use strict';
// Windows-only physical-input regression. Uses controlled windows and an
// isolated profile; no audio devices are opened or existing Freqx processes stopped.
// node tests/keybinds-electron.cjs [--app-root PATH_TO_APP_ASAR]
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 120000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else if (process.type === 'renderer') {
  const { ipcRenderer } = require('electron');
  window.soundmuncher = {
    registerGlobalKeybinds: entries => ipcRenderer.invoke('keybinds:register-global', entries).then(result => { window.__registration = result; return result; }),
    onGlobalKeybindTriggered: listener => ipcRenderer.on('keybinds:trigger', (_, payload) => {
      window.__keyTest?.global.push(payload); listener(payload);
    }),
  };
} else {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
}
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing production section: ${start}`);
  return source.slice(from, to);
}
async function run() {
  const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
  if (process.platform !== 'win32') { console.log('SKIP physical Windows keypad regression'); app.exit(0); return; }
  const output = path.join(root, 'output', 'keybinds-electron');
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'run-'));
  app.setPath('userData', path.join(directory, 'profile'));
  app.setPath('sessionData', path.join(directory, 'session'));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const argument = process.argv.indexOf('--app-root');
  const appRoot = argument < 0 ? root : path.resolve(process.argv[argument + 1]);
  const main = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(appRoot, 'renderer.js'), 'utf8');
  const checks = [];
  let win, other, context;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  function check(name, pass, detail) {
    checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!pass) throw new Error(name);
  }
  async function until(source, name) {
    const deadline = Date.now() + 3000;
    while (!(await evaluate(source))) { if (Date.now() > deadline) throw new Error(`Timed out: ${name}`); await pause(20); }
  }
  async function inject({ numLock = 'off', extended = false, ctrl = false, shift = false, repeats = 1, scan = 79, target = other } = {}) {
    target.show(); target.focus(); target.webContents.focus();
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers', 'windows-keyboard.ps1'),
      '-ScanCode', String(scan), '-NumLock', numLock, '-RepeatDown', String(repeats),
      '-WindowHandle', String(target.getNativeWindowHandle().readBigUInt64LE())];
    if (extended) args.push('-Extended'); if (ctrl) args.push('-Control'); if (shift) args.push('-Shift');
    const stdout = await new Promise((resolve, reject) => require('node:child_process').execFile('powershell.exe', args,
      { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => error || stderr.trim() ? reject(error || new Error(stderr)) : resolve(stdout)));
    const input = JSON.parse(stdout);
    check('input targets the controlled window and restores Num Lock', input.foreground === Number(target.getNativeWindowHandle().readBigUInt64LE())
      && input.numLock === (numLock === 'on') && input.restoredNumLock === input.initialNumLock, input);
    await pause(80);
  }
  const state = () => evaluate('JSON.parse(JSON.stringify(__keyTest))');
  try {
    await app.whenReady();
    const html = path.join(directory, 'keybinds.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="UTF-8"><title>Controlled keypad regression</title><h2>Controlled Freqx keypad regression</h2><p>Native Windows keyboard test; no audio is played.</p><input id="text"><button id="bodyFocus">Keyboard target</button>');
    win = new BrowserWindow({ show: true, width: 540, height: 240, title: 'Controlled Freqx keypad regression', alwaysOnTop: true,
      webPreferences: { preload: __filename, sandbox: false, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
    other = new BrowserWindow({ show: false, width: 540, height: 240, title: 'Controlled other foreground window', alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(html); await other.loadURL('data:text/html,<h2>Controlled other foreground window</h2><input autofocus>');
    context = require('node:vm').createContext({ keyHook: null, keyHookLoadAttempted: false, enableNativeKeyHook: false,
      globalKeybindRegistrations: [], process, console, mainWindow: win, BrowserWindow, globalShortcut, ipcMain,
      assertTrustedIpcSender(event) { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted keypad test IPC'); },
      require(name) { if (name !== 'uiohook-napi') throw new Error(`Unexpected module ${name}`); return require(path.join(appRoot, 'node_modules', name)); }
    });
    require('node:vm').runInContext(section(main, 'function loadNativeKeyHook(', 'function configureDevelopmentStoragePaths('), context);
    require('node:vm').runInContext(section(main, 'function emitGlobalKeyCode(', 'function configurePermissions('), context);
    require('node:vm').runInContext(section(main, '  ipcMain.handle("keybinds:register-global"', '  ipcMain.handle("app-settings:get"'), context);
    await evaluate(`window.__keyTest={plays:[],stops:0,global:[],local:[],notices:[]};
      var importedKeybinds={},importedLibraryItems=[{path:'sample'}],keybindCapturePath='',stopKeybindId='stop';
      function playImportedSound(item){__keyTest.plays.push(item.path)}
      function stopAllSounds(){__keyTest.stops++}
      function saveKeybinds(){localStorage.setItem('soundmuncher:keybinds',JSON.stringify(importedKeybinds))}
      function renderImportedLibrary(){} function renderStopKeybindButton(){}
      function setLibraryState(value){__keyTest.notices.push(value)}
      ${section(renderer, 'function keyCodeToAcceleratorParts(', 'function loadKeybinds(')}
      ${section(renderer, 'function getKeyLabelFromCode(', 'function beginKeybindCapture(')}
      ${section(renderer, 'function beginKeybindCapture(', 'function renderStopKeybindButton(')}
      ${section(renderer, 'function isTextEditingElement(', 'async function setMicCaptureEnabled(')}
      ${section(renderer, 'window.soundmuncher?.onGlobalKeybindTriggered', 'window.soundmuncher?.onExternalImportStarted')}
      window.addEventListener('keydown',event=>{__keyTest.local.push({code:event.code,ctrl:event.ctrlKey,shift:event.shiftKey,repeat:event.repeat});handleKeybindKeydown(event)});
      importedKeybinds={stop:{code:'Numpad1'},sample:{code:'Numpad1',modifiers:{ctrl:true}}};syncGlobalKeybinds();
      document.getElementById('bodyFocus').focus();`);
    await until('__registration?.native.length === 2', 'native registration');
    check('NumPad1 plain and chord bindings use the native physical aliases', await evaluate('__registration.mode === "uiohook" && __registration.globalShortcut.length === 0 && __registration.failed.length === 0'), await evaluate('__registration'));
    await inject({ numLock: 'on' });
    check('NumPad1 Stop works outside Freqx with Num Lock on', (await state()).stops === 1 && !(await evaluate('document.hasFocus()')), await state());
    await inject({ numLock: 'off' });
    check('NumPad1 Stop works outside Freqx with Num Lock off', (await state()).stops === 2, await state());
    await inject({ extended: true });
    check('separate navigation End never triggers keypad Stop or play', (await state()).stops === 2 && (await state()).plays.length === 0, await state());
    await inject({ ctrl: true });
    check('Ctrl plus keypad NumLock-off plays its distinct binding', (await state()).plays.length === 1 && (await state()).stops === 2, await state());
    win.hide();
    await inject({ numLock: 'on' }); await inject({ numLock: 'off' });
    check('hidden Freqx still receives keypad Stop in both Num Lock states', !win.isVisible() && (await state()).stops === 4, await state());
    await inject({ repeats: 3 });
    check('held keypad down repeats trigger Stop only once', (await state()).stops === 5, await state());
    await inject(); check('key release permits a new Stop press', (await state()).stops === 6, await state());
    win.show(); await evaluate('document.getElementById("bodyFocus").focus()');
    await inject({ target: win });
    check('focused keypad uses the DOM once without duplicating native IPC', (await state()).stops === 7 && (await evaluate('document.hasFocus()')) && (await state()).local.some(event => event.code === 'Numpad1'), await state());
    await evaluate('beginKeybindCapture("sample")');
    await inject({ target: win, ctrl: true, shift: true });
    check('focused capture stores keypad code and both modifiers without playing', await evaluate('keybindCapturePath === "" && importedKeybinds.sample.code === "Numpad1" && importedKeybinds.sample.modifiers.ctrl && importedKeybinds.sample.modifiers.shift && JSON.parse(localStorage.getItem("soundmuncher:keybinds")).sample.modifiers.shift') && (await state()).plays.length === 1, await state());
    await evaluate('assignKeybind("stop",{code:"Numpad2"})'); await pause(100);
    await inject(); check('rebound Stop ignores old NumPad1 key', (await state()).stops === 7, await state());
    await inject({ scan: 80 }); check('rebound Stop uses physical NumPad2 alias outside Freqx', (await state()).stops === 8, await state());
    await evaluate('importedKeybinds={};syncGlobalKeybinds()'); await until('__registration?.native.length === 0', 'clear native registration');
    check('clearing keypad bindings returns diagnostics to Electron mode', await evaluate('__registration.mode === "globalShortcut"'));
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ appRoot, checks, passed: true }, null, 2));
    console.log(`Passed ${checks.length} physical keypad checks. Results: ${path.join(directory, 'results.json')}`);
  } catch (error) {
    const current = win && !win.isDestroyed() ? await state().catch(() => null) : null;
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ appRoot, checks, passed: false, error: error.message, state: current }, null, 2));
    throw error;
  } finally {
    context?.keyHook?.stop(); globalShortcut.unregisterAll();
    if (win && !win.isDestroyed()) win.destroy(); if (other && !other.isDestroyed()) other.destroy();
  }
  app.exit(0);
}
