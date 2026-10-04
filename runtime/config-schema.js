/* Pure validation shared by Node and the browser. No I/O or mutable defaults. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreqxConfigSchema = api;
})(globalThis, () => {
  'use strict';
  const number = (min, max, integer = false) => ({ type: 'number', min, max, integer });
  const text = (kind = 'text') => ({ type: 'string', kind });
  const boolean = { type: 'boolean' };
  const enumeration = (...values) => ({ type: 'enum', values });
  const list = (item, minLength = 1) => ({ type: 'array', item, minLength });
  const ms = number(1, 3600000, true), bytes = number(1, 1073741824, true);
  const count = number(1, 10000, true), seconds = number(0.000001, 60);
  const color = text('color'), frequency = number(1, 24000), gain = number(0, 8);
  const compressor = { threshold: number(-100, 0), knee: number(0, 40), ratio: number(1, 20), attack: number(0, 1), release: number(0, 1) };
  const filter = { frequency, Q: number(0.0001, 100) };
  const peak = { ...filter, gain: number(-40, 40) };
  const analyser = { fftSize: { type: 'fft' }, smoothing: number(0, 1) };
  const mode = { attenuationDb: number(0, 1000), postFilterBeta: number(0, 1) };
  const voiceModes = { standard: mode, strong: mode };
  const reference = { capacitySeconds: number(0.001, 1), targetSeconds: number(0.001, 1), staleSeconds: number(0.001, 1), maxClockCorrection: number(0, 0.02), clockCorrectionSeconds: number(0.01, 100) };
  const aec = { captureDelaySamples: number(1, 48000, true), queueSamples: { type: 'powerOfTwo' }, statsIntervalBlocks: count };
  const schema = {
    version: enumeration(1),
    app: { websiteUrl: text('https'), window: { width: number(320, 7680, true), height: number(240, 4320, true), minWidth: number(320, 7680, true), minHeight: number(240, 4320, true), backgroundColor: color }, preferences: { launchOnStartup: boolean, startHidden: boolean, keepRunningInTray: boolean }, importReservationAttempts: count, externalProcessTimeoutMs: ms, hardwareAcceleration: boolean, nativeKeyHookEnabled: boolean, disabledFeatures: list(text(), 0), externalProcessBufferBytes: bytes },
    ui: { preferences: { compactMode: boolean, uiTheme: text(), padTheme: text() }, themes: list(text()), padPalettes: { spectrum: list(color), neon: list(color), candy: list(color), mono: list(color) }, defaultBoardName: text(), soundDefaults: { color, volume: number(0, 1.5), trimStart: number(0, 3600), trimEnd: number(0, 3600), fadeIn: number(0, 30), fadeOut: number(0, 30), playbackMode: enumeration('overlap', 'once', 'restart', 'loop'), favorite: boolean, pinned: boolean }, discoverPageSize: count, meterFramesPerSecond: number(1, 240, true), frequencyMeterFrameStride: count, frequencyMeterMinHz: frequency, frequencyMeterMaxHz: frequency, referenceQuietDb: number(-100, 0), rendererCrashTextLength: number(256, 100000, true) },
    audio: { defaults: { voiceIsolation: boolean, voiceIsolationMode: enumeration('standard', 'strong'), micEnabled: boolean, mixEnabled: boolean, playbackEnabled: boolean, micGain: number(0, 1), soundGain: number(0, 1), masterGain: number(0, 1) }, voiceModes, limiter: compressor, micCompressor: compressor, mixCompressor: compressor, equalizer: { highPass: filter, notch: filter, mudCut: peak, presence: peak, air: { frequency, gain: number(-40, 40) }, lowPass: filter }, analysers: { noise: analyser, gate: analyser, level: analyser, frequency: analyser }, soundToMixBoost: gain, micGateClosedGain: gain, previewGain: gain, gainRampSeconds: seconds, routeRampSeconds: seconds, bufferCacheBytes: bytes, testTone: { frequency, durationSeconds: seconds, gain: number(0.000001, 8), rampSeconds: seconds }, nativeTestTone: { frequency, durationSeconds: seconds, gain, stopPaddingMs: ms }, timing: { captureTimeoutMs: ms, teardownTimeoutMs: ms, resumeTimeoutMs: ms, startupTimeoutMs: ms, healthIntervalMs: ms }, aec, reference, loopback: { chunkBytes: bytes, backlogBytes: bytes, enumerateTimeoutMs: ms, enumerateBytes: bytes, maxDevices: count, killTimeoutMs: ms, startupTimeoutMs: ms, stderrBytes: bytes, maxInFlightPackets: count, heartbeatTimeoutMs: ms, heartbeatIntervalMs: ms } },
    network: { apiBaseUrl: text('origin'), allowedAudioHosts: list(text('host')), maxUrlLength: number(256, 65536, true), downloadTimeoutMs: ms, maxRedirects: number(0, 10, true), protocolAudioBytes: bytes, protocolAudioTimeoutMs: ms, platformAudioTimeoutMs: ms },
    auth: { requestTimeoutMs: ms, responseBytes: bytes, credentialBytes: bytes, refreshEarlyMs: number(0, 899999, true), oauthAttemptTimeoutMs: ms, uploadTimeoutMs: ms, uploadBytes: bytes, favoritesBatchSize: number(1, 100, true) },
    catalog: { mode: enumeration('remote', 'bundled'), catalogFile: text('filename'), catalogUrl: text('optionalHttps'), audioBaseUrl: text('optionalHttps'), catalogBytes: bytes, bundledSoundBytes: bytes, remoteSoundBytes: bytes, maxSounds: count, maxDurationSeconds: number(0.1, 3600), pageSize: number(1, 100, true), maxPages: count },
    updater: { feed: { provider: enumeration('github'), owner: text('github'), repo: text('github'), releaseType: enumeration('release') }, startupDelayMs: ms, requestTimeoutMs: ms, installerBytes: bytes, releaseResponseBytes: bytes },
    recovery: { restartWindowMs: ms, maxRestarts: number(1, 10, true), initialBackoffMs: ms, backoffMultiplier: number(1, 4), parentExitTimeoutMs: ms, pollIntervalMs: ms, watchdogStartupTimeoutMs: ms, watchdogReadyTimeoutMs: ms, unresponsiveTimeoutMs: ms, mainCrashTextLength: number(256, 100000, true), detailLimits: { nameLength: count, typeLength: count, stringLength: count, keyLength: count, arrayEntries: count, objectEntries: count, maxDepth: number(1, 10, true) } }
  };
  function invalid(path) { throw new TypeError(`Invalid desktop configuration: ${path}.`); }
  function check(value, rule, path) {
    if (!rule.type) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(rule).length || Object.keys(value).some(key => !Object.hasOwn(rule, key))) invalid(path);
      for (const [key, child] of Object.entries(rule)) check(value[key], child, `${path}.${key}`);
      return;
    }
    if (rule.type === 'boolean') { if (typeof value !== 'boolean') invalid(path); }
    else if (rule.type === 'enum') { if (!rule.values.includes(value)) invalid(path); }
    else if (rule.type === 'number') { if (!Number.isFinite(value) || value < rule.min || value > rule.max || rule.integer && !Number.isSafeInteger(value)) invalid(path); }
    else if (rule.type === 'fft' || rule.type === 'powerOfTwo') { if (!Number.isInteger(value) || value < (rule.type === 'fft' ? 32 : 512) || value > 32768 || (value & (value - 1))) invalid(path); }
    else if (rule.type === 'array') { if (!Array.isArray(value) || value.length < rule.minLength || value.length > 64) invalid(path); value.forEach((entry, index) => check(entry, rule.item, `${path}[${index}]`)); }
    else {
      if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(value)) invalid(path);
      if (rule.kind === 'optionalHttps' && value === '') return;
      if (!value.trim()) invalid(path);
      if (rule.kind === 'color' && !/^#[a-f0-9]{6}$/i.test(value)) invalid(path);
      if (rule.kind === 'filename' && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.includes('..'))) invalid(path);
      if (rule.kind === 'github' && !/^[A-Za-z0-9_.-]+$/.test(value)) invalid(path);
      if (rule.kind === 'host' && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value)) invalid(path);
      if (['https', 'origin', 'optionalHttps'].includes(rule.kind)) {
        let url; try { url = new URL(value); } catch { invalid(path); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || rule.kind === 'origin' && (url.pathname !== '/' || url.search)) invalid(path);
      }
    }
  }
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  function validateConfig(value) {
    check(value, schema, 'config');
    if (value.app.window.minWidth > value.app.window.width || value.app.window.minHeight > value.app.window.height) invalid('config.app.window');
    if (!value.ui.themes.includes(value.ui.preferences.uiTheme) || !Object.hasOwn(value.ui.padPalettes, value.ui.preferences.padTheme)) invalid('config.ui.preferences');
    if (value.ui.frequencyMeterMinHz >= value.ui.frequencyMeterMaxHz) invalid('config.ui.frequencyMeterMaxHz');
    validateAudioTuning(value.audio);
    for (const field of ['catalogUrl', 'audioBaseUrl']) if (value.catalog[field] && !value.network.allowedAudioHosts.includes(new URL(value.catalog[field]).hostname)) invalid(`config.catalog.${field}`);
    if (value.audio.loopback.heartbeatIntervalMs >= value.audio.loopback.heartbeatTimeoutMs || value.audio.loopback.chunkBytes > value.audio.loopback.backlogBytes) invalid('config.audio.loopback');
    if (value.recovery.pollIntervalMs >= value.recovery.parentExitTimeoutMs) invalid('config.recovery.pollIntervalMs');
    return freeze(value);
  }
  function validateAudioTuning(value) {
    // Worklet options are cloned across a boundary; validate selected tuning again.
    for (const [key, rule] of Object.entries({ voiceModes, reference, aec })) if (Object.hasOwn(value, key)) check(value[key], rule, `audio.${key}`);
    if (value.reference && !(value.reference.targetSeconds < value.reference.staleSeconds && value.reference.staleSeconds <= value.reference.capacitySeconds)) invalid('audio.reference');
    if (value.aec && value.aec.queueSamples < 480 * 2) invalid('audio.aec.queueSamples');
    return freeze(value);
  }
  return Object.freeze({ validateConfig, validateAudioTuning });
});
