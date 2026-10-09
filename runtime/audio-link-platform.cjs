'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { publicLookup } = require('./remote-download.cjs');
const { prepareLinkTools } = require('./audio-link-tools.cjs');
const { parseAudioLink, linkError, MAX_BYTES, MAX_SECONDS } = require('./audio-link.cjs');
const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com', 'youtubei.googleapis.com'],
  soundcloud: ['soundcloud.com', 'sndcdn.com']
};
function permittedHost(host, site) {
  return Boolean(PLATFORM_HOSTS[site]?.some(suffix => host === suffix || host.endsWith('.' + suffix)));
}
// All extractor requests, including redirects, cross this authenticated proxy.
// It only tunnels HTTPS to approved service hosts using connection-time public
// DNS checks. It never forwards cookies, credentials or requests from Freqx.
async function platformProxy(site, { signal, lookup = publicLookup } = {}) {
  const token = crypto.randomBytes(24).toString('hex'), authorization = 'Basic ' + Buffer.from('freqx:' + token).toString('base64');
  const sockets = new Set(); let bytes = 0, connections = 0, closed = false;
  const server = http.createServer((req, res) => { res.writeHead(403); res.end(); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(15000, () => socket.destroy()); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (req, socket, head) => {
    const reject = () => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
    const match = /^([a-z0-9.-]+):443$/.exec(req.url || '');
    if (closed || ++connections > 100 || sockets.size > 16 || !match || !permittedHost(match[1], site)
        || req.headers['proxy-authorization'] !== authorization || head.length) return reject();
    let upstream;
    try {
      parseAudioLink('https://' + match[1] + '/');
      upstream = net.connect({ host: match[1], port: 443, lookup });
    } catch { return reject(); }
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
    upstream.once('connect', () => {
      if (closed || signal?.aborted) { upstream.destroy(); socket.destroy(); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { upstream.destroy(); socket.destroy(); } });
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  function close() {
    if (closed) return; closed = true;
    signal?.removeEventListener('abort', close);
    for (const socket of sockets) socket.destroy();
    server.close();
  }
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) { close(); signal.throwIfAborted(); }
  return { url: `http://freqx:${token}@127.0.0.1:${server.address().port}`, close };
}
function extractorArguments(platform, tools, proxy) {
  return [
    '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cache-dir',
    '--no-remote-components', '--no-js-runtimes', '--js-runtimes', 'deno:' + tools.deno,
    '--no-cookies', '--no-cookies-from-browser', '--no-playlist',
    '--no-progress', '--quiet', '--no-warnings', '--no-update', '--socket-timeout', '10',
    '--retries', '0', '--extractor-retries', '0', '--proxy', proxy,
    '--use-extractors', platform.site === 'youtube' ? '^youtube$' : '^soundcloud$',
    '--skip-download', '--dump-single-json', '--format',
    'bestaudio[vcodec=none][protocol=https][ext=m4a]/bestaudio[vcodec=none][protocol=https][ext=mp3]/bestaudio[vcodec=none][protocol=http][ext=mp3]',
    '--', platform.url
  ];
}
async function runExtractor(executable, args, directory, { signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: directory, TMP: directory, DENO_DIR: path.join(directory, 'deno-cache'),
      DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1', PYTHONNOUSERSITE: '1',
      PATH: path.dirname(executable) };
    const child = spawn(executable, args, { cwd: directory, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, done = false;
    const timer = setTimeout(() => fail(linkError('The audio site took too long to respond.')), 45000);
    const abort = () => fail(signal.reason || linkError('Link playback canceled.'));
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    function fail(error) {
      if (done) return; done = true; cleanup();
      if (child.pid && process.platform === 'win32') {
        // Terminate only the tree we created, including a running Deno solver.
        execFile(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else child.kill();
      reject(error);
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) return fail(linkError('The site returned too much metadata.')); output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail(linkError('The site returned too much metadata.')); });
    child.on('error', () => fail(linkError('The website audio helper could not start.')));
    child.on('close', code => {
      if (done) return; done = true; cleanup();
      if (code !== 0) return reject(linkError('This public audio could not be retrieved. It may be private, restricted, or blocked by the site.'));
      try { resolve(JSON.parse(output)); } catch { reject(linkError('The audio site returned invalid metadata.')); }
    });
  });
}
function validatePlatformResult(info, site) {
  if (!info || typeof info !== 'object' || info._type && info._type !== 'video' || info.entries
      || info.is_live || ['is_live','is_upcoming','post_live'].includes(info.live_status)
      || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_SECONDS
      // Some SoundCloud extractors label their HTTPS progressive MP3 as "http".
      // The actual returned URL must still pass the HTTPS-only URL policy below.
      || info.vcodec !== 'none' || !['m4a','mp3'].includes(info.ext) || !['https','http'].includes(info.protocol)
      || info.fragments || Number.isFinite(info.filesize) && info.filesize > MAX_BYTES) {
    throw linkError('Use one public audio track under five minutes, with an available direct audio stream.');
  }
  const url = parseAudioLink(info.url);
  if (!permittedHost(url.hostname, site) || site === 'youtube' && !url.hostname.endsWith('.googlevideo.com')) throw linkError('The audio site returned an unsupported media address.');
  const title = typeof info.title === 'string' ? info.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120).trim() : '';
  return { url: url.href, title };
}
async function resolvePlatformLink(platform, { signal, toolsCache } = {}) {
  const tools = await prepareLinkTools(toolsCache, { signal });
  const proxy = await platformProxy(platform.site, { signal });
  try {
    const info = await runExtractor(tools['yt-dlp'], extractorArguments(platform, tools, proxy.url), path.dirname(tools.deno), { signal });
    return validatePlatformResult(info, platform.site);
  } finally { proxy.close(); }
}
module.exports = { resolvePlatformLink, platformProxy, permittedHost, extractorArguments, validatePlatformResult };
