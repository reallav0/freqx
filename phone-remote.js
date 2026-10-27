/* Phone pairing belongs beside the mixer: quiet surfaces, one clear connection. */
(() => {
  'use strict';
  function init(adapter) {
    const $ = id => document.getElementById(id);
    const dialog = $('phoneRemoteDialog'), launcher = $('openPhoneRemote');
    if (!dialog || !launcher) return null;
    let status = { enabled: false, connectedPhones: 0 }, busy = false, expiryTimer;
    const feedback = (message, error = false) => { $('phoneRemoteFeedback').textContent = message; $('phoneRemoteFeedback').dataset.error = String(error); };

    function expiry() {
      if (!status.enabled) return;
      const remaining = Math.max(0, Math.ceil((status.pairingExpiresAt - Date.now()) / 1000));
      $('phoneRemoteExpiry').textContent = remaining ? `Pairing link expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Pairing link expired. Refresh to connect another phone.';
      $('phoneRemoteQr').hidden = !remaining;
      $('phoneRemoteCopy').disabled = busy || !remaining;
    }

    function update(next) {
      status = { ...status, ...next };
      const enabled = status.enabled;
      $('phoneRemoteEnable').textContent = busy ? 'Please wait…' : enabled ? 'Turn off remote' : 'Enable phone remote';
      $('phoneRemoteEnable').classList.toggle('primary-action', !enabled);
      $('phoneRemoteEnable').classList.toggle('danger-action', enabled);
      $('phoneRemoteEnable').setAttribute('aria-pressed', String(enabled));
      $('phoneRemoteEnable').disabled = busy;
      $('phoneRemotePairing').hidden = !enabled;
      $('phoneRemoteOff').hidden = enabled;
      $('phoneRemoteState').textContent = enabled ? `${status.connectedPhones} ${status.connectedPhones === 1 ? 'phone' : 'phones'} connected` : 'Remote off';
      $('phoneRemoteState').dataset.enabled = String(enabled);
      $('phoneRemoteSettingState').textContent = enabled ? `${status.connectedPhones} connected · On` : 'Off';
      $('phoneRemoteNetworkField').hidden = !enabled || (status.addresses?.length || 0) < 2;
      const network = $('phoneRemoteNetwork');
      network.replaceChildren(...(status.addresses || []).map(item => {
        const option = document.createElement('option'); option.value = item.address; option.textContent = `${item.name} · ${item.address}`; return option;
      }));
      network.value = status.address || ''; network.disabled = busy;
      $('phoneRemoteLink').value = status.pairingUrl || '';
      if (status.qrDataUrl && $('phoneRemoteQr').src !== status.qrDataUrl) $('phoneRemoteQr').src = status.qrDataUrl;
      if (!enabled) $('phoneRemoteQr').removeAttribute('src');
      $('phoneRemoteRefresh').disabled = busy;
      $('phoneRemoteDisconnect').disabled = busy || !status.connectedPhones;
      expiry();
    }

    async function operation(action, message) {
      if (busy) return;
      busy = true; update(status); feedback(message);
      try { const next = await action(); adapter.onStatus(next); feedback(''); }
      catch (error) { feedback(error?.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || 'The remote could not be updated. Try again.', true); }
      finally { busy = false; update(status); }
    }

    async function open() {
      adapter.beforeOpen?.();
      dialog.showModal();
      feedback(''); update(status);
      clearInterval(expiryTimer); expiryTimer = setInterval(expiry, 1000);
      try { adapter.onStatus(await adapter.status()); }
      catch { feedback('Phone remote is unavailable. Restart Freqx and try again.', true); }
    }

    launcher.addEventListener('click', () => { void open(); });
    $('closePhoneRemote').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { clearInterval(expiryTimer); adapter.afterClose?.(); launcher.focus(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    $('phoneRemoteEnable').addEventListener('click', () => { void operation(() => status.enabled ? adapter.stop() : adapter.start({}), status.enabled ? 'Turning off remote…' : 'Opening your local remote…'); });
    $('phoneRemoteRefresh').addEventListener('click', () => { void operation(() => adapter.rotate({}), 'Refreshing the pairing link…'); });
    $('phoneRemoteNetwork').addEventListener('change', () => { void operation(() => adapter.rotate({ address: $('phoneRemoteNetwork').value }), 'Switching the pairing network…'); });
    $('phoneRemoteDisconnect').addEventListener('click', () => { void operation(() => adapter.disconnect(), 'Disconnecting phones…'); });
    $('phoneRemoteCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(status.pairingUrl); feedback('Pairing link copied. Open it on your phone.'); }
      catch { $('phoneRemoteLink').focus(); $('phoneRemoteLink').select(); feedback('Select and copy the pairing link above.'); }
    });
    update(status);
    return { update, close: () => { if (dialog.open) dialog.close(); } };
  }
  window.FreqxPhoneRemoteUi = { init };
})();
