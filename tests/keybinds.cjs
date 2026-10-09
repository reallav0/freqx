'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production section: ${start}`);
  return source.slice(from, to);
}
const keys = { Numpad1: 0x004f, NumpadEnd: 0xee4f, Numpad2: 0x0050, NumpadArrowDown: 0xee50,
  End: 0x0e4f, F8: 0x0042 };
function registrationFixture({ loadFailure = false, startFailure = false, occupied = [] } = {}) {
  const calls = { loads: 0, starts: 0, stops: 0, registered: [], triggered: [], warnings: [] };
  const hook = Object.assign(new EventEmitter(), {
    start() { calls.starts++; if (startFailure) throw new Error('native start failed'); },
    stop() { calls.stops++; }
  });
  const handlers = new Map();
  const global = new Map();
  const context = vm.createContext({
    keyHook: null, keyHookLoadAttempted: false, enableNativeKeyHook: false,
    globalKeybindRegistrations: [], process: { platform: 'win32' },
    console: { warn: (...args) => calls.warnings.push(args) },
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false,
      send: (channel, payload) => calls.triggered.push({ channel, ...JSON.parse(JSON.stringify(payload)) }) } },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    assertTrustedIpcSender(event) { if (!event.trusted) throw new Error('untrusted renderer'); },
    globalShortcut: {
      unregister: accelerator => global.delete(accelerator),
      register(accelerator, callback) { calls.registered.push(accelerator); if (occupied.includes(accelerator)) return false; global.set(accelerator, callback); return true; }
    },
    require(name) {
      assert.equal(name, 'uiohook-napi'); calls.loads++;
      if (loadFailure) throw new Error('native module missing');
      return { uIOhook: hook, UiohookKey: keys };
    }
  });
  vm.runInContext(section(main, 'function loadNativeKeyHook(', 'function configureDevelopmentStoragePaths('), context);
  vm.runInContext(section(main, 'function emitGlobalKeyCode(', 'function configurePermissions('), context);
  vm.runInContext(section(main, '  ipcMain.handle("keybinds:register-global"', '  ipcMain.handle("app-settings:get"'), context);
  return { calls, hook, global, context, register: entries => JSON.parse(JSON.stringify(handlers.get('keybinds:register-global')({ trusted: true }, entries))) };
}
const binding = (code, modifiers = {}) => ({ code, modifiers,
  preferGlobalShortcut: Object.values(modifiers).some(Boolean), accelerators: [code === 'Numpad1' ? 'num1' : code === 'Numpad2' ? 'num2' : code] });
function press(hook, keycode, modifiers = {}) { hook.emit('keydown', { keycode, ...modifiers }); }
function release(hook, keycode) { hook.emit('keyup', { keycode }); }

test('ordinary bindings stay on Electron; keypad bindings lazily load and reuse the native hook', () => {
  const fixture = registrationFixture();
  fixture.register([binding('F8')]);
  assert.equal(fixture.calls.loads, 0); assert.equal(fixture.calls.starts, 0);
  const result = fixture.register([binding('Numpad1'), binding('F8')]);
  assert.deepEqual(result.native, ['Numpad1']);
  assert.deepEqual(result.globalShortcut, [{ code: 'F8', accelerator: 'F8' }]);
  assert.equal(fixture.calls.loads, 1); assert.equal(fixture.calls.starts, 1);
  fixture.register([binding('F8'), binding('Numpad1')]);
  assert.equal(fixture.calls.loads, 1); assert.equal(fixture.calls.starts, 1);
  assert.equal(fixture.hook.listenerCount('keydown'), 1);
  assert.equal(fixture.register([binding('F8')]).mode, 'globalShortcut'); assert.equal(fixture.calls.stops, 1);
  press(fixture.hook, keys.Numpad1); assert.equal(fixture.calls.triggered.length, 0);
  fixture.register([binding('Numpad1')]); assert.equal(fixture.calls.starts, 2);
});

test('both Num Lock keypad forms trigger once per press, while the separate End key never triggers', () => {
  const fixture = registrationFixture(); fixture.register([binding('Numpad1')]);
  for (const keycode of [keys.Numpad1, keys.NumpadEnd]) {
    const before = fixture.calls.triggered.length;
    press(fixture.hook, keycode); press(fixture.hook, keycode); press(fixture.hook, keycode);
    assert.equal(fixture.calls.triggered.length, before + 1, 'held key repeats are suppressed');
    release(fixture.hook, keycode); press(fixture.hook, keycode); release(fixture.hook, keycode);
    assert.equal(fixture.calls.triggered.length, before + 2, 'release permits the next press');
  }
  press(fixture.hook, keys.End); release(fixture.hook, keys.End);
  assert.equal(fixture.calls.triggered.length, 4);
  assert.ok(fixture.calls.triggered.every(event => event.code === 'Numpad1'));
});

test('keypad chords use physical aliases and preserve actual native modifier state', () => {
  const fixture = registrationFixture();
  const result = fixture.register([binding('Numpad1', { ctrl: true, shift: true })]);
  assert.deepEqual(result.native, ['Numpad1']); assert.equal(fixture.calls.registered.length, 0);
  press(fixture.hook, keys.NumpadEnd, { ctrlKey: true, shiftKey: true, altKey: false, metaKey: true });
  assert.deepEqual(fixture.calls.triggered[0].modifiers, { ctrl: true, shift: true, alt: false, meta: true });
});

test('rebinding removes the old physical keypad watch and keeps one listener', () => {
  const fixture = registrationFixture(); fixture.register([binding('Numpad1')]);
  fixture.register([binding('Numpad2')]);
  press(fixture.hook, keys.NumpadEnd); release(fixture.hook, keys.NumpadEnd);
  press(fixture.hook, keys.NumpadArrowDown); release(fixture.hook, keys.NumpadArrowDown);
  assert.deepEqual(fixture.calls.triggered.map(event => event.code), ['Numpad2']);
  assert.equal(fixture.hook.listenerCount('keydown'), 1);
});

test('native load and start failures fall back without rejecting other registrations or claiming End', () => {
  for (const options of [{ loadFailure: true }, { startFailure: true }]) {
    const fixture = registrationFixture(options);
    const result = fixture.register([binding('Numpad1'), binding('F8')]);
    assert.deepEqual(result.failed, []); assert.deepEqual(result.native, []);
    assert.deepEqual(fixture.calls.registered, ['num1', 'F8']);
    fixture.register([binding('Numpad1')]); assert.equal(fixture.calls.loads, 1);
    if (options.startFailure) assert.equal(fixture.calls.starts, 1, 'a failed hook is not retried for every registration');
  }
  const unavailable = registrationFixture({ loadFailure: true, occupied: ['num1'] });
  assert.deepEqual(unavailable.register([binding('Numpad1')]).failed, [{ code: 'Numpad1', accelerators: ['num1'] }]);
  assert.ok(!unavailable.calls.registered.includes('End'));
});

function rendererFixture() {
  const calls = { plays: [], stops: 0, saved: 0, registered: [] };
  let globalListener;
  const context = vm.createContext({
    importedKeybinds: {}, importedLibraryItems: [{ path: 'sound' }], keybindCapturePath: '', stopKeybindId: 'stop',
    document: { activeElement: { tagName: 'BODY' }, hasFocus: () => context.focused }, focused: false,
    playImportedSound: item => calls.plays.push(item.path), stopAllSounds: () => calls.stops++,
    saveKeybinds: () => calls.saved++, getKeybindLabel: value => value.code,
    renderImportedLibrary() {}, renderStopKeybindButton() {}, setLibraryState() {},
    window: { soundmuncher: {
      registerGlobalKeybinds: async entries => { calls.registered.push(JSON.parse(JSON.stringify(entries))); return { failed: [] }; },
      onGlobalKeybindTriggered: listener => { globalListener = listener; }
    } }
  });
  vm.runInContext(section(renderer, 'function keyCodeToAcceleratorParts(', 'function loadKeybinds('), context);
  vm.runInContext(section(renderer, 'function beginKeybindCapture(', 'function renderStopKeybindButton('), context);
  vm.runInContext(section(renderer, 'function isTextEditingElement(', 'async function setMicCaptureEnabled('), context);
  vm.runInContext(section(renderer, 'window.soundmuncher?.onGlobalKeybindTriggered', 'window.soundmuncher?.onExternalImportStarted'), context);
  const event = (code = 'Numpad1', values = {}) => ({ code, repeat: false, ctrlKey: false,
    shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, ...values });
  return { calls, context, event, global: payload => globalListener(payload) };
}

test('keypad play and Stop route globally while local focus, repeats, and capture stay distinct', () => {
  const fixture = rendererFixture(); const { context, calls } = fixture;
  context.importedKeybinds = { stop: { code: 'Numpad1' }, sound: { code: 'Numpad1', modifiers: { ctrl: true } } };
  fixture.global({ code: 'Numpad1', modifiers: {} }); assert.equal(calls.stops, 1);
  fixture.global({ code: 'Numpad1', modifiers: { ctrl: true } }); assert.deepEqual(calls.plays, ['sound']);
  fixture.global({ code: 'End', modifiers: {} }); assert.equal(calls.stops, 1);
  context.focused = true;
  fixture.global({ code: 'Numpad1', modifiers: {} }); assert.equal(calls.stops, 1, 'native focused IPC must not duplicate DOM playback');
  context.handleKeybindKeydown(fixture.event()); assert.equal(calls.stops, 2);
  context.handleKeybindKeydown(fixture.event('Numpad1', { repeat: true })); assert.equal(calls.stops, 2);
  context.beginKeybindCapture('sound');
  context.handleKeybindKeydown(fixture.event('ControlLeft', { ctrlKey: true })); assert.equal(context.keybindCapturePath, 'sound');
  context.handleKeybindKeydown(fixture.event('Numpad1', { ctrlKey: true, shiftKey: true }));
  assert.equal(context.keybindCapturePath, '');
  assert.deepEqual(JSON.parse(JSON.stringify(context.importedKeybinds.sound)), { code: 'Numpad1', modifiers: { ctrl: true, shift: true, alt: false, meta: false }, label: 'Numpad1' });
  assert.deepEqual(calls.registered.at(-1).find(entry => entry.modifiers.ctrl).accelerators, ['Ctrl+Shift+num1']);
  assert.equal(calls.saved, 1);
});
