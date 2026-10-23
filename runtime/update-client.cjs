'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { isPackagedApp } = require('./app-mode.cjs');
const { config: desktopConfig } = require('./desktop-config.cjs');

async function verifyDownload(info) {
  if (!/^\d+\.\d+\.\d+$/.test(info.version || '')) throw new Error('Invalid update version.');
  const filename = info.downloadedFile;
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !filename.toLowerCase().endsWith('.exe')) throw new Error('Invalid update file.');
  const entry = info.files?.find(file => typeof file.url === 'string' && path.basename(new URL(file.url, 'https://github.com').pathname) === path.basename(filename));
  if (!entry || typeof entry.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)) throw new Error('Update checksum is missing.');
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > desktopConfig.updater.installerBytes) throw new Error('Invalid update size.');
  const digest = createHash('sha512'); let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) { bytes += chunk.length; if (bytes > stat.size) throw new Error('Update file changed.'); digest.update(chunk); }
  if (bytes !== stat.size || !timingSafeEqual(digest.digest(), Buffer.from(entry.sha512, 'base64'))) throw new Error('Update checksum failed.');
}
function createUpdateClient({ app, getWindow, updater, config, portable = false }) {
  let state = { status: 'idle', currentVersion: app.getVersion() }; let checking; let ready = false; let verificationGeneration = 0;
  let stopChecks = () => {};
  const supported = isPackagedApp(app) && process.platform === 'win32' && !portable;
  const notify = next => {
    state = { ...state, ...next }; const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed?.()) {
      // A renderer can close between the lifecycle check and IPC delivery. The
      // replacement renderer retrieves the retained state through updateStatus.
      try { window.webContents.send('app:update-state', state); } catch {}
    }
  };
  const invalidate = () => { ready = false; return ++verificationGeneration; };
  const failed = () => { invalidate(); notify({ status: 'error', message: 'Update service is unavailable. Try again later.' }); };
  if (supported) {
    if (config?.provider !== 'github' || !/^[A-Za-z0-9_.-]+$/.test(config.owner || '') || !/^[A-Za-z0-9_.-]+$/.test(config.repo || '')) throw new Error('Invalid trusted update configuration.');
    updater.setFeedURL({ provider: 'github', owner: config.owner, repo: config.repo, private: false, releaseType: 'release' });
    updater.autoDownload = true; updater.autoInstallOnAppQuit = false; updater.allowPrerelease = false; updater.allowDowngrade = false; updater.logger = null;
    updater.on('checking-for-update', () => { invalidate(); notify({ status: 'checking' }); });
    updater.on('update-not-available', () => { invalidate(); notify({ status: 'none', updateAvailable: false }); });
    updater.on('update-available', info => {
      invalidate();
      if (!/^\d+\.\d+\.\d+$/.test(info.version)) { notify({ status: 'error', message: 'Invalid release version.' }); return; }
      notify({ status: 'available', updateAvailable: true, latestVersion: info.version });
    });
    updater.on('download-progress', progress => notify({ status: 'downloading', percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)) }));
    updater.on('update-downloaded', info => {
      const generation = invalidate();
      verifyDownload(info).then(() => {
        if (generation !== verificationGeneration) return;
        ready = true; notify({ status: 'downloaded', latestVersion: info.version, message: 'Update verified. Restart to install.' });
      }).catch(() => {
        if (generation === verificationGeneration) notify({ status: 'error', message: 'Update verification failed. Installation is blocked.' });
      });
    });
    updater.on('error', failed);
  }
  const client = {
    status: () => ({ ...state }),
    startChecks(timers = globalThis) {
      stopChecks();
      if (!supported) return () => {};
      let stopped = false, timer;
      const schedule = delay => { timer = timers.setTimeout(poll, delay); timer.unref?.(); };
      const poll = () => {
        if (stopped) return;
        // Keep a downloaded update ready to install and avoid disturbing a
        // transfer already in progress when a periodic check becomes due.
        if (!['checking', 'available', 'downloading', 'downloaded'].includes(state.status)) void client.check();
        schedule(desktopConfig.updater.checkIntervalMs);
      };
      stopChecks = () => { stopped = true; timers.clearTimeout(timer); };
      schedule(desktopConfig.updater.startupDelayMs);
      return stopChecks;
    },
    async check() {
      if (!supported) return { ok: false, status: 'unsupported', message: 'Automatic updates require an installed Windows release. Portable and development builds update manually.' };
      if (!checking) checking = Promise.resolve().then(() => updater.checkForUpdates()).then(result => {
        // Checking resolves before auto-download finishes. Observe its separate
        // rejection without holding the settings Check button until it downloads.
        if (result?.downloadPromise) void Promise.resolve(result.downloadPromise).catch(failed);
      }).catch(failed).finally(() => { checking = null; });
      await checking; return { ok: state.status !== 'error', ...state };
    },
    install() { if (!ready || state.status !== 'downloaded') return { ok: false, message: 'No verified update is ready.' }; invalidate(); updater.quitAndInstall(false, true); return { ok: true }; }
  };
  return client;
}
module.exports = { createUpdateClient, verifyDownload };
