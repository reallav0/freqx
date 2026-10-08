// Local WASM adapters shared by the AudioWorklet and offline verification.
export const FRAME_SIZE = 480;

export function createLightEngine(wasmModule) {
  let engine;
  const memoryError = new Error('RNNoise memory changed during rendering.');
  const instance = new WebAssembly.Instance(wasmModule, {
    env: {
      __assert_fail: () => { throw new Error('RNNoise assertion failed.'); },
      emscripten_resize_heap: bytes => {
        if (!engine) return 0;
        const pages = Math.ceil((bytes - engine.memory.buffer.byteLength) / 65536);
        if (pages > 0) engine.memory.grow(pages);
        return 1;
      }
    },
    wasi_snapshot_preview1: { fd_write: (_fd, _vectors, _count, written) => {
      new DataView(engine.memory.buffer).setUint32(written, 0, true);
      return 0;
    } }
  });
  engine = instance.exports;
  engine.emscripten_stack_init();
  engine.__wasm_call_ctors();
  if (engine.rnnoise_get_frame_size() !== FRAME_SIZE) throw new Error('Unexpected RNNoise frame size.');
  const state = engine.rnnoise_create(0);
  const inputPointer = engine.malloc(FRAME_SIZE * 4);
  const outputPointer = engine.malloc(FRAME_SIZE * 4);
  if (!state || !inputPointer || !outputPointer) throw new Error('RNNoise initialization failed.');
  const heap = engine.memory.buffer;
  const input = new Float32Array(heap, inputPointer, FRAME_SIZE);
  const output = new Float32Array(heap, outputPointer, FRAME_SIZE);
  return {
    input, output, scale: 32768, latencySamples: FRAME_SIZE,
    process() {
      if (engine.memory.buffer !== heap) throw memoryError;
      return engine.rnnoise_process_frame(state, outputPointer, inputPointer);
    },
    destroy() {
      if (!engine) return;
      engine.rnnoise_destroy(state); engine.free(inputPointer); engine.free(outputPointer);
      engine = null;
      this.input = this.output = null;
    }
  };
}

export function createHighQualityEngine(wasmModule, { attenuationDb = 35, postFilterBeta = 0 } = {}) {
  let engine;
  let randomBytes;
  let rendering = false;
  const memoryError = new Error('DeepFilterNet3 memory changed during rendering.');
  let seed = 0x5f3759df;
  const instance = new WebAssembly.Instance(wasmModule, { freqx: {
    // Tract initialization only: no secrets, remote data, or security role.
    random_fill: (pointer, length) => {
      if (!randomBytes || randomBytes.buffer !== engine.memory.buffer) {
        if (rendering) throw memoryError;
        randomBytes = new Uint8Array(engine.memory.buffer);
      }
      for (let i = 0; i < length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        randomBytes[pointer + i] = seed & 255;
      }
    }
  } });
  engine = instance.exports;
  const state = engine.freqx_df_create(attenuationDb, postFilterBeta);
  if (!state) throw new Error('DeepFilterNet3 initialization failed.');
  let heap = engine.memory.buffer;
  let input = new Float32Array(heap, engine.freqx_df_input_ptr(state), FRAME_SIZE);
  // Warm tract caches before connecting live capture. Our pointer ABI owns
  // fixed input/output arrays; Rust/tract still uses its internal allocator.
  for (let frame = 0; frame < 16; frame++) {
    for (let i = 0; i < FRAME_SIZE; i++) input[i] = .03 * Math.sin((frame * FRAME_SIZE + i) * .037);
    engine.freqx_df_process(state);
    if (heap !== engine.memory.buffer) {
      heap = engine.memory.buffer;
      input = new Float32Array(heap, engine.freqx_df_input_ptr(state), FRAME_SIZE);
    }
  }
  // Flush warmup audio so startup cannot emit the synthetic probe.
  input.fill(0);
  for (let frame = 0; frame < 16; frame++) engine.freqx_df_process(state);
  if (heap !== engine.memory.buffer) {
    heap = engine.memory.buffer;
    input = new Float32Array(heap, engine.freqx_df_input_ptr(state), FRAME_SIZE);
  }
  const output = new Float32Array(heap, engine.freqx_df_output_ptr(state), FRAME_SIZE);
  randomBytes = new Uint8Array(heap);
  rendering = true;
  return {
    input, output, scale: 1, latencySamples: engine.freqx_df_latency_samples(state),
    process() {
      if (engine.memory.buffer !== heap) throw memoryError;
      return engine.freqx_df_process(state);
    },
    destroy() {
      if (!engine) return;
      engine.freqx_df_free(state);
      engine = null;
      randomBytes = null;
      this.input = this.output = null;
    }
  };
}
