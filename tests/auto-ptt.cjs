'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { AutoPttService, validKey, validTarget } = require('../runtime/auto-ptt.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const configuration = { enabled: true, key: 'KeyV', targetProcess: 'Game.exe' };
function fixture(t, options = {}) {
  const calls = [];
  const driver = Object.assign(new EventEmitter(), {
    start: async () => calls.push('start'), listApps: async () => [{ processName: 'Game.exe', title: 'Game' }],
    hold: async input => { calls.push(['down', input.key]); return { holding: true }; },
    release: async () => calls.push('up'), ping: () => calls.push('ping'), close: () => calls.push('close'),
  });
  const states = [], owner = { isDestroyed: () => false, send: (channel, state) => states.push(state) };
  const service = new AutoPttService({ driver, platform: 'win32', tuning: { leadMs: 0, tailMs: 10, leaseTimeoutMs: 3000 }, ...options });
  t.after(() => service.stop());
  return { service, driver, calls, owner, states, begin: id => service.begin(owner, { id, durationMs: 1000 }) };
}
test('off is idle and app listing is explicit; invalid configuration cannot inject input', async t => {
  const f = fixture(t);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.begin('off'), { ok: true, holding: false });
  assert.deepEqual(await f.service.listApps(), { apps: [{ processName: 'Game.exe', title: 'Game' }] });
  assert.deepEqual(f.calls, []);
  for (const key of ['ControlLeft', 'Enter', 'Alt+F4', 'Keya', 'Mouse1', 'F25', null]) {
    assert.equal(validKey(key), false);
    assert.equal((await f.service.configure(f.owner, { ...configuration, key })).ok, false);
  }
  for (const target of ['../game.exe', 'https://game.exe', 'game.exe\n', '.exe', '']) assert.equal(validTarget(target), false);
  assert.deepEqual(f.calls, []);
});
test('overlapping clips share one keydown and release after the final clip', async t => {
  const f = fixture(t); await f.service.configure(f.owner, configuration);
  assert.equal((await f.begin('first')).holding, true);
  assert.equal((await f.begin('second')).holding, true);
  assert.equal(f.calls.filter(call => Array.isArray(call)).length, 1);
  await f.service.end(f.owner, 'first'); await delay(25);
  assert.equal(f.calls.includes('up'), false);
  await f.service.end(f.owner, 'second'); await delay(25);
  assert.equal(f.calls.filter(call => call === 'up').length, 1);
  assert.equal(f.service.heartbeat, null);
});
test('Stop arriving during native key acquisition cancels the pending hold', async t => {
  const f = fixture(t); await f.service.configure(f.owner, configuration);
  let finish;
  f.driver.hold = () => new Promise(resolve => { finish = resolve; });
  const pending = f.begin('pending'); await tick();
  await f.service.end(f.owner, 'pending');
  finish({ holding: true });
  assert.deepEqual(await pending, { ok: true, holding: false });
  assert.equal(f.calls.filter(call => call === 'up').length, 1);
  assert.equal(f.service.leases.size, 0);
});
test('Stop during lead-in releases without waiting for clip playback', async t => {
  const f = fixture(t, { tuning: { leadMs: 60, tailMs: 0, leaseTimeoutMs: 3000 } });
  await f.service.configure(f.owner, configuration);
  const pending = f.begin('lead'); await tick();
  await f.service.releaseAll(f.owner);
  assert.equal(f.calls.at(-1), 'up');
  assert.equal((await pending).holding, false);
});
test('focus loss or manual takeover clears leases and never automatically re-presses', async t => {
  const f = fixture(t); await f.service.configure(f.owner, configuration); await f.begin('focus');
  f.driver.emit('state', { status: 'waiting', message: 'Focus changed.' });
  f.service.refresh(f.owner, ['focus']); await delay(25);
  assert.equal(f.service.leases.size, 0); assert.equal(f.service.heartbeat, null);
  assert.equal(f.calls.filter(call => Array.isArray(call)).length, 1);
  assert.equal(f.states.at(-1).status, 'waiting');
  await f.begin('next');
  assert.equal(f.calls.filter(call => Array.isArray(call)).length, 2);
});
test('wrong foreground skips acquisition and failed input releases outstanding state', async t => {
  const f = fixture(t); await f.service.configure(f.owner, configuration);
  f.driver.hold = async () => ({ holding: false });
  assert.equal((await f.begin('elsewhere')).holding, false);
  assert.equal(f.states.at(-1).status, 'waiting');
  f.driver.hold = async () => { throw new Error('Windows blocked input.'); };
  const failed = await f.begin('blocked');
  assert.equal(failed.ok, false); assert.match(failed.error, /Windows blocked/);
  assert.equal(f.service.leases.size, 0); assert.equal(f.service.pending.size, 0);
});

test('a blocked release closes the driver for native retry and retains an error state', async t => {
  const f = fixture(t); await f.service.configure(f.owner, configuration); await f.begin('blocked-up');
  f.driver.release = async () => { throw new Error('Windows blocked key release.'); };
  await f.service.releaseAll(f.owner);
  assert.equal(f.calls.at(-1), 'close');
  assert.equal(f.states.at(-1).status, 'error');
  assert.equal(f.service.held, false); assert.equal(f.service.heartbeat, null);
});

function nativeDriverFixture(t) {
  const { PassThrough } = require('node:stream');
  const children = [];
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 100 + children.length, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    children.push(child); return child;
  };
  const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, process,
    require: name => name === 'node:child_process' ? { spawn } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../runtime/auto-ptt.cjs'), 'utf8'), context);
  const driver = new context.module.exports.WindowsPttDriver('C:\\app');
  const exit = child => { child.exitCode = 0; child.emit('exit', 0); };
  t.after(() => { driver.close(); children.forEach(exit); });
  return { driver, children, exit, ready: child => child.stdout.write('{"type":"ready"}\n') };
}

test('closing during helper startup rejects its promise and ignores delayed output', async t => {
  const f = nativeDriverFixture(t), states = [];
  f.driver.on('state', state => states.push(state));
  const starting = assert.rejects(f.driver.start(), /closed/), child = f.children[0];
  f.driver.close(); f.ready(child);
  child.stdout.write('{"type":"state","status":"waiting"}\n');
  await starting; assert.equal(states.length, 0);
  await assert.rejects(f.driver.start(), /previous talk key/);
  f.exit(child);
  const restarted = f.driver.start(); f.ready(f.children[1]); await restarted;
  assert.equal(f.driver.child, f.children[1]);
});

test('a helper closed immediately after ready cannot receive a pending key command', async t => {
  const f = nativeDriverFixture(t);
  const command = assert.rejects(f.driver.hold(configuration), /closed/), child = f.children[0];
  f.ready(child); f.driver.close(); await command;
  assert.equal(child.stdin.readableLength, 0);
});

test('stdin failure retains a live helper until its pending native cleanup exits', async t => {
  const f = nativeDriverFixture(t);
  const starting = f.driver.start(), child = f.children[0]; f.ready(child); await starting;
  child.stdin.emit('error', new Error('Broken parent pipe.'));
  assert.equal(f.driver.child, null); assert.equal(f.driver.closingChild, child);
  await assert.rejects(f.driver.start(), /previous talk key/);
  f.exit(child); assert.equal(f.driver.closingChild, null);
});
test('renderer heartbeat expiry releases a held key even without an ended event', async t => {
  let time = 0;
  const f = fixture(t, { now: () => time }); await f.service.configure(f.owner, configuration); await f.begin('stale');
  time = 4000; await delay(550);
  assert.equal(f.calls.filter(call => call === 'up').length, 1);
  assert.equal(f.service.heartbeat, null);
});
test('disable releases active input; another sender cannot end or renew its leases', async t => {
  const f = fixture(t); await f.service.configure(f.owner, configuration); await f.begin('owned');
  const foreign = { isDestroyed: () => false, send() {} };
  assert.equal((await f.service.begin(foreign, { id: 'foreign', durationMs: 100 })).holding, false);
  await f.service.end(foreign, 'owned'); await f.service.releaseAll(foreign);
  assert.equal(f.calls.includes('up'), false);
  await f.service.configure(f.owner, { ...configuration, enabled: false });
  assert.ok(f.calls.indexOf('up') < f.calls.indexOf('close'));
  assert.equal(f.states.at(-1).status, 'off');
});
test('new clip during release padding keeps the key held without a second keydown', async t => {
  const f = fixture(t, { tuning: { leadMs: 0, tailMs: 50, leaseTimeoutMs: 3000 } });
  await f.service.configure(f.owner, configuration); await f.begin('one'); await f.service.end(f.owner, 'one');
  await f.begin('two'); await delay(70);
  assert.equal(f.calls.includes('up'), false);
  assert.equal(f.calls.filter(call => Array.isArray(call)).length, 1);
});
test('PTT IPC is restricted to the main soundboard frame including release and heartbeat', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handlers = new Map(), listeners = new Map(), calls = [];
  const owner = { mainFrame: { url: 'file:///app/index.html' } };
  const context = vm.createContext({ mainWindow: { webContents: owner },
    assertTrustedIpcSender: event => { if (!event.senderFrame?.url?.startsWith('file:///app/')) throw new Error('untrusted'); },
    stripUrlState: value => value, getRendererUrl: () => 'file:///app/index.html',
    autoPttService: Object.fromEntries(['listApps','configure','begin','end','refresh','releaseAll'].map(name => [name, () => calls.push(name)])),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
  });
  vm.runInContext(source.slice(source.indexOf('function assertAutoPttSender('), source.indexOf('function registerAudioIpc(')), context);
  vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('auto-ptt:apps'"), source.indexOf('  const referenceSender =')), context);
  for (const event of [
    { sender: owner, senderFrame: { url: 'file:///app/index.html' } },
    { sender: { mainFrame: owner.mainFrame }, senderFrame: owner.mainFrame },
    { sender: owner, senderFrame: { url: 'https://example.com' } },
  ]) {
    for (const handler of handlers.values()) assert.throws(() => handler(event), /Blocked|untrusted/);
    for (const handler of listeners.values()) handler(event);
  }
  assert.deepEqual(calls, []);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  for (const handler of handlers.values()) handler(event);
  for (const handler of listeners.values()) handler(event);
  assert.equal(calls.length, 6);
});
