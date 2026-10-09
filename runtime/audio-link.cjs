'use strict';
const net = require('node:net');
const path = require('node:path');
const { downloadBytes } = require('./remote-download.cjs');
const { config } = require('./desktop-config.cjs');

const MAX_BYTES = config.catalog.remoteSoundBytes;
const MAX_SECONDS = config.catalog.maxDurationSeconds;
function linkError(message, code = 'AUDIO_LINK_INVALID') {
  return Object.assign(new Error(message), { code, userMessage: message });
}
function parseAudioLink(value) {
  if (typeof value !== 'string' || !value || value.length > config.network.maxUrlLength
      || /[\u0000-\u0020\u007f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) {
    throw linkError('Paste a valid HTTPS audio link.');
  }
  let url; try { url = new URL(value); } catch { throw linkError('Paste a valid HTTPS audio link.'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw linkError('Use HTTPS without a password, fragment, or custom port.');
  }
  // Require a public DNS name, not IP literals, Windows shares or intranet names.
  if (net.isIP(host.replace(/^\[|\]$/g, '')) || host.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
      || /\.(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) {
    throw linkError('Local, private and reserved addresses are blocked.');
  }
  return url;
}
function platformLink(url) {
  const host = url.hostname;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    let id;
    if (host === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    else if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) throw linkError('Use a link to one public YouTube video.');
    return { site: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(host)) {
    if (!/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
        || /^\/(?:discover|search|stream|you)\//.test(url.pathname) || /\/sets\/?$/.test(url.pathname)) {
      throw linkError('Use a link to one public SoundCloud track.');
    }
    return { site: 'soundcloud', url: `https://soundcloud.com${url.pathname.replace(/\/$/, '')}` };
  }
  return null;
}
const MIME = new Map([
  ['audio/wav', '.wav'], ['audio/wave', '.wav'], ['audio/x-wav', '.wav'], ['audio/vnd.wave', '.wav'],
  ['audio/mpeg', '.mp3'], ['audio/mp3', '.mp3'], ['audio/x-mp3', '.mp3'],
  ['audio/ogg', '.ogg'], ['application/ogg', '.ogg'], ['audio/opus', '.ogg'],
  ['audio/flac', '.flac'], ['audio/x-flac', '.flac'],
  ['audio/aac', '.aac'], ['audio/aacp', '.aac'], ['audio/mp4', '.m4a'], ['audio/x-m4a', '.m4a']
]);
function contentType(headers) {
  const value = headers['content-type'];
  if (value !== undefined && typeof value !== 'string') throw linkError('Invalid audio response.');
  return (value || '').split(';')[0].trim().toLowerCase();
}
function validateAudioHeaders(headers) {
  const type = contentType(headers);
  if (type && !MIME.has(type) && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    throw linkError('This link returns a webpage or unsupported file. Use a direct audio, YouTube or SoundCloud link.');
  }
}
function boundedAudio(sampleRate, channels, samples = 0) {
  return sampleRate >= 8000 && sampleRate <= 96000 && channels >= 1 && channels <= 2
    && samples / sampleRate <= MAX_SECONDS;
}
function wav(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
      || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let format, data = 0;
  for (let p = 12; p + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4), start = p + 8;
    if (start + size > bytes.length) return false;
    if (tag === 'fmt ') {
      if (size < 16) return false;
      const code = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2), rate = bytes.readUInt32LE(start + 4);
      const block = bytes.readUInt16LE(start + 12), bits = bytes.readUInt16LE(start + 14);
      if (![1, 3].includes(code) || ![8, 16, 24, 32].includes(bits) || code === 3 && bits !== 32
          || !boundedAudio(rate, channels) || block !== channels * bits / 8 || bytes.readUInt32LE(start + 8) !== rate * block) return false;
      format = { rate, channels, block };
    } else if (tag === 'data') data += size;
    p = start + size + (size & 1);
  }
  return Boolean(format && data > 0 && data % format.block === 0 && boundedAudio(format.rate, format.channels, data / format.block));
}
function mp3Frame(bytes, p) {
  if (p + 4 > bytes.length || bytes[p] !== 255 || (bytes[p + 1] & 0xe0) !== 0xe0) return 0;
  const version = (bytes[p + 1] >> 3) & 3, layer = (bytes[p + 1] >> 1) & 3, bi = bytes[p + 2] >> 4, ri = (bytes[p + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bi === 0 || bi === 15 || ri === 3) return 0;
  const rates = [44100, 48000, 32000], rate = rates[ri] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bi];
  const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + ((bytes[p + 2] >> 1) & 1);
  return p + length <= bytes.length ? length : 0;
}
function mp3(bytes) {
  let p = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || ![2,3,4].includes(bytes[3]) || bytes.subarray(6, 10).some(b => b > 127)) return false;
    p = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0);
  }
  const first = mp3Frame(bytes, p);
  return Boolean(first && mp3Frame(bytes, p + first));
}
function ogg(bytes) {
  let p = 0, audioStreams = 0;
  while (p + 27 <= bytes.length) {
    if (bytes.toString('ascii', p, p + 4) !== 'OggS' || bytes[p + 4] !== 0) return false;
    const segments = bytes[p + 26];
    if (p + 27 + segments > bytes.length) return false;
    let size = 0; for (let i = 0; i < segments; i++) size += bytes[p + 27 + i];
    const payload = p + 27 + segments;
    if (payload + size > bytes.length) return false;
    if (bytes[p + 5] & 2) {
      if (size >= 19 && bytes.toString('ascii', payload, payload + 8) === 'OpusHead') {
        if (bytes[payload + 9] < 1 || bytes[payload + 9] > 2) return false;
      } else if (size >= 30 && bytes[payload] === 1 && bytes.toString('ascii', payload + 1, payload + 7) === 'vorbis') {
        if (!boundedAudio(bytes.readUInt32LE(payload + 12), bytes[payload + 11])) return false;
      } else return false;
      audioStreams++;
    }
    p = payload + size;
  }
  return audioStreams > 0 && p === bytes.length;
}
function m4a(bytes) {
  let audioTracks = 0, media = false, ftyp = false, invalid = false, boxes = 0;
  function walk(start, end, depth) {
    if (depth > 5) { invalid = true; return; }
    let p = start;
    while (p + 8 <= end) {
      if (++boxes > 10000) { invalid = true; return; }
      let size = bytes.readUInt32BE(p), head = 8;
      if (size === 1) {
        if (p + 16 > end) { invalid = true; return; }
        const n = bytes.readBigUInt64BE(p + 8); if (n > BigInt(bytes.length)) { invalid = true; return; }
        size = Number(n); head = 16;
      } else if (size === 0) size = end - p;
      if (size < head || p + size > end) { invalid = true; return; }
      const type = bytes.toString('ascii', p + 4, p + 8), data = p + head;
      if (type === 'ftyp' && depth === 0 && size >= 16) ftyp = true;
      if (type === 'mdat' && depth === 0 && size > head) media = true;
      if (['moov','trak','mdia'].includes(type)) walk(data, p + size, depth + 1);
      if (type === 'hdlr' && depth === 3) {
        if (size < head + 12 || bytes.toString('ascii', data + 8, data + 12) !== 'soun') invalid = true;
        else audioTracks++;
      }
      p += size;
    }
    if (p !== end) invalid = true;
  }
  walk(0, bytes.length, 0);
  return ftyp && media && audioTracks > 0 && !invalid;
}
function sniffAudio(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_BYTES) throw linkError('Audio links must return a nonempty file no larger than 24 MB.');
  let extension;
  if (wav(bytes)) extension = '.wav';
  else if (bytes.toString('ascii', 0, 4) === 'fLaC' && bytes.length >= 42 && (bytes[4] & 127) === 0 && bytes.readUIntBE(5, 3) === 34) {
    const packed = bytes.readBigUInt64BE(18), rate = Number(packed >> 44n), channels = Number((packed >> 41n) & 7n) + 1, samples = Number(packed & 0xfffffffffn);
    if (boundedAudio(rate, channels, samples)) extension = '.flac';
  } else if (mp3(bytes)) extension = '.mp3';
  else if (ogg(bytes)) extension = '.ogg';
  else if (bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0) {
    const rateIndex = (bytes[2] >> 2) & 15, channels = ((bytes[2] & 1) << 2) | (bytes[3] >> 6), length = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
    if (rateIndex >= 1 && rateIndex <= 11 && channels >= 1 && channels <= 2 && length >= 7 && length + 2 <= bytes.length && bytes[length] === 255 && (bytes[length + 1] & 0xf6) === 0xf0) extension = '.aac';
  } else if (m4a(bytes)) extension = '.m4a';
  if (!extension) throw linkError('This is not a supported audio file. Webpages, scripts, archives and executables are blocked.');
  return extension;
}
function safeFilename(url, extension, title) {
  let raw = title || path.posix.basename(url.pathname); try { raw = decodeURIComponent(raw); } catch { raw = ''; }
  const stem = path.parse(raw).name.replace(/[^a-zA-Z0-9 _-]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${stem && !/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? stem : 'linked-audio'}${extension}`;
}
async function downloadAudioLink(value, { signal, resolvePlatform, download = downloadBytes, toolsCache } = {}) {
  let url = parseAudioLink(value), title;
  signal?.throwIfAborted();
  const platform = platformLink(url);
  if (platform) {
    const resolver = resolvePlatform || require('./audio-link-platform.cjs').resolvePlatformLink;
    const result = await resolver(platform, { signal, toolsCache });
    url = parseAudioLink(result.url); title = result.title;
    const mediaHosts = platform.site === 'youtube' ? ['googlevideo.com'] : ['sndcdn.com', 'soundcloud.com'];
    if (!mediaHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw linkError('The site returned an unsupported audio host.');
  }
  let headers, finalUrl;
  signal?.throwIfAborted();
  let bytes;
  try {
    bytes = await download(url.href, MAX_BYTES, {
      signal, timeoutMs: config.network.protocolAudioTimeoutMs, parseUrl: parseAudioLink,
      validateResponse: validateAudioHeaders, onComplete: (h, u) => { headers = h; finalUrl = u; }
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error.userMessage) throw error;
    if (error.name === 'TimeoutError') throw linkError('The audio download timed out. Try a shorter clip.');
    throw linkError('The audio download failed its network, size or response checks.');
  }
  signal?.throwIfAborted();
  const extension = sniffAudio(bytes), type = contentType(headers || {});
  if (MIME.has(type) && MIME.get(type) !== extension) throw linkError('The audio format does not match its Content-Type.');
  return { bytes, filename: safeFilename(finalUrl || url, extension, title), finalUrl: (finalUrl || url).href, contentType: type, ...(title ? { title } : {}) };
}
module.exports = { downloadAudioLink, parseAudioLink, platformLink, sniffAudio, validateAudioHeaders, safeFilename, linkError, MAX_BYTES, MAX_SECONDS };
