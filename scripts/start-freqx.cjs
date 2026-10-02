// Use a branded development runtime so Task Manager never labels freqx Electron.
// Keep the installed framework dependency unchanged; cache this copy per version/icon.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { brandWindowsExecutable } = require('./windows-branding.cjs');
const root = path.resolve(__dirname, '..');

async function prepareRuntime() {
  const original = require('electron');
  if (process.platform !== 'win32') return original;
  const version = require('electron/package.json').version;
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'logo.ico')))
    .update(fs.readFileSync(path.join(__dirname, 'windows-branding.cjs')))
    .digest('hex').slice(0, 12);
  const directory = path.join(root, 'output', 'freqx-runtime', `${version}-${hash}`);
  const executable = path.join(directory, 'freqx.exe');
  const ready = path.join(directory, '.ready');
  if (!fs.existsSync(ready) || !fs.existsSync(executable)) {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.cp(path.dirname(original), directory, { recursive: true });
    await fs.promises.rename(path.join(directory, 'electron.exe'), executable);
    brandWindowsExecutable(executable, root);
    fs.writeFileSync(ready, version);
  }
  return executable;
}

if (require.main === module) {
  prepareRuntime().then(executable => {
    if (process.argv.includes('--prepare-only')) { console.log(executable); return; }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', error => { console.error(`Could not start freqx: ${error.message}`); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareRuntime };
