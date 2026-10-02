'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function bump(root) {
  const filename = path.join(root, 'package.json'); const lockfile = path.join(root, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(filename)); const lock = JSON.parse(fs.readFileSync(lockfile));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Package versions are inconsistent.');
  const parts = pkg.version.split('.').map(Number); parts[2]++;
  const version = parts.join('.'); pkg.version = version; lock.version = version; lock.packages[''].version = version;
  fs.writeFileSync(filename, JSON.stringify(pkg, null, 2) + '\n'); fs.writeFileSync(lockfile, JSON.stringify(lock, null, 2) + '\n');
  return version;
}
function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SOURCE_SHA || '')) throw new Error('Release automation requires a trusted GitHub main push.');
  const root = path.resolve(__dirname, '..'); const source = process.env.RELEASE_SOURCE_SHA;
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git(['fetch', 'origin', 'main', '--tags']);
  let tag;
  for (const candidate of git(['tag', '--list', 'v*', '--sort=-version:refname']).split('\n').filter(Boolean)) {
    if (/^v\d+\.\d+\.\d+$/.test(candidate) && git(['show', '-s', '--format=%B', candidate]).includes(`Release-Source: ${source}`)) { tag = candidate; break; }
  }
  if (!tag) {
    if (git(['rev-parse', 'origin/main']) !== source) throw new Error('Main advanced while checks ran. Rerun the latest main release; no unchecked commit will be published.');
    git(['checkout', '-B', 'main', source]);
    const version = bump(root); tag = `v${version}`;
    git(['config', 'user.name', 'github-actions[bot]']); git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    git(['add', 'package.json', 'package-lock.json']);
    git(['commit', '-m', `chore(release): ${tag} [skip ci]`, '-m', `Release-Source: ${source}`]);
    git(['tag', '-a', tag, '-m', `FreqX ${tag}\nRelease-Source: ${source}`]);
    try { git(['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${tag}`]); }
    catch { throw new Error('Release push rejected. Configure main protection for the release bot; no remote partial commit/tag was pushed. See docs/implementation/releases.md.'); }
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow output path.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\ncommit=${git(['rev-parse', `${tag}^{commit}`])}\n`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { bump };
