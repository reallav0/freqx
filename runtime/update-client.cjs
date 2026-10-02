'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { isPackagedApp } = require('./app-mode.cjs');
async function verifyDownload(info) {
  if (!/^\d+\.\d+\.\d+$/.test(info.version || '')) throw new Error('Invalid update version.');
  const filename = info.downloadedFile;
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !filename.toLowerCase().endsWith('.exe')) throw new Error('Invalid update file.');
  const entry = info.files?.find(file => typeof file.url === 'string' && path.basename(new URL(file.url, 'https://github.com').pathname) === path.basename(filename));
  if (!entry || typeof entry.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)) throw new Error('Update checksum is missing.');
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 536870912) throw new Error('Invalid update size.');
  const digest = createHash('sha512'); let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) { bytes += chunk.length; if (bytes > stat.size) throw new Error('Update file changed.'); digest.update(chunk); }
  if (bytes !== stat.size || !timingSafeEqual(digest.digest(), Buffer.from(entry.sha512, 'base64'))) throw new Error('Update checksum failed.');
}
function createUpdateClient({ app, getWindow, updater, config, portable = false }) {
  let state = { status: 'idle', currentVersion: app.getVersion() }; let checking; let ready = false;
  const supported = isPackagedApp(app) && process.platform === 'win32' && !portable;
  const notify = next => {
    state = { ...state, ...next }; const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('app:update-state', state);
  };
  if (supported) {
    if (config?.provider !== 'github' || !/^[A-Za-z0-9_.-]+$/.test(config.owner || '') || !/^[A-Za-z0-9_.-]+$/.test(config.repo || '')) throw new Error('Invalid trusted update configuration.');
    updater.setFeedURL({ provider: 'github', owner: config.owner, repo: config.repo, private: false, releaseType: 'release' });
    updater.autoDownload = true; updater.autoInstallOnAppQuit = false; updater.allowPrerelease = false; updater.allowDowngrade = false; updater.logger = null;
    updater.on('checking-for-update', () => notify({ status: 'checking' }));
    updater.on('update-not-available', () => notify({ status: 'none', updateAvailable: false }));
    updater.on('update-available', info => {
      if (!/^\d+\.\d+\.\d+$/.test(info.version)) { ready = false; notify({ status: 'error', message: 'Invalid release version.' }); return; }
      ready = false; notify({ status: 'available', updateAvailable: true, latestVersion: info.version });
    });
    updater.on('download-progress', progress => notify({ status: 'downloading', percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)) }));
    updater.on('update-downloaded', info => {
      ready = false;
      verifyDownload(info).then(() => { ready = true; notify({ status: 'downloaded', latestVersion: info.version, message: 'Update verified. Restart to install.' }); })
        .catch(() => notify({ status: 'error', message: 'Update verification failed. Installation is blocked.' }));
    });
    updater.on('error', () => { ready = false; notify({ status: 'error', message: 'Update service is unavailable. Try again later.' }); });
  }
  return {
    status: () => ({ ...state }),
    async check() {
      if (!supported) return { ok: false, status: 'unsupported', message: 'Automatic updates require an installed Windows release. Portable and development builds update manually.' };
      if (!checking) checking = updater.checkForUpdates().catch(() => { ready = false; notify({ status: 'error', message: 'Update service is unavailable. Try again later.' }); }).finally(() => { checking = null; });
      await checking; return { ok: state.status !== 'error', ...state };
    },
    install() { if (!ready || state.status !== 'downloaded') return { ok: false, message: 'No verified update is ready.' }; ready = false; updater.quitAndInstall(false, true); return { ok: true }; }
  };
}
module.exports = { createUpdateClient, verifyDownload };
