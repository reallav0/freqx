'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createAuthApiFixture } = require('./helpers/auth-api-fixture.cjs');
const { AuthClient, SecureCredentialStore, registerAuthIpc, trustedBase } = require('../runtime/auth-client.cjs');
let directory, server, window;
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function run() {
  const output = path.join(root, 'output', 'auth-electron');
  await fs.mkdir(output, { recursive: true });
  directory = await fs.mkdtemp(path.join(output, 'run-'));
  app.setPath('userData', path.join(directory, 'profile'));
  app.setPath('sessionData', path.join(directory, 'session'));
  await app.whenReady();
  try {
    const { application, messages, sms, stats } = createAuthApiFixture();
    server = application.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.FREQX_API_BASE_URL = base;
    registerAuthIpc({ ipcMain, app, safeStorage, getWindow: () => window });
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
    // The real account UI/preload with unrelated audio scripts removed. This
    // fixture never acquires any physical microphone or audio output.
    html = html.replace(/<script src="(?!account\.js)[^"]+"><\/script>/g, '');
    for (const filename of ['account.js', 'styles.css', 'discover.css']) html = html.replaceAll(`"${filename}"`, `"${pathToFileURL(path.join(root, filename)).href}"`);
    await fs.writeFile(path.join(directory, 'account.html'), html);
    await window.loadFile(path.join(directory, 'account.html'));
    const evaluate = source => window.webContents.executeJavaScript(source);
    assert.equal(await evaluate('typeof require'), 'undefined');
    assert.equal(await evaluate('typeof soundmuncher.request'), 'undefined');
    await evaluate(`document.getElementById('accountSwitch').click(); document.getElementById('accountUsername').value='Desktop_Test'; document.getElementById('accountEmail').value='desktop@example.com'; document.getElementById('accountPassword').value='test-desktop-password-2026'; document.getElementById('accountForm').requestSubmit();`);
    const deadline = Date.now() + 10000;
    while (await evaluate(`document.getElementById('accountSession').hidden`)) {
      if (Date.now() > deadline) throw new Error('Account UI signup did not complete.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await evaluate(`document.getElementById('accountPassword').value`), '');
    const signedIn = await evaluate('soundmuncher.authStatus()');
    assert.equal(signedIn.user.username, 'Desktop_Test');
    assert.ok(!('refreshToken' in signedIn)); assert.ok(!('accessToken' in signedIn));
    await application.locals.emailService.drain();
    await evaluate(`document.getElementById('accountVerifyCode').value=${JSON.stringify(messages[0].code)};document.getElementById('accountVerifyForm').requestSubmit();`);
    const verificationDeadline = Date.now() + 10000;
    while (await evaluate(`!document.getElementById('accountVerifyForm').hidden`)) {
      if (Date.now() > verificationDeadline) throw new Error('Account UI verification did not complete.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal((await evaluate('soundmuncher.authStatus()')).user.emailVerified, true);
    const store = new SecureCredentialStore({ directory: app.getPath('userData'), safeStorage });
    const token = await store.read();
    assert.ok(token);
    assert.ok(!(await fs.readFile(store.filename)).includes(Buffer.from(token)));
    assert.equal(await evaluate('localStorage.length'), 0);
    const resumed = new AuthClient({ apiBaseUrl: base, development: true, store });
    const restored = await Promise.all([resumed.status(), resumed.status()]);
    assert.equal(restored[0].user.id, signedIn.user.id);
    assert.equal(restored[1].user.id, signedIn.user.id);
    assert.notEqual(await store.read(), token);
    assert.equal(stats.rotations, 1);
    const insecure = new SecureCredentialStore({ directory, safeStorage: { isAsyncEncryptionAvailable: async () => false } });
    await assert.rejects(insecure.save(token), /unavailable/);
    assert.throws(() => trustedBase('http://127.0.0.1:3000', false));
    assert.throws(() => trustedBase('https://user:password@evil.example', true));
    const rotated = await store.read();
    const logout = await evaluate('soundmuncher.logout()');
    assert.equal(logout.user, null); assert.equal(logout.revocationPending, false);
    assert.equal(await store.read(), null);
    const response = await fetch(base + '/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rotated }) });
    assert.equal(response.status, 401);
    await assert.rejects(resumed.request('/api/users/me', undefined, true), { status: 401 });
    await evaluate(`document.getElementById('accountEmail').value='desktop@example.com';document.getElementById('accountForgot').click();`);
    const resetDeadline = Date.now() + 10000;
    while (await evaluate(`document.getElementById('accountResetForm').hidden`)) {
      if (Date.now() > resetDeadline) throw new Error('Account UI recovery did not open.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await application.locals.emailService.drain();
    const resetCode = messages.find(message => message.type === 'password_reset').code;
    await evaluate(`document.getElementById('accountResetCode').value=${JSON.stringify(resetCode)};document.getElementById('accountResetPassword').value='new-desktop-password-2026';document.getElementById('accountResetForm').requestSubmit();`);
    while (await evaluate(`!document.getElementById('accountResetForm').hidden`)) {
      if (Date.now() > resetDeadline) throw new Error('Account UI recovery did not complete.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await evaluate(`document.getElementById('accountResetPassword').value`), '');
    await application.locals.emailService.drain();
    await evaluate(`document.getElementById('accountPhone').click();document.getElementById('accountPhoneNumber').value='+14155552671';document.getElementById('accountPhoneSend').click();`);
    const phoneDeadline = Date.now() + 10000;
    while (!sms.length) { if (Date.now() > phoneDeadline) throw new Error('Phone UI did not request a code.'); await new Promise(resolve => setTimeout(resolve, 25)); }
    // Wait until the request's UI operation has enabled its submit controls.
    while (await evaluate(`document.getElementById('accountPhoneSend').disabled`)) await new Promise(resolve => setTimeout(resolve, 25));
    await evaluate(`document.getElementById('accountPhoneCode').value=${JSON.stringify(sms[0].code)};document.getElementById('accountPhoneForm').requestSubmit();`);
    while (await evaluate(`document.getElementById('accountSession').hidden`)) { if (Date.now() > phoneDeadline) throw new Error('Phone UI login did not complete.'); await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal((await evaluate('soundmuncher.authStatus()')).user.phoneVerified, true);
    await evaluate('soundmuncher.logout()');
    console.log('PASS real Electron safeStorage encryption, narrow IPC, HTTP-fixture signup, restart restore, serialized rotation and logout revocation');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
