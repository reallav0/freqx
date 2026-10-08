'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
async function processorFixture(options = {}) {
  const native = await import(pathToFileURL(path.join(root, 'audio/denoiser-engines.mjs')).href);
  const { MicCompressor } = await import(pathToFileURL(path.join(root, 'audio/mic-dynamics.mjs')).href);
  const messages = [];
  let Processor;
  const sandbox = {
    sampleRate: 48000, performance: options.clock || performance,
    Float32Array: options.Float32Array || Float32Array,
    FRAME_SIZE: native.FRAME_SIZE, MicCompressor,
    createLightEngine: options.createLightEngine || native.createLightEngine,
    createHighQualityEngine: options.createHighQualityEngine || native.createHighQualityEngine,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => messages.push(structuredClone(m)), close() {} }; } },
    registerProcessor: (_, implementation) => { Processor = implementation; }
  };
  const source = fs.readFileSync(path.join(root, 'audio/voice-isolation-worklet.mjs'), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, sandbox, { filename: 'voice-isolation-worklet.mjs' });
  const mode = options.mode || 'light';
  const compile = name => new WebAssembly.Module(fs.readFileSync(path.join(root, name)));
  const processor = new Processor({ processorOptions: {
    mode, strength: options.strength ?? .85, realtime: options.realtime ?? false,
    compressor: options.compressor ?? false,
    lightWasmModule: options.createLightEngine ? {} : compile('audio/vendor/rnnoise/rnnoise.wasm'),
    wasmModule: mode === 'high-quality' ? options.createHighQualityEngine ? {} : compile('audio/vendor/deepfilter/df_bg.wasm') : undefined,
    tuning: { voiceModes: { 'high-quality': { attenuationDb: 35, postFilterBeta: 0 } } }
  } });
  const error = messages.find(m => m.type === 'error');
  if (error) throw new Error(error.message);
  return { processor, messages };
}
module.exports = { processorFixture };
