/* Replay controls only. Recording, file access and playback use narrow adapters. */
(() => {
  'use strict';
  function init(adapter) {
    const $ = id => document.getElementById(id);
    const page = $('replayPage');
    if (!page) return;
    const source = $('replaySource'), bufferSize = $('replayBuffer'), canvas = $('replayWaveCanvas');
    const context = canvas.getContext('2d');
    let sources = [];
    let sourcesLoaded = false, sourceRevision = 0, loadingSources = false;
    let recorder = null, starting = false, recording = false, captureBusy = false, saving = false;
    let recordRevision = 0, buffered = 0, level = 0;
    let editor = null, selection = { start: 0, end: 0 }, cursor = 0, peaks = null;
    let drag = null, preview = null, previewRevision = 0, previewPending = false, animation = 0;
    let boardChosen = false, destroyed = false;
    const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
    const seconds = value => Math.max(0, value || 0).toFixed(2);
    const clock = value => `${Math.floor(Math.max(0, value) / 60)}:${(Math.max(0, value) % 60).toFixed(1).padStart(4, '0')}`;
    function feedback(message, error = false) {
      $('replayFeedback').textContent = message;
      $('replayFeedback').dataset.error = String(error);
    }
    function captureFeedback(message, error = false) {
      $('replayCaptureHelp').textContent = message;
      $('replayCaptureHelp').dataset.error = String(error);
    }
    function selectedSource() { return sources.find(item => `${item.kind}:${item.id || ''}` === source.value) || sources[0]; }
    function sourceHint() {
      const hints = {
        desktop: 'Records audio from all desktop apps. Your microphone is not added.',
        application: 'Records only the selected app. Your microphone is not added.',
        device: 'Records audio playing through the selected playback device.',
        microphone: 'Records raw microphone audio before isolation and voice effects. Choose Freqx mix for your processed voice.',
        mix: 'Records the Freqx mix: processed microphone and soundboard clips.'
      };
      return hints[selectedSource()?.kind] || 'Recording starts only when you press Start.';
    }
    function updateRecording() {
      const active = recording || starting;
      $('replayTabBadge').hidden = !active;
      $('replayTabBadge').textContent = starting ? 'Starting' : 'Recording';
      $('replayRecordState').dataset.active = String(active);
      const recordLabel = starting ? 'Starting…' : recording ? 'Recording' : 'Buffer off';
      if ($('replayRecordState').dataset.label !== recordLabel) {
        $('replayRecordState').dataset.label = recordLabel; $('replayRecordState').replaceChildren();
        const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true');
        $('replayRecordState').append(dot, document.createTextNode(recordLabel));
      }
      $('replayStart').dataset.active = String(active);
      $('replayStart').disabled = !active && (loadingSources || !sources.length);
      const startLabel = starting ? 'Cancel start' : recording ? 'Stop buffer' : 'Start buffer';
      if ($('replayStart').dataset.label !== startLabel) {
        $('replayStart').dataset.label = startLabel; $('replayStart').replaceChildren();
        const icon = document.createElement('span'); icon.className = 'replay-record-dot'; icon.setAttribute('aria-hidden', 'true');
        $('replayStart').append(icon, document.createTextNode(startLabel));
      }
      source.disabled = active || loadingSources;
      bufferSize.disabled = active;
      $('refreshReplaySources').disabled = active || loadingSources;
      $('replayCapture').disabled = !recording || buffered <= 0 || captureBusy;
      $('replayCapture').textContent = captureBusy ? 'Capturing…' : `Capture last ${bufferSize.value}s`;
      $('replayBuffered').textContent = `${buffered.toFixed(1)} / ${bufferSize.value}s`;
      $('replayInputMeter').setAttribute('aria-valuenow', String(clamp(level, 0, 1)));
      $('replayInputMeter').firstElementChild.style.width = `${clamp(level, 0, 1) * 100}%`;
    }
    function refreshBoards() {
      const current = $('replayBoard').value, choices = adapter.getBoards();
      $('replayBoard').replaceChildren(...choices.boards.map(name => {
        const option = document.createElement('option'); option.value = name; option.textContent = name; return option;
      }));
      $('replayBoard').value = boardChosen && choices.boards.includes(current) ? current : choices.preferred;
      if (!$('replayBoard').value && $('replayBoard').options.length) $('replayBoard').selectedIndex = 0;
      updateEditor(false);
    }
    async function refreshSources() {
      const revision = ++sourceRevision, previous = source.value;
      loadingSources = true; updateRecording();
      try {
        const result = await adapter.getSources();
        if (revision !== sourceRevision || destroyed) return;
        const known = new Map();
        for (const item of result.sources || []) {
          if (typeof item?.kind === 'string' && typeof item.label === 'string') known.set(`${item.kind}:${item.id || ''}`, item);
        }
        if (!known.size) throw new Error('No recording sources are available.');
        sources = [...known.values()];
        source.replaceChildren();
        for (const item of sources) {
          const option = document.createElement('option'); option.value = `${item.kind}:${item.id || ''}`; option.textContent = item.label; source.appendChild(option);
        }
        source.value = [...known.keys()].includes(previous) ? previous : `${sources[0].kind}:${sources[0].id || ''}`;
        sourcesLoaded = true;
        captureFeedback(result.error || sourceHint(), Boolean(result.error));
        if (result.error) feedback(result.error, true);
        else feedback('Recording sources are ready. Start a buffer to capture a moment.');
      } catch (error) { if (revision === sourceRevision) feedback(error?.message || 'Could not refresh recording sources.', true); }
      finally { if (revision === sourceRevision) { loadingSources = false; updateRecording(); } }
    }
    async function stopRecording() {
      recordRevision++; starting = false; recording = false; level = 0; updateRecording();
      try { await recorder?.stop(); }
      catch (error) { feedback(error?.message || 'Could not stop recording.', true); }
      captureFeedback(sourceHint());
      updateRecording();
    }
    async function startRecording() {
      if (starting || recording) { await stopRecording(); return; }
      const revision = ++recordRevision;
      try {
        if (!window.FreqxReplayAudio?.Recorder) throw new Error('Replay recording is unavailable in this build.');
        if (!recorder) recorder = new window.FreqxReplayAudio.Recorder({
          bridge: window.soundmuncher, getStream: adapter.getStream,
          onUpdate: state => {
            if (destroyed) return;
            buffered = Number.isFinite(state.bufferedSeconds) ? state.bufferedSeconds : 0;
            level = Number.isFinite(state.level) ? state.level : 0;
            recording = Boolean(state.active); updateRecording();
          },
          onError: error => {
            if (destroyed) return;
            recordRevision++; starting = false; recording = false; level = 0; updateRecording();
            captureFeedback(error?.message || 'Recording stopped unexpectedly.', true);
            feedback(error?.message || 'Recording stopped unexpectedly.', true);
          }
        });
        starting = true; buffered = 0; updateRecording(); feedback('Starting your rolling buffer…'); captureFeedback('Starting your rolling buffer…');
        await recorder.start({ ...selectedSource() }, Number(bufferSize.value));
        if (revision !== recordRevision || destroyed) return;
        starting = false; recording = recorder.active; updateRecording();
        feedback('Buffer running. Capture a moment whenever you are ready.');
        captureFeedback(`${sourceHint()} Buffer running in memory.`);
      } catch (error) {
        if (revision !== recordRevision || destroyed) return;
        starting = false; recording = false; level = 0; updateRecording();
        captureFeedback(error?.message || 'Could not start this recording source.', true);
        feedback(error?.message || 'Could not start this recording source.', true);
      }
    }
    function updateSelection() {
      const duration = editor?.duration || 0;
      selection.start = clamp(selection.start, 0, duration);
      selection.end = clamp(selection.end, selection.start, duration);
      $('replayIn').value = seconds(selection.start); $('replayOut').value = seconds(selection.end);
      $('replaySelectionLabel').textContent = `${(selection.end - selection.start).toFixed(2)}s selected`;
      $('replayTrim').disabled = !editor || selection.end <= selection.start || saving;
      $('replayCut').disabled = !editor || selection.end <= selection.start || selection.end - selection.start >= duration - 1 / 48000 || saving;
      drawWaveform();
    }
    function updateEditor(rebuild = true) {
      const duration = editor?.duration || 0, disabled = !editor || saving;
      for (const id of ['replayIn','replayOut','replaySeek','replayPlay','replayGain','replayFadeIn','replayFadeOut','replayReset','replayExport']) $(id).disabled = disabled;
      $('replaySave').disabled = disabled || !$('replayBoard').value;
      $('replayUndo').disabled = disabled || !editor?.canUndo;
      $('replayRedo').disabled = disabled || !editor?.canRedo;
      $('replayStopPreview').disabled = !preview && !previewPending;
      $('replayWaveEmpty').hidden = Boolean(editor);
      $('replaySelectionLabel').hidden = !editor;
      $('replayWaveform').dataset.loaded = String(Boolean(editor));
      $('replayClipDuration').textContent = editor ? `${duration.toFixed(2)} seconds · stereo` : 'No capture yet';
      $('replayRulerMiddle').textContent = editor ? clock(duration / 2) : '—';
      $('replayRulerEnd').textContent = editor ? clock(duration) : '—';
      for (const id of ['replayIn','replayOut','replaySeek','replayFadeIn','replayFadeOut']) $(id).max = String(duration);
      if (editor) {
        const effects = editor.effects;
        $('replayGain').value = String(effects.gain); $('replayFadeIn').value = String(effects.fadeIn); $('replayFadeOut').value = String(effects.fadeOut);
      }
      $('replayGainValue').textContent = `${Math.round(Number($('replayGain').value) * 100)}%`;
      if (rebuild) peaks = null;
      cursor = clamp(cursor, 0, duration); $('replaySeek').value = String(cursor); $('replayPosition').textContent = clock(cursor);
      updateSelection();
    }
    function drawWaveform() {
      const bounds = canvas.getBoundingClientRect(), width = Math.max(1, Math.round(bounds.width)), height = Math.max(1, Math.round(bounds.height));
      const scale = window.devicePixelRatio || 1;
      if (canvas.width !== width * scale || canvas.height !== height * scale) { canvas.width = width * scale; canvas.height = height * scale; peaks = null; }
      context.setTransform(scale, 0, 0, scale, 0, 0); context.clearRect(0, 0, width, height);
      const colors = getComputedStyle(page), border = colors.getPropertyValue('--border').trim(), accent = colors.getPropertyValue('--accent').trim();
      context.strokeStyle = border; context.lineWidth = 1;
      context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
      if (!editor || editor.duration <= 0) return;
      const start = selection.start / editor.duration * width, end = selection.end / editor.duration * width;
      context.fillStyle = accent; context.globalAlpha = .1; context.fillRect(start, 0, end - start, height); context.globalAlpha = 1;
      const points = Math.max(1, Math.floor(width / 3));
      if (!peaks || peaks.min.length !== points) {
        peaks = editor.waveform(points);
        peaks.extent = .01;
        for (let index = 0; index < peaks.min.length; index++) peaks.extent = Math.max(peaks.extent, Math.abs(peaks.min[index]), Math.abs(peaks.max[index]));
      }
      for (let index = 0; index < peaks.min.length; index++) {
        const x = (index + .5) * width / peaks.min.length;
        context.strokeStyle = x >= start && x <= end ? accent : colors.getPropertyValue('--text-muted').trim();
        context.beginPath(); context.moveTo(x, height / 2 - peaks.max[index] / peaks.extent * height * .4);
        context.lineTo(x, height / 2 - peaks.min[index] / peaks.extent * height * .4); context.stroke();
      }
      context.fillStyle = accent;
      for (const x of [start,end]) { context.fillRect(clamp(x - 1, 0, width - 2), 0, 2, height); context.fillRect(clamp(x - 3, 0, width - 6), height / 2 - 10, 6, 20); }
      const x = cursor / editor.duration * width;
      context.strokeStyle = colors.getPropertyValue('--text').trim(); context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    }
    function stopPreview() {
      previewRevision++; previewPending = false;
      cancelAnimationFrame(animation); animation = 0;
      preview?.stop(); preview = null; adapter.stopPreview(); updateEditor(false);
    }
    async function play(start = selection.start) {
      if (!editor) return;
      stopPreview(); const revision = previewRevision;
      const end = start < selection.end ? selection.end : editor.duration;
      if (start >= end) return;
      previewPending = true; updateEditor(false);
      try {
        const handle = await adapter.preview(editor.render(), { start, end, onEnded: () => {
          if (revision !== previewRevision) return;
          preview = null; previewPending = false; cancelAnimationFrame(animation); cursor = end; updateEditor(false);
        } });
        if (revision !== previewRevision || destroyed) { handle?.stop(); return; }
        preview = handle; previewPending = false; updateEditor(false);
        const tick = () => {
          if (!preview || revision !== previewRevision) return;
          cursor = clamp(preview.position(), 0, editor.duration); $('replaySeek').value = String(cursor); $('replayPosition').textContent = clock(cursor);
          drawWaveform(); animation = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) {
        if (revision !== previewRevision) return;
        previewPending = false; updateEditor(false); feedback(error?.message || 'Could not preview this clip.', true);
      }
    }
    async function capture() {
      if (!recorder?.active || captureBusy) return;
      captureBusy = true; updateRecording();
      try {
        const clip = await recorder.snapshot();
        if (destroyed) return;
        stopPreview(); editor = new window.FreqxReplayAudio.Editor(clip);
        selection = { start: 0, end: editor.duration }; cursor = 0; updateEditor();
        feedback(`Captured ${editor.duration.toFixed(2)} seconds. Select the part you want to keep.`);
      } catch (error) { feedback(error?.message || 'The buffer is not ready yet.', true); }
      finally { captureBusy = false; updateRecording(); }
    }
    function edit(action) {
      if (!editor) return;
      stopPreview();
      try {
        action(); selection = { start: 0, end: editor.duration }; cursor = 0; updateEditor();
      } catch (error) { feedback(error?.message || 'Could not edit this selection.', true); }
    }
    async function save(exportOnly) {
      if (!editor || saving) return;
      const name = $('replayName').value.trim() || 'Replay', board = $('replayBoard').value;
      saving = true; updateEditor(false);
      try {
        const bytes = editor.encode();
        const result = exportOnly ? await adapter.export({ name, bytes }) : await adapter.save({ name, board, bytes });
        if (result?.canceled) { feedback('Export canceled. Your clip is still here.'); return; }
        if (!result?.ok) throw new Error(result?.error || 'Could not save this clip.');
        feedback(exportOnly ? 'WAV exported.' : `Saved ${name} to ${board}. Ready on your soundboard.`);
      } catch (error) { feedback(error?.message || 'Could not save this clip.', true); }
      finally { saving = false; updateEditor(false); }
    }
    $('refreshReplaySources').addEventListener('click', () => void refreshSources());
    $('replayStart').addEventListener('click', () => void startRecording());
    $('replayCapture').addEventListener('click', () => void capture());
    source.addEventListener('change', () => captureFeedback(sourceHint()));
    bufferSize.addEventListener('change', updateRecording);
    $('replayBoard').addEventListener('change', () => { boardChosen = true; updateEditor(false); });
    $('replayPlay').addEventListener('click', () => void play());
    $('replayStopPreview').addEventListener('click', stopPreview);
    $('replaySeek').addEventListener('input', () => {
      cursor = Number($('replaySeek').value); drawWaveform(); $('replayPosition').textContent = clock(cursor);
      if (preview || previewPending) void play(cursor);
    });
    $('replayIn').addEventListener('change', () => { const value = $('replayIn').value; stopPreview(); selection.start = clamp(value, 0, selection.end); updateSelection(); });
    $('replayOut').addEventListener('change', () => { const value = $('replayOut').value; stopPreview(); selection.end = clamp(value, selection.start, editor?.duration || 0); updateSelection(); });
    $('replayTrim').addEventListener('click', () => edit(() => editor.trim(selection.start, selection.end)));
    $('replayCut').addEventListener('click', () => edit(() => editor.cut(selection.start, selection.end)));
    $('replayUndo').addEventListener('click', () => edit(() => editor.undo()));
    $('replayRedo').addEventListener('click', () => edit(() => editor.redo()));
    $('replayReset').addEventListener('click', () => edit(() => editor.reset()));
    $('replayGain').addEventListener('input', () => { $('replayGainValue').textContent = `${Math.round(Number($('replayGain').value) * 100)}%`; });
    for (const id of ['replayGain','replayFadeIn','replayFadeOut']) $(id).addEventListener('change', () => {
      if (!editor) return;
      const effects = { gain: clamp($('replayGain').value, 0, 3), fadeIn: clamp($('replayFadeIn').value, 0, editor.duration), fadeOut: clamp($('replayFadeOut').value, 0, editor.duration) };
      stopPreview();
      try { editor.setEffects(effects); updateEditor(); }
      catch (error) { feedback(error?.message || 'Could not apply clip effects.', true); }
    });
    $('replaySave').addEventListener('click', () => void save(false));
    $('replayExport').addEventListener('click', () => void save(true));
    canvas.addEventListener('pointerdown', event => {
      if (!editor || saving) return;
      stopPreview(); const bounds = canvas.getBoundingClientRect(), time = clamp((event.clientX - bounds.left) / bounds.width * editor.duration, 0, editor.duration);
      const tolerance = 10 / bounds.width * editor.duration;
      drag = Math.abs(time - selection.start) < tolerance ? { edge: 'start' } : Math.abs(time - selection.end) < tolerance ? { edge: 'end' } : { anchor: time };
      if (drag.anchor !== undefined) selection = { start: time, end: time };
      canvas.setPointerCapture(event.pointerId); event.preventDefault(); updateSelection();
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || !editor) return;
      const bounds = canvas.getBoundingClientRect(), time = clamp((event.clientX - bounds.left) / bounds.width * editor.duration, 0, editor.duration);
      if (drag.edge === 'start') selection.start = Math.min(time, selection.end);
      else if (drag.edge === 'end') selection.end = Math.max(time, selection.start);
      else selection = { start: Math.min(time, drag.anchor), end: Math.max(time, drag.anchor) };
      updateSelection();
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
    const observer = new ResizeObserver(() => drawWaveform()); observer.observe(canvas);
    function destroy() {
      if (destroyed) return;
      destroyed = true; sourceRevision++; stopPreview(); void stopRecording(); observer.disconnect();
    }
    window.addEventListener('pagehide', destroy); window.addEventListener('beforeunload', destroy);
    refreshBoards(); updateEditor(); updateRecording();
    return Object.freeze({ show() { refreshBoards(); if (!sourcesLoaded && !loadingSources) void refreshSources(); requestAnimationFrame(drawWaveform); }, hide: stopPreview, stopPreview, refreshBoards, destroy });
  }
  window.FreqxReplayUi = Object.freeze({ init });
})();
