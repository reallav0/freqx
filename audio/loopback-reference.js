/* Exact Windows playback endpoint reference. Captured PCM stays in this app. */
(() => {
  'use strict';
  const assetBase = new URL('.', document.currentScript.src);
  const active = new Map();
  const details = new WeakMap();
  let runtime;
  const supported = Boolean(window.soundmuncher?.startReference && window.soundmuncher?.onReferenceData);

  async function acquire({ timeoutMs = 4000, endpointId = '', signal } = {}) {
    if (!supported || signal?.aborted) return null;
    let capture, node, destination, unsubscribe, timer, track, closed = false;
    let sessionRuntime;
    let canceled = false;
    const releaseRuntime = () => {
      const released = sessionRuntime; sessionRuntime = null;
      if (!released) return;
      released.users = Math.max(0, released.users - 1);
      if (!released.users && released.context.state !== 'closed') void released.context.suspend().then(() => {
        if (released.users && released.context.state === 'suspended') return released.context.resume();
      }).catch(() => {});
    };
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(timer);
      signal?.removeEventListener('abort', close);
      unsubscribe?.();
      if (capture) void window.soundmuncher.stopReference(capture.id).catch(() => {});
      else if (canceled) void window.soundmuncher.cancelReference().catch(() => {});
      if (node) {
        const closingNode = node;
        let teardownTimer;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(teardownTimer); closingNode.disconnect(); closingNode.port.onmessage = null; closingNode.port.close();
          releaseRuntime();
        };
        closingNode.port.onmessage = ({ data }) => { if (data?.type === 'destroyed') finish(); };
        teardownTimer = setTimeout(finish, 250);
        closingNode.port.postMessage({ type: 'destroy' });
      } else releaseRuntime();
      destination?.stream.getTracks().forEach(value => value.stop());
      if (track) active.delete(track);
    };
    timer = setTimeout(close, timeoutMs);
    signal?.addEventListener('abort', close, { once: true });
    try {
      if (!runtime || runtime.context.state === 'closed') {
        const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        const module = context.audioWorklet.addModule(new URL('reference-worklet.mjs', assetBase).href).catch(error => {
          if (runtime?.context === context) runtime = null;
          void context.close().catch(() => {});
          throw error;
        });
        runtime = { context, module, users: 0 };
      }
      sessionRuntime = runtime; sessionRuntime.users++;
      const context = runtime.context;
      await runtime.module;
      if (closed) return null;
      // Subscribe before starting capture; ready/data ordering crosses two pipes.
      unsubscribe = window.soundmuncher.onReferenceData(packet => {
        if (!capture || packet?.id !== capture.id || closed) return;
        if (packet.type === 'ended') { track?.dispatchEvent(new Event('ended')); close(); }
        else if (packet.type === 'reset') node?.port.postMessage({ type: 'reset' });
        else if (packet.type === 'pcm') {
          const samples = new Float32Array(packet.samples);
          node?.port.postMessage({ type: 'pcm', samples }, [samples.buffer]);
        }
      });
      canceled = true;
      capture = await window.soundmuncher.startReference(endpointId);
      if (closed) { void window.soundmuncher.stopReference(capture.id).catch(() => {}); return null; }
      node = new AudioWorkletNode(context, 'freqx-playback-reference', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { sampleRate: capture.sampleRate }
      });
      destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      node.connect(destination);
      await context.resume();
      if (closed) return null;
      clearTimeout(timer);
      track = destination.stream.getAudioTracks()[0];
      details.set(track, Object.freeze({ endpointId: capture.endpointId, label: capture.label, source: 'WASAPI', sampleRate: capture.sampleRate }));
      active.set(track, close);
      node.addEventListener('processorerror', () => { track.dispatchEvent(new Event('ended')); close(); });
      return track;
    } catch (error) { close(); console.warn('[PlaybackReference]', error.message); return null; }
  }
  function release(track) { if (active.has(track)) active.get(track)(); else track?.stop(); }
  window.addEventListener('pagehide', () => {
    for (const close of [...active.values()]) close();
    if (runtime) void runtime.context.close().catch(() => {});
    runtime = null;
  });
  window.LoopbackReference = Object.freeze({ acquire, release, supported, details: track => details.get(track) || null });
})();
