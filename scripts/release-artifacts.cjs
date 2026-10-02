'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function generate(directory, root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const bomPath = path.join(directory, 'SBOM.cdx.json');
  const bom = JSON.parse(fs.readFileSync(bomPath, 'utf8').replace(/^\uFEFF/, ''));
  if (bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) throw new Error('Invalid production SBOM.');
  bom.components.push({ type: 'framework', name: 'electron', version: lock.packages['node_modules/electron'].version,
    purl: `pkg:npm/electron@${lock.packages['node_modules/electron'].version}` });
  const audio = JSON.parse(fs.readFileSync(path.join(root, 'audio/vendor/deepfilter/manifest.json')));
  for (const [filename, metadata] of Object.entries(audio.files)) bom.components.push({ type: 'file', name: `DeepFilterNet/${filename}`, version: audio.upstream.commit,
    hashes: [{ alg: 'SHA-256', content: metadata.sha256 }] });
  fs.writeFileSync(bomPath, JSON.stringify(bom, null, 2) + '\n');
  const allowed = fs.readdirSync(directory).filter(name => /^(?:FreqX-(?:Setup|Portable)-\d+\.\d+\.\d+\.exe(?:\.blockmap)?|latest\.yml|SBOM\.cdx\.json)$/.test(name));
  if (!allowed.includes(`FreqX-Setup-${pkg.version}.exe`) || !allowed.includes('latest.yml')) throw new Error('Installer/updater metadata is missing.');
  const sums = allowed.sort().map(name => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums);
  return allowed;
}
if (require.main === module) { try { generate(path.resolve(__dirname, '../dist'), path.resolve(__dirname, '..')); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { generate };
