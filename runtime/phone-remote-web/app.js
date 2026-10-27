'use strict';
(() => {
  const element = id => document.getElementById(id);
  const pads = new Map();
  const pending = new Set();
  let state = { boards: [], selectedBoard: '__all__', sounds: [], volume: 1 };
  let paired = false;
  let connected = false;
  let favoritesOnly = false;
  let events;
  let retryTimer;
  let generation = 0;
  let volumeEditing = false;
  let boardPending = false;
  let refreshing = false;
  function takePairingToken() {
    const token = new URLSearchParams(location.hash.slice(1)).get('pair');
    // Never leave the pairing secret in browser history, referrers or copied URLs.
    if (location.hash) history.replaceState(null, '', location.pathname);
    return token;
  }
  const initialToken = takePairingToken();

  async function request(route, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.ok === false) {
        const error = new Error(result.error || 'Freqx could not complete that action.');
        error.status = response.status;
        throw error;
      }
      return result;
    } catch (error) {
      if (error.status) throw error;
      throw new Error('Cannot reach Freqx. Keep it open and check that both devices are on the same Wi-Fi.');
    } finally { clearTimeout(timeout); }
  }

  function feedback(message = '', error = false) {
    element('commandFeedback').textContent = message;
    element('commandFeedback').dataset.error = String(error);
  }

  function connection(status) {
    connected = status === 'connected';
    const indicator = element('connectionState');
    indicator.dataset.status = status;
    indicator.lastElementChild.textContent = { connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', unpaired: 'Not connected' }[status];
    element('connectionHelp').hidden = !paired || connected;
    element('boardSelect').disabled = !connected || boardPending;
    element('soundVolume').disabled = !connected;
    element('stopAll').disabled = !connected;
    for (const [id, pad] of pads) pad.button.disabled = !connected || pending.has(id);
  }

  function showPairing(message = '') {
    paired = false;
    generation++;
    events?.close(); events = undefined;
    clearInterval(retryTimer);
    retryTimer = undefined;
    element('pairingPanel').hidden = false;
    element('controllerPanel').hidden = true;
    element('transport').hidden = true;
    element('pairingFeedback').textContent = message;
    connection('unpaired');
  }

  function createPad(id) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'sound-pad';
    const top = document.createElement('span'); top.className = 'pad-top';
    const index = document.createElement('span'); index.className = 'pad-index';
    const board = document.createElement('span'); board.className = 'pad-board';
    const tone = document.createElement('i'); tone.className = 'pad-tone'; tone.setAttribute('aria-hidden', 'true');
    const boardName = document.createElement('span');
    board.append(tone, boardName); top.append(index, board);
    const title = document.createElement('span'); title.className = 'pad-title';
    const bottom = document.createElement('span'); bottom.className = 'pad-bottom';
    const status = document.createElement('span'); status.className = 'pad-status';
    const play = document.createElement('span'); play.className = 'pad-play'; play.textContent = '▶'; play.setAttribute('aria-hidden', 'true');
    bottom.append(status, play); button.append(top, title, bottom);
    button.addEventListener('click', () => void command({ type: 'play', soundId: id }, id));
    return { button, index, tone, boardName, title, status };
  }

  function renderPads() {
    const query = element('soundSearch').value.trim().toLocaleLowerCase();
    const sounds = state.sounds.filter(sound =>
      (state.selectedBoard === '__all__' || sound.board === state.selectedBoard) &&
      (!favoritesOnly || sound.favorite) &&
      `${sound.title} ${sound.board}`.toLocaleLowerCase().includes(query));
    const container = element('soundPads');
    const ids = new Set(sounds.map(sound => sound.id));
    for (const [id, pad] of pads) if (!ids.has(id)) { pad.button.remove(); pads.delete(id); }
    sounds.forEach((sound, index) => {
      let pad = pads.get(sound.id);
      if (!pad) { pad = createPad(sound.id); pads.set(sound.id, pad); }
      pad.index.textContent = String(index + 1).padStart(2, '0');
      pad.boardName.textContent = sound.board;
      pad.title.textContent = sound.title;
      pad.tone.style.backgroundColor = /^#[a-f\d]{6}$/i.test(sound.color) ? sound.color : '#666660';
      pad.status.textContent = pending.has(sound.id) ? 'Sending…' : sound.playing ? 'Playing' : 'Tap to play';
      pad.button.setAttribute('aria-label', `Play ${sound.title}`);
      pad.button.setAttribute('aria-pressed', String(sound.playing));
      pad.button.disabled = !connected || pending.has(sound.id);
      if (container.children[index] !== pad.button) container.insertBefore(pad.button, container.children[index] || null);
    });
    element('soundCount').textContent = `${String(sounds.length).padStart(2, '0')} ${sounds.length === 1 ? 'sound' : 'sounds'}`;
    element('emptyState').hidden = sounds.length > 0;
    const hasSounds = state.sounds.length > 0;
    element('emptyTitle').textContent = hasSounds ? 'No matching sounds.' : 'A little quiet here.';
    element('emptyCopy').textContent = hasSounds ? 'Try another board, clear your search, or turn off Favorites.' : 'Import sounds in Freqx on your computer. They’ll appear here automatically.';
  }

  function render(next) {
    if (!next || !Array.isArray(next.sounds) || !Array.isArray(next.boards)) return;
    state = next;
    const select = element('boardSelect');
    const choices = [{ value: '__all__', label: 'All boards' }, ...state.boards.map(board => ({ value: board, label: board }))];
    if (JSON.stringify(Array.from(select.options, option => [option.value, option.textContent])) !== JSON.stringify(choices.map(choice => [choice.value, choice.label]))) {
      select.replaceChildren(...choices.map(choice => { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; return option; }));
    }
    select.value = state.selectedBoard;
    if (!volumeEditing) {
      element('soundVolume').value = state.volume;
      element('volumeValue').textContent = `${Math.round(state.volume * 100)}%`;
    }
    renderPads();
  }

  async function refresh() {
    if (!paired || refreshing) return;
    refreshing = true;
    const current = generation;
    try {
      const result = await request('/api/state');
      if (current !== generation) return;
      render(result.state);
      connection('connected');
      if (!events || events.readyState === EventSource.CLOSED) connectEvents();
    } catch (error) {
      if (current !== generation) return;
      if (error.status === 401) showPairing('Your connection has ended. Scan the current QR code in Freqx to pair again.');
      else connection('reconnecting');
    } finally { refreshing = false; }
  }

  function connectEvents() {
    events?.close();
    const current = generation;
    const stream = new EventSource('/api/events');
    events = stream;
    stream.addEventListener('state', event => {
      if (current !== generation) return;
      try { render(JSON.parse(event.data)); connection('connected'); } catch { connection('reconnecting'); }
    });
    stream.onerror = () => {
      if (current !== generation || !paired) return;
      connection('reconnecting');
      void refresh();
    };
  }

  function showController(next) {
    paired = true;
    generation++;
    element('pairingPanel').hidden = true;
    element('controllerPanel').hidden = false;
    element('transport').hidden = false;
    element('pairingLink').value = '';
    element('pairingFeedback').textContent = '';
    feedback(); render(next); connection('connected');
    connectEvents();
    clearInterval(retryTimer);
    retryTimer = setInterval(() => { if (!connected && document.visibilityState !== 'hidden') void refresh(); }, 5000);
  }

  async function pair(token) {
    showPairing();
    const current = generation;
    connection('connecting');
    element('pairButton').disabled = true;
    try {
      const result = await request('/api/pair', { token });
      if (current !== generation) return;
      showController(result.state);
    } catch (error) { if (current === generation) showPairing(error.message); }
    finally { element('pairButton').disabled = false; }
  }

  async function command(input, soundId) {
    if (!connected || (soundId && pending.has(soundId))) return;
    const current = generation;
    if (soundId) { pending.add(soundId); renderPads(); }
    try {
      const result = await request('/api/command', input);
      if (current !== generation) return;
      if (result.state) render(result.state);
      feedback(input.type === 'stop-all' ? 'All sounds stopped.' : '');
    } catch (error) {
      if (current !== generation) return;
      feedback(error.message, true);
      if (error.status === 401) showPairing('Your connection has ended. Scan the QR code in Freqx to pair again.');
      else if (!error.status) { connection('reconnecting'); void refresh(); }
    } finally { if (soundId) { pending.delete(soundId); renderPads(); } }
  }

  element('pairingForm').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const link = new URL(element('pairingLink').value.trim());
      if (link.origin !== location.origin || link.pathname !== '/') throw new Error();
      const token = new URLSearchParams(link.hash.slice(1)).get('pair');
      if (!token || !/^[\w-]{43}$/.test(token)) throw new Error();
      void pair(token);
    } catch { element('pairingFeedback').textContent = 'Paste the complete pairing link shown in Freqx on this computer.'; }
  });
  element('soundSearch').addEventListener('input', renderPads);
  element('favoritesToggle').addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    element('favoritesToggle').setAttribute('aria-pressed', String(favoritesOnly));
    renderPads();
  });
  element('boardSelect').addEventListener('change', async event => {
    boardPending = true;
    connection(connected ? 'connected' : 'reconnecting');
    await command({ type: 'board', board: event.target.value });
    boardPending = false;
    // On a failed command, restore the desktop's authoritative selection.
    element('boardSelect').value = state.selectedBoard;
    connection(connected ? 'connected' : 'reconnecting');
  });
  element('soundVolume').addEventListener('input', event => {
    volumeEditing = true;
    element('volumeValue').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
  });
  element('soundVolume').addEventListener('change', async event => {
    await command({ type: 'volume', value: Number(event.target.value) });
    volumeEditing = false;
    void refresh();
  });
  element('soundVolume').addEventListener('blur', () => { volumeEditing = false; });
  element('stopAll').addEventListener('click', () => void command({ type: 'stop-all' }));
  element('disconnectButton').addEventListener('click', async () => {
    element('disconnectButton').disabled = true;
    try { await request('/api/disconnect', {}); showPairing('Disconnected. Scan the QR code whenever you want to reconnect.'); }
    catch (error) { feedback(error.message, true); }
    finally { element('disconnectButton').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
  window.addEventListener('online', () => void refresh());
  window.addEventListener('offline', () => { if (paired) connection('reconnecting'); });
  window.addEventListener('hashchange', () => { const token = takePairingToken(); if (token) void pair(token); });
  window.addEventListener('pagehide', () => events?.close());
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });

  void (async () => {
    if (initialToken) { await pair(initialToken); return; }
    const current = generation;
    try { const result = await request('/api/state'); if (current === generation) showController(result.state); }
    catch (error) { if (current === generation) showPairing(error.status === 401 ? '' : error.message); }
  })();
})();
