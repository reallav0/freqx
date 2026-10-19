/* Mono microphone capture and converted-audio playback; no natural-voice bypass. */
class VoiceConversionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 7680;
    this.capacity = this.blockSize * 3;
    this.inputFrame = new Float32Array(this.blockSize);
    this.inputPosition = 0;
    this.sequence = 0;
    this.nextOutputSequence = 1;
    this.pendingBlocks = 0;
    this.outputRing = new Float32Array(this.capacity);
    this.readPosition = 0;
    this.writePosition = 0;
    this.available = 0;
    this.running = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'stop') { this.running = false; this.available = 0; return; }
      if (!this.running || data?.type !== 'output') return;
      if (!(data.samples instanceof Float32Array) || data.samples.length !== this.blockSize || data.sequence !== this.nextOutputSequence || !this.pendingBlocks || this.available + data.samples.length > this.capacity) {
        this.fail('AI voice playback buffer exceeded its limit.'); return;
      }
      for (const value of data.samples) {
        if (!Number.isFinite(value)) { this.fail('AI voice returned invalid samples.'); return; }
        this.outputRing[this.writePosition] = Math.max(-1, Math.min(1, value));
        this.writePosition = (this.writePosition + 1) % this.capacity;
      }
      this.available += data.samples.length;
      this.pendingBlocks--;
      this.nextOutputSequence++;
    };
  }
  fail(message) {
    this.running = false;
    this.available = 0;
    this.port.postMessage({ type: 'error', message });
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return this.running;
    if (!this.running) { output.fill(0); return false; }
    const microphone = inputs[0]?.[0];
    for (let index = 0; index < output.length; index++) {
      if (this.available) {
        output[index] = this.outputRing[this.readPosition];
        this.readPosition = (this.readPosition + 1) % this.capacity;
        this.available--;
      } else output[index] = 0;
      const sample = microphone?.[index];
      this.inputFrame[this.inputPosition++] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      if (this.inputPosition === this.blockSize) {
        if (this.pendingBlocks >= 3) {
          this.fail('The AI voice engine cannot keep up with live audio.');
          output.fill(0);
          return false;
        }
        this.pendingBlocks++;
        this.port.postMessage({ type: 'input', sequence: ++this.sequence, samples: this.inputFrame }, [this.inputFrame.buffer]);
        this.inputFrame = new Float32Array(this.blockSize);
        this.inputPosition = 0;
      }
    }
    return true;
  }
}
registerProcessor('freqx-voice-conversion', VoiceConversionProcessor);
