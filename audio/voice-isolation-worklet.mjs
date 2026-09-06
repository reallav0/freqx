// RNNoise consumes 10 ms mono frames at 48 kHz in the 16-bit PCM float range.
// This adapter buffers Web Audio quanta without touching the shared mixer.
const FRAME_SIZE = 480;
const PCM_SCALE = 32768;

class VoiceIsolationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = null;
    this.state = 0;
    this.inputPointer = 0;
    this.outputPointer = 0;
    this.destroyed = false;
    this.inputPosition = 0;
    this.outputQueue = new Float32Array(FRAME_SIZE * 2);
    this.outputRead = 0;
    this.outputWrite = FRAME_SIZE;
    // One frame of latency prevents quantum-boundary underflows (128 != 480).
    this.outputCount = FRAME_SIZE;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "destroy") this.destroy();
    };

    try {
      if (sampleRate !== 48000) throw new Error("RNNoise requires a microphone context at 48 kHz.");
      const instance = new WebAssembly.Instance(options.processorOptions.wasmModule, {
        env: {
          __assert_fail: () => { throw new Error("RNNoise processing assertion failed."); },
          emscripten_resize_heap: (bytes) => this.growMemory(bytes)
        },
        wasi_snapshot_preview1: {
          fd_write: (_fd, vectors, count, written) => {
            const memory = new DataView(this.engine.memory.buffer);
            let bytes = 0;
            for (let i = 0; i < count; i += 1) bytes += memory.getUint32(vectors + i * 8 + 4, true);
            memory.setUint32(written, bytes, true);
            return 0;
          }
        }
      });
      this.engine = instance.exports;
      this.engine.emscripten_stack_init();
      this.engine.__wasm_call_ctors();
      if (this.engine.rnnoise_get_frame_size() !== FRAME_SIZE) throw new Error("Unexpected RNNoise frame size.");
      this.state = this.engine.rnnoise_create(0);
      this.inputPointer = this.engine.malloc(FRAME_SIZE * 4);
      this.outputPointer = this.engine.malloc(FRAME_SIZE * 4);
      if (!this.state || !this.inputPointer || !this.outputPointer) throw new Error("Unable to allocate voice isolation buffers.");
      this.refreshViews();
      this.port.postMessage({ type: "ready" });
    } catch (error) {
      this.fail(error);
    }
  }

  growMemory(bytes) {
    if (!this.engine) return 0;
    try {
      const pages = Math.ceil((bytes - this.engine.memory.buffer.byteLength) / 65536);
      if (pages > 0) this.engine.memory.grow(pages);
      return 1;
    } catch {
      return 0;
    }
  }

  refreshViews() {
    this.heap = this.engine.memory.buffer;
    this.inputFrame = new Float32Array(this.heap, this.inputPointer, FRAME_SIZE);
    this.outputFrame = new Float32Array(this.heap, this.outputPointer, FRAME_SIZE);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.engine) {
      if (this.state) this.engine.rnnoise_destroy(this.state);
      if (this.inputPointer) this.engine.free(this.inputPointer);
      if (this.outputPointer) this.engine.free(this.outputPointer);
    }
    this.state = 0;
    this.inputPointer = 0;
    this.outputPointer = 0;
    this.outputQueue.fill(0);
    this.port.onmessage = null;
    this.port.close();
  }

  fail(error) {
    this.port.postMessage({ type: "error", message: error?.message || "Voice isolation processing failed." });
    this.destroy();
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return !this.destroyed;
    if (this.destroyed) {
      output.fill(0);
      return false;
    }
    const input = inputs[0]?.[0];
    try {
      if (this.heap !== this.engine.memory.buffer) this.refreshViews();
      for (let i = 0; i < output.length; i += 1) {
        output[i] = this.outputCount > 0 ? this.outputQueue[this.outputRead] : 0;
        if (this.outputCount > 0) {
          this.outputRead = (this.outputRead + 1) % this.outputQueue.length;
          this.outputCount -= 1;
        }
        const value = input?.[i] || 0;
        this.inputFrame[this.inputPosition++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) * PCM_SCALE : 0;
        if (this.inputPosition === FRAME_SIZE) {
          this.engine.rnnoise_process_frame(this.state, this.outputPointer, this.inputPointer);
          if (this.heap !== this.engine.memory.buffer) this.refreshViews();
          for (let j = 0; j < FRAME_SIZE; j += 1) {
            const sample = this.outputFrame[j] / PCM_SCALE;
            if (!Number.isFinite(sample)) throw new Error("Voice isolation produced invalid audio.");
            this.outputQueue[this.outputWrite] = Math.max(-1, Math.min(1, sample));
            this.outputWrite = (this.outputWrite + 1) % this.outputQueue.length;
          }
          this.outputCount += FRAME_SIZE;
          this.inputPosition = 0;
        }
      }
      return true;
    } catch (error) {
      output.fill(0);
      this.fail(error);
      return false;
    }
  }
}

registerProcessor("freqx-voice-isolation", VoiceIsolationProcessor);
