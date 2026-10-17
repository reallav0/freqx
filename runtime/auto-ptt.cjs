'use strict';
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const validKey = key => typeof key === 'string' && /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Mouse[45])$/.test(key);
const validTarget = name => typeof name === 'string' && /^[^<>:"/\\|?*\x00-\x1f]{1,120}\.exe$/i.test(name);
const validId = id => typeof id === 'string' && /^[\w:-]{1,96}$/.test(id);

class WindowsPttDriver extends EventEmitter {
  constructor(appRoot) {
    super();
    this.executable = path.join(appRoot, 'audio/native/AutoPushToTalk.exe').replace(/\.asar([\\/])/, '.asar.unpacked$1');
    this.child = null; this.closingChild = null; this.ready = null; this.cancelStartup = null;
    this.sequence = 0; this.requests = new Map();
  }
  async listApps() {
    const output = await new Promise((resolve, reject) => execFile(this.executable, ['--list', String(process.pid)],
      { windowsHide: true, timeout: 4000, maxBuffer: 131072, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const result = JSON.parse(output);
    if (!Array.isArray(result.apps)) throw new Error('The app list could not be read.');
    return result.apps.filter(item => validTarget(item?.processName) && typeof item.title === 'string')
      .slice(0, 256).map(item => ({ processName: item.processName, title: item.title.slice(0, 256) }));
  }
  start() {
    if (this.closingChild?.exitCode === null) return Promise.reject(new Error('Waiting for Windows to release the previous talk key. Return to your app and retry.'));
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = this.child = spawn(this.executable, ['--session', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', ready = false;
      const startup = setTimeout(() => { reject(new Error('Talk-key helper could not start.')); this.close(); }, 4000);
      this.cancelStartup = error => { clearTimeout(startup); if (!ready) reject(error); };
      child.stdout.setEncoding('utf8'); child.stderr.resume();
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 131072) { this.close(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { this.close(); return; }
          if (message.type === 'ready' && !ready) { ready = true; clearTimeout(startup); this.cancelStartup = null; resolve(child); }
          else if (message.type === 'reply') {
            const request = this.requests.get(message.id);
            if (request) { this.requests.delete(message.id); clearTimeout(request.timer); message.ok ? request.resolve(message) : request.reject(new Error(message.error || 'Talk-key input failed.')); }
          } else if (message.type === 'state') this.emit('state', message);
        }
      });
      const failed = error => {
        clearTimeout(startup); if (!ready) reject(error);
        if (this.child !== child) return;
        this.close(); this.emit('state', { status: 'error', message: error.message });
      };
      child.once('error', failed);
      child.once('exit', () => failed(new Error('Talk-key helper stopped. Enable Auto push-to-talk again to retry.')));
      child.stdin.on('error', error => failed(error));
    });
    return this.ready;
  }
  async command(type, input = {}) {
    const child = await this.start();
    if (this.child !== child || !child.stdin.writable) throw new Error('Talk-key helper closed.');
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Talk-key helper stopped responding.')); if (this.child === child) this.close(); }, 2000);
      this.requests.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ type, id, ...input }) + '\n');
    });
  }
  hold(configuration) { return this.command('hold', configuration); }
  release() { return this.child ? this.command('release') : Promise.resolve({ ok: true }); }
  ping() { if (this.child?.stdin.writable) this.child.stdin.write('{"type":"ping"}\n'); }
  close() {
    const child = this.child;
    if (!child) return;
    this.child = null; this.ready = null;
    this.cancelStartup?.(new Error('Talk-key helper closed.')); this.cancelStartup = null;
    // EOF lets the helper release its key even if this process exits immediately.
    if (child.pid && child.exitCode === null && child.signalCode === null) this.closingChild = child;
    child.stdin.end();
    // Do not kill a helper retrying a key-up blocked by a privilege boundary.
    // It exits as soon as it releases input or physical input takes ownership.
    child.once('exit', () => { if (this.closingChild === child) this.closingChild = null; });
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Talk-key helper closed.')); }
    this.requests.clear();
  }
}

class AutoPttService {
  constructor({ appRoot, driver, platform = process.platform, tuning = {}, now = Date.now } = {}) {
    this.driver = driver || new WindowsPttDriver(appRoot);
    this.platform = platform; this.now = now;
    this.leadMs = tuning.leadMs ?? 80; this.tailMs = tuning.tailMs ?? 120;
    this.leaseMs = tuning.leaseTimeoutMs ?? 3000;
    this.configuration = { enabled: false, key: 'KeyV', targetProcess: '' };
    this.leases = new Map(); this.pending = new Map(); this.owner = null;
    this.held = false; this.revision = 0; this.queue = Promise.resolve();
    this.heartbeat = null; this.tail = null;
    this.driver.on('state', state => {
      this.revision++; this.leases.clear(); this.pending.clear(); this.held = false; this.clearTimers();
      this.publish(state.status === 'error' ? 'error' : 'waiting', state.message);
    });
  }
  publish(status, message) {
    this.state = { status, ...(message ? { message: String(message).slice(0, 300) } : {}) };
    if (this.owner && !this.owner.isDestroyed()) this.owner.send('auto-ptt:state', this.state);
  }
  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  clearTimers() { clearInterval(this.heartbeat); clearTimeout(this.tail); this.heartbeat = null; this.tail = null; }
  supervise() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.driver.ping();
      for (const [id, lease] of this.leases) if (lease.expires <= this.now()) this.end(this.owner, id);
    }, 500);
    this.heartbeat.unref?.();
  }
  async listApps() { return { apps: this.platform === 'win32' ? await this.driver.listApps() : [] }; }
  async configure(owner, configuration) {
    if (!configuration || typeof configuration.enabled !== 'boolean' || !validKey(configuration.key)
      || typeof configuration.targetProcess !== 'string' || configuration.enabled && !validTarget(configuration.targetProcess)) {
      return { ok: false, error: 'Choose a supported talk key and target app.' };
    }
    await this.releaseAll(); this.owner = owner;
    if (configuration.enabled && this.platform !== 'win32') { this.publish('error', 'Auto push-to-talk requires Windows.'); return { ok: false, error: 'Auto push-to-talk requires Windows.' }; }
    this.configuration = { enabled: configuration.enabled, key: configuration.key, targetProcess: configuration.targetProcess.slice(0, 128) };
    if (!configuration.enabled) { this.driver.close(); this.publish('off'); return { ok: true }; }
    try { await this.driver.start(); this.publish('ready'); return { ok: true }; }
    catch (error) { this.configuration.enabled = false; this.publish('error', error.message); return { ok: false, error: error.message }; }
  }
  async begin(owner, input) {
    if (!validId(input?.id) || !Number.isFinite(input?.durationMs) || input.durationMs < 0 || input.durationMs > 86400000) return { ok: false, error: 'Invalid playback request.' };
    if (!this.configuration.enabled || owner !== this.owner) return { ok: true, holding: false };
    if (this.pending.has(input.id) || this.leases.has(input.id) || this.pending.size + this.leases.size >= 256) return { ok: false, error: 'Duplicate or excessive playback requests.' };
    const lease = { expires: this.now() + this.leaseMs, revision: this.revision, deadline: input.durationMs ? this.now() + input.durationMs + this.leadMs + 2000 : Infinity };
    this.pending.set(input.id, lease);
    try {
      const holding = await this.enqueue(async () => {
        if (this.pending.get(input.id) !== lease || lease.revision !== this.revision) return false;
        clearTimeout(this.tail); this.tail = null;
        if (!this.held) {
          const result = await this.driver.hold(this.configuration);
          if (this.pending.get(input.id) !== lease || lease.revision !== this.revision) {
            if (result.holding && !this.leases.size) await this.driver.release();
            return false;
          }
          if (!result.holding) { this.publish('waiting', 'Focus the selected app before starting a clip.'); return false; }
          this.held = true;
        }
        lease.expires = this.now() + this.leaseMs;
        this.leases.set(input.id, lease); this.supervise(); this.publish('holding'); return true;
      });
      if (holding && this.leadMs) await new Promise(resolve => setTimeout(resolve, this.leadMs));
      return { ok: true, holding: holding && this.leases.get(input.id) === lease };
    } catch (error) {
      this.pending.delete(input.id); this.leases.delete(input.id);
      await this.releaseAll(); this.publish('error', error.message); return { ok: false, error: error.message };
    } finally { if (this.pending.get(input.id) === lease) this.pending.delete(input.id); }
  }
  end(owner, id) {
    if (owner !== this.owner || !validId(id)) return Promise.resolve({ ok: false });
    this.pending.delete(id); this.leases.delete(id);
    if (!this.leases.size && !this.pending.size && this.held) {
      clearTimeout(this.tail);
      this.tail = setTimeout(() => {
        this.tail = null;
        void this.enqueue(async () => {
          if (this.leases.size || this.pending.size || !this.held) return;
          await this.driver.release(); this.held = false; this.clearTimers(); this.publish(this.configuration.enabled ? 'ready' : 'off');
        }).catch(error => { this.driver.close(); this.held = false; this.clearTimers(); this.publish('error', error.message); });
      }, this.tailMs);
    }
    return Promise.resolve({ ok: true });
  }
  refresh(owner, ids) {
    if (owner !== this.owner || !Array.isArray(ids) || ids.length > 256) return;
    for (const id of ids) {
      const lease = this.leases.get(id);
      if (lease) lease.expires = Math.min(this.now() + this.leaseMs, lease.deadline);
    }
  }
  releaseAll(owner) {
    if (owner && owner !== this.owner) return Promise.resolve();
    this.revision++; this.pending.clear(); this.leases.clear(); this.clearTimers();
    return this.enqueue(async () => {
      try { if (this.held) await this.driver.release(); }
      catch (error) { this.driver.close(); this.held = false; this.publish('error', error.message); return; }
      this.held = false;
      this.publish(this.configuration.enabled ? 'ready' : 'off');
    });
  }
  stop() { this.revision++; this.pending.clear(); this.leases.clear(); this.clearTimers(); this.held = false; this.driver.close(); }
}
module.exports = { AutoPttService, WindowsPttDriver, validKey, validTarget };
