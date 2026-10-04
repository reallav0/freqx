'use strict';
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { config: desktopConfig } = require('./desktop-config.cjs');
const loopback = desktopConfig.audio.loopback;
const virtualPattern = /cable|voicemeeter|vb-audio|virtual|sonar.*stream/i;

// Framed float32 PCM; reject malformed lengths before allocating or forwarding.
class PcmDecoder {
  constructor(onPacket, onReset = () => {}) { this.pending = Buffer.alloc(0); this.onPacket = onPacket; this.onReset = onReset; }
  push(chunk) {
    if (chunk.length > loopback.chunkBytes || this.pending.length + chunk.length > loopback.backlogBytes) throw new Error('Loopback PCM backlog exceeded.');
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32LE(0);
      if (size > 7680 || size % 4 !== 0) throw new Error('Invalid loopback PCM frame.');
      if (this.pending.length < size + 4) break;
      if (!size) this.onReset();
      else {
        const samples = new Float32Array(size / 4);
        for (let i = 0; i < samples.length; i++) {
          const value = this.pending.readFloatLE(4 + i * 4);
          samples[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        }
        this.onPacket(samples);
      }
      this.pending = this.pending.subarray(size + 4);
    }
  }
}

class LoopbackService {
  constructor({ appRoot, spawnProcess = spawn, exec = execFile, platform = process.platform }) {
    this.helper = path.join(appRoot.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'audio/native/LoopbackCapture.exe');
    this.spawn = spawnProcess; this.exec = exec; this.platform = platform;
    this.sessions = new Map();
    this.generations = new Map();
  }
  available() { return this.platform === 'win32' && fs.existsSync(this.helper); }
  async list() {
    if (!this.available()) return [];
    const output = await new Promise((resolve, reject) => this.exec(this.helper, ['list'], { windowsHide: true, timeout: loopback.enumerateTimeoutMs, maxBuffer: loopback.enumerateBytes }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length > loopback.maxDevices) throw new Error('Invalid WASAPI endpoint list.');
    return parsed.filter(d => typeof d?.id === 'string' && d.id.length < 1024 && typeof d.label === 'string')
      .map(d => ({ id: d.id, label: d.label.slice(0, 256), isDefault: Boolean(d.isDefault), isCommunications: Boolean(d.isCommunications), virtual: virtualPattern.test(d.label) }));
  }
  stopOwner(owner) {
    this.generations.set(owner.id, (this.generations.get(owner.id) || 0) + 1);
    for (const [id, session] of this.sessions) if (session.owner === owner) this.stop(owner, id);
  }
  stop(owner, id) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return;
    this.sessions.delete(id);
    session.close();
  }
  stopAll() { for (const session of this.sessions.values()) session.close(); this.sessions.clear(); this.generations.clear(); }
  async start(owner, endpointId) {
    if (typeof endpointId !== 'string' || endpointId.length > 1024) throw new TypeError('Invalid playback endpoint.');
    this.stopOwner(owner);
    const generation = this.generations.get(owner.id);
    const devices = await this.list();
    if (this.generations.get(owner.id) !== generation || owner.isDestroyed()) throw new Error('Playback capture canceled.');
    const endpoint = endpointId ? devices.find(d => d.id === endpointId) : devices.find(d => d.isDefault && !d.virtual);
    if (!endpoint || endpoint.virtual) throw new Error('Select the physical speakers or headphones playing the call.');
    const id = crypto.randomUUID();
    const child = this.spawn(this.helper, ['capture', endpoint.id], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false, closed = false, timer, killTimer, heartbeatTimer, lastHeartbeat = Date.now(), stderr = '', inFlight = 0, sequence = 0;
    const session = { owner, close: () => {
      if (closed) return;
      closed = true; clearTimeout(timer);
      clearInterval(heartbeatTimer);
      child.stdin.end('\n');
      killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, loopback.killTimeoutMs);
      killTimer.unref?.();
      session.reject?.(new Error('Playback capture canceled.'));
    } };
    this.sessions.set(id, session);
    const send = payload => {
      if (closed || owner.isDestroyed()) return;
      try { owner.send('audio:reference-data', { id, ...payload }); }
      catch { this.stop(owner, id); }
    };
    session.ack = () => { inFlight = Math.max(0, inFlight - 1); };
    session.closeOnError = error => {
      if (closed) return;
      send({ type: 'ended', reason: error.message });
      session.reject?.(error);
      this.stop(owner, id);
    };
    child.stdin.on('error', () => {});
    child.once('error', session.closeOnError);
    child.once('exit', () => { clearTimeout(killTimer); session.closeOnError(new Error('Playback endpoint capture ended.')); });
    const decoder = new PcmDecoder(samples => {
      if (!settled || closed) return;
      // Renderer acknowledges each packet. Bound queues during a frozen renderer.
      if (inFlight >= loopback.maxInFlightPackets) { session.closeOnError(new Error('Playback reference delivery stalled.')); return; }
      inFlight++;
      send({ type: 'pcm', sequence: ++sequence, samples });
    }, () => send({ type: 'reset' }));
    child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch (error) { session.closeOnError(error); } });
    return new Promise((resolve, reject) => {
      session.reject = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      timer = setTimeout(() => session.closeOnError(new Error('Playback capture startup timed out.')), loopback.startupTimeoutMs);
      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
        if (stderr.length > loopback.stderrBytes) { session.closeOnError(new Error('Invalid playback helper response.')); return; }
        let newline;
        while ((newline = stderr.indexOf('\n')) >= 0) {
          const line = stderr.slice(0, newline); stderr = stderr.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'heartbeat') lastHeartbeat = Date.now();
            if (message.type === 'error') throw new Error(String(message.message).slice(0, 256));
            if (message.type === 'ready' && !settled && !closed) {
              if (!Number.isInteger(message.sampleRate) || message.sampleRate < 8000 || message.sampleRate > 192000 || message.id !== endpoint.id) throw new Error('Invalid reference format.');
              settled = true; clearTimeout(timer);
              lastHeartbeat = Date.now();
              heartbeatTimer = setInterval(() => {
                if (Date.now() - lastHeartbeat > loopback.heartbeatTimeoutMs) session.closeOnError(new Error('Playback capture stopped responding.'));
              }, loopback.heartbeatIntervalMs);
              heartbeatTimer.unref?.();
              resolve({ id, endpointId: endpoint.id, label: endpoint.label, sampleRate: message.sampleRate, channels: 1 });
            }
          } catch (error) { session.closeOnError(error); }
        }
      });
    });
  }
  ack(owner, id) { const session = this.sessions.get(id); if (session?.owner === owner) session.ack(); }
}
module.exports = { LoopbackService, PcmDecoder };
