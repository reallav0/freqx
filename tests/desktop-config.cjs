'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { config, validateConfig } = require('../runtime/desktop-config.cjs');
const root = path.resolve(__dirname, '..');
const clone = () => structuredClone(config);

test('canonical config uses natural voice tuning and preserves shared desktop defaults', () => {
  assert.deepEqual(config.audio.voiceModes, { standard: { attenuationDb: 20, postFilterBeta: 0 }, strong: { attenuationDb: 20, postFilterBeta: 0 } });
  assert.deepEqual(config.audio.limiter, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.08 });
  assert.deepEqual(config.audio.micCompressor, { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.1 });
  assert.deepEqual(config.audio.equalizer, {
    highPass: { frequency: 20, Q: 0.7 }, notch: { frequency: 20, Q: 8 },
    mudCut: { frequency: 240, Q: 1.1, gain: 0 }, presence: { frequency: 3200, Q: 1, gain: 0 },
    air: { frequency: 8500, gain: 0 }, lowPass: { frequency: 24000, Q: 0.7 }
  });
  assert.deepEqual(config.audio.mixCompressor, { threshold: -3, knee: 6, ratio: 1.3, attack: 0.002, release: 0.06 });
  assert.deepEqual(config.app.window, { width: 1200, height: 760, minWidth: 900, minHeight: 620, backgroundColor: '#111111' });
  assert.deepEqual(config.app.preferences, { launchOnStartup: true, startHidden: false, keepRunningInTray: true });
  assert.equal(config.network.apiBaseUrl, 'https://api.freqx.app');
  assert.equal(config.auth.requestTimeoutMs, 10000);
  assert.equal(config.audio.aec.captureDelaySamples, 1440);
  assert.equal(config.audio.reference.targetSeconds, 0.015);
  assert.equal(config.audio.bufferCacheBytes, 256 * 1024 * 1024);
  assert.equal(config.updater.startupDelayMs, 5000);
  const { planRestart } = require('../runtime/recovery-policy.cjs');
  assert.deepEqual([0, 1, 2].map(index => planRestart({ version: 1, restarts: Array(index).fill(1000) }, 2000).delayMs), [1000, 2000, 4000]);
  assert.equal(planRestart({ version: 1, restarts: [1000, 1100, 1200] }, 2000).allowed, false);
});

test('configuration is deeply frozen and has no user-data override', () => {
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.audio.voiceModes.strong));
  assert.ok(Object.isFrozen(config.network.allowedAudioHosts));
  assert.throws(() => { config.audio.voiceModes.strong.attenuationDb = 999; }, TypeError);
  assert.throws(() => config.network.allowedAudioHosts.push('localhost'), TypeError);
  const browser = fs.readFileSync(path.join(root, 'runtime/desktop-config.js'), 'utf8');
  assert.ok(!/localStorage|sessionStorage|ipcRenderer|userData/.test(browser));
});

test('malformed keys, types, ranges and unsafe endpoint tuning fail closed', () => {
  const invalid = [
    value => { value.version = 2; }, value => { delete value.audio; }, value => { value.audio.userOverrides = {}; },
    value => { value.audio.voiceModes.strong.attenuationDb = Infinity; }, value => { value.audio.voiceModes.standard.postFilterBeta = -1; },
    value => { value.audio.limiter.ratio = 21; }, value => { value.audio.micCompressor.attack = 2; },
    value => { value.audio.testTone.gain = 0; },
    value => { value.audio.reference.targetSeconds = value.audio.reference.capacitySeconds; },
    value => { value.audio.aec.queueSamples = 1500; }, value => { value.audio.analysers.frequency.fftSize = 4095; },
    value => { value.auth.requestTimeoutMs = 0; }, value => { value.auth.favoritesBatchSize = 101; },
    value => { value.network.apiBaseUrl = 'http://api.freqx.app'; }, value => { value.network.apiBaseUrl = 'https://user:password@api.freqx.app'; },
    value => { value.network.allowedAudioHosts = ['audio.freqx.app/path']; }, value => { value.catalog.catalogFile = '../credentials.json'; },
    value => { value.catalog.catalogUrl = 'https://untrusted.example/catalog.json'; },
    value => { value.ui.preferences.uiTheme = 'unknown'; }, value => { value.recovery.maxRestarts = 11; }
  ];
  for (const mutate of invalid) { const value = clone(); mutate(value); assert.throws(() => validateConfig(value), /Invalid desktop configuration/); }
  const enabledFeatures = clone(); enabledFeatures.app.disabledFeatures = [];
  assert.deepEqual(validateConfig(enabledFeatures).app.disabledFeatures, []);
});

test('worklet applies custom developer strengths to the real native engine', () => {
  const custom = clone();
  custom.audio.voiceModes.standard = { attenuationDb: 25, postFilterBeta: 0.04 };
  custom.audio.voiceModes.strong = { attenuationDb: 55, postFilterBeta: 0.5 };
  validateConfig(custom);
  const messages = [], calls = [];
  const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(root, 'audio/vendor/deepfilter/dfn3.wasm')));
  const weights = fs.readFileSync(path.join(root, 'audio/vendor/deepfilter/dfn3_weights.bin'));
  let Processor;
  const sandbox = { sampleRate: 48000, ArrayBuffer, Uint8Array, Float32Array, DataView,
    FreqxConfigSchema: require('../runtime/config-schema.js'),
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor: (_, value) => { Processor = value; },
    WebAssembly: { Module: WebAssembly.Module, Instance: class {
      constructor(module, imports) {
        const native = new WebAssembly.Instance(module, imports).exports;
        return { exports: { ...native,
          dfn3_wasm_set_atten_lim: value => { calls.push(['attenuationDb', value]); native.dfn3_wasm_set_atten_lim(value); },
          dfn3_wasm_set_post_filter_beta: value => { calls.push(['postFilterBeta', value]); native.dfn3_wasm_set_post_filter_beta(value); }
        } };
      }
    } }
  };
  const source = fs.readFileSync(path.join(root, 'audio/voice-isolation-worklet.mjs'), 'utf8').replace("import '../runtime/config-schema.js';", '');
  vm.runInNewContext(source, sandbox);
  const processor = new Processor({ processorOptions: { wasmModule, modelBytes: new Uint8Array(weights), mode: 'standard', tuning: { voiceModes: custom.audio.voiceModes } } });
  try {
    const ready = messages.find(message => message.type === 'ready');
    assert.ok(ready, JSON.stringify(messages));
    assert.equal(ready.attenuationDb, 25);
    assert.equal(ready.postFilterBeta, 0.04);
    processor.port.onmessage({ data: { type: 'mode', mode: 'strong' } });
    assert.deepEqual(calls, [['attenuationDb', 25], ['postFilterBeta', 0.04], ['attenuationDb', 55], ['postFilterBeta', 0.5]]);
    assert.equal(messages.at(-1).attenuationDb, 55);
  } finally { processor.destroy(); }
});

test('browser without preload reads the actual canonical JSON and validates before readiness', async () => {
  const requested = [];
  const browser = { URL, console, document: { currentScript: { src: pathToFileURL(path.join(root, 'runtime/desktop-config.js')).href } },
    fetch: async url => { requested.push(url.href); return { ok: true, json: async () => JSON.parse(fs.readFileSync(url, 'utf8')) }; }
  };
  browser.window = browser;
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime/config-schema.js'), 'utf8'), browser);
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime/desktop-config.js'), 'utf8'), browser);
  const loaded = await browser.FreqxDesktopConfig.ready;
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), config);
  assert.deepEqual(requested, [pathToFileURL(path.join(root, 'runtime/desktop-config.json')).href]);
  assert.ok(Object.isFrozen(loaded.audio.voiceModes.standard));
  assert.equal(browser.FreqxDesktopConfig.current, loaded);
});

test('invalid browser configuration rejects readiness and remains unavailable', async () => {
  const value = clone(); value.audio.voiceModes.standard.postFilterBeta = 2;
  const browser = { URL, document: { currentScript: { src: 'file:///runtime/desktop-config.js' } }, fetch: async () => ({ ok: true, json: async () => value }) };
  browser.window = browser;
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime/config-schema.js'), 'utf8'), browser);
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime/desktop-config.js'), 'utf8'), browser);
  await assert.rejects(browser.FreqxDesktopConfig.ready, /Invalid desktop configuration/);
  assert.equal(browser.FreqxDesktopConfig.current, undefined);
});
