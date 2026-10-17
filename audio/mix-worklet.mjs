// Mixer-only DSP. No model, microphone capture, timers, or per-quantum allocations.
const finiteSample = value => Number.isFinite(value) ? value : 0;
const bounded = (value, fallback, low, high) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

class VoicePriorityProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'reductionDb', defaultValue: 12, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
      { name: 'thresholdDb', defaultValue: -42, minValue: -70, maxValue: -10, automationRate: 'k-rate' },
    ];
  }
  constructor({ processorOptions = {} } = {}) {
    super();
    this.attack = Math.exp(-1 / (sampleRate * bounded(processorOptions.attackMs, 15, 1, 200) / 1000));
    this.release = Math.exp(-1 / (sampleRate * bounded(processorOptions.releaseMs, 400, 10, 2000) / 1000));
    this.holdFrames = Math.round(sampleRate * bounded(processorOptions.holdMs, 180, 0, 2000) / 1000);
    // A short power envelope rejects isolated clicks and tracks speech on the audio thread.
    this.detector = Math.exp(-1 / (sampleRate * 0.01));
    this.power = 0;
    this.hold = 0;
    this.gain = 1;
    this.active = false;
    this.statusFrames = 0;
  }
  process(inputs, outputs, parameters) {
    const sound = inputs[0];
    const mic = inputs[1];
    const output = outputs[0];
    if (!output?.length) return true;
    const enabled = parameters.enabled[0] >= 0.5;
    const threshold = 10 ** (parameters.thresholdDb[0] / 10);
    const reduction = 10 ** (-parameters.reductionDb[0] / 20);
    for (let frame = 0; frame < output[0].length; frame++) {
      let power = 0;
      for (let channel = 0; channel < mic.length; channel++) {
        const value = finiteSample(mic[channel][frame]);
        power += value * value;
      }
      power /= mic.length || 1;
      this.power = this.detector * this.power + (1 - this.detector) * power;
      // Separate open/close thresholds avoid flutter around the speech boundary.
      if (enabled && mic.length && this.power > threshold * (this.hold ? 0.5 : 1)) this.hold = Math.max(1, this.holdFrames);
      else if (this.hold > 0) this.hold--;
      if (!enabled || !mic.length) { this.hold = 0; this.power = 0; }
      const target = enabled && this.hold > 0 ? reduction : 1;
      const coefficient = target < this.gain ? this.attack : this.release;
      this.gain = target + coefficient * (this.gain - target);
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][frame] = finiteSample(sound[channel]?.[frame] ?? sound[0]?.[frame]) * this.gain;
      }
    }
    this.statusFrames += output[0].length;
    const active = enabled && this.hold > 0 && this.gain < 0.99;
    if (active !== this.active && this.statusFrames >= sampleRate / 20) {
      this.active = active;
      this.statusFrames = 0;
      this.port.postMessage({ type: 'ducking', active });
    }
    return true;
  }
}

class PeakLimiterProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions = {} } = {}) {
    super();
    this.ceiling = 10 ** (bounded(processorOptions.ceilingDb, -1, -12, 0) / 20);
    this.delay = Math.round(sampleRate * bounded(processorOptions.lookaheadMs, 3, 0, 10) / 1000);
    this.channels = Math.round(bounded(processorOptions.channels, 2, 1, 2));
    this.ringSize = this.delay + 1;
    this.rings = Array.from({ length: this.channels }, () => new Float32Array(this.ringSize));
    this.queueSize = this.delay + 2;
    this.peaks = new Float64Array(this.queueSize);
    this.frames = new Float64Array(this.queueSize);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.frame = 0;
    this.gain = 1;
    this.release = Math.exp(-1 / (sampleRate * bounded(processorOptions.releaseMs, 80, 10, 2000) / 1000));
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;
    for (let frame = 0; frame < output[0].length; frame++, this.frame++) {
      const write = this.frame % this.ringSize;
      let peak = 0;
      for (let channel = 0; channel < this.channels; channel++) {
        const value = finiteSample(input[channel]?.[frame] ?? input[0]?.[frame]);
        this.rings[channel][write] = value;
        peak = Math.max(peak, Math.abs(value));
      }
      while (this.count && this.frames[this.head] < this.frame - this.delay) {
        this.head = (this.head + 1) % this.queueSize; this.count--;
      }
      while (this.count) {
        const last = (this.tail + this.queueSize - 1) % this.queueSize;
        if (this.peaks[last] > peak) break;
        this.tail = last; this.count--;
      }
      this.peaks[this.tail] = peak; this.frames[this.tail] = this.frame;
      this.tail = (this.tail + 1) % this.queueSize; this.count++;
      const target = Math.min(1, this.ceiling / Math.max(this.peaks[this.head], 1e-12));
      this.gain = Math.min(target, 1 - (1 - this.gain) * this.release);
      const read = (this.frame + 1) % this.ringSize;
      for (let channel = 0; channel < output.length; channel++) {
        const value = this.frame < this.delay ? 0 : this.rings[Math.min(channel, this.channels - 1)][read];
        output[channel][frame] = value * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('freqx-voice-priority', VoicePriorityProcessor);
registerProcessor('freqx-peak-limiter', PeakLimiterProcessor);
