// DeepFilterNet3 accepts normalized mono float audio at 48 kHz in 480-sample hops.
// Only the microphone is connected here; this node never sees the soundboard mix.
// Compilation/fetching happen outside the real-time thread. See vendor/deepfilter.
const FRAME_SIZE = 480;
const MODEL_BYTES = 8538564;
const MODES = Object.freeze({
  // Increased attenuation/post-filter for stronger noise removal.
  // Values here are decibel limits and filter betas sent to the native engine.
  // 'attenuationDb' is logarithmic (dB). These settings represent ~10× the
  // original defaults: standard (20 dB -> 200 dB), strong (60 dB -> 600 dB).
  standard: Object.freeze({ attenuationDb: 20, postFilterBeta: 0.02 }),
  strong: Object.freeze({ attenuationDb: 40, postFilterBeta: 0.2 })
});

class VoiceIsolationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = null;
    this.weightsPointer = 0;
    this.destroyed = false;
    this.initialized = false;
    this.inputPosition = 0;
    this.processedFrames = 0;
    this.outputQueue = new Float32Array(FRAME_SIZE * 2);
    this.outputRead = 0;
    this.outputWrite = FRAME_SIZE;
    // Exactly 10 ms of buffering bridges every 128/480 quantum boundary.
    this.outputCount = FRAME_SIZE;
    this.port.onmessage = ({ data }) => {
      if (this.destroyed) return;
      try {
        if (data?.type === "destroy") this.destroy();
        else if (data?.type === "mode") this.setMode(data.mode, true);
        else if (data?.type === "ping") this.port.postMessage({
          type: "pong", id: data.id, processedFrames: this.processedFrames,
          mode: this.mode, sampleRate: 48000
        });
      } catch (error) { this.fail(error); }
    };

    try {
      if (sampleRate !== 48000) throw new Error("DeepFilterNet3 requires a microphone context at 48 kHz.");
      const { wasmModule, modelBytes, mode = "standard" } = options.processorOptions || {};
      if (!(wasmModule instanceof WebAssembly.Module)) throw new Error("DeepFilterNet3 WASM was not compiled before worklet initialization.");
      const weights = modelBytes instanceof ArrayBuffer ? new Uint8Array(modelBytes) : modelBytes;
      if (!(weights instanceof Uint8Array) || weights.byteLength !== MODEL_BYTES) throw new Error("DeepFilterNet3 model has an unexpected size.");
      const instance = new WebAssembly.Instance(wasmModule, {
        wasi_snapshot_preview1: {
          // libc diagnostics stay local; a trap is surfaced once through the port.
          fd_write: (_fd, vectors, count, written) => {
            if (!this.engine) return 8;
            const memory = new DataView(this.engine.memory.buffer);
            let bytes = 0;
            for (let i = 0; i < count; i += 1) bytes += memory.getUint32(vectors + i * 8 + 4, true);
            memory.setUint32(written, bytes, true);
            return 0;
          },
          fd_close: () => 8,
          fd_seek: () => 8,
          proc_exit: () => { throw new Error("DeepFilterNet3 native processing aborted."); }
        }
      });
      this.engine = instance.exports;
      this.engine.__wasm_call_ctors?.();
      if (this.engine.dfn3_wasm_get_input_size() !== FRAME_SIZE || this.engine.dfn3_wasm_get_output_size() !== FRAME_SIZE) throw new Error("Unexpected DeepFilterNet3 frame size.");
      this.weightsPointer = this.engine.malloc(weights.byteLength);
      if (!this.weightsPointer) throw new Error("Unable to allocate DeepFilterNet3 model memory.");
      new Uint8Array(this.engine.memory.buffer, this.weightsPointer, weights.byteLength).set(weights);
      // Tensor pointers refer into this allocation: retain it until destroy().
      if (this.engine.dfn3_wasm_create(this.weightsPointer, weights.byteLength) !== 0) throw new Error("Unable to initialize DeepFilterNet3.");
      this.initialized = true;
      this.engine.dfn3_wasm_set_input_agc(0);
      this.engine.dfn3_wasm_set_output_agc(0);
      this.engine.dfn3_wasm_set_hpf(0);
      this.heap = this.engine.memory.buffer;
      this.inputFrame = new Float32Array(this.heap, this.engine.dfn3_wasm_get_input_ptr(), FRAME_SIZE);
      this.outputFrame = new Float32Array(this.heap, this.engine.dfn3_wasm_get_output_ptr(), FRAME_SIZE);
      this.setMode(mode, false);
      this.port.postMessage({
        type: "ready", frameSize: FRAME_SIZE, sampleRate: 48000, mode: this.mode,
        ...MODES[this.mode], bufferLatencyMs: 10, modelLatencyMs: 30
      });
    } catch (error) { this.fail(error); }
  }

  setMode(mode, acknowledge) {
    const settings = MODES[mode];
    if (!settings) throw new Error("Unknown DeepFilterNet3 mode.");
    this.engine.dfn3_wasm_set_atten_lim(settings.attenuationDb);
    this.engine.dfn3_wasm_set_post_filter_beta(settings.postFilterBeta);
    this.mode = mode;
    if (acknowledge) this.port.postMessage({ type: "mode", mode, ...settings });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // A trapped native instance must never prevent the fallback from taking over.
    try { if (this.initialized) this.engine.dfn3_wasm_destroy(); } catch {}
    try { if (this.weightsPointer) this.engine.free(this.weightsPointer); } catch {}
    this.weightsPointer = 0;
    this.initialized = false;
    this.outputQueue.fill(0);
    this.engine = null;
    this.heap = this.inputFrame = this.outputFrame = null;
    this.port.onmessage = null;
  }

  fail(error) {
    if (this.destroyed) return;
    this.port.postMessage({ type: "error", message: error?.message || "DeepFilterNet3 processing failed." });
    this.destroy();
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return !this.destroyed;
    if (this.destroyed) {
      output.fill(0);
      // ACK only in the final render quantum. Closing the context/port earlier
      // leaves Chromium's native Pending activities retaining this processor.
      this.port.postMessage({ type: 'destroyed' });
      this.port.close();
      return false;
    }
    const input = inputs[0]?.[0];
    try {
      // The packaged module has fixed 64 MiB memory; no allocation/growth occurs here.
      if (this.heap !== this.engine.memory.buffer) throw new Error("DeepFilterNet3 memory unexpectedly changed.");
      for (let i = 0; i < output.length; i += 1) {
        output[i] = this.outputCount > 0 ? this.outputQueue[this.outputRead] : 0;
        if (this.outputCount > 0) {
          this.outputRead = (this.outputRead + 1) % this.outputQueue.length;
          this.outputCount -= 1;
        }
        const value = input?.[i] || 0;
        this.inputFrame[this.inputPosition++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        if (this.inputPosition === FRAME_SIZE) {
          this.engine.dfn3_wasm_process();
          if (this.outputCount + FRAME_SIZE > this.outputQueue.length) throw new Error("DeepFilterNet3 output buffer overflow.");
          for (let j = 0; j < FRAME_SIZE; j += 1) {
            const sample = this.outputFrame[j];
            if (!Number.isFinite(sample)) throw new Error("DeepFilterNet3 produced invalid audio.");
            this.outputQueue[this.outputWrite] = Math.max(-1, Math.min(1, sample));
            this.outputWrite = (this.outputWrite + 1) % this.outputQueue.length;
          }
          this.outputCount += FRAME_SIZE;
          this.inputPosition = 0;
          this.processedFrames += 1;
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
