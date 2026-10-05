// Bounded mono reference queue. WASAPI keeps its native rate; conversion and
// modest clock drift compensation happen here without changing the mixer.
import '../runtime/config-schema.js';
const WorkletBase = typeof AudioWorkletProcessor === 'undefined' ? class {} : AudioWorkletProcessor;
export class ReferenceProcessor extends WorkletBase {
  constructor({ processorOptions } = {}) {
    super();
    if (!processorOptions?.tuning?.reference) throw new Error('Missing playback reference tuning.');
    this.tuning = globalThis.FreqxConfigSchema.validateAudioTuning(processorOptions.tuning).reference;
    this.rate = processorOptions?.sampleRate || 48000;
    this.outputRate = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.capacity = Math.ceil(this.rate * this.tuning.capacitySeconds);
    this.queue = new Float32Array(this.capacity);
    this.read = this.write = 0;
    this.target = Math.ceil(this.rate * this.tuning.targetSeconds);
    this.primed = false;
    this.closed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'destroy') {
        this.closed = true; this.queue = null;
        this.port.postMessage({ type: 'destroyed' });
      } else if (data?.type === 'reset') {
        this.read = this.write = 0; this.primed = false;
      } else if (data?.type === 'pcm' && !this.closed) {
        const samples = data.samples;
        if (!(samples instanceof Float32Array) || samples.length > 1920) return;
        // Reset a stale burst instead of increasing reference delay.
        if (this.write - this.read + samples.length > this.rate * this.tuning.staleSeconds) {
          this.read = this.write = 0; this.primed = false;
          this.port.postMessage({ type: 'discontinuity' });
        }
        for (const value of samples) this.queue[this.write++ % this.capacity] = Number.isFinite(value) ? value : 0;
        if (this.write - this.read >= this.target) this.primed = true;
      }
    };
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    // Bound clock correction so delay changes do not accumulate.
    const backlog = this.write - this.read;
    const correction = Math.max(-this.tuning.maxClockCorrection, Math.min(this.tuning.maxClockCorrection, (backlog - this.target) / (this.rate * this.tuning.clockCorrectionSeconds)));
    const increment = this.rate / this.outputRate * (1 + correction);
    for (let i = 0; i < output.length; i++) {
      if (!this.primed || this.write - this.read < 2) {
        output[i] = 0;
        if (this.primed) { this.primed = false; this.read = this.write; }
        continue;
      }
      const position = Math.floor(this.read);
      const fraction = this.read - position;
      const a = this.queue[position % this.capacity];
      const b = this.queue[(position + 1) % this.capacity];
      output[i] = a + (b - a) * fraction;
      this.read += increment;
    }
    return true;
  }
}
if (typeof registerProcessor === 'function') registerProcessor('freqx-playback-reference', ReferenceProcessor);
