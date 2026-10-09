'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const http = require('node:http');
const dns = require('node:dns');
const { downloadAudioLink, parseAudioLink, platformLink, sniffAudio, safeFilename, MAX_BYTES } = require('../runtime/audio-link.cjs');
const { downloadBytes, publicLookup } = require('../runtime/remote-download.cjs');
const { platformProxy, extractorArguments, validatePlatformResult } = require('../runtime/audio-link-platform.cjs');

function wave() {
  const b = Buffer.alloc(44 + 9600); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(9600, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(Math.round(12000 * Math.sin((i - 44) / 2 * Math.PI * 880 / 48000)), i);
  return b;
}
function network(responses) {
  const calls = [];
  function request(url, options, callback) {
    calls.push({ url, options });
    const req = new EventEmitter();
    queueMicrotask(() => {
      const record = responses[Math.min(calls.length - 1, responses.length - 1)];
      const res = Readable.from(record.body === undefined ? [wave()] : [record.body]);
      res.statusCode = record.status || 200; res.headers = record.headers || { 'content-type': 'audio/wav' }; res.complete = true;
      callback(res);
    });
    return req;
  }
  return { calls, download: (url, limit, options) => downloadBytes(url, limit, { ...options, request }) };
}

test('link policy rejects executable schemes, local/private URLs, credentials and parser ambiguity', () => {
  for (const value of [null, {}, [], '', 'javascript:alert(1)', 'data:audio/wav;base64,AAAA', 'file:///C:/Windows/win.ini',
    'http://example.com/a.wav', 'https://localhost/a', 'https://a.local/a', 'https://intranet/a',
    'https://127.1/a', 'https://2130706433/a', 'https://0x7f000001/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a',
    'https://169.254.169.254/a', 'https://user:pass@example.com/a', 'https://example.com:8443/a',
    'https://example.com/a#x', 'https://example.com/a\n', 'https:\\example.com/a', 'https://example.com/%00a',
    'https://example.com/%0da', 'https://example.com./a', 'https://example.com/' + 'a'.repeat(8200)]) {
    assert.throws(() => parseAudioLink(value), undefined, String(value));
  }
  assert.equal(parseAudioLink('https://cdn.example.com/audio?token=a%2Fb%3D').hostname, 'cdn.example.com');
});

test('YouTube video URLs canonicalize without playlist or injected options; SoundCloud is single-track only', () => {
  for (const value of ['https://youtu.be/jNQXAC9IVRw?t=4', 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=private', 'https://youtube.com/shorts/jNQXAC9IVRw']) {
    assert.deepEqual(platformLink(parseAudioLink(value)), { site: 'youtube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  }
  assert.equal(platformLink(parseAudioLink('https://soundcloud.com/artist/track?tracking=1')).url, 'https://soundcloud.com/artist/track');
  for (const url of ['https://youtube.com/playlist?list=x', 'https://youtu.be/--exec', 'https://soundcloud.com/artist/sets', 'https://soundcloud.com/artist/sets/album']) {
    assert.throws(() => platformLink(parseAudioLink(url)));
  }
  assert.equal(platformLink(parseAudioLink('https://youtube.com.evil.example.com/x')), null);
});

test('audio downloads retain bounded HTTPS transport and identify bytes independently of filenames', async () => {
  const net = network([{}]);
  const result = await downloadAudioLink('https://cdn.example.com/../../CON.exe?secret=yes', { download: net.download });
  assert.deepEqual(result.bytes, wave()); assert.equal(result.filename, 'linked-audio.wav');
  assert.equal(net.calls[0].options.lookup, publicLookup);
  assert.equal(net.calls[0].options.agent, false); assert.equal(net.calls[0].options.rejectUnauthorized, true);
  assert.equal(net.calls[0].options.headers['Accept-Encoding'], 'identity');
  assert.equal(safeFilename(parseAudioLink('https://example.com/%3Cscript%3E.mp3'), '.wav'), '_script_.wav');
});

test('HTML, JavaScript, SVG, archives, executables, forged MIME and malformed audio are rejected', async () => {
  for (const body of [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('MZ' + 'a'.repeat(100)),
    Buffer.from('PK\x03\x04' + 'a'.repeat(100)), Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('ID3' + 'a'.repeat(100)),
    wave().subarray(0, 100)]) {
    await assert.rejects(downloadAudioLink('https://example.com/safe.wav', { download: network([{ body }]).download }));
  }
  for (const type of ['text/html', 'application/javascript', 'image/svg+xml', 'application/zip', 'application/x-msdownload', 'audio/mp4']) {
    await assert.rejects(downloadAudioLink('https://example.com/safe.wav', { download: network([{ headers: { 'content-type': type } }]).download }));
  }
  assert.throws(() => sniffAudio(Buffer.alloc(MAX_BYTES + 1)));
});

test('redirects revalidate URLs; downgraded HTTPS and private targets never get a second request', async () => {
  for (const location of ['https://127.0.0.1/x', 'https://10.0.0.1/x', 'http://example.com/x', 'file:///x', 'https://a.local/x', 'https://user:pass@example.com/x']) {
    const net = network([{ status: 302, headers: { location } }]);
    await assert.rejects(downloadAudioLink('https://example.com/x.wav', { download: net.download }));
    assert.equal(net.calls.length, 1);
  }
  const net = network([{ status: 302, headers: { location: 'https://cdn.example.com/audio' } }, {}]);
  assert.equal((await downloadAudioLink('https://example.com/x.wav', { download: net.download })).finalUrl, 'https://cdn.example.com/audio');
});

test('actual DNS callback rejects mixed public/private and reserved responses before a connection', async () => {
  const original = dns.lookup;
  try {
    for (const address of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '::ffff:127.0.0.1', '2001:db8::1', '2001:20::1', '3fff::1']) {
      dns.lookup = (_host, _options, callback) => callback(null, [{ address: '1.1.1.1', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]);
      await assert.rejects(new Promise((resolve, reject) => publicLookup('example.com', {}, (error, ...args) => error ? reject(error) : resolve(args))), /not public/);
    }
  } finally { dns.lookup = original; }
});

test('aborted requests never call the downloader or start a website helper', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(downloadAudioLink('https://example.com/a.wav', { signal: controller.signal, download: () => { calls++; } }));
  assert.equal(calls, 0);
});

test('extractor uses fixed argument arrays, no shell/config/plugins/cookies/downloaded executable code', () => {
  const args = extractorArguments({ site: 'youtube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, { deno: 'C:/approved/deno.exe' }, 'http://proxy');
  for (const flag of ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cache-dir', '--no-remote-components', '--no-cookies', '--no-cookies-from-browser', '--no-update', '--skip-download']) assert.ok(args.includes(flag));
  assert.equal(args.at(-2), '--'); assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.ok(!args.includes('--exec')); assert.ok(!args.includes('--enable-file-urls'));
});

test('site metadata is bounded audio-only and cannot supply arbitrary media URLs or playlists', () => {
  const valid = { duration: 19, vcodec: 'none', ext: 'm4a', protocol: 'https', url: 'https://r1.googlevideo.com/videoplayback', title: '<script>title</script>' };
  assert.equal(validatePlatformResult(valid, 'youtube').title, '<script>title</script>'); // Rendered as textContent, never HTML.
  assert.equal(validatePlatformResult({ ...valid, ext: 'mp3', protocol: 'http', url: 'https://cf-media.sndcdn.com/audio.mp3' }, 'soundcloud').url, 'https://cf-media.sndcdn.com/audio.mp3');
  for (const change of [{ duration: 301 }, { is_live: true }, { entries: [] }, { vcodec: 'h264' }, { ext: 'exe' },
    { protocol: 'm3u8_native' }, { fragments: [] }, { filesize: MAX_BYTES + 1 }, { url: 'http://r1.googlevideo.com/a' }, { url: 'https://evil.example.com/a' }, { url: 'https://127.0.0.1/a' }]) {
    assert.throws(() => validatePlatformResult({ ...valid, ...change }, 'youtube'));
  }
});

test('platform proxy rejects unauthenticated tunnels and destinations outside the selected service', async () => {
  let lookups = 0;
  const proxy = await platformProxy('youtube', { lookup: (_h, _o, cb) => { lookups++; cb(new Error('No connection in this test')); } });
  const url = new URL(proxy.url);
  function connect(target, authenticated) {
    return new Promise((resolve, reject) => {
      const headers = authenticated ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') } : {};
      const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: target, headers });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('error', reject); req.end();
    });
  }
  try {
    for (const [host, auth] of [['www.youtube.com:443', false], ['127.0.0.1:443', true], ['youtube.com.evil.example.com:443', true], ['soundcloud.com:443', true], ['www.youtube.com:80', true]]) {
      assert.equal(await connect(host, auth), 403);
    }
    assert.equal(lookups, 0);
  } finally { proxy.close(); }
});
