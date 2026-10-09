'use strict';

const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { config: desktopConfig } = require('./desktop-config.cjs');


const DEFAULT_HOSTS = desktopConfig.network.allowedAudioHosts;
const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3]
]) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
blockedV6.addSubnet('2001:db8::', 32, 'ipv6');
blockedV6.addSubnet('2001::', 23, 'ipv6'); // IETF special-purpose space, including Teredo/ORCHID
blockedV6.addSubnet('2002::', 16, 'ipv6'); // 6to4 tunnelling
blockedV6.addSubnet('3fff::', 20, 'ipv6'); // Documentation space

function downloadError(message) {
  return Object.assign(new Error(message), { code: 'PUBLIC_LIBRARY_UNAVAILABLE' });
}

function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return !blockedV4.check(address, 'ipv4');
  if (version === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

function parseRemoteUrl(value, allowedHosts = DEFAULT_HOSTS) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw downloadError('Invalid remote library URL.');
  }
  let url;
  try { url = new URL(value); } catch { throw downloadError('Invalid remote library URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !allowedHosts.includes(url.hostname) || url.hash || value.length > desktopConfig.network.maxUrlLength) {
    throw downloadError('Remote library URL is not allowed.');
  }
  return url;
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, entries) => {
    if (error) return callback(error);
    if (!entries.length || entries.some(entry => !isPublicAddress(entry.address))) {
      return callback(downloadError('Remote library address is not public.'));
    }
    if (options?.all) return callback(null, entries);
    callback(null, entries[0].address, entries[0].family);
  });
}

// One deadline covers DNS, every redirect and the complete streamed body.
// request injection is only for tests; production always uses HTTPS and the
// DNS policy at the actual connection, avoiding a validation/connection race.
async function downloadBytes(value, limit, {
  signal, timeoutMs = desktopConfig.network.downloadTimeoutMs, maxRedirects = desktopConfig.network.maxRedirects, allowedHosts = DEFAULT_HOSTS,
  request = https.get, lookup = publicLookup,
  // Internal callers can use a different URL policy without broadening the
  // catalog allowlist. Never accept these callbacks/options over IPC.
  parseUrl = input => parseRemoteUrl(input, allowedHosts), validateResponse, onComplete
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid download limit');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = parseUrl(value);
  for (let redirects = 0; ; redirects++) {
    combined.throwIfAborted();
    const result = await new Promise((resolve, reject) => {
      let req;
      try {
        req = request(url, {
          signal: combined, lookup, agent: false, rejectUnauthorized: true,
          headers: { 'User-Agent': 'freqx', 'Accept-Encoding': 'identity' }
        }, response => {
          const fail = error => { response.destroy(); reject(error); };
          response.on('error', reject);
          const status = Number(response.statusCode);
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy();
            if (redirects >= maxRedirects) return reject(downloadError('Too many library redirects.'));
            try {
              if (typeof response.headers.location !== 'string' || /[\u0000-\u0020\u007f\\]/.test(response.headers.location)) throw downloadError('Invalid library redirect.');
              const location = new URL(response.headers.location, url).href;
              resolve({ redirect: parseUrl(location) });
            } catch (error) { reject(error); }
            return;
          }
          if (status !== 200) return fail(downloadError(`Library download returned HTTP ${status}.`));
          const encoding = response.headers['content-encoding'];
          if (encoding && encoding !== 'identity') return fail(downloadError('Encoded library responses are not supported.'));
          try { validateResponse?.(response.headers, url); } catch (error) { return fail(error); }
          const rawLength = response.headers['content-length'];
          let declared;
          if (rawLength !== undefined) {
            if (typeof rawLength !== 'string' || !/^\d+$/.test(rawLength)) return fail(downloadError('Invalid library Content-Length.'));
            declared = Number(rawLength);
            if (!Number.isSafeInteger(declared) || declared < 1 || declared > limit) return fail(downloadError('Library asset exceeds its size limit.'));
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > limit || (declared !== undefined && bytes > declared)) {
              return fail(downloadError('Library asset exceeds its size limit or declared length.'));
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on('aborted', () => reject(downloadError('Library download was interrupted.')));
          response.on('end', () => {
            if (!response.complete || bytes === 0 || (declared !== undefined && bytes !== declared)) {
              return reject(downloadError('Library download was incomplete.'));
            }
            try { onComplete?.(response.headers, url); } catch (error) { return reject(error); }
            resolve({ bytes: Buffer.concat(chunks, bytes) });
          });
        });
        req.on('error', reject);
      } catch (error) { reject(error); }
    });
    if (result.bytes) return result.bytes;
    url = result.redirect;
  }
}

module.exports = { downloadBytes, parseRemoteUrl, isPublicAddress, publicLookup, DEFAULT_HOSTS };
