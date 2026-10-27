'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const COOKIE = 'freqx_remote';
const EMPTY_STATE = () => ({ boards: [], selectedBoard: '__all__', sounds: [], volume: 1 });
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

function privateAddress(address, allowLoopback = false) {
  if (typeof address !== 'string') return false;
  address = address.replace(/^::ffff:/, '');
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some((part, index) => part > 255 || String(part) !== address.split('.')[index])) return false;
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || allowLoopback && parts[0] === 127;
}

function normalizeState(input) {
  if (!exactKeys(input, ['boards', 'selectedBoard', 'sounds', 'volume']) || !Array.isArray(input.boards) || input.boards.length > 128 || !Array.isArray(input.sounds) || input.sounds.length > 4096 || !Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1.5) throw new Error('Invalid remote state.');
  const boards = [...new Set(input.boards)];
  if (boards.some(board => !validText(board, 96) || board === '__all__') || input.selectedBoard !== '__all__' && !boards.includes(input.selectedBoard)) throw new Error('Invalid remote boards.');
  const ids = new Set();
  const sounds = input.sounds.map(sound => {
    if (!exactKeys(sound, ['id', 'title', 'board', 'color', 'playing', 'favorite']) || !validText(sound.id, 96) || !/^[A-Za-z0-9_-]+$/.test(sound.id) || ids.has(sound.id) || !validText(sound.title, 180) || !boards.includes(sound.board) || !/^#[0-9a-f]{6}$/i.test(sound.color) || typeof sound.playing !== 'boolean' || typeof sound.favorite !== 'boolean') throw new Error('Invalid remote sound.');
    ids.add(sound.id);
    return { id: sound.id, title: sound.title, board: sound.board, color: sound.color, playing: sound.playing, favorite: sound.favorite };
  });
  return { boards, selectedBoard: input.selectedBoard, sounds, volume: input.volume };
}

function validateCommand(input, state) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid command.');
  if (input.type === 'play' && exactKeys(input, ['type', 'soundId']) && state.sounds.some(sound => sound.id === input.soundId)) return { type: 'play', soundId: input.soundId };
  if (input.type === 'stop-all' && exactKeys(input, ['type'])) return { type: 'stop-all' };
  if (input.type === 'volume' && exactKeys(input, ['type', 'value']) && Number.isFinite(input.value) && input.value >= 0 && input.value <= 1.5) return { type: 'volume', value: input.value };
  if (input.type === 'board' && exactKeys(input, ['type', 'board']) && (input.board === '__all__' || state.boards.includes(input.board))) return { type: 'board', board: input.board };
  throw new Error('That sound or control is no longer available.');
}

class PhoneRemoteService {
  constructor({ webRoot = path.join(__dirname, 'phone-remote-web'), networkInterfaces = os.networkInterfaces, bindHost = '0.0.0.0', port = 0, allowLoopback = false, now = Date.now, onCommand = async () => ({ ok: false, error: 'Desktop is unavailable.' }), onStatus = () => {}, pairingTtlMs = 10 * 60 * 1000, sessionTtlMs = 12 * 60 * 60 * 1000, commandTimeoutMs = 10000 } = {}) {
    Object.assign(this, { webRoot, networkInterfaces, bindHost, requestedPort: port, allowLoopback, now, onCommand, onStatus, pairingTtlMs, sessionTtlMs, commandTimeoutMs });
    this.server = null; this.starting = false; this.cancelStart = null; this.port = 0; this.address = ''; this.addresses = [];
    this.pairingToken = ''; this.pairingExpiresAt = 0; this.sessions = new Map(); this.sockets = new Set(); this.streams = new Map(); this.rates = new Map(); this.state = EMPTY_STATE(); this.generation = 0; this.pendingCommands = 0;
  }

  enumerateAddresses() {
    const addresses = [];
    for (const [name, entries] of Object.entries(this.networkInterfaces())) for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && (!entry.internal || this.allowLoopback) && privateAddress(entry.address, this.allowLoopback) && !addresses.some(item => item.address === entry.address)) addresses.push({ address: entry.address, name });
    }
    return addresses;
  }

  status() {
    this.pruneSessions();
    return { enabled: Boolean(this.server?.listening), port: this.port, address: this.address, addresses: this.addresses.map(item => ({ ...item })), pairingUrl: this.server?.listening && this.pairingToken ? `http://${this.address}:${this.port}/#pair=${this.pairingToken}` : '', pairingExpiresAt: this.pairingExpiresAt, connectedPhones: this.sessions.size };
  }

  notify() { try { this.onStatus(this.status()); } catch {} }

  async start({ address } = {}) {
    if (this.starting) throw new Error('Phone remote is starting.');
    if (this.server) return this.status();
    this.addresses = this.enumerateAddresses();
    if (!this.addresses.length) throw new Error('Connect this computer to a private Wi-Fi or Ethernet network, then try again.');
    if (address && !this.addresses.some(item => item.address === address)) throw new Error('Choose an available network.');
    this.address = address || this.addresses[0].address; this.starting = true;
    const generation = ++this.generation;
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => { if (!response.headersSent) this.json(response, error.status || 500, { ok: false, error: error.status ? error.message : 'Remote request failed.' }); else response.destroy(); });
    });
    this.server = server;
    server.maxHeadersCount = 32; server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 500;
    server.on('connection', socket => {
      if (generation !== this.generation || this.server !== server || this.sockets.size >= 32 || !privateAddress(socket.remoteAddress, this.allowLoopback)) { socket.destroy(); return; }
      this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('error', () => { if (generation === this.generation && !this.starting) void this.stop(); });
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          server.removeListener('error', failed); server.removeListener('listening', ready);
          if (this.cancelStart === cancel) this.cancelStart = null;
        };
        const ready = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const cancel = () => { cleanup(); reject(new Error('Phone remote start canceled.')); };
        this.cancelStart = cancel;
        server.once('error', failed); server.once('listening', ready);
        try { server.listen(this.requestedPort, this.bindHost); } catch (error) { failed(error); }
      });
      if (generation !== this.generation) { server.close(); throw new Error('Phone remote start canceled.'); }
      this.port = server.address().port;
      this.rotatePairing();
      this.heartbeat = setInterval(() => {
        const before = this.sessions.size; this.pruneSessions();
        for (const response of this.streams.keys()) this.writeStream(response, ': heartbeat\n\n');
        if (before !== this.sessions.size) this.notify();
      }, 15000);
      this.heartbeat.unref?.();
      return this.status();
    } catch (error) {
      if (this.server === server) { this.server = null; this.port = 0; this.address = ''; }
      throw error;
    } finally { this.starting = false; }
  }

  async stop() {
    ++this.generation;
    this.cancelStart?.();
    clearInterval(this.heartbeat);
    const server = this.server; this.server = null; this.port = 0; this.address = ''; this.addresses = []; this.pairingToken = ''; this.pairingExpiresAt = 0;
    this.sessions.clear(); this.rates.clear(); this.state = EMPTY_STATE(); this.pendingCommands = 0;
    for (const response of this.streams.keys()) response.end();
    this.streams.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    this.notify(); return this.status();
  }

  rotatePairing({ address } = {}) {
    if (!this.server?.listening) throw new Error('Enable phone remote first.');
    if (address) {
      if (!this.addresses.some(item => item.address === address)) throw new Error('Choose an available network.');
      this.address = address;
    }
    this.pairingToken = randomBytes(32).toString('base64url'); this.pairingExpiresAt = this.now() + this.pairingTtlMs;
    this.notify(); return this.status();
  }

  disconnectAll() {
    this.sessions.clear(); for (const response of this.streams.keys()) response.end(); this.streams.clear();
    if (this.server?.listening) return this.rotatePairing();
    this.notify(); return this.status();
  }

  pruneSessions() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      for (const [response, owner] of this.streams) if (owner === id) { response.end(); this.streams.delete(response); }
    }
  }

  publish(input) {
    const state = normalizeState(input); this.state = state;
    const sessionCount = this.sessions.size; this.pruneSessions();
    if (sessionCount !== this.sessions.size) this.notify();
    const packet = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const response of this.streams.keys()) this.writeStream(response, packet);
    return state;
  }

  writeStream(response, packet) {
    if (response.destroyed || response.writableLength + Buffer.byteLength(packet) > 2 * 1024 * 1024) { response.destroy(); return; }
    response.write(packet);
  }

  json(response, code, body, extra = {}) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    response.end(JSON.stringify(body));
  }

  fail(status, message) { const error = new Error(message); error.status = status; throw error; }

  rate(key, limit, windowMs = 60000) {
    if (this.rates.size > 256) for (const [id, rate] of this.rates) if (rate.until <= this.now()) this.rates.delete(id);
    let rate = this.rates.get(key);
    if (!rate || rate.until <= this.now()) {
      if (!rate && this.rates.size >= 512) this.fail(429, 'The remote is busy. Try again in a moment.');
      rate = { count: 0, until: this.now() + windowMs }; this.rates.set(key, rate);
    }
    if (++rate.count > limit) this.fail(429, 'Too many requests. Wait a moment and try again.');
  }

  async body(request) {
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) this.fail(415, 'Send JSON to this control.');
    if (request.headers['content-encoding'] || Number(request.headers['content-length'] || 0) > 2048) this.fail(413, 'Request is too large.');
    let length = 0; const chunks = [];
    for await (const chunk of request) { length += chunk.length; if (length > 2048) this.fail(413, 'Request is too large.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { this.fail(400, 'Invalid JSON request.'); }
  }

  authenticate(request) {
    this.pruneSessions();
    const cookie = (request.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`));
    const id = cookie?.slice(COOKIE.length + 1);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id) || !this.sessions.has(id)) this.fail(401, 'Pair this phone with Freqx to continue.');
    const session = this.sessions.get(id);
    if (session.host !== request.headers.host) this.fail(401, 'Pair this phone on the selected network.');
    return id;
  }

  async handle(request, response) {
    const generation = this.generation;
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!this.server?.listening || !privateAddress(request.socket.remoteAddress, this.allowLoopback)) this.fail(403, 'Private network access only.');
    const host = request.headers.host;
    if (!this.addresses.some(item => host === `${item.address}:${this.port}`)) this.fail(403, 'Use the local address shown in Freqx.');
    const origin = `http://${host}`;
    if ((request.method === 'POST' || request.headers.origin) && request.headers.origin !== origin) this.fail(403, 'Open the remote from the pairing link.');
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) this.fail(403, 'Open the remote directly.');
    if (!['GET', 'POST'].includes(request.method)) this.fail(405, 'Method not allowed.');
    if (!request.url || request.url.length > 200 || request.url.includes('?') || request.url.includes('#')) this.fail(404, 'Not found.');
    const peer = request.socket.remoteAddress; this.rate(`all:${peer}`, 300);
    const asset = STATIC.get(request.url);
    if (request.method === 'GET' && asset) {
      let bytes; try { bytes = await fs.readFile(path.join(this.webRoot, asset[0])); } catch { this.fail(503, 'Phone remote files are unavailable. Restart or reinstall Freqx.'); }
      if (generation !== this.generation) return response.destroy();
      response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }); response.end(bytes); return;
    }
    if (request.method === 'POST' && request.url === '/api/pair') {
      this.rate(`pair:${peer}`, 12);
      const input = await this.body(request);
      if (generation !== this.generation) return response.destroy();
      if (!exactKeys(input, ['token']) || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || this.now() >= this.pairingExpiresAt || !this.pairingToken || !timingSafeEqual(Buffer.from(input.token), Buffer.from(this.pairingToken))) this.fail(401, 'Pairing link expired or invalid. Refresh it in Freqx.');
      this.pruneSessions();
      const previous = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (previous && this.sessions.get(previous)?.host === host) {
        this.sessions.delete(previous);
        for (const [stream, owner] of this.streams) if (owner === previous) { stream.end(); this.streams.delete(stream); }
      }
      if (this.sessions.size >= 8) this.fail(409, 'Eight phones are already paired. Disconnect a phone in Freqx.');
      const id = randomBytes(32).toString('base64url'); this.sessions.set(id, { host, expiresAt: this.now() + this.sessionTtlMs }); this.notify();
      this.json(response, 200, { ok: true, state: this.state }, { 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}` }); return;
    }
    if (!['/api/state', '/api/events', '/api/command', '/api/disconnect'].includes(request.url)) this.fail(404, 'Not found.');
    const id = this.authenticate(request);
    if (request.method === 'GET' && request.url === '/api/state') { this.json(response, 200, { ok: true, state: this.state }); return; }
    if (request.method === 'GET' && request.url === '/api/events') {
      if (this.streams.size >= 16 || [...this.streams.values()].filter(owner => owner === id).length >= 2) this.fail(429, 'This phone has too many open connections.');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(`event: state\ndata: ${JSON.stringify(this.state)}\n\n`); this.streams.set(response, id);
      response.on('close', () => this.streams.delete(response)); return;
    }
    if (request.method === 'POST' && request.url === '/api/disconnect') {
      await this.body(request);
      this.sessions.delete(id); for (const [stream, owner] of this.streams) if (owner === id) { stream.end(); this.streams.delete(stream); }
      this.notify(); this.json(response, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); return;
    }
    if (request.method === 'POST' && request.url === '/api/command') {
      this.rate(`command:${id}`, 180);
      const input = await this.body(request);
      let command; try { command = validateCommand(input, this.state); } catch (error) { this.fail(400, error.message); }
      // Keep one control slot available to stop clips still decoding or starting.
      if (this.pendingCommands >= (command.type === 'stop-all' ? 9 : 8)) this.fail(429, 'Controls are busy. Try again in a moment.');
      if (generation !== this.generation || !this.sessions.has(id)) return response.destroy();
      this.pendingCommands++; let timeout;
      try {
        const result = await Promise.race([Promise.resolve().then(() => this.onCommand(command)), new Promise(resolve => { timeout = setTimeout(() => resolve({ ok: false, error: 'Desktop did not respond. Try again.' }), this.commandTimeoutMs); timeout.unref?.(); })]);
        if (generation !== this.generation || !this.sessions.has(id)) return response.destroy();
        if (!result?.ok) { this.json(response, 409, { ok: false, error: validText(result?.error, 240) ? result.error : 'The desktop could not complete that control.' }); return; }
        this.json(response, 200, { ok: true });
      } catch { if (generation === this.generation) this.json(response, 409, { ok: false, error: 'The desktop could not complete that control.' }); }
      finally { clearTimeout(timeout); if (generation === this.generation) this.pendingCommands--; }
      return;
    }
    this.fail(405, 'Method not allowed.');
  }
}

module.exports = { PhoneRemoteService, normalizeState, validateCommand, privateAddress };
