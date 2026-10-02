'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { bump } = require('../scripts/release-version.cjs');
const { createUpdateClient, verifyDownload } = require('../runtime/update-client.cjs');
test('runtime update feed matches the release publisher independently of build metadata', () => {
  const metadata = require('../package.json');
  assert.deepEqual(require('../runtime/update-config.json'), metadata.build.publish);
  assert.ok(metadata.build.files.includes('runtime/**/*'), 'runtime update configuration ships in releases');
});
test('patch release updates both authoritative versions and rejects inconsistent locks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-release-test-'));
  try {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.4.2' }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '1.4.2', packages: { '': { version: '1.4.2' } } }));
    assert.equal(bump(directory), '1.4.3'); assert.equal(bump(directory), '1.4.4');
    const lock = JSON.parse(await fs.readFile(path.join(directory, 'package-lock.json'))); assert.equal(lock.packages[''].version, '1.4.4');
    lock.version = 'broken'; await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    assert.throws(() => bump(directory), /inconsistent/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('update verification rejects missing checksums and altered installer bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freqx-update-test-'));
  try {
    const filename = path.join(directory, 'FreqX-Setup-1.8.1.exe'); const bytes = Buffer.from('fixture executable bytes');
    await fs.writeFile(filename, bytes);
    const info = { version: '1.8.1', downloadedFile: filename, files: [{ url: path.basename(filename), sha512: createHash('sha512').update(bytes).digest('base64') }] };
    await verifyDownload(info);
    await assert.rejects(verifyDownload({ ...info, files: [] }), /checksum/);
    await fs.writeFile(filename, 'tampered'); await assert.rejects(verifyDownload(info), /checksum/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('updater uses trusted configuration, blocks unverified installation and contains network failure', async () => {
  const updater = new EventEmitter(); let configuration; let installs = 0;
  updater.setFeedURL = input => { configuration = input; }; updater.quitAndInstall = () => { installs++; };
  updater.checkForUpdates = async () => { throw new Error('network error including a sensitive URL'); };
  const client = createUpdateClient({ app: { isPackaged: true, getVersion: () => '1.8.0' }, getWindow: () => null, updater, config: { provider: 'github', owner: 'reallav0', repo: 'freqx' } });
  if (process.platform === 'win32') {
    assert.equal(configuration.provider, 'github'); assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal((await client.check()).ok, false); assert.ok(!JSON.stringify(client.status()).includes('sensitive'));
    updater.emit('update-downloaded', { files: [] }); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(client.install().ok, false); assert.equal(installs, 0);
});
