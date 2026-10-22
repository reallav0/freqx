// Stereo rolling capture. Output is always silent; audio never enters the mix.
class ReplayProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions = {} } = {}) {
    super();
    this.capacity = sampleRate * ([15, 30, 60].includes(processorOptions.seconds) ? processorOptions.seconds : 30);
    this.left = new Float32Array(this.capacity); this.right = new Float32Array(this.capacity);
    this.position = 0; this.count = 0; this.running = true;
    this.native = new Float32Array(sampleRate); this.read = 0; this.write = 0; this.available = 0;
    this.useNative = Boolean(processorOptions.native); this.local = Boolean(processorOptions.local);
    this.ticks = 0; this.power = 0;
    this.port.onmessage = ({ data }) => {
      if (!this.running) return;
      if (data?.type === 'stop') { this.running = false; this.snapshotRequest = null; this.left.fill(0); this.right.fill(0); this.native.fill(0); return; }
      if (data?.type === 'reset') { this.available = 0; this.read = this.write = 0; return; }
      if (data?.type === 'native') {
        const samples = data.samples;
        if (!(samples instanceof Float32Array) || samples.length % 2 || samples.length > 9600 || this.available + samples.length > this.native.length) {
          this.running = false; this.port.postMessage({ type: 'error', message: 'Replay capture delivery fell behind. Start buffering again.' }); return;
        }
        for (let index = 0; index < samples.length; index++) {
          this.native[this.write] = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
          this.write = (this.write + 1) % this.native.length;
        }
        this.available += samples.length; this.port.postMessage({ type: 'ack', sequence: data.sequence }); return;
      }
      if (data?.type === 'snapshot') {
        const [left, right] = data.channels || [];
        if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length < this.count || right.length < this.count) return;
        const begin = (this.position - this.count + this.capacity) % this.capacity;
        this.snapshotRequest = { left, right, begin, count: this.count, offset: 0, id: data.id };
      }
    };
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.running) return false;
    // Copy ahead of the writer in bounded slices instead of blocking a render
    // callback with a multi-million-sample allocation and copy.
    const snapshot = this.snapshotRequest;
    if (snapshot) {
      const end = Math.min(snapshot.count, snapshot.offset + 8192);
      for (let index = snapshot.offset; index < end; index++) {
        const from = (snapshot.begin + index) % this.capacity;
        snapshot.left[index] = this.left[from]; snapshot.right[index] = this.right[from];
      }
      snapshot.offset = end;
      if (end === snapshot.count) {
        this.snapshotRequest = null;
        this.port.postMessage({ type: 'snapshot', id: snapshot.id, sampleRate, frameCount: snapshot.count, channels: [snapshot.left, snapshot.right] }, [snapshot.left.buffer, snapshot.right.buffer]);
      }
    }
    const frames = outputs[0]?.[0]?.length || 128;
    const local = inputs[0];
    for (let index = 0; index < frames; index++) {
      let left = 0, right = 0;
      if (this.useNative && this.available >= 2) {
        left = this.native[this.read]; this.read = (this.read + 1) % this.native.length;
        right = this.native[this.read]; this.read = (this.read + 1) % this.native.length; this.available -= 2;
      }
      if (this.local) {
        const a = local?.[0]?.[index], b = local?.[1]?.[index] ?? a;
        if (Number.isFinite(a)) left += a; if (Number.isFinite(b)) right += b;
      }
      left = Math.max(-1, Math.min(1, left)); right = Math.max(-1, Math.min(1, right));
      this.left[this.position] = left; this.right[this.position] = right;
      this.position = (this.position + 1) % this.capacity; this.count = Math.min(this.capacity, this.count + 1);
      this.power += (left * left + right * right) / 2;
    }
    this.ticks += frames;
    if (this.ticks >= sampleRate / 10) {
      this.port.postMessage({ type: 'update', bufferedSeconds: this.count / sampleRate, level: Math.sqrt(this.power / this.ticks) });
      this.ticks = 0; this.power = 0;
    }
    return true;
  }
}
registerProcessor('freqx-replay', ReplayProcessor);
