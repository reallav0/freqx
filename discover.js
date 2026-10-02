/* UI-only controller. Catalog access and audio routing stay in the app adapter. */
(() => {
  'use strict';
  function init(adapter) {
    const $ = id => document.getElementById(id);
    const tabs = [$('soundboardTab'), $('discoverTab')];
    const page = $('discoverPage');
    if (!page) return;
    const grid = $('discoverGrid');
    const search = $('discoverSearch');
    const board = $('discoverBoard');
    const categories = $('discoverCategories');
    const loadMoreButton = $('discoverLoadMore');
    let sounds = [], selectedCategory = 'all', loaded = false, loading = false;
    let sourceLabel = 'FREQX ORIGINALS';
    let failed = false, playingId = null, previewRevision = 0;
    let boardChosen = false;
    let visibleLimit = 60;
    const pendingAdds = new Set();
    const cards = new Map();
    function element(tag, className, text) {
      const node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function humanizeTitle(value) {
      return String(value == null ? '' : value).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    function previewState(id) {
      playingId = id;
      for (const [soundId, card] of cards) {
        const button = card.querySelector('.discover-preview');
        const active = soundId === id;
        card.classList.toggle('is-playing', active);
        button.setAttribute('aria-pressed', String(active));
        button.textContent = active ? '■' : '▶';
      }
    }
    function stopPreview() {
      previewRevision++;
      adapter.stopPreview();
      previewState(null);
    }
    function syncBoards() {
      const choices = adapter.getBoards();
      const current = board.value;
      board.replaceChildren(...choices.boards.map(name => {
        const option = document.createElement('option'); option.value = name; option.textContent = name; return option;
      }));
      board.value = boardChosen && choices.boards.includes(current) ? current : choices.preferred;
      if (!board.value && board.options.length) board.selectedIndex = 0;
      syncAdded();
    }
    function syncAdded() {
      for (const [id, card] of cards) {
        const button = card.querySelector('.discover-add');
        const added = adapter.isAdded(id, board.value);
        const pending = pendingAdds.has(id);
        button.disabled = added || pending || !board.value;
        button.firstChild.textContent = pending ? 'Adding…' : added ? 'In this board' : 'Add to board';
        button.lastChild.textContent = added ? '✓' : '+';
      }
    }
    async function preview(sound) {
      if (playingId === sound.id) { stopPreview(); return; }
      stopPreview();
      const revision = previewRevision;
      previewState(sound.id);
      $('discoverFeedback').textContent = `Previewing ${sound.title} · Monitor only`;
      try {
        await adapter.previewSound(sound.id, () => {
          if (revision === previewRevision) {
            previewState(null); $('discoverFeedback').textContent = '';
          }
        });
      } catch (error) {
        if (revision !== previewRevision) return;
        stopPreview();
        $('discoverFeedback').textContent = error?.message || 'Preview unavailable. Try again.';
      }
    }
    async function add(sound) {
      const targetBoard = board.value;
      if (!targetBoard || pendingAdds.has(sound.id) || adapter.isAdded(sound.id, targetBoard)) return;
      pendingAdds.add(sound.id); syncAdded();
      $('discoverFeedback').textContent = `Adding ${sound.title}…`;
      try {
        await adapter.importSound(sound, targetBoard);
        $('discoverFeedback').textContent = `Added ${sound.title} to ${targetBoard}. Ready on your soundboard.`;
      } catch (error) {
        $('discoverFeedback').textContent = error?.message || 'Could not add this sound. Please try again.';
      } finally { pendingAdds.delete(sound.id); syncAdded(); }
    }
    function makeCard(sound) {
      const card = element('article', 'discover-card'); card.dataset.soundId = sound.id;
      const title = humanizeTitle(sound.title || sound.id);
      const topline = element('div', 'discover-card-top');
      const durationLabel = sound.duration > 0 ? `${sound.duration.toFixed(1)}s` : (sound.format || '');
      topline.append(element('span', '', sound.category), element('span', '', durationLabel));
      const waveRow = element('div', 'discover-card-wave');
      const wave = element('div', 'discover-waveform'); wave.setAttribute('aria-hidden', 'true');
      for (const value of sound.waveform || []) {
        const bar = document.createElement('i');
        bar.style.setProperty('--bar-height', `${Math.max(8, Math.min(100, Number(value) * 100 || 0))}%`); wave.append(bar);
      }
      const play = element('button', 'discover-preview', '▶'); play.type = 'button';
      play.setAttribute('aria-label', `Preview ${title}`); play.setAttribute('aria-pressed', 'false');
      play.addEventListener('click', () => void preview(sound));
      waveRow.append(wave, play);
      const addButton = element('button', 'discover-add'); addButton.type = 'button';
      addButton.setAttribute('aria-label', `Add ${title} to board`);
      addButton.append(element('span', '', 'Add to board'), element('span', '', '+'));
      addButton.lastChild.setAttribute('aria-hidden', 'true');
      addButton.addEventListener('click', () => void add(sound));
      const children = [topline, waveRow, element('h2', '', title)];
      const metaParts = [];
      if (sound.sizeBytes > 0) metaParts.push(formatBytes(sound.sizeBytes));
      if (sound.tags?.length) metaParts.push(sound.tags.slice(0, 4).map(humanizeTitle).join(' / '));
      if (metaParts.length) {
        const meta = element('div', 'discover-card-meta');
        meta.append(...metaParts.map(text => element('span', '', text)));
        children.push(meta);
      }
      children.push(element('p', 'discover-card-description', sound.description));
      children.push(addButton);
      card.append(...children);
      return card;
    }
    function cardFor(sound) {
      if (!cards.has(sound.id)) cards.set(sound.id, makeCard(sound));
      return cards.get(sound.id);
    }
    function render() {
      const query = search.value.trim().toLocaleLowerCase();
      const filtered = sounds.filter(sound =>
        (selectedCategory === 'all' || sound.category === selectedCategory) &&
        `${sound.title} ${sound.description} ${sound.tags.join(' ')}`.toLocaleLowerCase().includes(query));
      filtered.sort($('discoverSort').value === 'duration'
        ? (a, b) => a.duration - b.duration || a.title.localeCompare(b.title)
        : (a, b) => a.title.localeCompare(b.title));
      const shown = filtered.slice(0, visibleLimit);
      grid.replaceChildren(...shown.map(cardFor));
      const remaining = filtered.length - shown.length;
      loadMoreButton.hidden = remaining <= 0;
      loadMoreButton.textContent = remaining > 0 ? `Load more (${remaining})` : 'Load more';
      $('discoverCount').textContent = `${String(filtered.length).padStart(2, '0')} ${filtered.length === 1 ? 'SOUND' : 'SOUNDS'} / ${sourceLabel.toUpperCase()}`;
      $('discoverEmpty').hidden = filtered.length > 0 || loading;
      $('discoverEmptyTitle').textContent = failed ? 'The library is taking a break.' : sounds.length ? 'No signal this time.' : 'A little quiet here.';
      $('discoverEmptyCopy').textContent = failed ? 'We couldn’t load the sounds. Try again in a moment.' : sounds.length ? 'Try a different search or explore all sounds.' : 'Check back for new sounds. Your own boards are ready whenever you are.';
      $('discoverReset').hidden = !sounds.length || filtered.length > 0;
      $('discoverRetry').hidden = !failed;
      categories.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === selectedCategory)));
      syncAdded();
    }
    function resetFilters() {
      search.value = ''; selectedCategory = 'all'; visibleLimit = 60; stopPreview(); render();
    }
    async function load() {
      if (loading) return;
      loading = true; failed = false;
      $('discoverLoading').hidden = false; $('discoverEmpty').hidden = true;
      page.setAttribute('aria-busy', 'true');
      try {
        const catalog = await adapter.getCatalog();
        sounds = catalog.sounds;
        sourceLabel = catalog.sourceLabel || sourceLabel;
        cards.clear();
        visibleLimit = 60;
        categories.replaceChildren(...['all', ...new Set(sounds.map(sound => sound.category))].map(category => {
          const button = element('button', 'discover-category', category === 'all' ? 'All sounds' : category);
          button.type = 'button'; button.dataset.category = category;
          button.addEventListener('click', () => { selectedCategory = category; visibleLimit = 60; stopPreview(); render(); });
          return button;
        }));
        $('discoverState').textContent = catalog.source === 'remote'
          ? 'Sounds from the public freqx library. Ready for your boards.'
          : 'Original sounds. Included with freqx. Ready for your boards.';
        $('discoverSource').textContent = sourceLabel.toUpperCase();
        loaded = true;
      } catch {
        failed = true; $('discoverState').textContent = 'Your soundboard is still ready to play.';
      } finally {
        loading = false; $('discoverLoading').hidden = true;
        page.removeAttribute('aria-busy'); render();
      }
    }
    function show(discover) {
      $('soundboardPage').hidden = discover;
      page.hidden = !discover;
      tabs.forEach((tab, index) => {
        const selected = index === Number(discover);
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      });
      if (discover) { syncBoards(); if (!loaded) void load(); }
      else { stopPreview(); $('discoverFeedback').textContent = ''; }
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => show(index === 1));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
        show(next === 1); tabs[next].focus();
      });
    });
    search.addEventListener('input', () => { stopPreview(); visibleLimit = 60; render(); });
    $('discoverSort').addEventListener('change', () => { stopPreview(); visibleLimit = 60; render(); });
    board.addEventListener('change', () => { boardChosen = true; syncAdded(); });
    $('discoverReset').addEventListener('click', resetFilters);
    $('discoverRetry').addEventListener('click', () => void load());
    loadMoreButton.addEventListener('click', () => { visibleLimit += 60; render(); });
    $('discoverExplore').addEventListener('click', () => {
      resetFilters();
      $('discoverCount').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    window.addEventListener('pagehide', stopPreview);
    return Object.freeze({ show, stopPreview, refresh: syncBoards });
  }
  window.FreqxDiscover = Object.freeze({ init });
})();
