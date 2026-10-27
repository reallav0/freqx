'use strict';
// Serialized into the startup harness: exercises production main/preload/audio
// with an isolated profile, a synthetic clip and a real browser-only controller.
exports.run = async function phoneRemoteSmoke({ window, BrowserWindow, directory, fs, path }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, description) {
    const end = Date.now() + 10000;
    while (!await predicate()) {
      if (Date.now() > end) throw new Error('Phone remote smoke timed out: ' + description);
      await pause(30);
    }
  }
  const desktop = code => window.webContents.executeJavaScript(code, true);
  const idle = await desktop('window.soundmuncher.phoneRemoteStatus()');
  assert(!idle.enabled && !idle.pairingUrl, 'Remote must be off at startup.');
  await desktop(`document.getElementById('closeWalkthrough').click(); document.getElementById('openSettings').click(); document.getElementById('openPhoneRemote').click();`);
  await until(() => desktop('document.getElementById("phoneRemoteDialog").open'), 'pairing dialog');
  const wave = Buffer.alloc(44 + 48000 * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8);
  wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22); wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  for (let index = 0; index < 48000; index++) wave.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 440 * index / 48000)), 44 + index * 2);
  const source = path.join(directory, 'remote-smoke.wav'); fs.writeFileSync(source, wave);
  await desktop(`(async () => {
    const imported = await window.soundmuncher.importAudioFilePaths([${JSON.stringify(source)}]);
    if (!imported.imported?.length) throw new Error('Synthetic clip import failed.');
    await completeAudioImport(imported);
    const item = importedLibraryItems.find(item => item.path === imported.imported[0].path);
    libraryMetadata[item.path] = { ...getSoundMetadata(item), name: 'Remote smoke sound', playbackMode: 'loop', favorite: true };
    if (!boards.includes('Remote empty board')) boards.push('Remote empty board');
    saveLibraryMetadata(); renderImportedLibrary();
  })()`);
  await desktop(`document.getElementById('phoneRemoteEnable').click()`);
  let status;
  await until(async () => { status = await desktop('window.soundmuncher.phoneRemoteStatus()'); return status.enabled && status.pairingUrl; }, 'server start');
  await until(() => desktop('(() => { const qr=document.getElementById("phoneRemoteQr"); return qr.tagName === "IMG" ? qr.complete && qr.naturalWidth > 0 : Boolean(qr.querySelector("svg")); })()'), 'local QR code');
  window.showInactive(); await pause(200);
  fs.writeFileSync(path.join(directory, 'phone-remote-desktop.png'), (await window.webContents.capturePage()).toPNG());
  window.hide();
  const origin = new URL(status.pairingUrl).origin;
  const phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, partition: `phone-remote-smoke-${Date.now()}` } });
  const phoneErrors = [];
  phone.webContents.on('console-message', (_event, level, message) => { if (level >= 3) phoneErrors.push(message); });
  const mobile = code => phone.webContents.executeJavaScript(code, true);
  const post = async (route, body, cookie) => {
    const response = await fetch(origin + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await phone.loadURL(status.pairingUrl);
    await until(() => mobile('document.getElementById("connectionState").dataset.status === "connected" && document.querySelectorAll(".sound-pad").length > 0'), 'phone pairing and sound list');
    assert(await mobile('!location.hash && !window.soundmuncher && typeof require === "undefined" && document.cookie === ""'), 'Phone has no pairing fragment, readable cookie or Electron bridge.');
    const cookies = await phone.webContents.session.cookies.get({ url: origin });
    const session = cookies.find(cookie => cookie.name === 'freqx_remote');
    assert(session?.httpOnly, 'Phone session cookie is HttpOnly.');
    const cookie = `${session.name}=${session.value}`;
    const unauthorized = await fetch(origin + '/api/state');
    assert(unauthorized.status === 401, 'Unpaired clients cannot read the soundboard.');
    await mobile('document.querySelector(".sound-pad").click()');
    await until(() => desktop('activeSoundNodes.size > 0'), 'actual audio playback');
    await until(() => mobile('document.querySelector(".sound-pad").getAttribute("aria-pressed") === "true"'), 'live phone playback indicator');
    await mobile(`document.getElementById('soundVolume').value = '.37'; document.getElementById('soundVolume').dispatchEvent(new Event('change', {bubbles:true}));`);
    await until(() => desktop('Number(soundGainSlider.value) === .37'), 'remote mixer volume');
    await desktop(`soundGainSlider.value = '.42'; soundGainSlider.dispatchEvent(new Event('input', {bubbles:true}));`);
    await until(() => mobile('document.getElementById("volumeValue").textContent === "42%"'), 'desktop volume reflected on phone');
    await mobile(`document.getElementById('boardSelect').value = 'Remote empty board'; document.getElementById('boardSelect').dispatchEvent(new Event('change', {bubbles:true}));`);
    await until(() => desktop('selectedBoard === "Remote empty board"'), 'remote board selection');
    await until(() => mobile('!document.getElementById("emptyState").hidden'), 'empty board state');
    await mobile(`document.getElementById('boardSelect').value = '__all__'; document.getElementById('boardSelect').dispatchEvent(new Event('change', {bubbles:true}));`);
    await until(() => mobile('document.querySelectorAll(".sound-pad").length > 0'), 'return to all boards');
    await mobile('document.getElementById("stopAll").click()');
    await until(() => desktop('activeSoundNodes.size === 0 && pendingSoundStarts.size === 0'), 'stop-all audio and pending starts');
    await until(() => mobile('document.querySelector(".sound-pad").getAttribute("aria-pressed") === "false"'), 'phone stop status');
    await until(() => mobile('!document.querySelector(".sound-pad").disabled'), 'playback acknowledgement');
    assert(await mobile('document.documentElement.scrollWidth <= innerWidth'), 'Mobile layout fits without horizontal scrolling.');
    const layout = await mobile(`(() => { const stop=document.getElementById('stopAll').getBoundingClientRect(); return {bottom:stop.bottom,height:innerHeight,width:innerWidth}; })()`);
    assert(layout.bottom <= layout.height, 'Stop button is visible in the mobile viewport.');
    phone.showInactive(); await pause(150);
    fs.writeFileSync(path.join(directory, 'phone-remote-mobile.png'), (await phone.webContents.capturePage()).toPNG());
    phone.hide();
    const malformed = await post('/api/command', { type: 'play', soundId: '../private.wav' }, cookie);
    assert(malformed.status === 400, 'File paths cannot be used as sound IDs.');
    await desktop('window.soundmuncher.disconnectPhoneRemotes()');
    await until(() => mobile('!document.getElementById("pairingPanel").hidden'), 'desktop session revocation');
    const revoked = await post('/api/command', { type: 'stop-all' }, cookie);
    assert(revoked.status === 401, 'Revoked phone cannot control playback.');
    status = await desktop('window.soundmuncher.phoneRemoteStatus()');
    await phone.loadURL(status.pairingUrl);
    await until(() => mobile('document.getElementById("connectionState").dataset.status === "connected"'), 're-pairing');
    await mobile('document.getElementById("disconnectButton").click()');
    await until(() => mobile('!document.getElementById("pairingPanel").hidden'), 'phone disconnect');
    await until(async () => (await desktop('window.soundmuncher.phoneRemoteStatus()')).connectedPhones === 0, 'paired phone count');
    await desktop('window.soundmuncher.stopPhoneRemote()');
    assert(!(await desktop('window.soundmuncher.phoneRemoteStatus()')).enabled, 'Stop disables server.');
    await assertNetworkClosed(origin);
    const scriptErrors = phoneErrors.filter(message => !/Failed to load resource|net::ERR_/.test(message));
    assert(scriptErrors.length === 0, 'Phone has no script or CSP errors: ' + scriptErrors.join('; '));
    return { passed: true, disabledOnStartup: true, qr: true, playback: true, mixer: true, boards: true, stop: true, revocation: true, mobileWidth: layout.width, phoneErrors: scriptErrors };
  } finally { phone.destroy(); await desktop('window.soundmuncher.stopPhoneRemote()'); }

  async function assertNetworkClosed(base) {
    let closed = false;
    try { await fetch(base + '/api/state', { signal: AbortSignal.timeout(1000) }); } catch { closed = true; }
    assert(closed, 'Stopping remote closes its listening socket.');
  }
};
