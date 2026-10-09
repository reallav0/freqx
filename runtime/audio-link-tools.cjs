'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateRaw } = require('node:zlib');
const { promisify } = require('node:util');
const manifest = require('./vendor/link-tools/manifest.json');
const inflate = promisify(inflateRaw);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// These are hash-pinned build assets, never archives obtained from a pasted URL.
// Only the named executable is extracted; no archive path is used as an output.
async function extractBinary(archive, pin) {
  if (hash(archive) !== pin.archiveSha256) throw new Error('Link helper archive integrity failure.');
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, archive.length - 65557)) throw new Error('Invalid helper archive.');
  let p = archive.readUInt32LE(end + 16), count = archive.readUInt16LE(end + 10);
  for (let n = 0; n < count; n++) {
    if (p + 46 > archive.length || archive.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid helper ZIP entry.');
    const method = archive.readUInt16LE(p + 10), compressed = archive.readUInt32LE(p + 20), size = archive.readUInt32LE(p + 24);
    const nameLength = archive.readUInt16LE(p + 28), extra = archive.readUInt16LE(p + 30), comment = archive.readUInt16LE(p + 32);
    const name = archive.toString('utf8', p + 46, p + 46 + nameLength), offset = archive.readUInt32LE(p + 42);
    p += 46 + nameLength + extra + comment;
    if (name !== pin.binary) continue;
    if (size !== pin.bytes || offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid helper ZIP payload.');
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    if (start + compressed > archive.length) throw new Error('Truncated helper ZIP.');
    const payload = archive.subarray(start, start + compressed);
    const binary = method === 0 ? payload : method === 8 ? await inflate(payload, { maxOutputLength: pin.bytes }) : null;
    if (!binary || binary.length !== pin.bytes || hash(binary) !== pin.sha256) throw new Error('Link helper executable integrity failure.');
    return binary;
  }
  throw new Error('Missing link helper executable.');
}
async function prepareLinkTools(cacheDirectory, { signal } = {}) {
  if (process.platform !== 'win32') throw new Error('Website audio links currently require Windows.');
  if (typeof cacheDirectory !== 'string' || !path.isAbsolute(cacheDirectory)) throw new Error('Missing app-owned link tools cache.');
  const directory = path.join(cacheDirectory, '2026.08.19-deno-2.9.7');
  await fs.mkdir(directory, { recursive: true });
  const result = {};
  for (const [name, pin] of Object.entries(manifest)) {
    signal?.throwIfAborted();
    const filename = path.join(directory, pin.binary);
    let bytes; try { bytes = await fs.readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes || bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) {
      const archive = await fs.readFile(path.join(__dirname, 'vendor/link-tools', pin.archive));
      bytes = await extractBinary(archive, pin);
      signal?.throwIfAborted();
      const temporary = path.join(directory, `${pin.binary}.${crypto.randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, filename); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    // Reverify the on-disk executable immediately before giving its path to spawn.
    if (hash(await fs.readFile(filename)) !== pin.sha256) throw new Error('Link helper cache integrity failure.');
    result[name] = filename;
  }
  return result;
}
module.exports = { prepareLinkTools, extractBinary };
