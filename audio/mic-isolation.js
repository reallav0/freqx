/* Local mic processing. The caller owns capture and echo-cancellation fallback. */
(() => {
  'use strict';
  const assetBase = new URL(".", document.currentScript.src);
  const sessions = new Set();
  let assetsPromise;
  let isolationRuntime;
  let aecAssetsPromise;
  const echoOwners = new WeakMap();
  const constraintUpdates = new WeakMap();
  function updateEcho(track, enabled) {
    if (typeof track.applyConstraints !== 'function' || track.readyState !== 'live') return Promise.resolve();
    const update = (constraintUpdates.get(track) || Promise.resolve()).catch(() => {}).then(() => {
      if (track.readyState === 'live') return track.applyConstraints({ echoCancellation: { exact: enabled } });
    });
    constraintUpdates.set(track, update);
    return update;
  }
  const simdProbe = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);

  function captureConstraints(deviceId, { echoCancellation = true } = {}) {
    return {
      echoCancellation, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    };
  }

  function supported() {
    return typeof WebAssembly === 'object' && typeof AudioWorkletNode === 'function' && WebAssembly.validate(simdProbe);
  }

  function normalizedMode(mode) {
    if (!['standard', 'strong'].includes(mode)) throw new TypeError('Voice isolation mode must be standard or strong.');
    return mode;
  }

  function acquireLoopback(endpointId, signal) {
    if (!window.LoopbackReference || typeof window.LoopbackReference.acquire !== 'function') return Promise.resolve(null);
    return Promise.resolve(window.LoopbackReference.acquire({ timeoutMs: window.FreqxDesktopConfig.current.audio.timing.captureTimeoutMs, endpointId, signal })).catch(() => null);
  }

  function releaseLoopback(track) {
    if (!track) return;
    try { window.LoopbackReference?.release?.(track); } catch {}
  }

  async function loadAssets() {
    if (!assetsPromise) {
      assetsPromise = (async () => {
        const read = async (name) => {
          const response = await fetch(new URL(`vendor/deepfilter/${name}`, assetBase));
          if (!response.ok) throw new Error(`Cannot load packaged DeepFilterNet asset: ${name}.`);
          return response.arrayBuffer();
        };
        const [wasm, modelBytes] = await Promise.all([read('dfn3.wasm'), read('dfn3_weights.bin')]);
        if (!modelBytes.byteLength) throw new Error('The packaged DeepFilterNet model is empty.');
        return { wasmModule: await WebAssembly.compile(wasm), modelBytes };
      })().catch((error) => {
        assetsPromise = null;
        throw error;
      });
    }
    return assetsPromise;
  }

  function acquireRuntime() {
    if (!isolationRuntime || isolationRuntime.context.state === 'closed') {
      const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      isolationRuntime = { context, users: 0, modulePromise: null, aecModulePromise: null };
    }
    isolationRuntime.users += 1;
    return isolationRuntime;
  }

  function releaseRuntime(runtime) {
    runtime.users = Math.max(0, runtime.users - 1);
    if (runtime.users || runtime.context.state === 'closed') return;
    // Chromium retains closed AudioWorklet global scopes until document exit.
    // Keep one idle context instead of accumulating one per switch. No model,
    // mic track or processor is retained by it after session teardown.
    void runtime.context.suspend().then(() => {
      // An enable may arrive while Chromium is acknowledging the suspension.
      if (runtime.users && runtime.context.state === 'suspended') return runtime.context.resume();
    }).catch(() => {});
  }

  function loadWorklet(runtime) {
    if (!runtime.modulePromise) {
      runtime.modulePromise = runtime.context.audioWorklet.addModule(new URL('voice-isolation-worklet.mjs', assetBase).href)
        .catch(error => { runtime.modulePromise = null; throw error; });
    }
    return runtime.modulePromise;
  }

  function loadAecWorklet(runtime) {
    if (!runtime.aecModulePromise) {
      runtime.aecModulePromise = runtime.context.audioWorklet.addModule(new URL('aec-worklet.mjs', assetBase).href)
        .catch(error => { runtime.aecModulePromise = null; throw error; });
    }
    return runtime.aecModulePromise;
  }
  async function loadAecAssets() {
    if (!aecAssetsPromise) aecAssetsPromise = (async () => {
      const response = await fetch(new URL('vendor/aec3/aec3.wasm', assetBase));
      if (!response.ok) throw new Error('Cannot load packaged WebRTC AEC3.');
      return WebAssembly.compile(await response.arrayBuffer());
    })().catch(error => { aecAssetsPromise = null; throw error; });
    return aecAssetsPromise;
  }

  async function create(stream, { mode, onError = () => {}, onDiagnostics = () => {}, referenceDeviceId = '', signal, compressor = false } = {}) {
    const config = (await window.FreqxDesktopConfig.ready).audio;
    mode = normalizedMode(mode || config.defaults.voiceIsolationMode);
    if (signal?.aborted) throw new Error("Voice isolation startup canceled.");
    const track = stream?.getAudioTracks().find((value) => value.readyState === 'live');
    if (!track) {
      throw new Error("Voice isolation requires a live microphone.");
    }
    if (!supported()) throw new Error('WebAssembly SIMD or AudioWorklet is unavailable; using microphone echo cancellation.');

    // Resample capture in its own 48 kHz context. Never alter the shared mixer.
    const runtime = acquireRuntime();
    let context = runtime.context;
    let node;
    let source;
    let aecNode;
    let refSource;
    let referenceTrack;
    let aecCaptureStream;
    let rejectAecCapture;
    let aecActive = false;
    let aecUsable = true;
    let aecTeardown = Promise.resolve();
    let rejectAecStartup;
    let pendingAecPing = null;
    const echoOwner = {};
    let diagnostics = { engine: 'Chromium AEC', reference: 'unavailable', referenceLabel: '', referenceDb: -100, latencyMs: 0 };
    const publish = changes => {
      diagnostics = Object.freeze({ ...diagnostics, ...changes });
      try { onDiagnostics(diagnostics); } catch {}
    };
    const restoreEcho = () => {
      if (echoOwners.get(track) !== echoOwner) return Promise.resolve();
      echoOwners.delete(track);
      return updateEcho(track, true).catch(error => console.warn('[VoiceIsolation] Cannot restore microphone echo cancellation:', error.message));
    };
    const releaseAecCapture = () => {
      if (!aecCaptureStream) return;
      for (const value of aecCaptureStream.getTracks()) {
        value.removeEventListener('ended', aecProcessorError);
        value.stop();
      }
      aecCaptureStream = null;
    };
    async function acquireRawCapture() {
      // Chromium/device implementations can reject changing AEC on a live source.
      // In that case keep the caller's AEC stream as a standby and own a raw one.
      const deviceId = track.getSettings?.().deviceId;
      if (!deviceId || !navigator.mediaDevices?.getUserMedia) throw new Error('Cannot acquire an unprocessed microphone for AEC3.');
      let abandoned = false;
      let timer;
      const pending = navigator.mediaDevices.getUserMedia({ audio: captureConstraints(deviceId, { echoCancellation: false }), video: false }).then(capture => {
        if (abandoned || closed) { capture.getTracks().forEach(value => value.stop()); return null; }
        return capture;
      });
      try {
        const capture = await Promise.race([pending, new Promise((resolve, reject) => {
          rejectAecCapture = reject;
          timer = setTimeout(() => reject(new Error('Unprocessed microphone startup timed out.')), config.timing.captureTimeoutMs);
        })]);
        const input = capture?.getAudioTracks().find(value => value.readyState === 'live');
        if (!input || input.getSettings().echoCancellation !== false || input.label !== track.label) {
          capture?.getTracks().forEach(value => value.stop());
          throw new Error('Unprocessed microphone does not match the selected input.');
        }
        aecCaptureStream = capture;
        input.addEventListener('ended', aecProcessorError, { once: true });
      } finally { abandoned = true; clearTimeout(timer); rejectAecCapture = null; }
    }
    const destroyAec = () => {
      const closingAec = aecNode;
      if (!closingAec) return;
      closingAec.removeEventListener('processorerror', aecProcessorError);
      let resolveTeardown;
      aecTeardown = new Promise(resolve => { resolveTeardown = resolve; });
      let timer;
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); closingAec.disconnect(); closingAec.port.onmessage = null; closingAec.port.close(); resolveTeardown(); };
      closingAec.port.onmessage = ({ data }) => { if (data?.type === 'destroyed') finish(); };
      timer = setTimeout(finish, config.timing.teardownTimeoutMs);
      closingAec.port.postMessage({ type: 'destroy' });
      aecNode = null;
    };
    let destination;
    let limiter;
    let closed = false;
    let ready = false;
    let startupTimer;
    let resumeTimer;
    let resumePending;
    let healthTimer;
    let pingId = 0;
    let pendingPing = null;
    let rejectStartup;
    const abortStartup = () => fail(new DOMException("Voice isolation startup canceled.", 'AbortError'));
    const processorError = () => fail(new Error("DeepFilterNet AudioWorklet stopped unexpectedly."));
    const inputEnded = () => fail(new Error('The microphone stream ended.'));
    const bypassAec = () => {
      if (!aecActive || closed) return;
      aecActive = false;
      void restoreEcho();
      publish({ engine: 'Chromium AEC', reference: 'unavailable', referenceDb: -100, latencyMs: 0 });
      destroyAec();
      try { refSource?.disconnect(); } catch {}
      if (referenceTrack) { referenceTrack.removeEventListener('ended', aecProcessorError); releaseLoopback(referenceTrack); referenceTrack = null; }
      refSource = null;
      // Fail open: reconnect the microphone straight into DeepFilterNet.
      if (source && node) {
        try {
          source.disconnect();
          if (aecCaptureStream) source = context.createMediaStreamSource(stream);
          source.connect(node);
        } catch {}
      }
      releaseAecCapture();
    };
    const aecProcessorError = () => {
      aecUsable = false;
      if (!ready && rejectAecStartup) rejectAecStartup(new Error('Playback echo processor or reference ended during startup.'));
      else bypassAec();
    };

    function close() {
      if (closed) return;
      closed = true;
      const echoRestored = restoreEcho();
      rejectAecCapture?.(new Error('Unprocessed microphone startup canceled.'));
      releaseAecCapture();
      rejectAecStartup?.(new Error('Playback echo startup canceled.'));
      rejectAecStartup = null;
      sessions.delete(close);
      signal?.removeEventListener("abort", abortStartup);
      track.removeEventListener('ended', inputEnded);
      context.removeEventListener('statechange', stateChanged);
      clearTimeout(startupTimer);
      clearTimeout(resumeTimer);
      clearInterval(healthTimer);
      rejectStartup?.(new Error("Voice isolation stopped before it was ready."));
      rejectStartup = null;
      source?.disconnect();
      refSource?.disconnect();
      destroyAec();
      limiter?.disconnect();
      if (referenceTrack) { referenceTrack.removeEventListener('ended', aecProcessorError); releaseLoopback(referenceTrack); referenceTrack = null; }
      // This is our processed stream. The caller still owns the raw microphone.
      destination?.stream.getTracks().forEach((track) => track.stop());
      const closingNode = node;
      // Release the neural engine before stopping its worklet thread. Closing
      // the MessagePort/context immediately can discard the destroy message.
      // Input disconnect and processed-track stop are immediate. Keep the
      // output edge until process() returns false so Blink drops pending work.
      let teardownTimer;
      let finished = false;
      const finish = (acknowledged = true) => {
        if (finished) return;
        finished = true;
        clearTimeout(teardownTimer);
        if (closingNode) {
          closingNode.disconnect();
          closingNode.port.onmessage = null;
          closingNode.port.close();
        }
        if (!acknowledged && runtime.context.state !== 'closed') {
          // Never reuse a thread whose processor cannot finish teardown.
          if (isolationRuntime === runtime) isolationRuntime = null;
          void runtime.context.close().catch(() => {});
        }
        // Keep the shared worklet thread running until both engines free memory.
        void aecTeardown.then(() => releaseRuntime(runtime));
      };
      if (closingNode) {
        closingNode.removeEventListener("processorerror", processorError);
        closingNode.port.onmessage = ({ data }) => { if (data?.type === 'destroyed') finish(); };
        teardownTimer = setTimeout(() => finish(false), config.timing.teardownTimeoutMs);
        try { closingNode.port.postMessage({ type: 'destroy' }); } catch { finish(false); }
      } else finish();
      source = aecNode = refSource = node = destination = limiter = context = null;
      return echoRestored;
    }

    function fail(error) {
      if (closed) return;
      const wasReady = ready;
      rejectStartup?.(error);
      rejectStartup = null;
      close();
      if (error.name !== 'AbortError') console.warn('[VoiceIsolation]', error.message);
      if (wasReady) onError(error);
    }

    async function resume() {
      if (closed) return;
      if (context.state === 'closed') { fail(new Error('The voice isolation audio context closed.')); return; }
      if (context.state === 'running') return;
      if (!resumePending) {
        resumeTimer = setTimeout(() => fail(new Error('Voice isolation could not resume; using microphone echo cancellation.')), config.timing.resumeTimeoutMs);
        resumePending = context.resume().then(() => {
          if (!closed && context.state !== 'running') throw new Error('Voice isolation audio context is unavailable.');
        }).catch(fail).finally(() => { clearTimeout(resumeTimer); resumePending = null; });
      }
      await resumePending;
    }

    function stateChanged() {
      if (closed || !ready) return;
      if (context.state === 'closed') fail(new Error('The voice isolation audio context closed.'));
      else if (context.state !== 'running') void resume();
    }

    try {
      if (!context.audioWorklet || context.sampleRate !== 48000) {
        throw new Error("This audio engine cannot run voice isolation.");
      }
      sessions.add(close);
      track.addEventListener('ended', inputEnded, { once: true });
      context.addEventListener('statechange', stateChanged);
      const startup = new Promise((resolve, reject) => {
        rejectStartup = reject;
        let modelReady = false;
        let graphReady = false;
        const completeStartup = () => {
          if (closed || !modelReady || !graphReady) return;
          clearTimeout(startupTimer);
          rejectStartup = null;
          resolve();
        };
        signal?.addEventListener("abort", abortStartup, { once: true });
        startupTimer = setTimeout(() => fail(new Error("DeepFilterNet startup timed out; using microphone echo cancellation.")), config.timing.startupTimeoutMs);
        // Compilation occurs off the audio thread; the compiled module is cloned into it.
        void (async () => {
          const [assets, , loopbackTrack] = await Promise.all([
            loadAssets(),
            loadWorklet(runtime),
            acquireLoopback(referenceDeviceId, signal).then(loopbackTrack => {
              // Own the capture as soon as it arrives, even if another startup
              // operation has failed or cancellation has already closed us.
              if (closed) {
                releaseLoopback(loopbackTrack);
                return null;
              }
              referenceTrack = loopbackTrack;
              return loopbackTrack;
            })
          ]);
          if (closed) {
            return;
          }
          node = new AudioWorkletNode(context, "freqx-voice-isolation", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: { ...assets, mode, tuning: { voiceModes: config.voiceModes } }
          });
          node.addEventListener("processorerror", processorError);
          node.port.onmessage = ({ data }) => {
            if (closed) return;
            if (data?.type === "ready") {
              modelReady = true;
              completeStartup();
            } else if (data?.type === "error") {
              fail(new Error(data.message || "Voice isolation could not start."));
            } else if (data?.type === 'pong' && data.id === pendingPing) pendingPing = null;
          };
          destination = context.createMediaStreamDestination();
          destination.channelCount = 1;
          if (compressor) {
            // Optional mic-only peak control; the app already has a mic compressor.
            limiter = context.createDynamicsCompressor();
            for (const [name, value] of Object.entries(config.limiter)) limiter[name].value = value;
            node.connect(limiter).connect(destination);
          } else node.connect(destination);
          if (loopbackTrack) {
            try {
              const [, wasmModule] = await Promise.all([loadAecWorklet(runtime), loadAecAssets()]);
              if (closed) { releaseLoopback(referenceTrack); referenceTrack = null; return; }
              aecNode = new AudioWorkletNode(context, "freqx-aec", {
                numberOfInputs: 2,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: "explicit",
                processorOptions: { wasmModule, tuning: { aec: config.aec } }
              });
              aecNode.addEventListener("processorerror", aecProcessorError);
              const aecReady = new Promise((resolve, reject) => {
                rejectAecStartup = reject;
                aecNode.port.onmessage = ({ data }) => {
                  if (data?.type === 'ready') { rejectAecStartup = null; resolve(); }
                  else if (data?.type === 'error') { aecUsable = false; reject(errorFromAec(data)); if (ready) bypassAec(); }
                  else if (data?.type === 'stats' && aecActive) publish({ ...data, type: undefined, reference: data.referenceDb > -65 ? 'receiving' : 'quiet' });
                  else if (data?.type === 'pong' && data.id === pendingAecPing) pendingAecPing = null;
                };
              });
              function errorFromAec(data) { return new Error(data.message || 'WebRTC AEC3 failed.'); }
              referenceTrack.addEventListener('ended', aecProcessorError, { once: true });
              refSource = context.createMediaStreamSource(new MediaStream([referenceTrack]));
              aecNode.connect(node);
              await resume();
              await aecReady;
              if (closed) return;
            } catch (error) {
              // AEC is best-effort. Keep the existing DeepFilterNet-only path.
              console.warn("[VoiceIsolation] Echo-cancellation loopback unavailable:", error.message);
              rejectAecStartup = null;
              destroyAec();
              refSource?.disconnect();
              referenceTrack?.removeEventListener('ended', aecProcessorError);
              releaseLoopback(referenceTrack); referenceTrack = null;
              aecNode = null; refSource = null; aecActive = false;
            }
          }
          await resume();
          graphReady = true;
          completeStartup();
        })().catch(fail);
      });
      await startup;
      await resume();
      if (closed || track.readyState !== 'live') throw new Error("Voice isolation stopped.");
      if (aecNode && refSource) {
        try {
          if (!aecUsable || referenceTrack.readyState !== 'live') throw new Error('Playback reference ended during startup.');
          echoOwners.set(track, echoOwner);
          try {
            await updateEcho(track, false);
            if (track.getSettings?.().echoCancellation === true) throw new Error('Microphone echo cancellation could not be disabled for AEC3.');
          } catch {
            await restoreEcho();
            if (closed) throw new Error('Voice isolation stopped.');
            await acquireRawCapture();
          }
          if (!aecUsable || referenceTrack.readyState !== 'live') throw new Error('Playback reference ended during microphone startup.');
          if (closed) { await restoreEcho(); throw new Error('Voice isolation stopped.'); }
        } catch (error) {
          await restoreEcho();
          if (closed) throw error;
          destroyAec(); refSource.disconnect(); refSource = null;
          releaseAecCapture();
          referenceTrack?.removeEventListener('ended', aecProcessorError);
          releaseLoopback(referenceTrack); referenceTrack = null;
          console.warn('[VoiceIsolation] Using Chromium AEC:', error.message);
        }
      }
      source = context.createMediaStreamSource(aecCaptureStream || stream);
      if (aecNode && refSource) {
        source.connect(aecNode, 0, 0);
        refSource.connect(aecNode, 0, 1);
        aecActive = true;
        const detail = window.LoopbackReference?.details?.(referenceTrack);
        publish({ engine: 'WebRTC AEC3', reference: 'quiet', referenceLabel: detail?.label || 'Playback reference', referenceEndpointId: detail?.endpointId || '', latencyMs: (config.aec.captureDelaySamples + 480) / 48 });
      } else {
        source.connect(node);
        publish({ engine: 'Chromium AEC', reference: 'unavailable' });
      }
      ready = true;
      signal?.removeEventListener('abort', abortStartup);
      // Bound a hung worklet failure without logging or posting every audio frame.
      healthTimer = setInterval(() => {
        if (closed || context.state !== 'running') return;
        if (pendingPing !== null) { fail(new Error('DeepFilterNet stopped responding; using microphone echo cancellation.')); return; }
        pendingPing = ++pingId; node.port.postMessage({ type: 'ping', id: pendingPing });
        if (aecActive) {
          if (pendingAecPing !== null) { bypassAec(); return; }
          pendingAecPing = pingId; aecNode.port.postMessage({ type: 'ping', id: pendingAecPing });
        }
      }, config.timing.healthIntervalMs);
      console.info(`[VoiceIsolation] DeepFilterNet3 ready (${mode}, 48 kHz, local assets).`);
      return Object.freeze({
        stream: destination.stream, close, resume,
        get mode() { return mode; },
        get contextState() { return context?.state || 'closed'; },
        get diagnostics() { return diagnostics; },
        get inputSettings() { return (aecCaptureStream || stream).getAudioTracks()[0]?.getSettings?.() || {}; },
        setMode(nextMode) {
          nextMode = normalizedMode(nextMode);
          if (closed) throw new Error('Voice isolation session is closed.');
          if (nextMode === mode) return;
          node.port.postMessage({ type: 'mode', mode: nextMode }); mode = nextMode;
        }
      });
    } catch (error) {
      close();
      throw error;
    }
  }

  window.addEventListener('pagehide', () => {
    for (const close of sessions) close();
    if (isolationRuntime && isolationRuntime.context.state !== 'closed') void isolationRuntime.context.close().catch(() => {});
    isolationRuntime = null;
  });
  const api = Object.freeze({ create, captureConstraints, supported });
  window.VoiceIsolation = api;
  window.MicVoiceIsolation = api;
})();
