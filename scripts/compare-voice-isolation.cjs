'use strict';
// Run the same frame adapter, blend and gate offline. No capture/network/audio output.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { processorFixture } = require('./lib/voice-worklet.cjs');
const { config } = require('../runtime/desktop-config.cjs');
function readWav(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a RIFF/WAVE file.');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), begin = offset + 8;
    if (begin + size > bytes.length) throw new Error('Truncated WAV chunk.');
    const id = bytes.toString('ascii', offset, offset + 4);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format.');
      let type = bytes.readUInt16LE(begin);
      if (type === 65534 && size >= 40) type = bytes.readUInt16LE(begin + 24);
      format = { type, channels: bytes.readUInt16LE(begin + 2), rate: bytes.readUInt32LE(begin + 4), stride: bytes.readUInt16LE(begin + 12), bits: bytes.readUInt16LE(begin + 14) };
    } else if (id === 'data') data = bytes.subarray(begin, begin + size);
    offset = begin + size + (size & 1);
  }
  if (!format || !data) throw new Error('Missing WAV format/data chunk.');
  const { type, channels, rate, bits, stride } = format;
  if (![1, 3].includes(type) || ![16, 24, 32].includes(bits) || (type === 3 && bits !== 32) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000 || stride !== channels * bits / 8 || data.length % stride) throw new Error('Use PCM16/24/32 or float32 WAV, 8–192 kHz, 1–8 channels.');
  const mono = new Float32Array(data.length / stride);
  for (let i = 0; i < mono.length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const offset = i * stride + ch * bits / 8;
      const value = type === 3 ? data.readFloatLE(offset) : bits === 16 ? data.readInt16LE(offset) / 32768 : bits === 24 ? data.readIntLE(offset, 3) / 8388608 : data.readInt32LE(offset) / 2147483648;
      if (!Number.isFinite(value)) throw new Error('WAV contains non-finite samples.');
      mono[i] += value / channels;
    }
  }
  if (rate === 48000) return mono;
  // Use 48 kHz input for critical listening; live capture uses Chromium's resampler.
  const result = new Float32Array(Math.round(mono.length * 48000 / rate));
  for (let i = 0; i < result.length; i++) {
    const position = i * rate / 48000, index = Math.floor(position), fraction = position - index;
    result[i] = mono[index] * (1 - fraction) + mono[Math.min(index + 1, mono.length - 1)] * fraction;
  }
  return result;
}
function writeWav(file, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), 44 + i * 2);
  fs.writeFileSync(file, bytes);
}
function highPass(samples) {
  const result = new Float32Array(samples.length);
  const filter = config.audio.equalizer.highPass;
  // Web Audio interprets Q in dB for low/high-pass filters (unlike peaking EQ).
  const omega = 2 * Math.PI * filter.frequency / 48000, cosine = Math.cos(omega), alpha = Math.sin(omega) / (2 * 10 ** (filter.Q / 20)), a0 = 1 + alpha;
  const b0 = (1 + cosine) / (2 * a0), b1 = -(1 + cosine) / a0, b2 = b0, a1 = -2 * cosine / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    result[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return result;
}
async function compare(file, strength = .85) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Strength must be between 0 and 1.');
  const original = readWav(file), mic = highPass(original);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freqx-voice-'));
  writeWav(path.join(directory, 'input.wav'), original);
  const { MicCompressor } = await import('../audio/mic-dynamics.mjs');
  const offCompressor = new MicCompressor(config.audio.micCompressor);
  writeWav(path.join(directory, 'off.wav'), mic.map(value => offCompressor.process(value)));
  const summary = { input: path.resolve(file), sampleRate: 48000, strength, outputs: [], note: '80 Hz HPF and exact live worklet (blend/gate/compressor), before the mixer. Off uses the same zero-lookahead compressor for a fair level comparison. Automatic overload fallback disabled offline. Non-48k input uses linear resampling; prefer 48k for listening.' };
  for (const mode of ['light', 'high-quality']) {
    const { processor, messages } = await processorFixture({ mode, strength, compressor: true });
    if (processor.mode !== mode) throw new Error(mode + ' failed to initialize: ' + JSON.stringify(messages));
    const input = new Float32Array(128), output = new Float32Array(128), inputs = [[input]], outputs = [[output]];
    const rendered = new Float32Array(Math.ceil((mic.length + 48000) / 128) * 128);
    const start = performance.now();
    try {
      for (let offset = 0; offset < rendered.length; offset += 128) {
        for (let i = 0; i < 128; i++) input[i] = mic[offset + i] || 0;
        if (!processor.process(inputs, outputs)) throw new Error('Worklet failed: ' + JSON.stringify(messages));
        rendered.set(output, offset);
      }
      processor.publishStats();
      const stats = messages.at(-1);
      // Compensate the measured model + fixed FIFO delay for easy A/B listening.
      const delay = Math.round(stats.estimatedLatencyMs * 48);
      const destination = path.join(directory, mode + '.wav');
      writeWav(destination, rendered.subarray(delay, delay + mic.length));
      summary.outputs.push({ mode, file: destination, processingSeconds: (performance.now() - start) / 1000, ...stats });
    } finally { processor.destroy(); }
  }
  fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(summary, null, 2));
  console.log('Compare input.wav, off.wav, light.wav and high-quality.wav in: ' + directory);
  return directory;
}
if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: npm run compare:voice -- noisy-speech.wav [strength 0..1]'); process.exitCode = 1; }
  else compare(process.argv[2], process.argv[3] === undefined ? .85 : Number(process.argv[3])).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { readWav, writeWav, highPass, compare };
