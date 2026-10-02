'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
async function cleanup(directory, temporaryRoot) {
  if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith('run-')) throw new Error('Unsafe source scan cleanup.');
  await fs.rm(directory, { recursive: true, force: true });
}
async function main() {
  const root = path.resolve(__dirname, '..'); const temporaryRoot = path.join(root, '.local/source-scans');
  await fs.mkdir(temporaryRoot, { recursive: true }); const directory = await fs.mkdtemp(path.join(temporaryRoot, 'run-'));
  try {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--deduplicate', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const filename of files) {
      const source = path.resolve(root, filename); const target = path.resolve(directory, filename);
      if (!source.startsWith(root + path.sep) || !target.startsWith(directory + path.sep)) throw new Error('Unsafe source scan path.');
      const stat = await fs.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
    }
    const command = process.env.GITLEAKS_BIN || 'gitleaks';
    const result = spawnSync(command, ['dir', '.', '--config', path.join(root, '.gitleaks.toml'), '--redact', '--no-banner'], { cwd: directory, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error; process.exitCode = result.status ?? 1;
  } finally {
    await cleanup(directory, temporaryRoot);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
