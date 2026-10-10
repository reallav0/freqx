'use strict';
(() => {
  const bridge = window.soundmuncher;
  const element = id => document.getElementById(id);
  const overlay = element('accountOverlay');
  const panel = overlay.querySelector('.account-panel');
  let signup = false;
  let pending = false;
  let resetting = false;
  let resetCodeSent = false;
  let phoneMode = false;
  let currentUser = null;
  let returnFocus = null;

  function status(message = '', tone = 'info') {
    const notice = element('accountStatus');
    notice.textContent = message;
    notice.hidden = !message;
    notice.dataset.tone = tone;
  }
  function resetPasswordVisibility() {
    element('accountPassword').type = 'password';
    element('accountPasswordToggle').textContent = 'Show';
    element('accountPasswordToggle').setAttribute('aria-label', 'Show password');
    element('accountPasswordToggle').setAttribute('aria-pressed', 'false');
  }
  function focusForMode() {
    if (overlay.hidden) return;
    const target = currentUser ? element('closeAccount') : resetting
      ? element(resetCodeSent ? 'accountResetCode' : 'accountResetEmail')
      : phoneMode ? element('accountPhoneNumber') : element(signup ? 'accountUsername' : 'accountEmail');
    target.focus({ preventScroll: true });
  }
  function openAccount() {
    if (overlay.hidden) returnFocus = document.activeElement;
    overlay.hidden = false;
    focusForMode();
  }
  function closeAccount() {
    overlay.hidden = true;
    for (const input of overlay.querySelectorAll('input[type="password"], #accountPassword')) input.value = '';
    resetPasswordVisibility();
    const target = returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : element('openAccount');
    target.focus({ preventScroll: true });
  }
  function updateMode() {
    element('accountForm').hidden = Boolean(currentUser) || resetting || phoneMode;
    element('accountPhoneForm').hidden = Boolean(currentUser) || !phoneMode;
    element('accountResetForm').hidden = Boolean(currentUser) || !resetting;
    element('accountSession').hidden = !currentUser;
    element('accountLocalNote').hidden = Boolean(currentUser);
    element('accountVerifyForm').hidden = !currentUser?.email || currentUser.emailVerified;
    panel.dataset.session = String(Boolean(currentUser));
    panel.dataset.mode = currentUser ? 'session' : resetting ? 'reset' : phoneMode ? 'phone' : signup ? 'signup' : 'login';
    element('accountUsernameField').hidden = !signup;
    element('accountUsername').required = signup;
    element('accountPassword').minLength = signup ? 12 : 1;
    element('accountPassword').autocomplete = signup ? 'new-password' : 'current-password';
    element('accountPassword').setAttribute('aria-describedby', signup ? 'accountPasswordHint' : '');
    element('accountPasswordHint').hidden = !signup;
    element('accountForgot').hidden = signup;
    element('accountSubmit').textContent = signup ? 'Create account' : 'Log in';
    element('accountSwitchPrompt').textContent = signup ? 'Already have an account?' : 'New to FreqX?';
    element('accountSwitch').textContent = signup ? 'Log in' : 'Create an account';
    element('accountResetFields').hidden = !resetCodeSent;
    element('accountResetCode').required = resetCodeSent;
    element('accountResetPassword').required = resetCodeSent;
    element('accountResetSend').textContent = resetCodeSent ? 'Resend reset code' : 'Send reset code';
    let title = signup ? 'Create your account.' : 'Welcome back.';
    let subtitle = signup ? 'Create an account for your sounds and favorites.' : 'Log in to sync your favorites and keep your sounds close.';
    if (currentUser) { title = 'Your account.'; subtitle = 'Your profile, cloud sounds and account settings in one place.'; }
    else if (resetting) { title = 'Reset your password.'; subtitle = resetCodeSent ? 'Check your inbox for a reset code, then choose a new password.' : 'Enter your email address and we’ll send you a reset code.'; }
    else if (phoneMode) { title = 'Log in with your phone.'; subtitle = 'We’ll send a verification code to your phone. No password needed.'; }
    element('accountTitle').textContent = title;
    element('accountSubtitle').textContent = subtitle;
  }
  function setSignup(value) {
    signup = value;
    resetPasswordVisibility();
    updateMode();
  }
  function render(result) {
    const previousUser = currentUser;
    if (result && Object.hasOwn(result, 'user')) currentUser = result.user;
    const user = currentUser;
    if (user) { resetting = false; phoneMode = false; }
    updateMode();
    if (!user || previousUser?.id !== user.id) {
      element('cloudSoundList').replaceChildren();
      element('cloudSoundEmpty').hidden = false;
      element('cloudSoundEmpty').textContent = 'Your cloud library will appear here. Refresh to load your sounds.';
    }
    if (result?.cloud) {
      const sounds = result.cloud.sounds || [];
      element('cloudSoundEmpty').hidden = Boolean(sounds.length);
      element('cloudSoundEmpty').textContent = 'No cloud sounds yet. Upload your first sound above.';
      element('cloudSoundList').replaceChildren(...sounds.map(sound => {
        const item = document.createElement('li');
        const label = document.createElement('div'); label.className = 'account-cloud-label';
        const title = document.createElement('strong'); title.textContent = sound.title;
        const detail = document.createElement('small'); detail.textContent = `${sound.processingStatus === 'verified' ? 'Ready to play' : sound.processingStatus} · ${sound.visibility}`;
        label.append(title, detail);
        const actions = document.createElement('div'); actions.className = 'account-cloud-actions';
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.className = 'mixer-action danger-action';
        const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = 'Preview'; preview.className = 'mixer-action'; preview.disabled = sound.processingStatus !== 'verified';
        const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add to current board'; add.className = 'mixer-action'; add.disabled = sound.processingStatus !== 'verified';
        if (preview.disabled) { preview.title = 'Available when this sound has been verified.'; add.title = preview.title; }
        preview.addEventListener('click', () => window.dispatchEvent(new CustomEvent('freqx-cloud-preview', { detail: { id: sound.id } })));
        add.addEventListener('click', () => window.dispatchEvent(new CustomEvent('freqx-cloud-import', { detail: { sound } })));
        remove.addEventListener('click', () => operation(async () => {
          const deleted = await bridge.deleteCloudSound(sound.soundId);
          return deleted.error ? deleted : { ...await bridge.listCloudSounds(), message: deleted.message };
        }, 'Deleting your sound…'));
        actions.append(preview, add, remove); item.append(label, actions); return item;
      }));
    }
    element('openAccount').textContent = user ? user.displayName || user.username || 'Account' : 'Account';
    if (user) {
      const name = user.displayName || user.username || 'Your account';
      element('accountDisplayName').value = user.displayName || user.username || '';
      element('accountIdentityName').textContent = name;
      element('accountIdentityDetail').textContent = user.email || user.phoneNumber || (user.username ? `@${user.username}` : 'Your FreqX account');
      element('accountAvatar').textContent = name.slice(0, 1).toUpperCase();
    }
    window.dispatchEvent(new CustomEvent('freqx-account-state', { detail: { userId: user?.id || null } }));
    status(result?.error || result?.message || (result?.revocationPending
      ? 'Logged out on this device. The server could not be reached to revoke your session.' : ''), result?.error ? 'error' : 'info');
    if (!overlay.hidden && (Boolean(previousUser) !== Boolean(user) || document.activeElement?.closest('[hidden]'))) focusForMode();
  }
  async function operation(callback, message = 'Updating your account…', activeButton) {
    if (pending) return;
    pending = true;
    const disabledStates = new Map();
    for (const control of overlay.querySelectorAll('button')) {
      if (control.id === 'closeAccount') continue;
      disabledStates.set(control, control.disabled);
      control.disabled = true;
    }
    const previousLabel = activeButton?.textContent;
    if (activeButton) activeButton.textContent = 'Please wait…';
    panel.setAttribute('aria-busy', 'true');
    status(message, 'pending');
    try { render(await callback()); }
    catch { status('We couldn’t reach the account service. Check your connection and try again.', 'error'); }
    finally {
      pending = false;
      panel.removeAttribute('aria-busy');
      for (const [control, disabled] of disabledStates) if (control.isConnected) control.disabled = disabled;
      if (activeButton) activeButton.textContent = previousLabel;
      updateMode();
    }
  }
  element('openAccount').addEventListener('click', openAccount);
  element('accountWebsite').addEventListener('click', async () => {
    try { await bridge.openWebsite('account'); }
    catch { status('Could not open the website. Try again.', 'error'); }
  });
  element('closeAccount').addEventListener('click', closeAccount);
  overlay.addEventListener('click', event => { if (event.target === overlay) closeAccount(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAccount(); }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button, input, select, summary, [tabindex="0"]')].filter(control => !control.disabled && control.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!first) { event.preventDefault(); panel.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  element('accountPasswordToggle').addEventListener('click', () => {
    const visible = element('accountPassword').type === 'password';
    element('accountPassword').type = visible ? 'text' : 'password';
    element('accountPasswordToggle').textContent = visible ? 'Hide' : 'Show';
    element('accountPasswordToggle').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    element('accountPasswordToggle').setAttribute('aria-pressed', String(visible));
  });
  element('accountSwitch').addEventListener('click', () => { setSignup(!signup); status(); focusForMode(); });
  element('accountForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = { email: element('accountEmail').value, password: element('accountPassword').value };
    if (signup) input.username = element('accountUsername').value;
    operation(async () => {
      try { return await (signup ? bridge.signup(input) : bridge.login(input)); }
      finally { element('accountPassword').value = ''; input.password = ''; resetPasswordVisibility(); }
    }, signup ? 'Creating your account…' : 'Logging you in…', element('accountSubmit'));
  });
  const logout = all => operation(async () => { setSignup(false); phoneMode = false; resetting = false; return all ? bridge.logoutAll() : bridge.logout(); }, 'Logging you out…');
  element('accountLogout').addEventListener('click', () => logout(false));
  element('accountLogoutAll').addEventListener('click', () => logout(true));
  element('cloudRefresh').addEventListener('click', () => operation(() => bridge.listCloudSounds(), 'Loading your cloud sounds…'));
  element('accountProfileForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(async () => {
      const result = await bridge.updateProfile({ displayName: element('accountDisplayName').value });
      return result.error || result.message ? result : { ...result, message: 'Profile saved.' };
    }, 'Saving your profile…');
  });
  element('accountPasswordForm').addEventListener('submit', event => {
    event.preventDefault(); const input = { currentPassword: element('accountCurrentPassword').value, password: element('accountNewPassword').value };
    operation(async () => { try { return await bridge.changePassword(input); } finally { element('accountCurrentPassword').value = ''; element('accountNewPassword').value = ''; input.currentPassword = ''; input.password = ''; } }, 'Updating your password…');
  });
  element('accountSyncFavorites').addEventListener('click', () => operation(
    () => new Promise(resolve => window.dispatchEvent(new CustomEvent('freqx-favorites-sync', { detail: { complete: resolve } }))),
    'Syncing your favorites…'
  ));
  element('cloudUploadForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(() => bridge.uploadCloudSound({ title: element('cloudTitle').value, visibility: element('cloudVisibility').value }), 'Choose a sound in the file picker to upload…');
  });
  element('accountDiscord').addEventListener('click', () => operation(() => bridge.oauthLogin('discord'), 'Opening Discord sign-in in your browser…'));
  element('accountGoogle').addEventListener('click', () => operation(() => bridge.oauthLogin('google'), 'Opening Google sign-in in your browser…'));
  element('accountPhone').addEventListener('click', () => { phoneMode = true; resetting = false; updateMode(); status(); focusForMode(); });
  element('accountPhoneCancel').addEventListener('click', () => { phoneMode = false; setSignup(false); status(); focusForMode(); });
  element('accountPhoneSend').addEventListener('click', () => {
    if (element('accountPhoneNumber').reportValidity()) operation(async () => {
      const result = await bridge.requestPhoneCode({ phoneNumber: element('accountPhoneNumber').value });
      if (!result.error && !overlay.hidden) element('accountPhoneCode').focus();
      return result;
    }, 'Sending your verification code…');
  });
  element('accountPhoneForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(async () => {
      const result = await bridge.verifyPhone({ phoneNumber: element('accountPhoneNumber').value, code: element('accountPhoneCode').value });
      if (!result.error) phoneMode = false;
      element('accountPhoneCode').value = ''; return result;
    }, 'Verifying your phone…');
  });
  bridge?.onAuthState?.(result => { render(result); openAccount(); });
  element('accountVerifyForm').addEventListener('submit', event => {
    event.preventDefault();
    operation(() => bridge.verifyEmail({ code: element('accountVerifyCode').value }), 'Verifying your email…');
  });
  element('accountResend').addEventListener('click', () => operation(() => bridge.resendEmail(), 'Sending a new verification code…'));
  function sendResetCode() {
    if (!element('accountResetEmail').reportValidity()) return;
    operation(async () => {
      const result = await bridge.forgotPassword({ email: element('accountResetEmail').value });
      if (!result.error) { resetCodeSent = true; updateMode(); focusForMode(); }
      return result;
    }, 'Sending your password reset code…');
  }
  element('accountForgot').addEventListener('click', () => {
    resetting = true; phoneMode = false; resetCodeSent = false;
    element('accountResetEmail').value = element('accountEmail').value;
    element('accountResetCode').value = ''; element('accountResetPassword').value = '';
    updateMode(); status(); focusForMode();
    if (element('accountResetEmail').value && element('accountResetEmail').checkValidity()) sendResetCode();
  });
  element('accountResetSend').addEventListener('click', sendResetCode);
  element('accountResetCancel').addEventListener('click', () => { resetting = false; element('accountResetPassword').value = ''; updateMode(); status(); focusForMode(); });
  element('accountResetForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!resetCodeSent) { sendResetCode(); return; }
    const input = { email: element('accountResetEmail').value, code: element('accountResetCode').value, password: element('accountResetPassword').value };
    operation(async () => {
      try { const result = await bridge.resetPassword(input); if (!result.error) { resetting = false; setSignup(false); element('accountEmail').value = input.email; } return result; }
      finally { input.password = ''; element('accountResetPassword').value = ''; }
    }, 'Resetting your password…');
  });
  updateMode();
  if (bridge?.authStatus) operation(() => bridge.authStatus(), 'Checking your account…');
})();
