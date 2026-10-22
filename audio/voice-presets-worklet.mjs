// Two overlapping variable-delay grains shift pitch without changing duration.
// All buffers are allocated at construction; only microphone samples enter here.
const bounded = (value, fallback, low, high) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

class VoicePresetsProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions = {} } = {}) {
    super();
    const options = processorOptions;
    this.ratio = 2 ** (bounded(options.semitones, 0, -18, 18) / 12);
    this.span = Math.round(sampleRate * 0.075);
    this.phaseStep = (1 - this.ratio) / this.span;
    this.phase = 0;
    let capacity = 1; while (capacity < this.span + 256) capacity *= 2;
    this.ring = new Float32Array(capacity); this.mask = capacity - 1; this.position = 0;
    this.highPass = Math.exp(-2 * Math.PI * bounded(options.lowCut, 80, 20, 1000) / sampleRate);
    this.lowPass = Math.exp(-2 * Math.PI * bounded(options.highCut, 11000, 1000, 16000) / sampleRate);
    this.bodyFilter = Math.exp(-2 * Math.PI * 280 / sampleRate);
    this.brightFilter = Math.exp(-2 * Math.PI * 2500 / sampleRate);
    this.bodyGain = 10 ** (bounded(options.body, 0, -6, 6) / 20) - 1;
    this.brightGain = 10 ** (bounded(options.brightness, 0, -6, 6) / 20) - 1;
    this.lowState = 0; this.highState = 0; this.bodyState = 0; this.brightState = 0;
    this.ringStep = 2 * Math.PI * bounded(options.ringHz, 0, 0, 150) / sampleRate;
    this.ringMix = bounded(options.ringMix, 0, 0, 1); this.ringPhase = 0;
    this.drive = bounded(options.drive, 1, 1, 4);
    this.fade = 0; this.running = true;
    this.port.onmessage = ({ data }) => { if (data?.type === 'stop') { this.running = false; this.ring.fill(0); } };
    this.port.postMessage({ type: 'ready' });
  }
  read(delay) {
    const position = this.position - delay;
    const index = Math.floor(position), fraction = position - index;
    return this.ring[index & this.mask] * (1 - fraction) + this.ring[(index + 1) & this.mask] * fraction;
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return this.running;
    if (!this.running) { output.fill(0); return false; }
    const input = inputs[0]?.[0];
    for (let index = 0; index < output.length; index++) {
      const raw = input?.[index];
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      this.ring[this.position] = sample;
      let shifted = sample;
      if (Math.abs(this.ratio - 1) > 1e-8) {
        const second = this.phase < 0.5 ? this.phase + 0.5 : this.phase - 0.5;
        const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
        shifted = this.read(16 + this.phase * this.span) * weight + this.read(16 + second * this.span) * (1 - weight);
        this.phase += this.phaseStep;
        this.phase -= Math.floor(this.phase);
      }
      this.position = (this.position + 1) & this.mask;
      this.lowState = this.highPass * this.lowState + (1 - this.highPass) * shifted;
      const high = shifted - this.lowState;
      this.highState = this.lowPass * this.highState + (1 - this.lowPass) * high;
      this.bodyState = this.bodyFilter * this.bodyState + (1 - this.bodyFilter) * this.highState;
      this.brightState = this.brightFilter * this.brightState + (1 - this.brightFilter) * this.highState;
      let value = this.highState + this.bodyGain * this.bodyState + this.brightGain * (this.highState - this.brightState);
      if (this.ringMix) {
        value *= 1 - this.ringMix + this.ringMix * Math.sin(this.ringPhase);
        this.ringPhase += this.ringStep; if (this.ringPhase >= 2 * Math.PI) this.ringPhase -= 2 * Math.PI;
      }
      if (this.drive > 1) value = Math.tanh(value * this.drive) / Math.sqrt(this.drive);
      this.fade = Math.min(1, this.fade + 1 / (sampleRate * 0.01));
      output[index] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value * this.fade)) : 0;
    }
    return true;
  }
}
registerProcessor('freqx-voice-presets', VoicePresetsProcessor);
