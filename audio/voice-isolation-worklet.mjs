// A microphone-only processor. Soundboard and master nodes never connect here.
import { FRAME_SIZE, createLightEngine, createHighQualityEngine } from './denoiser-engines.mjs';
import { MicCompressor } from './mic-dynamics.mjs';
const now = typeof performance === 'object' ? () => performance.now() : () => Date.now();
const QUANTUM_BUDGET_MS = 128 / 48;
const HOLD_SAMPLES = 48000 * .12;
const ATTACK = 1 - Math.exp(-1 / (48000 * .003));
const RELEASE = 1 - Math.exp(-1 / (48000 * .07));
// 480 - gcd(480, 128): the smallest queue that covers every quantum phase.
const FIFO_DELAY = 448;

class VoiceIsolationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.destroyed = false;
    this.inputPosition = 0;
    this.processedFrames = 0;
    this.inputFrame = new Float32Array(FRAME_SIZE);
    this.dryDelay = new Float32Array(FRAME_SIZE);
    this.outputQueue = new Float32Array(FRAME_SIZE * 2);
    this.outputRead = 0;
    this.outputWrite = FIFO_DELAY;
    this.outputCount = FIFO_DELAY;
    this.gateGain = 0;
    this.gateHold = 0;
    this.overBudget = 0;
    this.underruns = 0;
    this.processingMs = 0;
    this.peakProcessingMs = 0;
    this.quantumMs = 0;
    this.stats = { type: 'stats', mode: '', processingMs: 0, peakProcessingMs: 0,
      quantumMs: 0, estimatedLatencyMs: (FIFO_DELAY + FRAME_SIZE) / 48, processedFrames: 0, underruns: 0, id: 0 };
    this.fallbackMessage = { type: 'fallback', mode: 'light', reason: 'High quality exceeded the audio processing budget; switched to Light.' };
    this.destroyedMessage = { type: 'destroyed' };
    this.invalidAudio = new Error('The denoiser produced invalid audio.');
    this.port.onmessage = ({ data }) => {
      if (this.destroyed) return;
      try {
        if (data?.type === 'destroy') this.destroy();
        else if (data?.type === 'mode') {
          this.setMode(data.mode);
          this.port.postMessage({ type: 'mode', mode: this.mode });
        } else if (data?.type === 'strength') this.strength = this.normalizeStrength(data.strength);
        else if (data?.type === 'ping') this.publishStats(data.id);
      } catch (error) { this.fail(error); }
    };
    try {
      if (sampleRate !== 48000) throw new Error('Voice isolation requires a 48 kHz microphone context.');
      const { wasmModule, lightWasmModule, mode = 'light', strength = .85, tuning } = options.processorOptions;
      this.realtime = options.processorOptions.realtime !== false;
      this.compressor = options.processorOptions.compressor === false ? null : new MicCompressor(tuning?.compressor);
      this.strength = this.normalizeStrength(strength);
      this.wet = this.strength;
      this.light = createLightEngine(lightWasmModule);
      let initialFallback = false;
      if (wasmModule) {
        try { this.highQuality = createHighQualityEngine(wasmModule, tuning?.voiceModes?.['high-quality']); }
        catch { initialFallback = mode === 'high-quality'; }
      }
      this.setMode(initialFallback ? 'light' : mode);
      this.port.postMessage({ type: 'ready', mode: this.mode, frameSize: FRAME_SIZE,
        sampleRate: 48000, bufferLatencyMs: FIFO_DELAY / 48, modelLatencyMs: this.active.latencySamples / 48 });
      if (initialFallback) {
        this.fallbackMessage.reason = 'High quality could not initialize; switched to Light.';
        this.port.postMessage(this.fallbackMessage);
      }
    } catch (error) { this.fail(error); }
  }
  normalizeStrength(value) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : .85; }
  setMode(mode) {
    if (mode !== 'light' && mode !== 'high-quality') throw new Error('Unknown voice isolation mode.');
    if (mode === 'high-quality' && !this.highQuality) throw new Error('High quality requires the local DFN3 model.');
    this.mode = mode;
    this.active = mode === 'high-quality' ? this.highQuality : this.light;
    this.overBudget = 0;
  }
  publishStats(id) {
    const stats = this.stats;
    stats.type = id === undefined ? 'stats' : 'pong';
    stats.id = id;
    stats.mode = this.mode;
    stats.processingMs = this.processingMs;
    stats.peakProcessingMs = this.peakProcessingMs;
    stats.quantumMs = this.quantumMs;
    stats.estimatedLatencyMs = (FIFO_DELAY + this.active.latencySamples) / 48;
    stats.processedFrames = this.processedFrames;
    stats.underruns = this.underruns;
    this.port.postMessage(stats);
  }
  fallback() {
    if (this.mode !== 'high-quality') return;
    this.setMode('light');
    this.port.postMessage(this.fallbackMessage);
    // The large model is freed by destroy's message handler, outside rendering.
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.light?.destroy(); } catch {}
    try { this.highQuality?.destroy(); } catch {}
    this.active = this.light = this.highQuality = null;
    this.outputQueue.fill(0);
    this.port.onmessage = null;
  }
  fail(error) {
    if (this.destroyed) return;
    this.port.postMessage({ type: 'error', message: error?.message || 'Voice isolation failed.' });
    this.destroy();
  }
  processFrame() {
    const start = now();
    const engine = this.active;
    for (let i = 0; i < FRAME_SIZE; i++) engine.input[i] = this.inputFrame[i] * engine.scale;
    let vad;
    try { vad = engine.process(); }
    catch (error) {
      if (this.mode !== 'high-quality') throw error;
      this.fallback();
      for (let i = 0; i < FRAME_SIZE; i++) this.light.input[i] = this.inputFrame[i] * this.light.scale;
      vad = this.light.process();
    }
    let energy = 0;
    const active = this.active;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const sample = active.output[i] / active.scale;
      if (!Number.isFinite(sample)) throw this.invalidAudio;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / FRAME_SIZE);
    const speech = rms > (this.gateHold > 0 ? .002 : .004)
      && (this.mode !== 'light' || vad > .15 || rms > .02);
    if (speech) this.gateHold = HOLD_SAMPLES;
    for (let i = 0; i < FRAME_SIZE; i++) {
      this.wet += (this.strength - this.wet) * .002;
      const dry = this.dryDelay[i];
      this.dryDelay[i] = this.inputFrame[i];
      const blend = dry * (1 - this.wet) + active.output[i] / active.scale * this.wet;
      const target = this.gateHold > 0 ? 1 : 0;
      if (this.gateHold > 0) this.gateHold--;
      this.gateGain += (target - this.gateGain) * (target > this.gateGain ? ATTACK : RELEASE);
      const gated = blend * this.gateGain;
      const compressed = this.compressor ? this.compressor.process(gated) : gated;
      this.outputQueue[this.outputWrite] = Math.max(-1, Math.min(1, compressed));
      this.outputWrite = (this.outputWrite + 1) % this.outputQueue.length;
    }
    this.outputCount += FRAME_SIZE;
    this.processedFrames++;
    this.inputPosition = 0;
    const elapsed = now() - start;
    this.processingMs += (elapsed - this.processingMs) * .05;
    this.peakProcessingMs = Math.max(elapsed, this.peakProcessingMs * .999);
    if (this.realtime && this.processedFrames > 32 && this.mode === 'high-quality') {
      this.overBudget = elapsed > QUANTUM_BUDGET_MS ? this.overBudget + 1 : Math.max(0, this.overBudget - .25);
      if (this.overBudget >= 4) this.fallback();
    }
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return !this.destroyed;
    if (this.destroyed) {
      output.fill(0);
      this.port.postMessage(this.destroyedMessage);
      this.port.close();
      return false;
    }
    const input = inputs[0]?.[0];
    const start = now();
    try {
      for (let i = 0; i < output.length; i++) {
        const value = input?.[i] || 0;
        this.inputFrame[this.inputPosition++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        if (this.inputPosition === FRAME_SIZE) this.processFrame();
      }
      for (let i = 0; i < output.length; i++) {
        if (this.outputCount > 0) {
          output[i] = this.outputQueue[this.outputRead];
          this.outputRead = (this.outputRead + 1) % this.outputQueue.length;
          this.outputCount--;
        } else {
          output[i] = 0;
          this.underruns++;
          this.fallback();
        }
      }
      this.quantumMs += (now() - start - this.quantumMs) * .05;
      return true;
    } catch (error) {
      output.fill(0);
      this.fail(error);
      return false;
    }
  }
}
registerProcessor('freqx-voice-isolation', VoiceIsolationProcessor);
