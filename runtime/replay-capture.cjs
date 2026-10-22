'use strict';
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const fail = error => ({ ok: false, error: String(error?.message || error || 'Replay capture failed.').slice(0, 256) });
class ReplayDecoder {
  constructor(packet, reset = () => {}) { this.pending = Buffer.alloc(0); this.packet = packet; this.reset = reset; }
  push(chunk) {
    if (chunk.length > 1024 * 1024 || this.pending.length + chunk.length > 1024 * 1024) throw new Error('Replay capture backlog exceeded.');
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const bytes = this.pending.readUInt32LE(0);
      if (bytes > 3840 || bytes % 8) throw new Error('Invalid stereo capture frame.');
      if (this.pending.length < bytes + 4) return;
      if (!bytes) this.reset(); else {
        const samples = new Float32Array(bytes / 4);
        for (let index = 0; index < samples.length; index++) { const sample = this.pending.readFloatLE(4 + index * 4); samples[index] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0; }
        this.packet(samples);
      }
      this.pending = this.pending.subarray(bytes + 4);
    }
  }
}
class ReplayCaptureService {
  constructor({ appRoot, spawnProcess = spawn, exec = execFile, platform = process.platform }) {
    this.helper = path.join(appRoot.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'audio/native/ReplayCapture.exe');
    this.spawn = spawnProcess; this.exec = exec; this.platform = platform; this.sessions = new Map(); this.revisions = new Map();
  }
  async list() {
    try {
      if (this.platform !== 'win32' || !fs.existsSync(this.helper)) throw new Error('Windows audio capture is unavailable in this build.');
      const output = await new Promise((resolve, reject) => this.exec(this.helper, ['list'], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const result = JSON.parse(output);
      if (!Array.isArray(result?.sources) || result.sources.length > 1000) throw new Error('Invalid replay source list.');
      const sources = result.sources.filter(source => ['desktop', 'application', 'device'].includes(source?.kind) && typeof source.id === 'string' && source.id.length <= 1024 && typeof source.label === 'string')
        .map(source => ({ kind: source.kind, id: source.id, label: source.label.slice(0, 160) }));
      return { ok: true, sources, processCaptureSupported: result.processCaptureSupported === true };
    } catch (error) { return { ...fail(error), sources: [], processCaptureSupported: false }; }
  }
  async start(owner, source) {
    if (!['desktop', 'application', 'device'].includes(source?.kind) || typeof source.id !== 'string' || source.id.length > 1024) return fail('Choose an available recording source.');
    this.stopOwner(owner); const revision = this.revisions.get(owner.id);
    try {
      const listed = await this.list();
      if (this.revisions.get(owner.id) !== revision || owner.isDestroyed()) throw new Error('Replay capture canceled.');
      if (!listed.ok) return listed;
      if (!listed.sources.some(item => item.kind === source.kind && item.id === source.id)) throw new Error('The selected source is no longer available. Refresh sources.');
      const id = randomUUID(), child = this.spawn(this.helper, ['capture', source.kind, source.id], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      return await new Promise((resolve, reject) => {
        let closed = false, ready = false, stderr = '', sequence = 0, lastAck = 0, heartbeat = Date.now(), killTimer;
        const send = packet => { if (!closed && !owner.isDestroyed()) owner.send('replay:data', { id, ...packet }); };
        const session = { owner, close: () => {
          if (closed) return; closed = true; clearTimeout(startup); clearInterval(watchdog);
          child.stdin.end('\n'); killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000); killTimer.unref?.();
          if (!ready) reject(new Error('Replay capture canceled.'));
        }, ack: value => { if (Number.isSafeInteger(value) && value > lastAck && value <= sequence) lastAck = value; } };
        const stop = error => {
          if (closed) return;
          try { send({ type: 'ended', reason: error.message }); } catch {}
          if (!ready) reject(error); this.stop(owner, id);
        };
        const startup = setTimeout(() => stop(new Error('Replay source startup timed out.')), 10000);
        const watchdog = setInterval(() => { if (owner.isDestroyed() || Date.now() - heartbeat > 5000) stop(new Error('Replay source stopped responding.')); }, 1000); watchdog.unref?.();
        this.sessions.set(id, session);
        child.stdin.on('error', () => {}); child.once('error', stop); child.once('exit', () => { clearTimeout(killTimer); stop(new Error('Replay source disconnected.')); });
        const decoder = new ReplayDecoder(samples => {
          if (!ready || closed) return;
          if (sequence - lastAck >= 32) { stop(new Error('Replay capture delivery stalled.')); return; }
          try { send({ type: 'pcm', sequence: ++sequence, samples }); } catch (error) { stop(error); }
        }, () => { try { send({ type: 'reset' }); } catch (error) { stop(error); } });
        child.stdout.on('data', bytes => { try { decoder.push(bytes); } catch (error) { stop(error); } });
        child.stderr.on('data', bytes => {
          stderr += bytes.toString('utf8'); if (stderr.length > 16384) { stop(new Error('Invalid replay helper response.')); return; }
          let newline;
          while ((newline = stderr.indexOf('\n')) >= 0) {
            const line = stderr.slice(0, newline); stderr = stderr.slice(newline + 1);
            try {
              const message = JSON.parse(line);
              if (message.type === 'heartbeat') heartbeat = Date.now();
              if (message.type === 'error') throw new Error(String(message.message).slice(0, 256));
              if (message.type === 'ready' && !ready && !closed) {
                if (message.sampleRate !== 48000 || message.channels !== 2 || message.kind !== source.kind || message.id !== source.id) throw new Error('Invalid replay capture format.');
                ready = true; clearTimeout(startup); resolve({ ok: true, id, sampleRate: 48000, channels: 2 });
              }
            } catch (error) { stop(error); }
          }
        });
      });
    } catch (error) { return fail(error); }
  }
  stop(owner, id) { const session = this.sessions.get(id); if (session?.owner === owner) { this.sessions.delete(id); session.close(); } }
  stopOwner(owner) { this.revisions.set(owner.id, (this.revisions.get(owner.id) || 0) + 1); for (const [id, session] of this.sessions) if (session.owner === owner) this.stop(owner, id); }
  stopAll() { for (const session of this.sessions.values()) session.close(); this.sessions.clear(); for (const [id, revision] of this.revisions) this.revisions.set(id, revision + 1); }
  ack(owner, id, sequence) { const session = this.sessions.get(id); if (session?.owner === owner) session.ack(sequence); }
}
function validateReplayWav(input) {
  if (!(input instanceof Uint8Array) || input.byteLength < 44 || input.byteLength > 44 + 48000 * 60 * 4) throw new Error('Invalid replay audio size.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const channels = bytes.readUInt16LE(22), length = bytes.length - 44;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 16) !== 'WAVEfmt '
    || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || ![1, 2].includes(channels) || bytes.readUInt32LE(24) !== 48000
    || bytes.readUInt32LE(28) !== 48000 * channels * 2 || bytes.readUInt16LE(32) !== channels * 2 || bytes.readUInt16LE(34) !== 16
    || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== length || length % (channels * 2) || length < 480 * channels * 2 || length > 48000 * 60 * channels * 2) throw new Error('Invalid replay WAV format.');
  return Buffer.from(bytes);
}
module.exports = { ReplayCaptureService, ReplayDecoder, validateReplayWav };
