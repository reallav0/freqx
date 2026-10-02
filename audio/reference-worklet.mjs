// Bounded mono reference queue. WASAPI keeps its native rate; conversion and
// modest clock drift compensation happen here without changing the mixer.
const WorkletBase = typeof AudioWorkletProcessor === 'undefined' ? class {} : AudioWorkletProcessor;
export class ReferenceProcessor extends WorkletBase {
  constructor({ processorOptions } = {}) {
    super();
    this.rate = processorOptions?.sampleRate || 48000;
    this.outputRate = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.capacity = Math.ceil(this.rate * .15);
    this.queue = new Float32Array(this.capacity);
    this.read = this.write = 0;
    this.target = Math.ceil(this.rate * .015);
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
        // A burst exceeding 100 ms is stale; reset instead of increasing delay.
        if (this.write - this.read + samples.length > this.rate * .1) {
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
    // The clock correction remains within +/-0.2%; delay changes don't accumulate.
    const backlog = this.write - this.read;
    const correction = Math.max(-.002, Math.min(.002, (backlog - this.target) / (this.rate * 10)));
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
