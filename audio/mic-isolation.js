/* Local mic processing. The caller owns the unprocessed capture stream. */
(() => {
  'use strict';
  const assetBase = new URL(".", document.currentScript.src);
  const sessions = new Set();
  const assetsPromises = new Map();
  let isolationRuntime;
  let aecAssetsPromise;
  let teardownPending = Promise.resolve();
  const simdProbe = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);

  function captureConstraints(deviceId) {
    return {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    };
  }

  function supported(mode = 'high-quality') {
    return typeof WebAssembly === 'object' && typeof AudioWorkletNode === 'function' && (mode === 'light' || WebAssembly.validate(simdProbe));
  }

  function normalizedMode(mode) {
    if (!['light', 'high-quality'].includes(mode)) throw new TypeError('Voice isolation mode must be light or high-quality.');
    return mode;
  }

  function acquireLoopback(endpointId, signal) {
    if (endpointId === 'off') return Promise.resolve(null);
    if (!window.LoopbackReference || typeof window.LoopbackReference.acquire !== 'function') return Promise.resolve(null);
    return Promise.resolve(window.LoopbackReference.acquire({ timeoutMs: window.FreqxDesktopConfig.current.audio.timing.captureTimeoutMs, endpointId, signal })).catch(() => null);
  }

  function releaseLoopback(track) {
    if (!track) return;
    try { window.LoopbackReference?.release?.(track); } catch {}
  }

  async function loadModule(name) {
    if (!assetsPromises.has(name)) assetsPromises.set(name, (async () => {
      const response = await fetch(new URL(`vendor/${name}`, assetBase));
      if (!response.ok) throw new Error(`Cannot load packaged voice isolation asset: ${name}.`);
      return WebAssembly.compile(await response.arrayBuffer());
    })().catch(error => { assetsPromises.delete(name); throw error; }));
    return assetsPromises.get(name);
  }

  async function loadAssets(mode) {
    const light = loadModule('rnnoise/rnnoise.wasm');
    if (mode === 'light') return { lightWasmModule: await light };
    const [wasmModule, lightWasmModule] = await Promise.all([loadModule('deepfilter/df_bg.wasm'), light]);
    return { wasmModule, lightWasmModule };
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
    if (runtime.users || runtime.context.state === 'closed') return Promise.resolve();
    // Closing releases the audio thread's WASM backing stores promptly. Keeping
    // an idle global scope can retain large freed heaps until audio-thread GC.
    // Compiled modules remain cached off the audio thread for the next startup.
    if (isolationRuntime === runtime) isolationRuntime = null;
    return runtime.context.close().catch(() => {});
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

  async function create(stream, { mode, strength, onError = () => {}, onDiagnostics = () => {}, onFallback = () => {}, referenceDeviceId = 'off', signal, compressor = true } = {}) {
    const config = (await window.FreqxDesktopConfig.ready).audio;
    mode = normalizedMode(mode || config.defaults.voiceIsolationMode);
    strength = strength ?? config.defaults.voiceIsolationStrength;
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new TypeError('Voice isolation strength must be between 0 and 1.');
    let effectiveMode = mode;
    const highQualityLoaded = mode === 'high-quality';
    if (signal?.aborted) throw new Error("Voice isolation startup canceled.");
    const track = stream?.getAudioTracks().find((value) => value.readyState === 'live');
    if (!track) {
      throw new Error("Voice isolation requires a live microphone.");
    }
    if (!supported(mode)) throw new Error('WebAssembly SIMD or AudioWorklet is unavailable; using the raw microphone.');
    // A new model constructor can occupy the audio thread for hundreds of ms.
    // Let previous processors acknowledge destruction before starting another.
    await teardownPending;
    if (signal?.aborted || track.readyState !== 'live') throw new DOMException('Voice isolation startup canceled.', 'AbortError');

    // Resample capture in its own 48 kHz context. Never alter the shared mixer.
    const runtime = acquireRuntime();
    let context = runtime.context;
    let node;
    let source;
    let aecNode;
    let refSource;
    let referenceTrack;
    let aecActive = false;
    let aecUsable = true;
    let aecTeardown = Promise.resolve();
    let rejectAecStartup;
    let pendingAecPing = null;
    let diagnostics = { engine: 'No echo cancellation', mode, reference: 'unavailable', referenceLabel: '', referenceDb: -100, latencyMs: 0, processingMs: 0, estimatedLatencyMs: 0 };
    let algorithmLatencyMs = 0;
    const publish = changes => {
      diagnostics = Object.freeze({ ...diagnostics, ...changes });
      diagnostics = Object.freeze({ ...diagnostics, estimatedLatencyMs: algorithmLatencyMs + (context?.baseLatency || 0) * 1000 + diagnostics.latencyMs });
      try { onDiagnostics(diagnostics); } catch {}
    };
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
    let highPass;
    let closed = false;
    let ready = false;
    let startupTimer;
    let resumeTimer;
    let outputReadyTimer;
    let rejectOutputReady;
    let resumePending;
    let healthTimer;
    let pingId = 0;
    let pendingPing = null;
    let closePromise;
    let rejectStartup;
    const abortStartup = () => fail(new DOMException("Voice isolation startup canceled.", 'AbortError'));
    const processorError = () => fail(new Error("Voice isolation AudioWorklet stopped unexpectedly."));
    const inputEnded = () => fail(new Error('The microphone stream ended.'));
    const bypassAec = () => {
      if (!aecActive || closed) return;
      aecActive = false;
      publish({ engine: 'No echo cancellation', reference: 'unavailable', referenceDb: -100, latencyMs: 0 });
      destroyAec();
      try { refSource?.disconnect(); } catch {}
      if (referenceTrack) { referenceTrack.removeEventListener('ended', aecProcessorError); releaseLoopback(referenceTrack); referenceTrack = null; }
      refSource = null;
      // Fail open: reconnect the microphone straight into DeepFilterNet.
      if (source && node) {
        try {
          source.disconnect();
          source.connect(highPass);
        } catch {}
      }
    };
    const aecProcessorError = () => {
      aecUsable = false;
      if (!ready && rejectAecStartup) rejectAecStartup(new Error('Playback echo processor or reference ended during startup.'));
      else bypassAec();
    };

    function close() {
      if (closed) return closePromise;
      closed = true;
      let resolveClose;
      closePromise = new Promise(resolve => { resolveClose = resolve; });
      teardownPending = Promise.all([teardownPending, closePromise]).then(() => {});
      rejectAecStartup?.(new Error('Playback echo startup canceled.'));
      rejectAecStartup = null;
      sessions.delete(close);
      signal?.removeEventListener("abort", abortStartup);
      track.removeEventListener('ended', inputEnded);
      context.removeEventListener('statechange', stateChanged);
      clearTimeout(startupTimer);
      clearTimeout(resumeTimer);
      clearTimeout(outputReadyTimer);
      rejectOutputReady?.(new DOMException('Voice isolation startup canceled.', 'AbortError'));
      rejectOutputReady = null;
      clearInterval(healthTimer);
      rejectStartup?.(new Error("Voice isolation stopped before it was ready."));
      rejectStartup = null;
      source?.disconnect();
      refSource?.disconnect();
      destroyAec();
      highPass?.disconnect();
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
        void aecTeardown.then(() => releaseRuntime(runtime)).then(resolveClose);
      };
      if (closingNode) {
        closingNode.removeEventListener("processorerror", processorError);
        closingNode.port.onmessage = ({ data }) => { if (data?.type === 'destroyed') finish(); };
        teardownTimer = setTimeout(() => finish(false), config.timing.teardownTimeoutMs);
        try { closingNode.port.postMessage({ type: 'destroy' }); } catch { finish(false); }
      } else finish();
      source = aecNode = refSource = node = destination = highPass = context = null;
      return closePromise;
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
        resumeTimer = setTimeout(() => fail(new Error('Voice isolation could not resume; using the raw microphone.')), config.timing.resumeTimeoutMs);
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

    function confirmMonoOutput() {
      if (closed || signal?.aborted) return Promise.reject(new DOMException('Voice isolation startup canceled.', 'AbortError'));
      const processedTrack = destination.stream.getAudioTracks()[0];
      if (typeof processedTrack?.getSettings !== 'function') return Promise.reject(new Error('Voice isolation output format is unavailable.'));
      // Blink applies the channel options to a default stereo destination, and
      // publishes its new track format only when the first audio reaches it.
      // Keep the stream private until its real format is 48 kHz mono.
      return new Promise((resolve, reject) => {
        rejectOutputReady = reject;
        const deadline = performance.now() + config.timing.resumeTimeoutMs;
        const checkFormat = () => {
          outputReadyTimer = null;
          if (closed || signal?.aborted) { reject(new DOMException('Voice isolation startup canceled.', 'AbortError')); return; }
          const settings = processedTrack.getSettings();
          if (settings.channelCount === 1 && settings.sampleRate === 48000) {
            rejectOutputReady = null;
            resolve();
          } else if (performance.now() >= deadline || processedTrack.readyState === 'ended') {
            rejectOutputReady = null;
            reject(new Error('Voice isolation could not produce a 48 kHz mono output.'));
          } else outputReadyTimer = setTimeout(checkFormat, 10);
        };
        checkFormat();
      });
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
        startupTimer = setTimeout(() => fail(new Error("Voice isolation startup timed out; using the raw microphone.")), config.timing.startupTimeoutMs);
        // Compilation occurs off the audio thread; the compiled module is cloned into it.
        void (async () => {
          const [assets, , loopbackTrack] = await Promise.all([
            loadAssets(mode),
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
            processorOptions: { ...assets, mode, strength, compressor, tuning: { voiceModes: config.voiceModes, compressor: config.micCompressor } }
          });
          node.addEventListener("processorerror", processorError);
          node.port.onmessage = ({ data }) => {
            if (closed) return;
            if (data?.type === "ready") {
              effectiveMode = data.mode || effectiveMode;
              modelReady = true;
              completeStartup();
            } else if (data?.type === "error") {
              fail(new Error(data.message || "Voice isolation could not start."));
            } else if (data?.type === 'fallback') {
              effectiveMode = 'light';
              publish({ mode: effectiveMode });
              onFallback(data.reason || 'High quality exceeded the audio processing budget.');
            } else if (data?.type === 'mode') effectiveMode = data.mode;
            if (data && ['ready', 'stats', 'pong'].includes(data.type)) {
              if (data.type === 'pong' && data.id === pendingPing) pendingPing = null;
              const algorithmLatency = data.estimatedLatencyMs ?? (data.bufferLatencyMs + data.modelLatencyMs);
              if (Number.isFinite(algorithmLatency)) algorithmLatencyMs = algorithmLatency;
              publish({ mode: effectiveMode, processingMs: data.processingMs || 0,
                peakProcessingMs: data.peakProcessingMs || 0, processedFrames: data.processedFrames || 0,
                underruns: data.underruns || 0 });
            }
          };
          highPass = context.createBiquadFilter();
          highPass.type = 'highpass';
          highPass.frequency.value = config.equalizer.highPass.frequency;
          highPass.Q.value = config.equalizer.highPass.Q;
          highPass.channelCount = 1;
          highPass.channelCountMode = 'explicit';
          highPass.connect(node);
          // Configure mono explicitly; confirmMonoOutput verifies the actual
          // track format before any caller can consume this processed stream.
          destination = typeof MediaStreamAudioDestinationNode === 'function'
            ? new MediaStreamAudioDestinationNode(context, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' })
            : context.createMediaStreamDestination();
          destination.channelCount = 1;
          destination.channelCountMode = 'explicit';
          destination.channelInterpretation = 'discrete';
          // The worklet gate is followed by zero-lookahead gentle compression.
          node.connect(destination);
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
              aecNode.connect(highPass);
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
      await confirmMonoOutput();
      if (closed || track.readyState !== 'live') throw new Error("Voice isolation stopped.");
      if (aecNode && refSource) {
        try {
          if (!aecUsable || referenceTrack.readyState !== 'live') throw new Error('Playback reference ended during startup.');
        } catch (error) {
          if (closed) throw error;
          destroyAec(); refSource.disconnect(); refSource = null;
          referenceTrack?.removeEventListener('ended', aecProcessorError);
          releaseLoopback(referenceTrack); referenceTrack = null;
          console.warn('[VoiceIsolation] Playback echo reference unavailable:', error.message);
        }
      }
      source = context.createMediaStreamSource(stream);
      if (aecNode && refSource) {
        source.connect(aecNode, 0, 0);
        refSource.connect(aecNode, 0, 1);
        aecActive = true;
        const detail = window.LoopbackReference?.details?.(referenceTrack);
        publish({ engine: 'WebRTC AEC3', reference: 'quiet', referenceLabel: detail?.label || 'Playback reference', referenceEndpointId: detail?.endpointId || '', latencyMs: (config.aec.captureDelaySamples + 480) / 48 });
      } else {
        source.connect(highPass);
        publish({ engine: 'No echo cancellation', reference: 'unavailable' });
      }
      ready = true;
      signal?.removeEventListener('abort', abortStartup);
      // Bound a hung worklet failure without logging or posting every audio frame.
      healthTimer = setInterval(() => {
        if (closed || context.state !== 'running') return;
        if (pendingPing !== null) { fail(new Error('Voice isolation stopped responding; using the raw microphone.')); return; }
        pendingPing = ++pingId; node.port.postMessage({ type: 'ping', id: pendingPing });
        if (aecActive) {
          if (pendingAecPing !== null) { bypassAec(); return; }
          pendingAecPing = pingId; aecNode.port.postMessage({ type: 'ping', id: pendingAecPing });
        }
      }, config.timing.healthIntervalMs);
      console.info(`[VoiceIsolation] Ready (${mode}, 48 kHz, local assets).`);
      return Object.freeze({
        stream: destination.stream, close, resume,
        get mode() { return effectiveMode; },
        get requestedMode() { return mode; },
        get strength() { return strength; },
        get contextState() { return context?.state || 'closed'; },
        get diagnostics() { return diagnostics; },
        get inputSettings() { return stream.getAudioTracks()[0]?.getSettings?.() || {}; },
        setMode(nextMode) {
          nextMode = normalizedMode(nextMode);
          if (closed) throw new Error('Voice isolation session is closed.');
          if (nextMode === 'high-quality' && !highQualityLoaded) throw new Error('High quality requires loading its local model.');
          if (nextMode === mode) return;
          node.port.postMessage({ type: 'mode', mode: nextMode }); mode = effectiveMode = nextMode;
        },
        setStrength(nextStrength) {
          if (closed) throw new Error('Voice isolation session is closed.');
          if (!Number.isFinite(nextStrength) || nextStrength < 0 || nextStrength > 1) throw new TypeError('Voice isolation strength must be between 0 and 1.');
          strength = nextStrength;
          node.port.postMessage({ type: 'strength', strength });
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
