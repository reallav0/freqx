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
  assert.deepEqual(platformLink(parseAudioLink('https://www.youtube.com/watch?v=h7MYJghRWt0&list=RDh7MYJghRWt0&start_radio=1')),
    { site: 'youtube', url: 'https://www.youtube.com/watch?v=h7MYJghRWt0' });
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

test('platform metadata preserves only safe request headers and bounded availability times', () => {
  const info = { duration: 218, vcodec: 'none', ext: 'm4a', protocol: 'https', url: 'https://r1.googlevideo.com/audio',
    title: 'Track', http_headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', 'Accept-Language': 'en-US',
      Cookie: 'discard', Authorization: 'discard', 'Proxy-Authorization': 'discard', Host: '127.0.0.1' } };
  const availableAt = Date.now() / 1000 + 0.06;
  const result = validatePlatformResult({ ...info, available_at: availableAt }, 'youtube');
  assert.equal(result.availableAt, availableAt);
  const headers = Object.fromEntries(Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value]));
  assert.deepEqual(headers, { 'user-agent': 'Mozilla/5.0', accept: '*/*', 'accept-language': 'en-US' });
  for (const available_at of [undefined, null]) assert.equal(validatePlatformResult({ ...info, available_at }, 'youtube').availableAt, undefined);
  for (const available_at of ['123', {}, Infinity, NaN, -1, 0, Date.now() / 1000 + 31]) {
    assert.throws(() => validatePlatformResult({ ...info, available_at }, 'youtube'));
  }
  for (const value of ['browser\r\nCookie: stolen', 'non-ASCII-é', ['browser'], 'x'.repeat(1025)]) {
    assert.throws(() => validatePlatformResult({ ...info, http_headers: { 'User-Agent': value } }, 'youtube'));
  }
});

test('platform downloads send a bounded whole-file Range and preserve validated browser headers', async () => {
  const bytes = wave();
  const net = network([{ status: 206, headers: { 'content-type': 'audio/wav', 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length) } }]);
  const result = await downloadAudioLink('https://www.youtube.com/watch?v=h7MYJghRWt0&list=RDh7MYJghRWt0&start_radio=1', {
    resolvePlatform: async platform => {
      assert.equal(platform.url, 'https://www.youtube.com/watch?v=h7MYJghRWt0');
      return { url: 'https://r1.googlevideo.com/audio?token=private', title: 'Track', headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', 'Accept-Language': 'en-US' } };
    }, download: net.download,
  });
  assert.deepEqual(result.bytes, bytes);
  const headers = Object.fromEntries(Object.entries(net.calls[0].options.headers).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(headers.range, `bytes=0-${MAX_BYTES - 1}`);
  assert.equal(headers['user-agent'], 'Mozilla/5.0');
  assert.equal(headers['accept-language'], 'en-US');
  assert.equal(headers['accept-encoding'], 'identity');
  const direct = network([{}]);
  await downloadAudioLink('https://example.com/audio.wav', { download: direct.download });
  assert.equal(Object.keys(direct.calls[0].options.headers).some(name => name.toLowerCase() === 'range'), false);
});

test('future stream availability delays the CDN request, while past or missing times request immediately', async () => {
  const availableAt = Date.now() / 1000 + 0.06;
  let calls = 0, requestedAt;
  const pending = downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
    resolvePlatform: async () => ({ url: 'https://r1.googlevideo.com/audio', availableAt }),
    download: async () => { calls++; requestedAt = Date.now() / 1000; return wave(); },
  });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 0, 'No CDN request is sent during the required site wait');
  await pending;
  assert.equal(calls, 1);
  assert.ok(requestedAt + 0.002 >= availableAt, 'Request begins only when the stream is eligible');
  for (const availableAt of [undefined, Date.now() / 1000 - 10]) {
    let downloaded = false;
    await downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
      resolvePlatform: async () => ({ url: 'https://r1.googlevideo.com/audio', availableAt }),
      download: async () => { downloaded = true; return wave(); },
    });
    assert.equal(downloaded, true);
  }
});

test('canceling a site-required wait prevents CDN access and retry', async () => {
  const controller = new AbortController(); let resolved = 0, downloaded = 0;
  const pending = downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
    signal: controller.signal,
    resolvePlatform: async () => { resolved++; return { url: 'https://r1.googlevideo.com/audio', availableAt: Date.now() / 1000 + 0.08 }; },
    download: async () => { downloaded++; return wave(); },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new Error('user canceled'));
  await assert.rejects(pending, /user canceled/);
  assert.equal(resolved, 1); assert.equal(downloaded, 0);
});

test('only a platform CDN 403 refreshes the resolver and retries exactly once', async () => {
  let resolves = 0;
  const net = network([{ status: 403 }, {}]);
  const result = await downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
    resolvePlatform: async () => ({ url: `https://r1.googlevideo.com/audio?token=fresh-${++resolves}` }), download: net.download,
  });
  assert.deepEqual(result.bytes, wave()); assert.equal(resolves, 2); assert.equal(net.calls.length, 2);
  assert.equal(net.calls[0].url.searchParams.get('token'), 'fresh-1');
  assert.equal(net.calls[1].url.searchParams.get('token'), 'fresh-2');
  for (const [source, host, site] of [['https://youtu.be/h7MYJghRWt0', 'r1.googlevideo.com', 'YouTube'], ['https://soundcloud.com/artist/track', 'cf-media.sndcdn.com', 'SoundCloud']]) {
    let resolves = 0; const forbidden = network([{ status: 403 }]);
    await assert.rejects(downloadAudioLink(source, {
      resolvePlatform: async () => ({ url: `https://${host}/audio?token=private-signed-url-${++resolves}` }), download: forbidden.download,
    }), error => error.userMessage.includes(site) && !JSON.stringify(error).includes('private-signed-url') && !error.message.includes('private-signed-url'));
    assert.equal(resolves, 2); assert.equal(forbidden.calls.length, 2);
  }
  for (const error of [Object.assign(new Error('TLS rejected'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('not public'), { code: 'PUBLIC_LIBRARY_UNAVAILABLE' }),
    Object.assign(new Error('server failed'), { httpStatus: 500 }), new Error('asset exceeds size limit')]) {
    let resolves = 0, calls = 0;
    await assert.rejects(downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
      resolvePlatform: async () => { resolves++; return { url: 'https://r1.googlevideo.com/audio' }; },
      download: async () => { calls++; throw error; },
    }));
    assert.equal(resolves, 1); assert.equal(calls, 1);
  }
});

test('original user cancellation after a CDN 403 prevents fresh resolution', async () => {
  const controller = new AbortController(); let resolves = 0;
  await assert.rejects(downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
    signal: controller.signal,
    resolvePlatform: async () => { resolves++; return { url: 'https://r1.googlevideo.com/audio' }; },
    download: async () => { controller.abort(new Error('user canceled')); throw Object.assign(new Error('forbidden'), { httpStatus: 403 }); },
  }), /user canceled/);
  assert.equal(resolves, 1);
});

test('the overall deadline includes the site availability wait and reports a safe timeout', async t => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => nativeTimeout(ms === 90000 ? 20 : ms));
  let requests = 0;
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(downloadAudioLink('https://youtu.be/h7MYJghRWt0', {
      resolvePlatform: async () => ({ url: 'https://r1.googlevideo.com/audio?token=private-signed-url', availableAt: Date.now() / 1000 + 0.08 }),
      download: async () => { requests++; return wave(); },
    }), error => /timed out/i.test(error.userMessage) && !error.message.includes('private-signed-url'));
    assert.equal(requests, 0);
  } finally { clearTimeout(keepAlive); }
});
