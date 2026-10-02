'use strict';
(() => {
  const bridge = window.soundmuncher;
  const element = id => document.getElementById(id);
  let signup = false;
  let pending = false;
  let resetting = false;
  let phoneMode = false;
  function setSignup(value) {
    signup = value;
    element('accountUsernameField').hidden = !signup;
    element('accountUsername').required = signup;
    element('accountPassword').minLength = signup ? 12 : 1;
    element('accountPassword').autocomplete = signup ? 'new-password' : 'current-password';
    element('accountSubmit').textContent = signup ? 'Create account' : 'Log in';
    element('accountSwitch').textContent = signup ? 'I already have an account' : 'Create an account';
  }
  function render(result) {
    const user = result?.user;
    element('accountForm').hidden = Boolean(user) || resetting || phoneMode;
    element('accountPhoneForm').hidden = Boolean(user) || !phoneMode;
    element('accountResetForm').hidden = Boolean(user) || !resetting;
    element('accountSession').hidden = !user;
    element('accountVerifyForm').hidden = !user?.email || user.emailVerified;
    if (!user) element('cloudSoundList').replaceChildren();
    if (result?.cloud) {
      element('cloudSoundList').replaceChildren(...result.cloud.sounds.map(sound => {
        const item = document.createElement('li');
        const label = document.createElement('span'); label.textContent = `${sound.title} (${sound.processingStatus}, ${sound.visibility}) `;
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
        const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = 'Preview'; preview.disabled = sound.processingStatus !== 'verified';
        preview.addEventListener('click', () => window.dispatchEvent(new CustomEvent('freqx-cloud-preview', { detail: { id: sound.id } })));
        const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add to current board'; add.disabled = sound.processingStatus !== 'verified';
        add.addEventListener('click', () => window.dispatchEvent(new CustomEvent('freqx-cloud-import', { detail: { sound } })));
        remove.addEventListener('click', () => operation(async () => {
          const deleted = await bridge.deleteCloudSound(sound.soundId);
          return deleted.error ? deleted : { ...await bridge.listCloudSounds(), message: deleted.message };
        }));
        item.append(label, preview, add, remove); return item;
      }));
    }
    element('openAccount').textContent = user ? user.displayName || user.username : 'Account';
    if (user) element('accountDisplayName').value = user.displayName;
    window.dispatchEvent(new CustomEvent('freqx-account-state', { detail: { userId: user?.id || null } }));
    element('accountStatus').textContent = result?.error || result?.message || (result?.revocationPending
      ? 'Logged out on this device. The server could not be reached to revoke your session.'
      : user ? `Signed in as ${user.username}.` : 'You can use your local sounds without signing in.');
  }
  async function operation(callback) {
    if (pending) return;
    pending = true;
    for (const control of element('accountOverlay').querySelectorAll('button')) control.disabled = true;
    try { render(await callback()); }
    catch { element('accountStatus').textContent = 'Account service is unavailable. Please try again.'; }
    finally { pending = false; for (const control of element('accountOverlay').querySelectorAll('button')) control.disabled = false; }
  }
  element('openAccount').addEventListener('click', () => { element('accountOverlay').hidden = false; element('accountEmail').focus(); });
  element('closeAccount').addEventListener('click', () => { element('accountOverlay').hidden = true; for (const input of element('accountOverlay').querySelectorAll('input[type=password]')) input.value = ''; element('openAccount').focus(); });
  element('accountOverlay').addEventListener('keydown', event => { if (event.key === 'Escape') element('closeAccount').click(); });
  element('accountSwitch').addEventListener('click', () => {
    setSignup(!signup);
  });
  element('accountForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = { email: element('accountEmail').value, password: element('accountPassword').value };
    if (signup) input.username = element('accountUsername').value;
    operation(async () => {
      try { return await (signup ? bridge.signup(input) : bridge.login(input)); }
      finally { element('accountPassword').value = ''; input.password = ''; }
    });
  });
  element('accountLogout').addEventListener('click', () => operation(async () => { setSignup(false); phoneMode = false; return bridge.logout(); }));
  element('accountLogoutAll').addEventListener('click', () => operation(async () => { setSignup(false); phoneMode = false; return bridge.logoutAll(); }));
  element('cloudRefresh').addEventListener('click', () => operation(() => bridge.listCloudSounds()));
  element('accountProfileForm').addEventListener('submit', event => { event.preventDefault(); operation(() => bridge.updateProfile({ displayName: element('accountDisplayName').value })); });
  element('accountPasswordForm').addEventListener('submit', event => {
    event.preventDefault(); const input = { currentPassword: element('accountCurrentPassword').value, password: element('accountNewPassword').value };
    operation(async () => { try { return await bridge.changePassword(input); } finally { element('accountCurrentPassword').value = ''; element('accountNewPassword').value = ''; input.currentPassword = ''; input.password = ''; } });
  });
  element('accountSyncFavorites').addEventListener('click', () => window.dispatchEvent(new Event('freqx-favorites-sync')));
  element('cloudUploadForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(() => bridge.uploadCloudSound({ title: element('cloudTitle').value, visibility: element('cloudVisibility').value }));
  });
  element('accountDiscord').addEventListener('click', () => operation(() => bridge.oauthLogin('discord')));
  element('accountGoogle').addEventListener('click', () => operation(() => bridge.oauthLogin('google')));
  element('accountPhone').addEventListener('click', () => { phoneMode = true; render({ user: null }); element('accountPhoneNumber').focus(); });
  element('accountPhoneCancel').addEventListener('click', () => { phoneMode = false; render({ user: null }); });
  element('accountPhoneSend').addEventListener('click', () => {
    if (element('accountPhoneNumber').reportValidity()) operation(() => bridge.requestPhoneCode({ phoneNumber: element('accountPhoneNumber').value }));
  });
  element('accountPhoneForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(async () => {
      const result = await bridge.verifyPhone({ phoneNumber: element('accountPhoneNumber').value, code: element('accountPhoneCode').value });
      if (!result.error) phoneMode = false;
      element('accountPhoneCode').value = ''; return result;
    });
  });
  bridge?.onAuthState?.(result => { render(result); element('accountOverlay').hidden = false; });
  element('accountVerifyForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(() => bridge.verifyEmail({ code: element('accountVerifyCode').value }));
  });
  element('accountResend').addEventListener('click', () => operation(() => bridge.resendEmail()));
  element('accountForgot').addEventListener('click', () => {
    if (!element('accountEmail').reportValidity()) return;
    element('accountResetEmail').value = element('accountEmail').value;
    operation(async () => { const result = await bridge.forgotPassword({ email: element('accountEmail').value }); if (!result.error) resetting = true; return result; });
  });
  element('accountResetCancel').addEventListener('click', () => { resetting = false; element('accountResetPassword').value = ''; render({ user: null }); });
  element('accountResetForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = { email: element('accountResetEmail').value, code: element('accountResetCode').value, password: element('accountResetPassword').value };
    operation(async () => {
      try { const result = await bridge.resetPassword(input); if (!result.error) { resetting = false; setSignup(false); } return result; }
      finally { input.password = ''; element('accountResetPassword').value = ''; }
    });
  });
  if (bridge?.authStatus) operation(() => bridge.authStatus());
})();
