// ABI adapter for the pinned @ennuicastr/webrtcaec3.js 0.3.0 binary.
// AudioBuffer CopyFrom/CopyTo converts normalized Web Audio samples.
// No loader, eval, network imports, or memory growth on the audio thread.
export class Aec3Engine {
  constructor(module, delayMs = 0) {
    this.memory = new WebAssembly.Memory({ initial: 256, maximum: 256 });
    const abort = () => { throw new Error('WebRTC AEC3 engine aborted.'); };
    const memory = this.memory;
    this.api = new WebAssembly.Instance(module, { a: {
      a: memory, b: abort, c: abort, f: abort, g: () => 52, e: () => 70,
      d: (fd, iov, count, written) => {
        const view = new DataView(memory.buffer);
        let bytes = 0;
        for (let i = 0; i < count; i++) bytes += view.getUint32(iov + i * 8 + 4, true);
        view.setUint32(written, bytes, true);
        return 0;
      }
    } }).exports;
    const a = this.api;
    a.h();
    this.handle = a.i(48000, 1, 1);
    if (!this.handle) throw new Error('Cannot allocate WebRTC AEC3.');
    try {
      this.renderIn = a.x(this.handle, 48000, 1, 48000, 1, 48000, 1);
      this.captureIn = a.y(this.handle, 48000, 1, 48000, 1, 48000, 1);
      this.render = a.n(this.handle);
      this.capture = a.o(this.handle);
      this.captureOut = a.q(this.handle);
      this.reference = this.channel(this.renderIn);
      this.microphone = this.channel(this.captureIn);
      this.output = this.channel(this.captureOut);
      if (this.reference.length !== 480 || this.microphone.length !== 480 || this.output.length !== 480) throw new Error('Unexpected AEC3 frame size.');
      a.k(this.handle, Math.max(0, Math.min(500, Math.round(delayMs))));
    } catch (error) { this.close(); throw error; }
  }
  channel(buffer) {
    const a = this.api;
    const pointer = new DataView(this.memory.buffer).getUint32(a.s(buffer), true);
    return new Float32Array(this.memory.buffer, pointer, a.r(buffer));
  }
  process(reference, microphone) {
    if (!this.handle) throw new Error('WebRTC AEC3 is closed.');
    const a = this.api;
    this.reference.set(reference);
    this.microphone.set(microphone);
    a.v(this.render, this.renderIn, 48000, 1);
    a.t(this.render);
    a.z(this.handle);
    a.v(this.capture, this.captureIn, 48000, 1);
    a.t(this.capture);
    a.A(this.handle);
    a.B(this.handle, 0);
    a.u(this.capture);
    a.w(this.captureOut, this.capture, 48000, 1);
    return this.output;
  }
  close() {
    if (this.handle) this.api.j(this.handle);
    this.handle = 0;
    this.api = this.memory = this.reference = this.microphone = this.output = null;
  }
}
