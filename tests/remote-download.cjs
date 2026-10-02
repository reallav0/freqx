'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const dns = require('node:dns');
const { downloadBytes, parseRemoteUrl, isPublicAddress, publicLookup } = require('../runtime/remote-download.cjs');
const url = 'https://audio.freqx.app/sound.mp3';

function transport(responses) {
  let calls = 0;
  const request = (target, options, callback) => {
    calls++;
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
  return { request, calls: () => calls };
}

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
