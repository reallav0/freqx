/* Local microphone conversion transport. The companion never receives the mix. */
(function (root) {
  'use strict';
  const BLOCK_SIZE = 7680;
  const MAX_BLOCKS = 3;
  const scriptUrl = root.document?.currentScript?.src || new URL('audio/voice-conversion.js', root.location.href).href;
  const moduleLoads = new WeakMap();
  const aborted = () => new DOMException('Voice conversion stopped.', 'AbortError');

  async function create(context, { bridge, port = 18000, voiceId, pitch = 0, signal, onReady = () => {}, onError = () => {}, onDiagnostics = () => {} } = {}) {
    if (signal?.aborted) throw aborted();
    if (context?.sampleRate !== 48000) throw new Error('AI voice requires a 48 kHz microphone.');
    if (!['startVoiceConversion', 'convertVoiceFrame', 'stopVoiceConversion'].every(name => typeof bridge?.[name] === 'function')) {
      throw new Error('AI voice is unavailable in this build.');
    }
    let closed = false, sessionId = null, node = null, inFlight = false, ready = false;
    let lastInputSequence = 0;
    const pending = [];
    const stop = id => { try { bridge.stopVoiceConversion(id); } catch {} };
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', close);
      pending.length = 0;
      if (node) {
        node.port.onmessage = null;
        try { node.port.postMessage({ type: 'stop' }); } catch {}
        try { node.disconnect(); } catch {}
      }
      // An absent ID cancels the owner's pending start; stale returned IDs are
      // stopped separately below so they cannot replace a newer microphone.
      stop(sessionId);
    };
    const fail = error => {
      if (closed) return;
      close();
      onError(error instanceof Error ? error : new Error(String(error)));
    };
    signal?.addEventListener('abort', close, { once: true });

    async function pump() {
      if (closed || inFlight || !pending.length) return;
      inFlight = true;
      const frame = pending.shift();
      try {
        const result = await bridge.convertVoiceFrame({ id: sessionId, sequence: frame.sequence, samples: frame.samples });
        if (closed) return;
        if (!result?.ok) throw new Error(result?.error || 'The AI voice engine stopped responding.');
        if (result.id !== sessionId || result.sequence !== frame.sequence || !(result.samples instanceof Float32Array)
          || result.samples.length !== BLOCK_SIZE || !result.samples.every(Number.isFinite)) {
          throw new Error('The AI voice engine returned invalid audio.');
        }
        node.port.postMessage({ type: 'output', sequence: result.sequence, samples: result.samples }, [result.samples.buffer]);
        if (!ready) { ready = true; onReady(); }
        onDiagnostics({ processingMs: Number.isFinite(result.processingMs) ? result.processingMs : 0, blockMs: BLOCK_SIZE / 48, queuedBlocks: pending.length });
      } catch (error) {
        fail(error);
      } finally {
        inFlight = false;
        if (!closed) void pump();
      }
    }

    try {
      const result = await bridge.startVoiceConversion({ port, voiceId, pitch });
      if (result?.ok && typeof result.id === 'string') sessionId = result.id;
      if (closed || signal?.aborted) { if (sessionId) stop(sessionId); throw aborted(); }
      if (!result?.ok) throw new Error(result?.error || 'The AI voice engine could not start.');
      if (!sessionId || result.sampleRate !== 48000 || result.blockSize !== BLOCK_SIZE) throw new Error('The AI voice engine uses an unsupported audio format.');
      if (!moduleLoads.has(context)) {
        const url = new URL('voice-conversion-worklet.mjs', scriptUrl).href;
        const loading = context.audioWorklet.addModule(url);
        moduleLoads.set(context, loading);
        loading.catch(() => { if (moduleLoads.get(context) === loading) moduleLoads.delete(context); });
      }
      await moduleLoads.get(context);
      if (closed || signal?.aborted) throw aborted();
      node = new AudioWorkletNode(context, 'freqx-voice-conversion', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { blockSize: BLOCK_SIZE, maxBlocks: MAX_BLOCKS }
      });
      node.addEventListener('processorerror', () => fail(new Error('AI voice audio processing stopped.')));
      node.port.onmessage = ({ data }) => {
        if (closed) return;
        if (data?.type === 'error') { fail(new Error(data.message || 'AI voice audio buffering stopped.')); return; }
        if (data?.type !== 'input') return;
        if (!(data.samples instanceof Float32Array) || data.samples.length !== BLOCK_SIZE || !Number.isSafeInteger(data.sequence) || data.sequence !== lastInputSequence + 1) {
          fail(new Error('AI voice microphone audio is invalid.')); return;
        }
        lastInputSequence = data.sequence;
        if (pending.length + (inFlight ? 1 : 0) >= MAX_BLOCKS) {
          fail(new Error('The AI voice engine cannot keep up with live audio.')); return;
        }
        pending.push(data);
        void pump();
      };
      return { node, close };
    } catch (error) {
      close();
      throw error;
    }
  }

  root.FreqxVoiceConversion = Object.freeze({ create });
})(globalThis);
