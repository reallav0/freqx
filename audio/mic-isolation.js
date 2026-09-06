/* The only input accepted here is the raw microphone MediaStream. */
(() => {
  const assetBase = new URL(".", document.currentScript.src);
  let compiledModule;

  async function loadModule() {
    if (!compiledModule) {
      compiledModule = (async () => {
        const response = await fetch(new URL("vendor/rnnoise.wasm", assetBase));
        if (!response.ok) throw new Error("Could not load the voice isolation model.");
        return WebAssembly.compile(await response.arrayBuffer());
      })().catch((error) => {
        compiledModule = null;
        throw error;
      });
    }
    return compiledModule;
  }

  async function create(stream, { onError = () => {}, signal } = {}) {
    if (signal?.aborted) throw new Error("Voice isolation startup canceled.");
    if (!stream?.getAudioTracks().some((track) => track.readyState === "live")) {
      throw new Error("Voice isolation requires a live microphone.");
    }

    // RNNoise requires 48 kHz. Never change the shared mixer or output contexts.
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    let node;
    let source;
    let destination;
    let closed = false;
    let ready = false;
    let startupTimer;
    let rejectStartup;
    const abortStartup = () => fail(new Error("Voice isolation startup canceled."));
    const processorError = () => fail(new Error("Voice isolation processing stopped."));

    function close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", abortStartup);
      clearTimeout(startupTimer);
      rejectStartup?.(new Error("Voice isolation stopped before it was ready."));
      rejectStartup = null;
      source?.disconnect();
      if (node) {
        node.removeEventListener("processorerror", processorError);
        node.port.onmessage = null;
        node.port.postMessage({ type: "destroy" });
        node.disconnect();
        node.port.close();
      }
      // This is our processed stream. The caller still owns the raw microphone.
      destination?.stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => {});
    }

    function fail(error) {
      if (closed) return;
      const wasReady = ready;
      rejectStartup?.(error);
      rejectStartup = null;
      close();
      if (wasReady) onError(error);
    }

    try {
      if (!context.audioWorklet || context.sampleRate !== 48000) {
        throw new Error("This audio engine cannot run voice isolation.");
      }
      const startup = new Promise((resolve, reject) => {
        rejectStartup = reject;
        signal?.addEventListener("abort", abortStartup, { once: true });
        startupTimer = setTimeout(() => fail(new Error("Voice isolation startup timed out.")), 10000);
        // Compilation occurs off the audio thread; the compiled module is cloned into it.
        void (async () => {
          const [wasmModule] = await Promise.all([
            loadModule(),
            context.audioWorklet.addModule(new URL("voice-isolation-worklet.mjs", assetBase).href)
          ]);
          if (closed) return;
          node = new AudioWorkletNode(context, "freqx-voice-isolation", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: { wasmModule }
          });
          node.addEventListener("processorerror", processorError);
          node.port.onmessage = ({ data }) => {
            if (closed) return;
            if (data?.type === "ready") {
              clearTimeout(startupTimer);
              rejectStartup = null;
              ready = true;
              resolve();
            } else if (data?.type === "error") {
              fail(new Error(data.message || "Voice isolation could not start."));
            }
          };
          destination = context.createMediaStreamDestination();
          node.connect(destination);
          await context.resume();
        })().catch(fail);
      });
      await startup;
      signal?.removeEventListener("abort", abortStartup);
      if (closed) throw new Error("Voice isolation stopped.");
      source = context.createMediaStreamSource(stream);
      source.connect(node);
      return Object.freeze({ stream: destination.stream, close });
    } catch (error) {
      close();
      throw error;
    }
  }

  window.MicVoiceIsolation = Object.freeze({ create });
})();
