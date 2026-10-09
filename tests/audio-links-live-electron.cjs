'use strict';
// Opt-in live website test: real pinned helpers, public-DNS HTTPS transport,
// sandbox decoder and library save. No transport or extractor is mocked.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  // Chromium rejects a URL followed by extra positional arguments on Windows.
  // Keep every test option in --name=value form in the native child argv.
  const args = process.argv.slice(2), childArgs = [__filename];
  for (let i = 0; i < args.length; i++) {
    if (['--url', '--repeat', '--app-root'].includes(args[i]) && args[i + 1] !== undefined) childArgs.push(args[i] + '=' + args[++i]);
    else childArgs.push(args[i]);
  }
  const result = require('node:child_process').spawnSync(require('electron'), childArgs, {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 600000,
  });
  if (result.error) console.error('Live Electron check could not complete.');
  process.exit(result.status ?? 1);
} else run().catch(error => {
  // Never expose helper stderr or a signed media URL from a network exception.
  console.error(error.userMessage || 'Live audio-link verification failed.');
  require('electron').app.exit(1);
});

async function run() {
  const { app, BrowserWindow, session } = require('electron');
  function argument(name, fallback) {
    const inline = process.argv.find(value => value.startsWith(name + '='));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
  }
  const appRoot = path.resolve(argument('--app-root', root));
  const value = argument('--url');
  const repeats = Number(argument('--repeat', '1'));
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
  const { downloadAudioLink, parseAudioLink, platformLink } = require(path.join(appRoot, 'runtime/audio-link.cjs'));
  const { AudioLinkService, validateNormalizedWav } = require(path.join(appRoot, 'runtime/audio-link-service.cjs'));
  assert.ok(platformLink(parseAudioLink(value)), 'Supply a supported website URL with --url.');
  const output = path.join(root, 'output', 'audio-links-live'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'run-'));
  const library = path.join(directory, 'library'); fs.mkdirSync(library);
  app.setPath('userData', path.join(directory, 'profile'));
  app.setPath('sessionData', path.join(directory, 'session'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  await app.whenReady();
  let imports = 0;
  const checks = [];
  const service = new AudioLinkService({ appRoot, BrowserWindow, session, tempRoot: path.join(directory, 'temporary'),
    download: (url, { signal }) => downloadAudioLink(url, { signal, toolsCache: path.join(directory, 'tools') }),
    reserve: async filename => {
      const destinationPath = path.join(library, `${imports++}-${filename}`);
      return { destinationPath, handle: await fs.promises.open(destinationPath, 'wx') };
    },
    item: filename => ({ path: filename }),
  });
  try {
    for (let attempt = 0; attempt < repeats; attempt++) {
      const start = Date.now();
      const result = await service.import(value, { owner: 'live-test' });
      assert.equal(result.ok, true); assert.equal(result.imported.length, 1);
      const wave = validateNormalizedWav(fs.readFileSync(result.imported[0].path));
      const channels = wave.readUInt16LE(22), seconds = (wave.length - 44) / channels / 2 / 48000;
      let energy = 0;
      for (let p = 44; p < wave.length; p += 2) energy += (wave.readInt16LE(p) / 32768) ** 2;
      const rms = Math.sqrt(energy / ((wave.length - 44) / 2));
      assert.ok(seconds > 0 && seconds <= 300 && rms > 0.0001);
      assert.deepEqual(fs.readdirSync(path.join(directory, 'temporary')), []);
      const check = { attempt: attempt + 1, pass: true, seconds, channels, rms, bytes: wave.length, elapsedMs: Date.now() - start };
      checks.push(check); console.log(JSON.stringify(check));
    }
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ appRoot, checks }, null, 2));
    console.log('Verified real website download, sandbox decode and import. Outputs: ' + directory);
    app.exit(0);
  } finally { service.stopAll(); }
}
