'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const dns = require('node:dns');
const { downloadBytes, parseRemoteUrl, isPublicAddress, publicLookup, safeMediaHeaders } = require('../runtime/remote-download.cjs');
const url = 'https://audio.freqx.app/sound.mp3';

function transport(responses) {
  let calls = 0;
  const requests = [];
  const request = (target, options, callback) => {
    calls++;
    requests.push({ target, options });
    const req = new EventEmitter();
    const onAbort = () => req.emit('error', options.signal.reason);
    options.signal.addEventListener('abort', onAbort, { once: true });
    queueMicrotask(() => {
      const record = responses[Math.min(calls - 1, responses.length - 1)];
      if (record.hang) return;
      const response = Readable.from((record.chunks || [Buffer.from('audio')]).map(chunk => Buffer.from(chunk)));
      response.statusCode = record.status || 200;
      response.headers = record.headers || {};
      response.complete = record.complete !== false;
      response.on('close', () => options.signal.removeEventListener('abort', onAbort));
      callback(response);
    });
    return req;
  };
  return { request, calls: () => calls, requests };
}

const lowerHeaders = headers => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

test('streams without Content-Length but stops at the enforced byte limit', async () => {
  assert.equal((await downloadBytes(url, 5, transport([{}]))).toString(), 'audio');
  await assert.rejects(downloadBytes(url, 5, transport([{ chunks: ['123', '456'] }])), /size limit/);
});

test('rejects false, malformed, oversized and truncated response lengths', async () => {
  for (const length of ['2', '7', '-1', 'NaN', '1e3', '999999999999999999999']) {
    await assert.rejects(downloadBytes(url, 6, transport([{ headers: { 'content-length': length } }])));
  }
  await assert.rejects(downloadBytes(url, 6, transport([{ complete: false }])), /incomplete/);
  await assert.rejects(downloadBytes(url, 6, transport([{ chunks: [] }])), /incomplete/);
  await assert.rejects(downloadBytes(url, 6, transport([{ status: 206 }])), /206/);
  await assert.rejects(downloadBytes(url, 6, transport([{ headers: { 'content-encoding': 'gzip' } }])), /Encoded/);
});

test('validates each redirect and caps the entire redirect chain', async () => {
  const request = transport([{ status: 302, headers: { location: '/next' } }, {}]);
  assert.equal((await downloadBytes(url, 5, request)).length, 5);
  assert.equal(request.calls(), 2);
  const loop = transport([{ status: 302, headers: { location: '/next' } }]);
  await assert.rejects(downloadBytes(url, 5, { ...loop, maxRedirects: 2 }), /Too many/);
  assert.equal(loop.calls(), 3);
  for (const location of ['http://audio.freqx.app/a', 'file:///etc/passwd', 'https://127.0.0.1/a', 'https://evil.r2.dev/a', 'https://user:pass@audio.freqx.app/a']) {
    await assert.rejects(downloadBytes(url, 5, transport([{ status: 302, headers: { location } }])));
  }
});

test('cancellation and whole-operation deadlines reject stalled transfers', async () => {
  const controller = new AbortController();
  const pending = downloadBytes(url, 5, { ...transport([{ hang: true }]), signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  // Keep the process alive while the unref'ed AbortSignal timeout fires.
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(downloadBytes(url, 5, { ...transport([{ hang: true }]), timeoutMs: 10 }), /timeout/i); }
  finally { clearTimeout(keepAlive); }
});

test('URL and connection-time DNS policies reject local and reserved destinations', async () => {
  for (const value of ['garbage', url + '\n', 'https://audio.freqx.app:8080/a', 'https://audio.freqx.app/a#b', 'https:\\audio.freqx.app']) {
    assert.throws(() => parseRemoteUrl(value));
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const original = dns.lookup;
  try {
    dns.lookup = (host, options, callback) => callback(null, [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await assert.rejects(new Promise((resolve, reject) => publicLookup('audio.freqx.app', {}, error => error ? reject(error) : resolve())), /not public/);
  } finally { dns.lookup = original; }
});

test('internal media headers retain only bounded ASCII browser request headers', () => {
  const headers = safeMediaHeaders({ 'User-Agent': 'Mozilla/5.0', Accept: '*/*', 'accept-language': 'en-US,en;q=0.5',
    Cookie: 'private-cookie', Authorization: 'Bearer private', Host: '127.0.0.1', Range: 'bytes=100-',
    'Accept-Encoding': 'gzip', Referer: 'https://youtube.com/?private=query', 'Proxy-Authorization': 'private',
    'X-Forwarded-For': '127.0.0.1', Unknown: 'discard' });
  assert.deepEqual(lowerHeaders(headers), { 'user-agent': 'Mozilla/5.0', accept: '*/*', 'accept-language': 'en-US,en;q=0.5' });
  for (const name of ['User-Agent', 'Accept', 'Accept-Language']) {
    for (const value of ['browser\r\nCookie: secret', 'browser\u0000', 'browser\u007f', 'non-ASCII-é', ['browser'], {}, 1, 'x'.repeat(1025)]) {
      assert.throws(() => safeMediaHeaders({ [name]: value }), undefined, `${name} rejects ${JSON.stringify(value)}`);
    }
  }
});

test('whole-file Range is opt-in and accepts only a complete bounded partial response', async () => {
  const partial = transport([{ status: 206, headers: { 'content-range': 'bytes 0-4/5', 'content-length': '5' } }]);
  assert.equal((await downloadBytes(url, 6, { ...partial, wholeFileRange: true,
    requestHeaders: { 'User-Agent': 'Mozilla/5.0', Accept: 'audio/*', Cookie: 'discard', 'Accept-Encoding': 'gzip' } })).toString(), 'audio');
  const headers = lowerHeaders(partial.requests[0].options.headers);
  assert.equal(headers.range, 'bytes=0-5');
  assert.equal(headers['user-agent'], 'Mozilla/5.0');
  assert.equal(headers.accept, 'audio/*');
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers.cookie, undefined);
  assert.equal(partial.requests[0].options.lookup, publicLookup);
  assert.equal(partial.requests[0].options.rejectUnauthorized, true);
  const noLength = transport([{ status: 206, headers: { 'content-range': 'bytes 0-4/5' } }]);
  assert.equal((await downloadBytes(url, 6, { ...noLength, wholeFileRange: true })).toString(), 'audio');
  const ignored = transport([{ status: 200, headers: { 'content-length': '5' } }]);
  assert.equal((await downloadBytes(url, 6, { ...ignored, wholeFileRange: true })).toString(), 'audio');
  const catalog = transport([{ status: 206, headers: { 'content-range': 'bytes 0-4/5' } }]);
  await assert.rejects(downloadBytes(url, 6, catalog), error => error.httpStatus === 206);
  assert.equal(lowerHeaders(catalog.requests[0].options.headers).range, undefined);
});

test('whole-file Range rejects gaps, partial segments, malformed totals and mismatched bodies', async () => {
  for (const contentRange of [undefined, '', 'bytes 1-5/6', 'bytes 0-3/5', 'bytes 0-5/5', 'bytes 0-6/7',
    'bytes 0-4/*', 'bytes */5', 'bytes 0-0/0', 'bytes 0-4/NaN', 'bytes 0-4/999999999999999999999',
    'bytes 0-4/5\r\nX: y', ['bytes 0-4/5'], 'items 0-4/5', 'bytes 0-4/5, 0-4/5']) {
    await assert.rejects(downloadBytes(url, 6, { ...transport([{ status: 206, headers: { 'content-range': contentRange } }]), wholeFileRange: true }), undefined, String(contentRange));
  }
  for (const record of [
    { headers: { 'content-range': 'bytes 0-4/5', 'content-length': '4' } },
    { headers: { 'content-range': 'bytes 0-4/5', 'content-length': '6' } },
    { headers: { 'content-range': 'bytes 0-4/5' }, chunks: ['audi'] },
    { headers: { 'content-range': 'bytes 0-4/5' }, chunks: ['audio', 'x'] },
    { headers: { 'content-range': 'bytes 0-4/5' }, complete: false },
    { headers: { 'content-range': 'bytes 0-4/5', 'content-encoding': 'gzip' } },
    { headers: { 'content-range': 'bytes 0-5/6' }, chunks: ['123', '456', '7'] },
  ]) await assert.rejects(downloadBytes(url, 6, { ...transport([{ ...record, status: 206 }]), wholeFileRange: true }));
});

test('whole-file Range keeps redirect security and HTTP errors expose only a numeric status', async () => {
  for (const location of ['http://audio.freqx.app/x', 'https://127.0.0.1/x', 'https://user:password@audio.freqx.app/x']) {
    const attempt = transport([{ status: 302, headers: { location } }]);
    await assert.rejects(downloadBytes(url, 6, { ...attempt, wholeFileRange: true }));
    assert.equal(attempt.calls(), 1);
  }
  const attempt = transport([{ status: 302, headers: { location: '/next' } }, { status: 206, headers: { 'content-range': 'bytes 0-4/5' } }]);
  await downloadBytes(url, 6, { ...attempt, wholeFileRange: true });
  assert.equal(attempt.calls(), 2);
  assert.ok(attempt.requests.every(({ options }) => lowerHeaders(options.headers).range === 'bytes=0-5' && options.lookup === publicLookup && options.rejectUnauthorized));
  await assert.rejects(downloadBytes(url + '?token=private-signed-url', 6, transport([{ status: 403 }])), error =>
    error.httpStatus === 403 && error.code === 'PUBLIC_LIBRARY_UNAVAILABLE' && !error.message.includes('private-signed-url'));
});
