/* Session-only update notice. Main owns download verification and install confirmation. */
(() => {
  'use strict';
  function version(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  }
  function compare(a, b) {
    const first = version(a), second = version(b);
    if (!first || !second) return null;
    for (let index = 0; index < 3; index++) if (first[index] !== second[index]) return first[index] > second[index] ? 1 : -1;
    return 0;
  }
  function init(adapter) {
    const $ = id => document.getElementById(id), dialog = $('updateNotice');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    const dismissed = new Set();
    let candidate = null, highestVersion = '', manualRequested = false, unsupported = false;
    let returnFocus = null, restoreContext = null, busy = false, localMessage = '', localError = false, destroyed = false;
    function blockers() {
      return Array.from(document.querySelectorAll('[aria-modal="true"]')).filter(element => element !== dialog
        && !element.closest('[hidden]') && element.getClientRects().length > 0 && (element.tagName !== 'DIALOG' || element.open));
    }
    function close(dismiss = false) {
      if (dismiss && candidate) dismissed.add(candidate.latestVersion);
      manualRequested = false;
      if (dialog.open) dialog.close();
      const restore = restoreContext, focused = returnFocus;
      restoreContext = null; returnFocus = null;
      if (restore) restore();
      else if (!blockers().length && focused?.isConnected && !focused.closest('[hidden]')) focused.focus();
    }
    function render() {
      if (!candidate) return;
      const ready = candidate.status === 'downloaded', failed = candidate.status === 'error', checking = candidate.status === 'checking';
      $('updateNoticeTitle').textContent = ready ? `Freqx ${candidate.latestVersion} is ready.` : `Freqx ${candidate.latestVersion} is available.`;
      $('updateNoticeBody').textContent = ready
        ? 'The download has been verified. Restart when you are ready to install the update.'
        : 'Your update downloads in the background. Keep using Freqx while it gets ready.';
      $('updateNoticeCurrent').textContent = `v${candidate.currentVersion}`; $('updateNoticeLatest').textContent = `v${candidate.latestVersion}`;
      $('updateNoticeDownload').hidden = ready || failed;
      const percent = Number.isFinite(candidate.percent) ? Math.min(100, Math.max(0, candidate.percent)) : 0;
      $('updateNoticePercent').textContent = candidate.status === 'downloading' ? `${Math.round(percent)}%` : '';
      $('updateNoticePhase').textContent = checking ? 'Checking for updates' : candidate.status === 'downloading' ? 'Downloading in the background' : 'Preparing your download';
      if (candidate.status === 'downloading') $('updateNoticeProgress').value = percent;
      else $('updateNoticeProgress').removeAttribute('value');
      const message = localMessage || (failed ? String(candidate.message || 'The update could not download. Try again when you are connected.').slice(0, 500)
        : ready ? 'Restarting will stop active audio. You will be asked to confirm.' : 'Later keeps the download running. We will not interrupt you again for this version.');
      if ($('updateNoticeStatus').textContent !== message) $('updateNoticeStatus').textContent = message;
      $('updateNoticeStatus').dataset.error = String(localError || failed);
      $('updateNoticeAction').textContent = busy ? ready ? 'Waiting for confirmation…' : 'Checking…' : ready ? 'Restart and install' : failed ? 'Retry download' : 'Downloading…';
      $('updateNoticeAction').disabled = busy || (!ready && !failed);
      dialog.setAttribute('aria-busy', String(busy));
    }
    function maybeOpen() {
      if (destroyed || unsupported || !candidate || dismissed.has(candidate.latestVersion) || dialog.open) return;
      const blocking = blockers();
      if (blocking.length) {
        if (!manualRequested || !blocking.every(element => element.closest('#settingsOverlay'))) return;
        returnFocus = document.activeElement; restoreContext = adapter.prepareManualOpen?.() || null;
        if (blockers().length) return;
      }
      if (!returnFocus) returnFocus = document.activeElement;
      render(); dialog.showModal(); manualRequested = false;
      $('updateNoticeLater').focus();
    }
    function update(state) {
      if (destroyed || !state || typeof state !== 'object') return;
      if (state.status === 'unsupported' || state.status === 'none') {
        if (state.status === 'unsupported') unsupported = true;
        candidate = null; close(); return;
      }
      if (unsupported) return;
      if (['available', 'downloading', 'downloaded'].includes(state.status)) {
        if (compare(state.latestVersion, state.currentVersion) !== 1 || (highestVersion && compare(state.latestVersion, highestVersion) === -1)) return;
        highestVersion = state.latestVersion; candidate = { ...state }; localMessage = ''; localError = false;
      } else if (state.status === 'error' && candidate) {
        candidate = { ...candidate, status: 'error', message: state.message }; localMessage = ''; localError = false; busy = false;
      } else if (state.status === 'error') { manualRequested = false; return; }
      else if (state.status === 'checking' && candidate) candidate = { ...candidate, status: 'checking' };
      else return;
      render();
      maybeOpen();
    }
    function requestCheck() {
      if (unsupported) return;
      dismissed.clear(); manualRequested = true; localMessage = ''; localError = false; maybeOpen();
    }
    $('updateNoticeLater').addEventListener('click', () => close(true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(true); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    $('updateNoticeAction').addEventListener('click', async () => {
      if (!candidate || busy || !['downloaded', 'error'].includes(candidate.status)) return;
      const installing = candidate.status === 'downloaded'; busy = true; localMessage = ''; localError = false; render();
      try {
        const result = await (installing ? adapter.install() : adapter.retry());
        if (installing && result?.ok) { localMessage = 'Restarting to install the update…'; render(); return; }
        busy = false;
        if (installing) { localMessage = result?.message || 'Update installation is unavailable.'; localError = !/cancel/i.test(localMessage); }
        else if (result?.ok === false && !candidate?.message) { localMessage = result.message || 'Could not check for updates. Try again later.'; localError = true; }
        render();
      } catch (error) {
        busy = false; localMessage = error?.message || 'The update action could not start. Try again.'; localError = true; render();
      }
    });
    const observer = new MutationObserver(() => { if (!dialog.open) maybeOpen(); });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class', 'style'] });
    const destroy = () => { destroyed = true; observer.disconnect(); close(); };
    window.addEventListener('pagehide', destroy);
    return Object.freeze({ update, requestCheck, destroy });
  }
  window.FreqxUpdateNotice = Object.freeze({ init });
})();
