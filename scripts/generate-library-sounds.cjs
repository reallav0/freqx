'use strict';

// Deterministic original sound effects. No samples, network access, native
// tools, random sources, or microphone input are used by this generator.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../assets/library');
const sampleRate = 48000;
const tau = 2 * Math.PI;
const sine = (frequency, t) => Math.sin(tau * frequency * t);
const decay = (t, rate) => Math.exp(-t * rate);

const definitions = [
  { id: 'fm-ping', title: 'FM ping', category: 'Notifications', tags: ['bright', 'digital', 'short'], duration: 0.65,
    description: 'A bright digital ping with a gently fading metallic edge.',
    sample: t => Math.sin(tau * 880 * t + 1.8 * decay(t, 11) * sine(440, t)) * decay(t, 9) },
  { id: 'soft-click', title: 'Soft click', category: 'Interface', tags: ['soft', 'minimal', 'tap'], duration: 0.18,
    description: 'A soft, rounded tap for quiet interface moments.',
    sample: t => (sine(630, t) * 0.65 + sine(1260, t) * 0.25 + sine(2200, t) * 0.1) * decay(t, 42) },
  { id: 'low-pulse', title: 'Low pulse', category: 'Transitions', tags: ['bass', 'warm', 'pulse'], duration: 0.8,
    description: 'A warm low pulse that settles into a smooth bass tail.',
    sample: t => Math.sin(tau * (66 * t + 70 * (1 - Math.exp(-t * 7)) / 7)) * decay(t, 5) },
  { id: 'glass-chime', title: 'Glass chime', category: 'Notifications', tags: ['glass', 'bright', 'chime'], duration: 1.5,
    description: 'Three airy glass harmonics with a clear, delicate decay.',
    sample: t => (sine(1046.5, t) * decay(t, 4) + 0.45 * sine(1567.98, t) * decay(t, 6) + 0.23 * sine(2630, t) * decay(t, 9)) / 1.68 },
  { id: 'ready-tone', title: 'Ready tone', category: 'Interface', tags: ['positive', 'two-note', 'ready'], duration: 0.85,
    description: 'A friendly two-note cue for something ready to go.',
    sample: t => {
      const first = sine(659.25, t) * decay(t, 10);
      const next = Math.max(0, t - 0.19);
      return (first + (t >= 0.19 ? sine(987.77, next) * decay(next, 8) * Math.min(1, next / 0.007) : 0)) * 0.78;
    } },
  { id: 'signal-sweep', title: 'Signal sweep', category: 'Transitions', tags: ['sweep', 'digital', 'rise'], duration: 1.1,
    description: 'A smooth rising signal with a little shimmer at the top.',
    sample: t => (Math.sin(tau * (150 * t + 390 * t * t)) * 0.85 + Math.sin(tau * (300 * t + 780 * t * t)) * 0.15) * Math.sin(Math.PI * t / 1.1) * decay(t, 0.7) }
];

fs.mkdirSync(root, { recursive: true });
const sounds = definitions.map(definition => {
  const sampleCount = Math.round(definition.duration * sampleRate);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(sampleCount * 2, 40);
  const waveform = Array(32).fill(0);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const fade = Math.min(1, t / 0.006, (definition.duration - t) / 0.035);
    // Fixed -8 dBFS peak ceiling keeps previews comfortable and leaves headroom.
    const sample = Math.max(-0.398, Math.min(0.398, definition.sample(t) * fade * 0.398));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    const bucket = Math.min(31, Math.floor(i * 32 / sampleCount));
    waveform[bucket] = Math.max(waveform[bucket], Math.abs(sample));
  }
  const peak = Math.max(...waveform);
  fs.writeFileSync(path.join(root, `${definition.id}.wav`), buffer);
  const { sample, ...metadata } = definition;
  return { ...metadata, source: 'Freqx originals', sizeBytes: buffer.length,
    waveform: waveform.map(value => Number((value / peak).toFixed(3))), sha256: createHash('sha256').update(buffer).digest('hex') };
});
fs.writeFileSync(path.join(root, 'catalog.json'), `${JSON.stringify({ version: 1, sounds }, null, 2)}\n`);
console.log(`Generated ${sounds.length} original sounds (${sounds.reduce((total, sound) => total + sound.sizeBytes, 0)} bytes).`);
