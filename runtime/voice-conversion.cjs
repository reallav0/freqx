'use strict';
// VCClient's local REST PCM protocol. Microphone audio never leaves loopback.
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// 160 ms: whole Chromium render quanta AND whole 16 kHz / 10 ms model hops.
const SAMPLE_RATE = 48000, BLOCK_SIZE = 7680;
const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;
const validVoice = id => typeof id === 'string' && /^(0|[1-9][0-9]{0,2})$/.test(id);
const errorResult = error => ({ ok: false, error: String(error?.message || 'Voice conversion failed.').slice(0, 240) });

function requestJson(port, endpoint, { fields, json, rawBody, headers = {}, method, binary = false, signal, timeoutMs = 3000, maxBytes = 1024 * 1024 } = {}) {
  if (!validPort(port)) return Promise.reject(new Error('Choose a voice engine port between 1024 and 65535.'));
  const body = rawBody || (fields ? new URLSearchParams(fields).toString() : json ? JSON.stringify(json) : null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const request = http.request({ hostname: '127.0.0.1', port, path: endpoint, method: method || (body ? 'POST' : 'GET'),
      agent: false, signal, headers: body ? { 'Content-Type': fields ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } : headers,
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy(); finish(Object.assign(new Error('The local voice engine returned an incompatible response.'), { statusCode: response.statusCode })); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(); finish(new Error('The voice engine response exceeded its limit.')); }
        else chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('aborted', () => finish(new Error('The voice engine response was interrupted.')));
      response.once('end', () => {
        try { const bytes = Buffer.concat(chunks); finish(null, binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null); }
        catch { finish(new Error('This voice engine does not support the required RVC REST protocol.')); }
      });
    });
    const timer = setTimeout(() => { request.destroy(); finish(new Error('The local voice engine took too long to respond.')); }, timeoutMs);
    request.once('error', error => finish(error.code === 'ECONNREFUSED' ? new Error('Start a compatible RVC voice engine, then refresh voices.') : error));
    request.end(body);
  });
}

function voicesFromInfo(info) {
  if (!info || info.status !== 'OK' || !Array.isArray(info.modelSlots) || info.modelSlots.length > 1000) {
    throw new Error('This engine is incompatible. Use VCClient with the RVC REST API.');
  }
  const seen = new Set();
  return info.modelSlots.filter(slot => {
    const id = String(slot?.slotIndex);
    if (slot?.voiceChangerType !== 'RVC' || !validVoice(id) || typeof slot.modelFile !== 'string' || !slot.modelFile || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(slot => ({ id: String(slot.slotIndex), name: (typeof slot.name === 'string' && slot.name.trim() ? slot.name.trim() : `Voice ${slot.slotIndex + 1}`).slice(0, 96) }));
}

function voicesFromModern(slots) {
  if (!Array.isArray(slots) || slots.length > 1000) throw new Error('This engine did not return a compatible RVC voice list.');
  const seen = new Set();
  return slots.filter(slot => {
    const id = String(slot?.slot_index);
    if (slot?.voice_changer_type !== 'RVC' || !validVoice(id) || typeof slot.model_file !== 'string' || !slot.model_file || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(slot => ({ id: String(slot.slot_index), name: (typeof slot.name === 'string' && slot.name.trim() ? slot.name.trim() : `Voice ${slot.slot_index + 1}`).slice(0, 96) }));
}

class VoiceConversionService {
  constructor({ request = requestJson, now = Date.now } = {}) {
    this.request = request; this.now = now; this.session = null; this.revision = 0;
    this.pendingOwner = null;
    this.configurationQueue = Promise.resolve();
  }
  async list({ port } = {}) {
    try { return { ok: true, voices: (await this.discover(port)).voices }; }
    catch (error) { return { ...errorResult(error), voices: [] }; }
  }
  async discover(port) {
    if (!validPort(port)) throw new Error('Choose a voice engine port between 1024 and 65535.');
    try {
      const slots = await this.request(port, '/api/slot-manager/slots');
      return { protocol: 'modern', slots, voices: voicesFromModern(slots) };
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      const info = await this.request(port, '/info');
      return { protocol: 'legacy', info, voices: voicesFromInfo(info) };
    }
  }
  async start(owner, configuration) {
    const { port, voiceId, pitch } = configuration || {};
    if (!validPort(port) || !validVoice(voiceId) || !Number.isInteger(pitch) || pitch < -12 || pitch > 12) return errorResult(new Error('Choose an installed RVC voice and a pitch from -12 to +12.'));
    this.stopAll();
    const revision = this.revision;
    this.pendingOwner = owner;
    const operation = this.configurationQueue.then(async () => {
      const current = () => { if (revision !== this.revision || owner.isDestroyed()) throw new Error('Voice conversion canceled.'); };
      current();
      const engine = await this.discover(port); current();
      if (!engine.voices.some(voice => voice.id === voiceId)) throw new Error('That voice is no longer installed. Refresh the voice list.');
      if (engine.protocol === 'modern') {
        const manager = await this.request(port, '/api/voice-changer-manager/information'); current();
        if (![false, 0].includes(manager?.local_voice_changer_interface_active)) throw new Error('Stop audio in the voice engine before connecting Freqx.');
        const config = await this.request(port, '/api/configuration-manager/configuration'); current();
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('The engine configuration is incompatible.');
        const slot = engine.slots.find(slot => String(slot.slot_index) === voiceId);
        await this.request(port, `/api/slot-manager/slots/${voiceId}`, { method: 'PUT', json: { ...slot, pitch_shift: pitch, chunk_sec: BLOCK_SIZE / SAMPLE_RATE }, timeoutMs: 30000 }); current();
        await this.request(port, '/api/configuration-manager/configuration', { method: 'PUT', json: { ...config, current_slot_index: Number(voiceId), voice_changer_input_mode: 'client', input_sample_rate: SAMPLE_RATE, output_sample_rate: SAMPLE_RATE, pass_through: false, recording_started: false, sio_broadcast: false }, timeoutMs: 30000 }); current();
        const confirmed = await this.request(port, '/api/configuration-manager/configuration'); current();
        const confirmedSlot = await this.request(port, `/api/slot-manager/slots/${voiceId}`); current();
        if (String(confirmed?.current_slot_index) !== voiceId || confirmed.input_sample_rate !== SAMPLE_RATE || confirmed.output_sample_rate !== SAMPLE_RATE
          || confirmed.pass_through !== false || confirmed.recording_started !== false || confirmed.voice_changer_input_mode !== 'client' || confirmedSlot?.pitch_shift !== pitch) throw new Error('The engine did not confirm converted-only, unrecorded 48 kHz audio.');
      } else {
        const info = engine.info;
        if (Number(info.serverAudioStated) === 1) throw new Error('Stop audio in the voice engine before connecting Freqx.');
        const settings = [['modelSlotIndex', voiceId], ['inputSampleRate', '48000'], ['outputSampleRate', '48000'], ['tran', String(pitch)], ['passThrough', 'false'], ['recordIO', '0']];
        for (const [key, val] of settings) {
          current();
          const result = await this.request(port, '/update_settings', { fields: { key, val }, timeoutMs: 30000 });
          if (result?.status !== 'OK') throw new Error('The voice engine could not configure the selected voice.');
        }
        current();
        const confirmed = await this.request(port, '/info'); current();
        if (String(confirmed.modelSlotIndex) !== voiceId || confirmed.inputSampleRate !== SAMPLE_RATE || confirmed.outputSampleRate !== SAMPLE_RATE
          || Number(confirmed.tran) !== pitch || confirmed.passThrough !== false || Number(confirmed.recordIO) !== 0 || Number(confirmed.serverAudioStated) === 1) {
          throw new Error('The engine did not confirm converted-only, unrecorded 48 kHz audio. Check its RVC setup.');
        }
      }
      // Prime model inference before connecting a real microphone. A cold model
      // must not spend the audio worklet's entire bounded queue on initialization.
      if (engine.protocol === 'modern') {
        const boundary = 'FreqxWarmup' + randomUUID().replaceAll('-', '');
        const audio = Buffer.alloc(BLOCK_SIZE * 4);
        for (let index = 0; index < BLOCK_SIZE; index++) audio.writeFloatLE(0.001 * Math.sin(2 * Math.PI * 220 * index / SAMPLE_RATE), index * 4);
        const rawBody = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="waveform"; filename="waveform.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), audio, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        let ready = false;
        // A model switch may return a shortened crossfade buffer first. Discard
        // synthetic startup output; real microphone frames remain exact-sized.
        for (let attempt = 0; attempt < 3; attempt++) {
          const primed = await this.request(port, '/api/voice-changer/convert_chunk', { rawBody, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'x-timestamp': '0' }, binary: true, timeoutMs: 30000, maxBytes: BLOCK_SIZE * 4 }); current();
          if (!Buffer.isBuffer(primed) || !primed.length || primed.length % 4 || primed.length > BLOCK_SIZE * 4) break;
          let finite = true;
          for (let index = 0; index < primed.length; index += 4) if (!Number.isFinite(primed.readFloatLE(index))) { finite = false; break; }
          if (!finite) break;
          if (primed.length === BLOCK_SIZE * 4) { ready = true; break; }
        }
        if (!ready) throw new Error('The voice engine could not prepare live conversion.');
      }
      const session = { id: randomUUID(), owner, port, protocol: engine.protocol, revision, sequence: 0, busy: false, controller: new AbortController(), lastFrame: this.now(), invalidFrames: 0 };
      session.watchdog = setInterval(() => { if (this.now() - session.lastFrame > 4000 || owner.isDestroyed()) this.stop(owner, session.id); }, 1000);
      session.watchdog.unref?.();
      this.session = session;
      this.pendingOwner = null;
      return { ok: true, id: session.id, sampleRate: SAMPLE_RATE, blockSize: BLOCK_SIZE };
    });
    this.configurationQueue = operation.catch(() => {});
    try { return await operation; } catch (error) { return errorResult(error); }
    finally { if (revision === this.revision) this.pendingOwner = null; }
  }
  async frame(owner, input) {
    const session = this.session;
    if (!session || session.owner !== owner || input?.id !== session.id) return errorResult(new Error('Voice conversion is no longer active.'));
    try {
      const samples = input.samples;
      if (session.busy || !Number.isSafeInteger(input.sequence) || input.sequence !== session.sequence + 1
        || !ArrayBuffer.isView(samples) || samples.BYTES_PER_ELEMENT !== 4 || Object.prototype.toString.call(samples) !== '[object Float32Array]' || samples.length !== BLOCK_SIZE) {
        throw new Error('Invalid or excessive voice audio frames.');
      }
      session.busy = true; session.sequence = input.sequence; session.lastFrame = this.now();
      if (session.protocol === 'modern') {
        const audio = Buffer.allocUnsafe(BLOCK_SIZE * 4);
        for (let index = 0; index < samples.length; index++) {
          if (!Number.isFinite(samples[index])) throw new Error('Invalid microphone audio.');
          audio.writeFloatLE(Math.max(-1, Math.min(1, samples[index])), index * 4);
        }
        const boundary = 'FreqxVoice' + randomUUID().replaceAll('-', '');
        const rawBody = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="waveform"; filename="waveform.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), audio, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        const started = this.now();
        const converted = await this.request(session.port, '/api/voice-changer/convert_chunk', { rawBody, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'x-timestamp': String(input.sequence) }, binary: true, signal: session.controller.signal, timeoutMs: 1500, maxBytes: BLOCK_SIZE * 4 });
        if (this.session !== session || session.controller.signal.aborted) throw new Error('Voice conversion canceled.');
        if (!Buffer.isBuffer(converted) || converted.length !== BLOCK_SIZE * 4) throw new Error('The voice model is not producing live audio. Check its configuration.');
        const output = new Float32Array(BLOCK_SIZE);
        for (let index = 0; index < BLOCK_SIZE; index++) {
          const value = converted.readFloatLE(index * 4);
          if (!Number.isFinite(value)) throw new Error('The voice model returned invalid audio.');
          output[index] = Math.max(-1, Math.min(1, value));
        }
        return { ok: true, id: session.id, sequence: input.sequence, samples: output, processingMs: Math.max(0, this.now() - started) };
      }
      const pcm = Buffer.allocUnsafe(BLOCK_SIZE * 2);
      for (let index = 0; index < samples.length; index++) {
        if (!Number.isFinite(samples[index])) throw new Error('Invalid microphone audio.');
        const value = Math.max(-1, Math.min(1, samples[index])); pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), index * 2);
      }
      const started = this.now();
      const response = await this.request(session.port, '/test', { json: { timestamp: input.sequence, buffer: pcm.toString('base64') }, signal: session.controller.signal, timeoutMs: 1500, maxBytes: BLOCK_SIZE * 4 });
      if (this.session !== session || session.controller.signal.aborted) throw new Error('Voice conversion canceled.');
      if (response?.timestamp !== input.sequence || typeof response.changedVoiceBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.changedVoiceBase64)) throw new Error('Invalid converted voice audio.');
      const converted = Buffer.from(response.changedVoiceBase64, 'base64');
      // VCClient reports a tiny silent buffer while its model is warming up.
      if (converted.length !== BLOCK_SIZE * 2) {
        if (![2, 2048, 8192].includes(converted.length) || ++session.invalidFrames > 8 || converted.some(byte => byte !== 0)) throw new Error('The voice model is not producing live audio. Check its configuration.');
      } else session.invalidFrames = 0;
      const output = new Float32Array(BLOCK_SIZE);
      if (converted.length === BLOCK_SIZE * 2) for (let index = 0; index < BLOCK_SIZE; index++) output[index] = converted.readInt16LE(index * 2) / 32768;
      return { ok: true, id: session.id, sequence: input.sequence, samples: output, processingMs: Math.max(0, this.now() - started) };
    } catch (error) {
      this.stop(owner, session.id); return errorResult(error);
    } finally { session.busy = false; }
  }
  stop(owner, id) {
    const session = this.session;
    if (!session || owner !== session.owner || id !== session.id) return;
    this.session = null; session.controller.abort(); clearInterval(session.watchdog);
  }
  stopOwner(owner) {
    if (this.pendingOwner !== owner && this.session?.owner !== owner) return;
    this.revision++;
    this.pendingOwner = null;
    if (this.session?.owner === owner) this.stop(owner, this.session.id);
  }
  stopAll() {
    this.revision++;
    this.pendingOwner = null;
    if (this.session) this.stop(this.session.owner, this.session.id);
  }
}
module.exports = { VoiceConversionService, requestJson, voicesFromInfo, voicesFromModern, validPort, SAMPLE_RATE, BLOCK_SIZE };
