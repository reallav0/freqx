'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = path.resolve(__dirname, '../runtime/vendor/link-tools');
const manifest = require('../runtime/vendor/link-tools/manifest.json');
for (const [name, pin] of Object.entries(manifest)) {
  const bytes = fs.readFileSync(path.join(directory, pin.archive));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== pin.archiveSha256) throw new Error('Link tools integrity failure: ' + name);
}
const source = fs.readFileSync(path.join(directory, 'yt-dlp-source.tar.gz'));
if (crypto.createHash('sha256').update(source).digest('hex') !== '072aad4f2a7604e92155f61a275a4752dc64046c8f6d90df3710525d94cd37c1') throw new Error('Link tools source integrity failure.');
for (const name of ['YTDLP-LICENSE.txt','YTDLP-THIRD-PARTY-LICENSES.txt','GPL-3.0.txt','DENO-LICENSE.txt','DENO-THIRD-PARTY-LICENSES.txt','DENO-rust-dependencies.json','V8-BSD-3-Clause.txt','TypeScript-APACHE.txt']) {
  if (!fs.statSync(path.join(directory, name)).size) throw new Error('Missing link tool attribution: ' + name);
}
console.log('Verified pinned local website audio helpers and notices. No runtime tool downloads.');
