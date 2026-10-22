/* Offline microphone effects. No engine, model downloads, or network transport. */
(function (root) {
  'use strict';
  const scriptUrl = root.document?.currentScript?.src || new URL('audio/voice-presets.js', root.location.href).href;
  const moduleLoads = new WeakMap();
  const presets = Object.freeze([
    { id: 'anime', name: 'Anime girl', semitones: 5, lowCut: 140, highCut: 11000, body: -3, brightness: 3 },
    { id: 'deep', name: 'Deep man', semitones: -5, lowCut: 65, highCut: 7000, body: 4, brightness: -2 },
    { id: 'robot', name: 'Robot', semitones: 0, lowCut: 110, highCut: 8000, ringHz: 45, ringMix: 0.85, drive: 1.4 },
    { id: 'helium', name: 'Helium', semitones: 10, lowCut: 210, highCut: 12000, body: -4, brightness: 2 },
    { id: 'monster', name: 'Monster', semitones: -9, lowCut: 55, highCut: 5000, body: 4, ringHz: 28, ringMix: 0.35, drive: 2 },
    { id: 'radio', name: 'Radio', semitones: 0, lowCut: 380, highCut: 3200, drive: 3 }
  ].map(Object.freeze));

  async function create(context, { presetId = 'anime', pitch = 0, signal, onReady = () => {}, onError = () => {} } = {}) {
    const preset = presets.find(value => value.id === presetId);
    if (!preset || !Number.isFinite(pitch) || pitch < -12 || pitch > 12) throw new Error('Choose an available voice preset and a pitch from -12 to +12.');
    if (context?.sampleRate !== 48000) throw new Error('Voice presets require a 48 kHz microphone.');
    const aborted = () => new DOMException('Voice preset stopped.', 'AbortError');
    if (signal?.aborted) throw aborted();
    if (!moduleLoads.has(context)) {
      const loading = context.audioWorklet.addModule(new URL('voice-presets-worklet.mjs', scriptUrl).href);
      moduleLoads.set(context, loading);
      loading.catch(() => { if (moduleLoads.get(context) === loading) moduleLoads.delete(context); });
    }
    await moduleLoads.get(context);
    if (signal?.aborted) throw aborted();
    const node = new AudioWorkletNode(context, 'freqx-voice-presets', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { ...preset, semitones: Math.max(-18, Math.min(18, preset.semitones + pitch)) }
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; signal?.removeEventListener('abort', close); node.port.onmessage = null;
      try { node.port.postMessage({ type: 'stop' }); } catch {}
      try { node.disconnect(); } catch {}
    };
    const fail = error => { if (!closed) { close(); onError(error); } };
    node.addEventListener('processorerror', () => fail(new Error('Voice preset processing stopped.')));
    node.port.onmessage = ({ data }) => {
      if (closed) return;
      if (data?.type === 'ready') onReady();
      else if (data?.type === 'error') fail(new Error('Voice preset processing stopped.'));
    };
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) { close(); throw aborted(); }
    return { node, close };
  }

  root.FreqxVoicePresets = Object.freeze({ presets, create });
})(globalThis);
