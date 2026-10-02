import { Aec3Engine } from './aec3-engine.mjs';

const WorkletBase = typeof AudioWorkletProcessor === 'undefined' ? class {} : AudioWorkletProcessor;
export class AecProcessor extends WorkletBase {
  constructor(options = {}) {
    super();
    this.closed = false;
    this.position = 0;
    this.reference = new Float32Array(480);
    this.microphone = new Float32Array(480);
    // Delay capture 30 ms so IPC delivery of WASAPI reference precedes it.
    this.captureDelay = new Float32Array(1440);
    this.delayPosition = 0;
    this.queue = new Float32Array(2048);
    this.read = 0;
    this.write = 480;
    this.blocks = 0;
    this.referencePower = this.inputPower = this.outputPower = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'destroy') this.destroy();
      if (data?.type === 'ping') this.port.postMessage({ type: 'pong', id: data.id });
    };
    try {
      this.engine = new Aec3Engine(options.processorOptions.wasmModule);
      this.port.postMessage({ type: 'ready', engine: 'WebRTC AEC3', latencyMs: 40 });
    } catch (error) {
      this.port.postMessage({ type: 'error', message: error.message });
      this.closed = true;
    }
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.engine?.close();
    this.engine = this.reference = this.microphone = this.captureDelay = this.queue = null;
    this.port.postMessage({ type: 'destroyed' });
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    const microphone = inputs[0]?.[0];
    const reference = inputs[1]?.[0];
    try {
      for (let i = 0; i < output.length; i++) {
        const raw = microphone?.[i] || 0;
        const delayed = this.captureDelay[this.delayPosition];
        this.captureDelay[this.delayPosition] = raw;
        this.delayPosition = (this.delayPosition + 1) % this.captureDelay.length;
        this.microphone[this.position] = delayed;
        this.reference[this.position++] = reference?.[i] || 0;
        if (this.position === 480) {
          const processed = this.engine.process(this.reference, this.microphone);
          for (let j = 0; j < 480; j++) {
            const sample = processed[j];
            if (!Number.isFinite(sample)) throw new Error('Non-finite WebRTC AEC3 output.');
            this.queue[this.write++ & 2047] = Math.max(-1, Math.min(1, sample));
            this.referencePower += this.reference[j] ** 2;
            this.inputPower += this.microphone[j] ** 2;
            this.outputPower += sample ** 2;
          }
          this.position = 0;
          if (++this.blocks === 100) {
            const db = power => Math.max(-100, 10 * Math.log10(Math.max(1e-10, power / 48000)));
            this.port.postMessage({ type: 'stats', engine: 'WebRTC AEC3', referenceDb: db(this.referencePower), inputDb: db(this.inputPower), outputDb: db(this.outputPower), latencyMs: 40 });
            this.blocks = this.referencePower = this.inputPower = this.outputPower = 0;
          }
        }
        output[i] = this.queue[this.read++ & 2047];
      }
    } catch (error) {
      output.fill(0);
      this.port.postMessage({ type: 'error', message: error.message });
      this.destroy();
      return false;
    }
    return true;
  }
}
if (typeof registerProcessor === 'function') registerProcessor('freqx-aec', AecProcessor);
