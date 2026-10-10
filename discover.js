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
    let paginated = false, nextCursor = null, totalSounds = null, catalogRevision = 0, searchTimer;
    const knownCategories = new Set();
    let categoriesRendered = false;
    let boardChosen = false;
    const pageSize = window.FreqxDesktopConfig.current.ui.discoverPageSize;
    let visibleLimit = pageSize;
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
      const filtered = paginated ? [...sounds] : sounds.filter(sound =>
        (selectedCategory === 'all' || sound.category === selectedCategory) &&
        `${sound.title} ${sound.description} ${sound.tags.join(' ')}`.toLocaleLowerCase().includes(query));
      filtered.sort($('discoverSort').value === 'duration'
        ? (a, b) => a.duration - b.duration || a.title.localeCompare(b.title)
        : (a, b) => a.title.localeCompare(b.title));
      const shown = filtered.slice(0, visibleLimit);
      grid.replaceChildren(...shown.map(cardFor));
      const remaining = filtered.length - shown.length;
      loadMoreButton.hidden = remaining <= 0 && !nextCursor;
      loadMoreButton.disabled = loading;
      loadMoreButton.textContent = loading && sounds.length ? 'Loading more…' : failed && sounds.length ? 'Try loading more' : remaining > 0 ? `Load more (${remaining} loaded)` : 'Load more';
      $('discoverCount').textContent = paginated
        ? `${shown.length.toLocaleString()} SHOWN / ${totalSounds === null ? sourceLabel.toUpperCase() : `${totalSounds.toLocaleString()} SOUNDS`}`
        : `${String(filtered.length).padStart(2, '0')} ${filtered.length === 1 ? 'SOUND' : 'SOUNDS'} / ${sourceLabel.toUpperCase()}`;
      $('discoverEmpty').hidden = filtered.length > 0 || loading;
      const filteredQuery = Boolean(query || selectedCategory !== 'all');
      $('discoverEmptyTitle').textContent = failed ? 'The library is taking a break.' : sounds.length || filteredQuery ? 'No signal this time.' : 'A little quiet here.';
      $('discoverEmptyCopy').textContent = failed ? 'We couldn’t load the sounds. Try again in a moment.' : sounds.length || filteredQuery ? 'Try a different search or explore all sounds.' : 'Check back for new sounds. Your own boards are ready whenever you are.';
      $('discoverReset').hidden = !filteredQuery || filtered.length > 0;
      $('discoverRetry').hidden = !failed;
      categories.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === selectedCategory)));
      syncAdded();
    }
    function loadingState(value, append = false) {
      loading = value;
      $('discoverLoading').hidden = !value || append;
      if (value) page.setAttribute('aria-busy', 'true');
      else page.removeAttribute('aria-busy');
    }
    function updateCategories(catalog) {
      if (!paginated) knownCategories.clear();
      for (const category of [...(catalog.categories || []), ...catalog.sounds.map(sound => sound.category)]) {
        if (typeof category === 'string' && category && category !== 'all') knownCategories.add(category);
      }
      if (selectedCategory !== 'all') knownCategories.add(selectedCategory);
      const values = ['all', ...knownCategories];
      const buttons = [...categories.querySelectorAll('button')];
      if (categoriesRendered && buttons.length === values.length && buttons.every((button, index) => button.dataset.category === values[index])) return;
      categoriesRendered = true;
      categories.replaceChildren(...values.map(category => {
        const button = element('button', 'discover-category', category === 'all' ? 'All sounds' : humanizeTitle(category));
        button.type = 'button'; button.dataset.category = category;
        button.addEventListener('click', () => {
          if (selectedCategory === category) return;
          selectedCategory = category; changeFilters();
        });
        return button;
      }));
    }
    function changeFilters(delay = 0) {
      clearTimeout(searchTimer);
      stopPreview(); visibleLimit = pageSize;
      if (loaded && !paginated) { render(); return; }
      const revision = ++catalogRevision;
      sounds = []; cards.clear(); nextCursor = null; failed = false;
      loadingState(true); render();
      if (delay) searchTimer = setTimeout(() => void load({ revision }), delay);
      else void load({ revision });
    }
    function resetFilters() {
      search.value = ''; selectedCategory = 'all'; changeFilters();
    }
    async function load({ append = false, revision } = {}) {
      if (append && (loading || !nextCursor)) return;
      if (revision === undefined) revision = append ? catalogRevision : ++catalogRevision;
      const cursor = append ? nextCursor : undefined;
      loadingState(true, append); failed = false; render();
      try {
        const catalog = await adapter.getCatalog({
          search: search.value.trim(), category: selectedCategory === 'all' ? '' : selectedCategory,
          ...(cursor ? { cursor } : {})
        });
        if (revision !== catalogRevision) return;
        if (append && !catalog.paginated) throw new Error('The library could not load more sounds. Try again.');
        paginated = Boolean(catalog.paginated);
        sounds = append
          ? [...new Map([...sounds, ...catalog.sounds].map(sound => [sound.id, sound])).values()]
          : catalog.sounds;
        nextCursor = paginated ? catalog.nextCursor || null : null;
        if (Number.isSafeInteger(catalog.totalSounds) && catalog.totalSounds >= 0) totalSounds = catalog.totalSounds;
        else if (!append) totalSounds = null;
        sourceLabel = catalog.sourceLabel || sourceLabel;
        if (append) visibleLimit += pageSize;
        else { cards.clear(); visibleLimit = pageSize; }
        updateCategories(catalog);
        $('discoverSortLabel').textContent = paginated ? 'Sort loaded' : 'Sort';
        $('discoverSort').setAttribute('aria-label', paginated ? 'Sort loaded sounds' : 'Sort sounds');
        $('discoverState').textContent = catalog.source === 'remote'
          ? 'Sounds from the public freqx library. Ready for your boards.'
          : 'Original sounds. Included with freqx. Ready for your boards.';
        $('discoverSource').textContent = sourceLabel.toUpperCase();
        if (append) $('discoverFeedback').textContent = '';
        loaded = true;
      } catch (error) {
        if (revision !== catalogRevision) return;
        failed = true;
        if (append) $('discoverFeedback').textContent = error?.message || 'Could not load more sounds. Try again.';
        else $('discoverState').textContent = 'Your soundboard is still ready to play.';
      } finally {
        if (revision === catalogRevision) { loadingState(false); render(); }
      }
    }
    function show(discover) {
      $('soundboardPage').hidden = discover;
      page.hidden = !discover;
      tabs.forEach((tab, index) => {
        const selected = index === Number(discover);
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      });
      if (discover) { syncBoards(); if (!loaded && !loading) void load(); }
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
    search.addEventListener('input', () => changeFilters(250));
    $('discoverSort').addEventListener('change', () => { stopPreview(); visibleLimit = pageSize; render(); });
    board.addEventListener('change', () => { boardChosen = true; syncAdded(); });
    $('discoverReset').addEventListener('click', resetFilters);
    $('discoverRetry').addEventListener('click', () => void load());
    loadMoreButton.addEventListener('click', () => {
      if (loading) return;
      if (paginated && visibleLimit >= sounds.length && nextCursor) void load({ append: true });
      else { visibleLimit += pageSize; render(); }
    });
    $('discoverWebsite').addEventListener('click', () => {
      void adapter.openWebsite('soundboard').catch(() => { $('discoverFeedback').textContent = 'Could not open the website. Try again.'; });
    });
    $('discoverExplore').addEventListener('click', () => {
      resetFilters();
      $('discoverCount').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    window.addEventListener('pagehide', () => { clearTimeout(searchTimer); catalogRevision++; stopPreview(); });
    return Object.freeze({ show, stopPreview, refresh: syncBoards });
  }
  window.FreqxDiscover = Object.freeze({ init });
})();
