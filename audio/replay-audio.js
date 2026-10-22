(function (root) {
  'use strict';
  const asset = root.document?.currentScript?.src || new URL('audio/replay-audio.js', root.location.href).href;
  const aborted = () => new DOMException('Replay capture canceled.', 'AbortError');
  class Recorder {
    constructor({ bridge, getStream, onUpdate = () => {}, onError = () => {} }) {
      this.bridge = bridge; this.getStream = getStream; this.onUpdate = onUpdate; this.onError = onError;
      this.generation = 0; this.active = false; this.bufferedSeconds = 0; this.requests = new Map(); this.sequence = 0;
    }
    async start(source, seconds = 30) {
      if (![15, 30, 60].includes(seconds)) throw new Error('Choose a 15, 30, or 60 second buffer.');
      const stopping = this.stop(), generation = this.generation; await stopping;
      const current = () => { if (generation !== this.generation) throw aborted(); };
      current();
      const native = ['desktop', 'device', 'application'].includes(source?.kind);
      const local = ['microphone', 'mix'].includes(source?.kind);
      if (!native && !local) throw new Error('Choose a recording source.');
      try {
        const context = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } }); this.context = context;
        await context.suspend(); current();
        await context.audioWorklet.addModule(new URL('replay-worklet.mjs', asset).href); current();
        const node = new AudioWorkletNode(context, 'freqx-replay', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { seconds, native, local } });
        this.node = node;
        const fail = error => { if (generation !== this.generation) return; void this.stop(); this.onError(error instanceof Error ? error : new Error(String(error))); };
        node.addEventListener('processorerror', () => fail(new Error('Replay audio processing stopped.')));
        node.port.onmessage = ({ data }) => {
          if (generation !== this.generation) return;
          if (data?.type === 'ack' && this.nativeId) this.bridge.ackReplayCapture(this.nativeId, data.sequence);
          else if (data?.type === 'error') fail(new Error(data.message));
          else if (data?.type === 'update') { this.bufferedSeconds = data.bufferedSeconds; this.onUpdate({ active: this.active, bufferedSeconds: data.bufferedSeconds, level: data.level }); }
          else if (data?.type === 'snapshot') {
            const request = this.requests.get(data.id); if (!request) return;
            this.requests.delete(data.id); clearTimeout(request.timer);
            const channels = data.channels.map(channel => channel.subarray(0, data.frameCount));
            request.resolve({ sampleRate: data.sampleRate, channels, duration: data.frameCount / data.sampleRate });
          }
        };
        node.connect(context.destination);
        if (local) {
          const stream = await this.getStream(source);
          if (generation !== this.generation) { stream?.getTracks().forEach(track => track.stop()); throw aborted(); }
          this.stream = stream;
          if (!stream?.getAudioTracks().length) throw new Error('The selected source has no audio.');
          for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => fail(new Error('The selected audio source disconnected.')), { once: true });
          this.input = context.createMediaStreamSource(stream); this.input.connect(node);
        }
        if (native) {
          this.unsubscribe = this.bridge.onReplayCaptureData(packet => {
            if (generation !== this.generation || !this.nativeId || packet.id !== this.nativeId) return;
            if (packet.type === 'ended') fail(new Error(packet.reason || 'The selected source stopped.'));
            else if (packet.type === 'reset') node.port.postMessage({ type: 'reset' });
            else if (packet.type === 'pcm') { const samples = new Float32Array(packet.samples); node.port.postMessage({ type: 'native', sequence: packet.sequence, samples }, [samples.buffer]); }
          });
          this.nativePending = true;
          const result = await this.bridge.startReplayCapture({ kind: source.kind, id: source.id });
          if (generation !== this.generation) { if (result?.id) void this.bridge.stopReplayCapture(result.id); throw aborted(); }
          this.nativePending = false;
          if (!result?.ok) throw new Error(result?.error || 'The recording source could not start.');
          this.nativeId = result.id;
          if (result.sampleRate !== 48000 || result.channels !== 2) throw new Error('Unsupported recording format.');
        }
        await context.resume(); current(); this.seconds = seconds; this.active = true; this.onUpdate({ active: true, bufferedSeconds: 0, level: 0 });
        context.addEventListener('statechange', () => { if (context.state === 'closed' && generation === this.generation) fail(new Error('Replay audio capture closed.')); });
      } catch (error) { if (generation === this.generation) await this.stop(); throw error; }
    }
    snapshot() {
      if (!this.active || !this.node) return Promise.reject(new Error('Start buffering before capturing a replay.'));
      if (this.requests.size) return Promise.reject(new Error('A replay capture is already being prepared.'));
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Replay snapshot timed out.')); }, 3000);
        const channels = [new Float32Array(this.seconds * 48000), new Float32Array(this.seconds * 48000)];
        this.requests.set(id, { resolve, reject, timer }); this.node.port.postMessage({ type: 'snapshot', id, channels }, channels.map(channel => channel.buffer));
      });
    }
    async stop() {
      this.generation++; this.active = false; this.bufferedSeconds = 0;
      this.unsubscribe?.(); this.unsubscribe = null;
      if (this.nativeId) { void this.bridge.stopReplayCapture(this.nativeId).catch(() => {}); this.nativeId = null; }
      if (this.nativePending) { void this.bridge.cancelReplayCapture().catch(() => {}); this.nativePending = false; }
      for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(aborted()); } this.requests.clear();
      if (this.node) { this.node.port.onmessage = null; this.node.port.postMessage({ type: 'stop' }); this.node.disconnect(); this.node = null; }
      this.input?.disconnect(); this.input = null;
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
      const context = this.context; this.context = null;
      this.onUpdate({ active: false, bufferedSeconds: 0, level: 0 });
      if (context && context.state !== 'closed') await context.close().catch(() => {});
    }
  }
  class Editor {
    constructor(clip) {
      if (clip?.sampleRate !== 48000 || !Array.isArray(clip.channels) || ![1, 2].includes(clip.channels.length)
        || !clip.channels.every(channel => channel instanceof Float32Array && channel.length === clip.channels[0].length)
        || clip.channels[0].length < 480 || clip.channels[0].length > 48000 * 60) throw new Error('Choose a replay between 0.01 and 60 seconds.');
      for (const channel of clip.channels) if (!channel.every(Number.isFinite)) throw new Error('The replay contains invalid audio.');
      this.original = clip; this.history = []; this.future = []; this.state = this.initial();
    }
    initial() { return { segments: [[0, this.original.channels[0].length]], effects: { gain: 1, fadeIn: 0, fadeOut: 0 } }; }
    get duration() { return this.state.segments.reduce((sum, range) => sum + range[1] - range[0], 0) / 48000; }
    get channels() { return this.original.channels.length; }
    get effects() { return { ...this.state.effects }; }
    get canUndo() { return this.history.length > 0; } get canRedo() { return this.future.length > 0; }
    commit(state) { this.history.push(this.state); if (this.history.length > 30) this.history.shift(); this.future = []; this.state = state; }
    range(start, end) {
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Enter a valid selection.');
      const length = Math.round(this.duration * 48000);
      const a = Math.max(0, Math.min(length, Math.round(start * 48000))), b = Math.max(0, Math.min(length, Math.round(end * 48000)));
      if (b - a < 48) throw new Error('Select at least one millisecond of audio.'); return [a, b];
    }
    slice(start, end) {
      const segments = []; let offset = 0;
      for (const [a, b] of this.state.segments) { const low = Math.max(start, offset), high = Math.min(end, offset + b - a); if (high > low) segments.push([a + low - offset, a + high - offset]); offset += b - a; }
      return segments;
    }
    trim(start, end) { const [a, b] = this.range(start, end); if (b - a < 480) throw new Error('Keep at least 0.01 seconds.'); this.commit({ ...this.state, segments: this.slice(a, b) }); }
    cut(start, end) {
      const [a, b] = this.range(start, end), length = Math.round(this.duration * 48000);
      if (length - (b - a) < 480) throw new Error('Keep at least 0.01 seconds.');
      const segments = [...this.slice(0, a), ...this.slice(b, length)];
      if (segments.length > 128) throw new Error('This clip has reached its edit limit. Save it before making more cuts.'); this.commit({ ...this.state, segments });
    }
    setEffects(effects) {
      const next = { ...this.state.effects, ...effects };
      if (!Number.isFinite(next.gain) || next.gain < 0 || next.gain > 3 || ![next.fadeIn, next.fadeOut].every(value => Number.isFinite(value) && value >= 0 && value <= 60)) throw new Error('Invalid volume or fade settings.');
      if (Object.keys(next).some(key => next[key] !== this.state.effects[key])) this.commit({ ...this.state, effects: next });
    }
    undo() { if (this.canUndo) { this.future.push(this.state); this.state = this.history.pop(); } }
    redo() { if (this.canRedo) { this.history.push(this.state); this.state = this.future.pop(); } }
    reset() { this.commit(this.initial()); }
    render() {
      const length = Math.round(this.duration * 48000), { gain, fadeIn, fadeOut } = this.state.effects;
      const channels = this.original.channels.map(original => {
        const output = new Float32Array(length); let offset = 0;
        for (const [start, end] of this.state.segments) { output.set(original.subarray(start, end), offset); offset += end - start; }
        const front = Math.min(length, Math.round(fadeIn * 48000)), tail = Math.min(length, Math.round(fadeOut * 48000));
        for (let index = 0; index < length; index++) {
          const envelope = Math.min(1, front ? index / front : 1, tail ? (length - 1 - index) / tail : 1);
          output[index] = Math.max(-1, Math.min(1, output[index] * gain * envelope));
        }
        return output;
      });
      return { channels, sampleRate: 48000, duration: length / 48000 };
    }
    waveform(points = 1000) {
      points = Math.max(1, Math.min(4000, Math.round(points) || 1000)); const clip = this.render(), length = clip.channels[0].length;
      const min = new Float32Array(points), max = new Float32Array(points);
      for (let bin = 0; bin < points; bin++) for (let frame = Math.floor(bin * length / points); frame < Math.floor((bin + 1) * length / points); frame++) {
        for (const channel of clip.channels) { min[bin] = Math.min(min[bin], channel[frame]); max[bin] = Math.max(max[bin], channel[frame]); }
      }
      return { min, max };
    }
    encode() {
      const clip = this.render(), count = clip.channels.length, length = clip.channels[0].length;
      const bytes = new Uint8Array(44 + length * count * 2), view = new DataView(bytes.buffer);
      const text = (at, value) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index); };
      text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, count, true); view.setUint32(24, 48000, true); view.setUint32(28, 48000 * count * 2, true);
      view.setUint16(32, count * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes.length - 44, true);
      for (let frame = 0; frame < length; frame++) for (let channel = 0; channel < count; channel++) { const value = clip.channels[channel][frame]; view.setInt16(44 + (frame * count + channel) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
      return bytes;
    }
  }
  root.FreqxReplayAudio = Object.freeze({ Recorder, Editor });
})(globalThis);
