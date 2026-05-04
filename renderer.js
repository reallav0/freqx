const nowPlaying = document.getElementById("nowPlaying");
const stopAllSoundsButton = document.getElementById("stopAllSounds");
const stopKeybindButton = document.getElementById("stopKeybind");
const toggleMicCaptureButton = document.getElementById("toggleMicCapture");
const toggleMixToOutputButton = document.getElementById("toggleMixToOutput");
const toggleSoundPlaybackButton = document.getElementById("toggleSoundPlayback");
const mixState = document.getElementById("mixState");
const micGainSlider = document.getElementById("micGain");
const soundGainSlider = document.getElementById("soundGain");
const masterGainSlider = document.getElementById("masterGain");
const micGainValue = document.getElementById("micGainValue");
const soundGainValue = document.getElementById("soundGainValue");
const masterGainValue = document.getElementById("masterGainValue");
const inputDeviceSelect = document.getElementById("inputDevice");
const outputDeviceSelect = document.getElementById("outputDevice");
const localPlaybackDeviceSelect = document.getElementById("localPlaybackDevice");
const refreshDevicesButton = document.getElementById("refreshDevices");
const sendToneButton = document.getElementById("sendTone");
const keepRunningInTrayCheckbox = document.getElementById("keepRunningInTray");
const launchOnStartupCheckbox = document.getElementById("launchOnStartup");
const startHiddenCheckbox = document.getElementById("startHidden");
const routeState = document.getElementById("routeState");
const dbValue = document.getElementById("dbValue");
const hzValue = document.getElementById("hzValue");
const meterFill = document.getElementById("meterFill");
const meterTrack = document.querySelector(".meter-track");
const dbValueFooter = document.getElementById("dbValueFooter");
const meterFillFooter = document.getElementById("meterFillFooter");
const meterTrackFooter = document.getElementById("meterTrackFooter");
const importAudioButton = document.getElementById("importAudio");
const openLibraryButton = document.getElementById("openLibrary");
const importedList = document.getElementById("importedList");
const libraryState = document.getElementById("libraryState");

let audioContext;
let micStream;
let micSource;
let micGainNode;
let micHighPassNode;
let micNotchNode;
let micNoiseReductionGainNode;
let micNoiseAnalyser;
let micNoiseData;
let micMudCutNode;
let micPresenceNode;
let micAirNode;
let micLowPassNode;
let micCompressorNode;
let micGateGainNode;
let micGateAnalyser;
let micGateData;
let micGateIntervalId;
let micMonitorGainNode;
let soundGainNode;
let appPlaybackGainNode;
let soundToMixGainNode;
let masterGainNode;
let compressorNode;
let mixDestination;
let appPlaybackDestination;
let monitorElement;
let appPlaybackElement;
let levelAnalyser;
let levelData;
let micFrequencyAnalyser;
let micFrequencyData;
let meterAnimationFrame;
let isMicGateOpen = false;
let selectedInputDeviceId = "";
let selectedOutputDeviceId = "";
let isMicCaptureEnabled = true;
let isMixToOutputEnabled = true;
let isSoundPlaybackEnabled = true;
let selectedLocalPlaybackDeviceId = "";
let availableInputDevices = [];
let availableOutputDevices = [];
const soundToMixBoost = 1.4;
const micGateOpenThresholdDb = -46;
const micGateCloseThresholdDb = -54;
const micGateClosedGain = 0;
const micNoiseReductionMinGain = 0.16;
const micNoiseReductionMarginDb = 10;
const micNoiseReductionRangeDb = 12;
const micNoiseFloorAdaptUp = 0.015;
const micNoiseFloorAdaptDown = 0.1;
let micNoiseFloorDb = -62;
const importedAudioBuffers = new Map();
const activeSoundNodes = new Set();
let importedLibraryItems = [];
const stopKeybindId = "__soundmuncher_stop_all__";
const keybindStorageKey = "soundmuncher:keybinds";
const mixerSettingsStorageKey = "soundmuncher:mixer-settings";
let importedKeybinds = {};
let keybindCapturePath = "";

function codeToAccelerators(code) {
  if (/^Key[A-Z]$/.test(code)) {
    return [code.slice(3)];
  }

  if (/^Digit\d$/.test(code)) {
    return [code.slice(5)];
  }

  if (/^Numpad\d$/.test(code)) {
    const digit = code.slice(6);
    const fallbackMap = {
      0: "Insert",
      1: "End",
      2: "Down",
      3: "PageDown",
      4: "Left",
      5: "Clear",
      6: "Right",
      7: "Home",
      8: "Up",
      9: "PageUp"
    };

    const fallback = fallbackMap[digit];
    return fallback ? [`num${digit}`, fallback] : [`num${digit}`];
  }

  if (/^F\d{1,2}$/.test(code)) {
    return [code];
  }

  if (code === "Space") {
    return ["Space"];
  }

  const symbolMap = {
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    NumpadAdd: "numadd",
    NumpadSubtract: "numsub",
    NumpadMultiply: "nummult",
    NumpadDivide: "numdiv",
    NumpadDecimal: "numdec",
    NumpadEnter: "numenter"
  };

  return symbolMap[code] ? [symbolMap[code]] : [];
}

function isModifierOnlyCode(code) {
  return code === "ControlLeft"
    || code === "ControlRight"
    || code === "ShiftLeft"
    || code === "ShiftRight"
    || code === "AltLeft"
    || code === "AltRight"
    || code === "MetaLeft"
    || code === "MetaRight";
}

function syncGlobalKeybinds() {
  if (!window.soundmuncher?.registerGlobalKeybinds) {
    return;
  }

  const entries = Object.keys(importedKeybinds)
    .map((path) => importedKeybinds[path]?.code)
    .filter(Boolean)
    .map((code) => ({
      code,
      accelerators: codeToAccelerators(code)
    }));

  window.soundmuncher.registerGlobalKeybinds(entries).then((result) => {
    if (result?.failed?.length) {
      setLibraryState("Some keybinds are not supported as global shortcuts.");
    }
  }).catch(() => {
  });
}

function loadKeybinds() {
  try {
    const raw = window.localStorage.getItem(keybindStorageKey);
    importedKeybinds = raw ? JSON.parse(raw) : {};
  } catch (error) {
    importedKeybinds = {};
  }
}

function saveKeybinds() {
  try {
    window.localStorage.setItem(keybindStorageKey, JSON.stringify(importedKeybinds));
  } catch (error) {
  }
}

function clampUnitInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(1, Math.max(0, number));
}

function loadMixerSettings() {
  try {
    const raw = window.localStorage.getItem(mixerSettingsStorageKey);
    const settings = raw ? JSON.parse(raw) : null;

    [
      [micGainSlider, settings?.micGain],
      [soundGainSlider, settings?.soundGain],
      [masterGainSlider, settings?.masterGain]
    ].forEach(([slider, value]) => {
      const clamped = clampUnitInterval(value);
      if (slider && clamped !== null) {
        slider.value = String(clamped);
      }
    });

    if (typeof settings?.soundPlayback === "boolean") {
      isSoundPlaybackEnabled = settings.soundPlayback;
    }

    if (typeof settings?.localPlaybackDeviceId === "string") {
      selectedLocalPlaybackDeviceId = settings.localPlaybackDeviceId;
    }
  } catch (error) {
  }
}

function saveMixerSettings() {
  try {
    window.localStorage.setItem(mixerSettingsStorageKey, JSON.stringify({
      micGain: Number(micGainSlider.value),
      soundGain: Number(soundGainSlider.value),
      masterGain: Number(masterGainSlider.value),
      soundPlayback: isSoundPlaybackEnabled,
      localPlaybackDeviceId: selectedLocalPlaybackDeviceId
    }));
  } catch (error) {
  }
}

function applyBackgroundSettingsToUi(settings = {}) {
  if (keepRunningInTrayCheckbox) {
    keepRunningInTrayCheckbox.checked = settings.keepRunningInTray !== false;
  }

  if (launchOnStartupCheckbox) {
    launchOnStartupCheckbox.checked = Boolean(settings.launchOnStartup);
  }

  if (startHiddenCheckbox) {
    startHiddenCheckbox.checked = Boolean(settings.startHidden);
    startHiddenCheckbox.disabled = !settings.launchOnStartup;
  }
}

async function loadBackgroundSettings() {
  if (!window.soundmuncher?.getAppSettings) {
    return;
  }

  try {
    const result = await window.soundmuncher.getAppSettings();
    applyBackgroundSettingsToUi(result);
  } catch (error) {
  }
}

async function saveBackgroundSettings(updates) {
  if (!window.soundmuncher?.setAppSettings) {
    return;
  }

  try {
    const result = await window.soundmuncher.setAppSettings(updates);
    applyBackgroundSettingsToUi(result?.settings || updates);
  } catch (error) {
    setRouteState("Failed to save background setting.");
  }
}

function getKeyLabelFromCode(code) {
  if (!code) {
    return "";
  }

  if (/^Digit\d$/.test(code)) {
    return code.slice(5);
  }

  if (/^Numpad\d$/.test(code)) {
    return `Num ${code.slice(6)}`;
  }

  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (code === "Space") {
    return "Space";
  }

  return code.replace(/^Numpad/, "Num ").replace(/^Arrow/, "Arrow ");
}

function beginKeybindCapture(path) {
  keybindCapturePath = path;
  renderImportedLibrary();
  renderStopKeybindButton();
  setLibraryState("Press a key to bind. Esc to cancel, Backspace/Delete to clear.");
}

function cancelKeybindCapture() {
  keybindCapturePath = "";
  renderImportedLibrary();
  renderStopKeybindButton();
}

function assignKeybind(path, code) {
  Object.keys(importedKeybinds).forEach((existingPath) => {
    if (importedKeybinds[existingPath]?.code === code) {
      delete importedKeybinds[existingPath];
    }
  });

  importedKeybinds[path] = {
    code,
    label: getKeyLabelFromCode(code)
  };

  saveKeybinds();
  syncGlobalKeybinds();
}

function clearKeybind(path) {
  if (importedKeybinds[path]) {
    delete importedKeybinds[path];
    saveKeybinds();
    syncGlobalKeybinds();
  }
}

function renderStopKeybindButton() {
  if (!stopKeybindButton) {
    return;
  }

  const binding = importedKeybinds[stopKeybindId];
  stopKeybindButton.textContent = keybindCapturePath === stopKeybindId
    ? "Press key..."
    : binding?.label
      ? `Stop Key: ${binding.label}`
      : "Bind Stop Key";
  stopKeybindButton.classList.toggle("listening", keybindCapturePath === stopKeybindId);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
}

function setLibraryState(message) {
  if (libraryState) {
    libraryState.textContent = message;
  }
}

function renderImportedLibrary() {
  if (!importedList) {
    return;
  }

  importedList.innerHTML = "";

  if (importedLibraryItems.length === 0) {
    const placeholder = document.createElement("p");
    placeholder.className = "routing-tip";
    placeholder.textContent = "No imported audio yet.";
    importedList.appendChild(placeholder);
    return;
  }

  importedLibraryItems.forEach((item) => {
    const card = document.createElement("div");
    card.className = "imported-item";

    const trigger = document.createElement("button");
    trigger.className = "pad imported-pad";
    trigger.type = "button";
    trigger.style.setProperty("--tone", "#4da8ff");

    const name = document.createElement("p");
    name.className = "imported-name";
    name.textContent = item.name;

    const detail = document.createElement("p");
    detail.className = "imported-meta";
    detail.textContent = formatSize(item.sizeBytes || 0);

    trigger.addEventListener("click", () => {
      playImportedSound(item);
    });

    const actions = document.createElement("div");
    actions.className = "imported-actions";

    const binding = importedKeybinds[item.path];
    const bindButton = document.createElement("button");
    bindButton.type = "button";
    bindButton.className = "mixer-action keybind-button";
    bindButton.textContent = keybindCapturePath === item.path
      ? "Press key..."
      : binding?.label || "Bind key";

    if (keybindCapturePath === item.path) {
      bindButton.classList.add("listening");
    }

    bindButton.addEventListener("click", () => {
      if (keybindCapturePath === item.path) {
        cancelKeybindCapture();
      } else {
        beginKeybindCapture(item.path);
      }
    });

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "mixer-action keybind-clear";
    clearButton.textContent = "Clear";
    clearButton.disabled = !binding;
    clearButton.addEventListener("click", () => {
      clearKeybind(item.path);
      if (keybindCapturePath === item.path) {
        keybindCapturePath = "";
      }
      renderImportedLibrary();
      setLibraryState("Keybind cleared.");
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "mixer-action imported-remove";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      removeImportedAudio(item);
    });

    trigger.appendChild(name);
    trigger.appendChild(detail);
    actions.appendChild(bindButton);
    actions.appendChild(clearButton);
    actions.appendChild(removeButton);
    card.appendChild(trigger);
    card.appendChild(actions);
    importedList.appendChild(card);
  });
}

async function loadImportedLibrary() {
  if (!window.soundmuncher?.listImportedFiles) {
    setLibraryState("Audio import bridge unavailable.");
    return;
  }

  try {
    importedLibraryItems = await window.soundmuncher.listImportedFiles();
    renderImportedLibrary();

    if (importedLibraryItems.length > 0) {
      setLibraryState(`${importedLibraryItems.length} imported file(s) stored locally.`);
    } else {
      setLibraryState("Import files to store them locally and trigger them from this library.");
    }
  } catch (error) {
    setLibraryState("Failed to load imported audio library.");
  }
}

async function importAudioFiles() {
  if (!window.soundmuncher?.importAudioFiles) {
    setLibraryState("Audio import bridge unavailable.");
    return;
  }

  try {
    importAudioButton.disabled = true;
    const result = await window.soundmuncher.importAudioFiles();

    if (!result || result.canceled) {
      setLibraryState("Import canceled.");
      return;
    }

    importedAudioBuffers.clear();
    await loadImportedLibrary();
    setLibraryState(`Imported ${result.imported.length} file(s) into local library.`);
  } catch (error) {
    setLibraryState("Import failed. Check file permissions and try again.");
  } finally {
    importAudioButton.disabled = false;
  }
}

async function removeImportedAudio(item) {
  if (!window.soundmuncher?.removeImportedFile) {
    setLibraryState("Audio remove bridge unavailable.");
    return;
  }

  const confirmed = window.confirm(`Remove ${item.name} from the local library?`);
  if (!confirmed) {
    return;
  }

  try {
    const result = await window.soundmuncher.removeImportedFile(item.path);
    if (!result?.ok) {
      setLibraryState("Could not remove audio file.");
      return;
    }

    importedAudioBuffers.delete(item.path);
    clearKeybind(item.path);
    if (keybindCapturePath === item.path) {
      keybindCapturePath = "";
    }

    importedLibraryItems = importedLibraryItems.filter((existing) => existing.path !== item.path);
    renderImportedLibrary();
    setLibraryState(`Removed ${item.name}.`);
  } catch (error) {
    setLibraryState("Could not remove audio file.");
  }
}

async function decodeImportedAudio(item) {
  if (importedAudioBuffers.has(item.path)) {
    return importedAudioBuffers.get(item.path);
  }

  const response = await fetch(item.fileUrl);
  const data = await response.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(data.slice(0));
  importedAudioBuffers.set(item.path, decoded);
  return decoded;
}

function trackSoundNode(sourceNode, outputNode = null) {
  const entry = {
    sourceNode,
    outputNode,
    stopped: false
  };

  activeSoundNodes.add(entry);

  sourceNode.addEventListener?.("ended", () => {
    activeSoundNodes.delete(entry);
  }, { once: true });

  return entry;
}

function stopTrackedSound(entry) {
  if (!entry || entry.stopped) {
    return;
  }

  entry.stopped = true;

  try {
    entry.sourceNode.stop(0);
  } catch (error) {
  }

  try {
    entry.sourceNode.disconnect();
  } catch (error) {
  }

  try {
    entry.outputNode?.disconnect();
  } catch (error) {
  }

  activeSoundNodes.delete(entry);
}

function stopAllSounds() {
  if (activeSoundNodes.size === 0) {
    nowPlaying.textContent = "Ready";
    return;
  }

  Array.from(activeSoundNodes).forEach(stopTrackedSound);
  nowPlaying.textContent = "Stopped";
  setLibraryState("Stopped all playing sounds.");
}

async function playImportedSound(item) {
  try {
    if (!audioContext) {
      await setupMixer({ requestMic: false });
    }

    const buffer = await decodeImportedAudio(item);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(soundGainNode);
    trackSoundNode(source);
    source.start();

    nowPlaying.textContent = `${item.name} (Imported)`;
  } catch (error) {
    setLibraryState(`Could not play ${item.name}.`);
  }
}

function setRouteState(message) {
  routeState.textContent = message;
}

function selectedOutputLabel() {
  const option = outputDeviceSelect.selectedOptions?.[0];
  return option ? option.textContent : "selected output";
}

function selectedLocalPlaybackLabel() {
  const option = localPlaybackDeviceSelect?.selectedOptions?.[0];
  return option ? option.textContent : "selected hearing output";
}

function isVirtualOutputSelection() {
  const label = selectedOutputLabel();
  return /cable|voicemeeter|vb-audio/i.test(label);
}

function syncMonitorAudibility() {
  if (!monitorElement) {
    return;
  }

  monitorElement.muted = !isVirtualOutputSelection();
}

function formatDeviceName(device) {
  return device.label || `Unknown ${device.kind === "audioinput" ? "input" : "output"} device`;
}

function getDeviceById(devices, deviceId) {
  return devices.find((device) => device.deviceId === deviceId) || null;
}

function getSelectedOutputDevice() {
  return getDeviceById(availableOutputDevices, selectedOutputDeviceId || outputDeviceSelect.value);
}

function getSelectedInputDevice() {
  return getDeviceById(availableInputDevices, selectedInputDeviceId || inputDeviceSelect.value);
}

function getPreferredLocalPlaybackDevice(outputDevices) {
  if (!Array.isArray(outputDevices) || outputDevices.length === 0) {
    return null;
  }

  const currentDeviceId = selectedLocalPlaybackDeviceId || localPlaybackDeviceSelect?.value;
  if (currentDeviceId) {
    const existingSelection = outputDevices.find((device) => device.deviceId === currentDeviceId);
    if (existingSelection) {
      return existingSelection;
    }
  }

  const physicalOutput = outputDevices.find((device) => !isLikelyVirtualDevice(device.label));
  return physicalOutput || outputDevices[0];
}

function isLikelyVirtualDevice(label) {
  return /cable|voicemeeter|vb-audio/i.test(label || "");
}

function isLikelyVirtualInputEndpoint(label) {
  return /cable\s*input|voicemeeter\s*input|vb-audio\s*input/i.test(label || "");
}

function isLikelyVirtualOutputEndpoint(label) {
  return /cable\s*output|voicemeeter\s*output|vb-audio\s*output/i.test(label || "");
}

function isLikelyLoopbackInput(label) {
  return /stereo\s*mix|stereo\s*mixer|what\s*u\s*hear|monitor\s*of|wave\s*out\s*mix|wasapi\s*loopback|output\s*capture|desktop\s*audio|application\s*audio|cable\s*output|voicemeeter\s*output|vb-audio\s*output|virtual\s*output|loopback|system\s*audio/i.test(label || "");
}

function isLikelyVirtualCaptureInput(label) {
  return /cable|vb-audio|voicemeeter|virtual\s*(audio|cable|input|output|mic|microphone)|desktop\s*capture|system\s*capture/i.test(label || "");
}

function getPreferredOutputDevice(outputDevices) {
  if (!Array.isArray(outputDevices) || outputDevices.length === 0) {
    return null;
  }

  const currentOutputId = selectedOutputDeviceId || outputDeviceSelect.value;
  if (currentOutputId) {
    const existingSelection = outputDevices.find((device) => device.deviceId === currentOutputId);
    if (existingSelection) {
      return existingSelection;
    }
  }

  const virtualInputLike = outputDevices.find((device) => isLikelyVirtualInputEndpoint(device.label));
  const virtualGeneric = outputDevices.find((device) => isLikelyVirtualDevice(device.label));
  return virtualInputLike || virtualGeneric || outputDevices[0];
}

function isPairedVirtualLoopbackInput(inputDevice, selectedOutputDevice) {
  if (!inputDevice || !selectedOutputDevice) {
    return false;
  }

  if (!isLikelyVirtualDevice(selectedOutputDevice.label)) {
    return false;
  }

  if (isLikelyVirtualOutputEndpoint(inputDevice.label)) {
    return true;
  }

  const inputGroupId = String(inputDevice.groupId || "");
  const outputGroupId = String(selectedOutputDevice.groupId || "");
  return Boolean(inputGroupId && outputGroupId && inputGroupId === outputGroupId);
}

function isSafeMicInputDevice(inputDevice, selectedOutputDevice) {
  const label = inputDevice?.label || "";

  if (isLikelyLoopbackInput(label) || isLikelyVirtualCaptureInput(label)) {
    return false;
  }

  if (isPairedVirtualLoopbackInput(inputDevice, selectedOutputDevice)) {
    return false;
  }

  return true;
}

function populateInputDevicesForOutput(selectedOutputDevice) {
  const safeInputDevices = availableInputDevices.filter((device) => isSafeMicInputDevice(device, selectedOutputDevice));
  const blockedInputCount = Math.max(0, availableInputDevices.length - safeInputDevices.length);
  const previousInputDeviceId = selectedInputDeviceId || inputDeviceSelect.value;

  inputDeviceSelect.innerHTML = "";

  if (safeInputDevices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No safe microphone devices detected";
    inputDeviceSelect.appendChild(option);
    selectedInputDeviceId = "";
  } else {
    safeInputDevices.forEach((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = formatDeviceName(device);
      inputDeviceSelect.appendChild(option);
    });

    if (previousInputDeviceId && safeInputDevices.some((device) => device.deviceId === previousInputDeviceId)) {
      selectedInputDeviceId = previousInputDeviceId;
    } else {
      selectedInputDeviceId = safeInputDevices[0].deviceId;
    }

    inputDeviceSelect.value = selectedInputDeviceId;
  }

  return {
    safeInputCount: safeInputDevices.length,
    blockedInputCount,
    inputChanged: previousInputDeviceId !== selectedInputDeviceId
  };
}

function withBlockedInputNotice(message, blockedInputCount) {
  if (blockedInputCount <= 0) {
    return message;
  }

  const plural = blockedInputCount === 1 ? "" : "s";
  return `${message} Hidden ${blockedInputCount} loopback/system input${plural}.`;
}

async function refreshOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableInputDevices = devices.filter((device) => device.kind === "audioinput");
    availableOutputDevices = devices.filter((device) => device.kind === "audiooutput");
    const preferredOutput = getPreferredOutputDevice(availableOutputDevices);
    const preferredLocalPlayback = getPreferredLocalPlaybackDevice(availableOutputDevices);

    outputDeviceSelect.innerHTML = "";
    if (localPlaybackDeviceSelect) {
      localPlaybackDeviceSelect.innerHTML = "";
    }

    availableOutputDevices.forEach((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = formatDeviceName(device);
      outputDeviceSelect.appendChild(option);

      if (localPlaybackDeviceSelect) {
        const localOption = document.createElement("option");
        localOption.value = device.deviceId;
        localOption.textContent = formatDeviceName(device);
        localPlaybackDeviceSelect.appendChild(localOption);
      }
    });

    if (preferredOutput) {
      selectedOutputDeviceId = preferredOutput.deviceId;
      outputDeviceSelect.value = preferredOutput.deviceId;
    }

    if (preferredLocalPlayback && localPlaybackDeviceSelect) {
      selectedLocalPlaybackDeviceId = preferredLocalPlayback.deviceId;
      localPlaybackDeviceSelect.value = preferredLocalPlayback.deviceId;
    }

    const { safeInputCount, blockedInputCount } = populateInputDevicesForOutput(preferredOutput);

    if (availableOutputDevices.length === 0) {
      setRouteState(withBlockedInputNotice("No audio output devices detected.", blockedInputCount));
      return;
    }

    if (preferredOutput && isLikelyVirtualDevice(preferredOutput.label)) {
      if (isLikelyVirtualOutputEndpoint(preferredOutput.label)) {
        setRouteState(withBlockedInputNotice(`Detected ${preferredOutput.label}. For Discord mic feed, choose virtual INPUT here. Discord output must be headphones/speakers, never VB-CABLE or Default if Default is VB-CABLE.`, blockedInputCount));
      } else {
        setRouteState(withBlockedInputNotice(`Detected virtual output candidate: ${preferredOutput.label}. Discord output must be headphones/speakers, never VB-CABLE or Default if Default is VB-CABLE.`, blockedInputCount));
      }
    } else {
      setRouteState(withBlockedInputNotice(`Detected ${safeInputCount} mic(s) and ${availableOutputDevices.length} output device(s).`, blockedInputCount));
    }

    if (audioContext) {
      await applyOutputDevice();
      await applyLocalPlaybackDevice({ silent: true });
    }
  } catch (error) {
    setRouteState("Failed to detect media devices. Grant microphone permission and refresh again.");
  }
}

async function applyOutputDevice() {
  if (!monitorElement) {
    return;
  }

  const deviceId = outputDeviceSelect.value;
  selectedOutputDeviceId = deviceId;
  const selectedOutputDevice = getSelectedOutputDevice();

  if (!deviceId) {
    setRouteState("Select an output device first.");
    return;
  }

  const selectedLabel = selectedOutputLabel();
  if (isLikelyVirtualOutputEndpoint(selectedLabel)) {
    setRouteState("Selected endpoint looks like virtual OUTPUT. Choose virtual INPUT (for example, CABLE Input) to avoid echo/feedback.");
    return;
  }

  const { inputChanged, blockedInputCount } = populateInputDevicesForOutput(selectedOutputDevice);
  const needsMicReconnect = inputChanged && isMicCaptureEnabled && Boolean(micStream);

  if (typeof monitorElement.setSinkId !== "function") {
    setRouteState("Output routing API not available in this Electron runtime.");
    return;
  }

  try {
    await monitorElement.setSinkId(deviceId);
    syncMonitorAudibility();

    if (needsMicReconnect) {
      stopMicCapture();

      if (selectedInputDeviceId) {
        await setupMixer({ requestMic: true });
        setRouteState(withBlockedInputNotice(`Mixed output routed to ${selectedOutputLabel()}. Mic auto-switched away from loopback input.`, blockedInputCount));
      } else {
        isMicCaptureEnabled = false;
        updateMixStateText();
        updateToggleButtonLabels();
        setRouteState(withBlockedInputNotice(`Mixed output routed to ${selectedOutputLabel()}. No safe microphone remains selected.`, blockedInputCount));
      }

      return;
    }

    setRouteState(withBlockedInputNotice(`Mixed output routed to ${selectedOutputLabel()}. Use headphones for Discord output; speakers can still leak into the mic.`, blockedInputCount));
  } catch (error) {
    setRouteState("Failed to route mixed output to selected device.");
  }
}

async function applyLocalPlaybackDevice(options = {}) {
  const { silent = false } = options;

  if (!appPlaybackElement || !localPlaybackDeviceSelect) {
    return;
  }

  const deviceId = localPlaybackDeviceSelect.value;
  selectedLocalPlaybackDeviceId = deviceId;
  saveMixerSettings();

  if (!deviceId) {
    if (!silent) {
      setRouteState("Select a hearing output device first.");
    }
    return;
  }

  if (typeof appPlaybackElement.setSinkId !== "function") {
    if (!silent) {
      setRouteState("Local playback routing API not available in this Electron runtime.");
    }
    return;
  }

  try {
    await appPlaybackElement.setSinkId(deviceId);
    await appPlaybackElement.play();

    if (!silent) {
      const caution = isLikelyVirtualDevice(selectedLocalPlaybackLabel())
        ? " This is a virtual device; choose headphones/speakers if you want to hear it directly."
        : "";
      setRouteState(`Meme playback routed to ${selectedLocalPlaybackLabel()}.${caution}`);
    }
  } catch (error) {
    if (!silent) {
      setRouteState("Failed to route local meme playback to selected device.");
    }
  }
}

async function sendTestTone() {
  if (!audioContext) {
    await setupMixer({ requestMic: false });
  }

  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const duration = 0.32;

  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.28, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain);
  gain.connect(soundGainNode);
  trackSoundNode(osc, gain);
  osc.start(now);
  osc.stop(now + duration + 0.02);

  setRouteState("Test tone injected into mix.");
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function updateGainLabels() {
  micGainValue.textContent = percent(Number(micGainSlider.value));
  soundGainValue.textContent = percent(Number(soundGainSlider.value));
  masterGainValue.textContent = percent(Number(masterGainSlider.value));
}

function updateToggleButtonLabels() {
  if (toggleMicCaptureButton) {
    toggleMicCaptureButton.textContent = isMicCaptureEnabled ? "Mic: On" : "Mic: Off";
    toggleMicCaptureButton.classList.toggle("active", isMicCaptureEnabled);
  }

  if (toggleMixToOutputButton) {
    toggleMixToOutputButton.textContent = isMixToOutputEnabled ? "Mix: On" : "Mix: Off";
    toggleMixToOutputButton.classList.toggle("active", isMixToOutputEnabled);
  }

  if (toggleSoundPlaybackButton) {
    toggleSoundPlaybackButton.textContent = isSoundPlaybackEnabled ? "Hear: On" : "Hear: Off";
    toggleSoundPlaybackButton.classList.toggle("active", isSoundPlaybackEnabled);
  }
}

function updateMixStateText() {
  const micText = isMicCaptureEnabled ? "on" : "off";
  const mixText = isMixToOutputEnabled ? "on" : "off";
  const hearText = isSoundPlaybackEnabled ? "on" : "off";
  mixState.textContent = `Mic capture is ${micText}. Mix to output is ${mixText}. Local sound is ${hearText}.`;
}

function updateMixerGains() {
  if (!audioContext) {
    return;
  }

  const now = audioContext.currentTime;
  micGainNode.gain.setTargetAtTime(Number(micGainSlider.value), now, 0.01);
  soundGainNode.gain.setTargetAtTime(Number(soundGainSlider.value), now, 0.01);
  masterGainNode.gain.setTargetAtTime(Number(masterGainSlider.value), now, 0.01);
}

function updateMicNoiseReduction() {
  if (!audioContext || !micNoiseAnalyser || !micNoiseData || !micNoiseReductionGainNode || !micStream) {
    return;
  }

  micNoiseAnalyser.getFloatTimeDomainData(micNoiseData);

  let sumSquares = 0;
  for (let index = 0; index < micNoiseData.length; index += 1) {
    const sample = micNoiseData[index];
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / micNoiseData.length) || 0;
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  if (!Number.isFinite(db)) {
    return;
  }

  if (db < micNoiseFloorDb) {
    micNoiseFloorDb = (micNoiseFloorDb * (1 - micNoiseFloorAdaptDown)) + (db * micNoiseFloorAdaptDown);
  } else {
    micNoiseFloorDb = (micNoiseFloorDb * (1 - micNoiseFloorAdaptUp)) + (db * micNoiseFloorAdaptUp);
  }

  const thresholdDb = micNoiseFloorDb + micNoiseReductionMarginDb;
  let targetGain = 1;

  if (db <= thresholdDb) {
    targetGain = micNoiseReductionMinGain;
  } else if (db < thresholdDb + micNoiseReductionRangeDb) {
    const normalized = (db - thresholdDb) / micNoiseReductionRangeDb;
    targetGain = micNoiseReductionMinGain + ((1 - micNoiseReductionMinGain) * normalized);
  }

  const smoothing = targetGain < 1 ? 0.03 : 0.08;
  micNoiseReductionGainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, smoothing);
}

function updateMicNoiseGate() {
  if (!audioContext || !micGateAnalyser || !micGateData || !micGateGainNode || !micStream) {
    return;
  }

  micGateAnalyser.getFloatTimeDomainData(micGateData);

  let sumSquares = 0;
  for (let index = 0; index < micGateData.length; index += 1) {
    const sample = micGateData[index];
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / micGateData.length) || 0;
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  if (!isMicGateOpen && db > micGateOpenThresholdDb) {
    isMicGateOpen = true;
    micGateGainNode.gain.setTargetAtTime(1, audioContext.currentTime, 0.02);
  } else if (isMicGateOpen && db < micGateCloseThresholdDb) {
    isMicGateOpen = false;
    micGateGainNode.gain.setTargetAtTime(micGateClosedGain, audioContext.currentTime, 0.03);
  }
}

function ensureMicGateUpdater() {
  if (micGateIntervalId) {
    return;
  }

  micGateIntervalId = window.setInterval(() => {
    updateMicNoiseReduction();
    updateMicNoiseGate();
  }, 50);
}

function updateLevelMeter() {
  if (!levelAnalyser || !levelData) {
    return;
  }

  levelAnalyser.getFloatTimeDomainData(levelData);

  let sumSquares = 0;
  for (let index = 0; index < levelData.length; index += 1) {
    const sample = levelData[index];
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / levelData.length) || 0;
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const boundedDb = Math.max(-60, Math.min(0, db));
  const percent = ((boundedDb + 60) / 60) * 100;
  const dbLabel = Number.isFinite(db) ? `${boundedDb.toFixed(1)} dB` : "-inf dB";

  if (meterFill) {
    meterFill.style.width = `${percent.toFixed(1)}%`;
  }

  if (dbValue) {
    dbValue.textContent = dbLabel;
  }

  if (meterFillFooter) {
    meterFillFooter.style.width = `${percent.toFixed(1)}%`;
  }

  if (dbValueFooter) {
    dbValueFooter.textContent = dbLabel;
  }

  if (meterTrack) {
    meterTrack.setAttribute("aria-valuenow", String(Math.round(boundedDb)));
  }

  if (meterTrackFooter) {
    meterTrackFooter.setAttribute("aria-valuenow", String(Math.round(boundedDb)));
  }

  if (hzValue && micFrequencyAnalyser && micFrequencyData) {
    micFrequencyAnalyser.getByteFrequencyData(micFrequencyData);

    const minHz = 40;
    const maxHz = 12000;
    const nyquist = audioContext.sampleRate / 2;
    const minBin = Math.max(1, Math.floor((minHz / nyquist) * micFrequencyData.length));
    const maxBin = Math.min(micFrequencyData.length - 1, Math.floor((maxHz / nyquist) * micFrequencyData.length));

    let maxValue = 0;
    let peakBin = 0;

    for (let index = minBin; index <= maxBin; index += 1) {
      const value = micFrequencyData[index];
      if (value > maxValue) {
        maxValue = value;
        peakBin = index;
      }
    }

    if (maxValue > 18 && peakBin > 0) {
      const peakHz = (peakBin * audioContext.sampleRate) / micFrequencyAnalyser.fftSize;
      hzValue.textContent = `${Math.round(peakHz)} Hz`;
    } else {
      hzValue.textContent = "-- Hz";
    }
  }

  meterAnimationFrame = window.requestAnimationFrame(updateLevelMeter);
}

async function setupMixer(options = {}) {
  const { requestMic = true } = options;

  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });

    micGainNode = audioContext.createGain();
    micHighPassNode = audioContext.createBiquadFilter();
    micNotchNode = audioContext.createBiquadFilter();
    micNoiseReductionGainNode = audioContext.createGain();
    micNoiseAnalyser = audioContext.createAnalyser();
    micNoiseData = new Float32Array(1024);
    micMudCutNode = audioContext.createBiquadFilter();
    micPresenceNode = audioContext.createBiquadFilter();
    micAirNode = audioContext.createBiquadFilter();
    micLowPassNode = audioContext.createBiquadFilter();
    micCompressorNode = audioContext.createDynamicsCompressor();
    micGateGainNode = audioContext.createGain();
    micGateAnalyser = audioContext.createAnalyser();
    micGateData = new Float32Array(1024);
    micMonitorGainNode = audioContext.createGain();
    soundGainNode = audioContext.createGain();
    appPlaybackGainNode = audioContext.createGain();
    soundToMixGainNode = audioContext.createGain();
    masterGainNode = audioContext.createGain();
    compressorNode = audioContext.createDynamicsCompressor();
    levelAnalyser = audioContext.createAnalyser();
    micFrequencyAnalyser = audioContext.createAnalyser();
    mixDestination = audioContext.createMediaStreamDestination();
    appPlaybackDestination = audioContext.createMediaStreamDestination();
    levelData = new Float32Array(1024);
    micFrequencyData = new Uint8Array(2048);

    micHighPassNode.type = "highpass";
    micHighPassNode.frequency.value = 85;
    micHighPassNode.Q.value = 0.7;

    micNotchNode.type = "notch";
    micNotchNode.frequency.value = 60;
    micNotchNode.Q.value = 8;

    micNoiseReductionGainNode.gain.value = 1;
    micNoiseAnalyser.fftSize = 2048;
    micNoiseAnalyser.smoothingTimeConstant = 0.8;

    micMudCutNode.type = "peaking";
    micMudCutNode.frequency.value = 240;
    micMudCutNode.Q.value = 1.1;
    micMudCutNode.gain.value = -3;

    micPresenceNode.type = "peaking";
    micPresenceNode.frequency.value = 3200;
    micPresenceNode.Q.value = 1;
    micPresenceNode.gain.value = 2.5;

    micAirNode.type = "highshelf";
    micAirNode.frequency.value = 8500;
    micAirNode.gain.value = 2;

    micLowPassNode.type = "lowpass";
    micLowPassNode.frequency.value = 12000;
    micLowPassNode.Q.value = 0.7;

    micCompressorNode.threshold.value = -28;
    micCompressorNode.knee.value = 18;
    micCompressorNode.ratio.value = 4;
    micCompressorNode.attack.value = 0.003;
    micCompressorNode.release.value = 0.1;

    micGateGainNode.gain.value = micGateClosedGain;
    micGateAnalyser.fftSize = 2048;
    micGateAnalyser.smoothingTimeConstant = 0.55;

    micMonitorGainNode.gain.value = 0;
    appPlaybackGainNode.gain.value = isSoundPlaybackEnabled ? 1 : 0;
    soundToMixGainNode.gain.value = isMixToOutputEnabled ? soundToMixBoost : 0;

    levelAnalyser.fftSize = 2048;
    levelAnalyser.smoothingTimeConstant = 0.82;

    micFrequencyAnalyser.fftSize = 4096;
    micFrequencyAnalyser.smoothingTimeConstant = 0.72;

    compressorNode.threshold.value = -3;
    compressorNode.knee.value = 6;
    compressorNode.ratio.value = 1.3;
    compressorNode.attack.value = 0.002;
    compressorNode.release.value = 0.06;

    micGainNode.connect(micHighPassNode);
    micHighPassNode.connect(micNotchNode);
    micNotchNode.connect(micNoiseAnalyser);
    micNotchNode.connect(micNoiseReductionGainNode);
    micNoiseReductionGainNode.connect(micMudCutNode);
    micMudCutNode.connect(micPresenceNode);
    micPresenceNode.connect(micAirNode);
    micAirNode.connect(micLowPassNode);
    micLowPassNode.connect(micGateAnalyser);
    micLowPassNode.connect(micFrequencyAnalyser);
    micLowPassNode.connect(micCompressorNode);
    micCompressorNode.connect(micGateGainNode);
    micGateGainNode.connect(masterGainNode);
    micGateGainNode.connect(micMonitorGainNode);
    soundGainNode.connect(soundToMixGainNode);
    soundToMixGainNode.connect(masterGainNode);
    masterGainNode.connect(compressorNode);
    compressorNode.connect(levelAnalyser);
    compressorNode.connect(mixDestination);
    soundGainNode.connect(appPlaybackGainNode);
    micMonitorGainNode.connect(audioContext.destination);
    appPlaybackGainNode.connect(appPlaybackDestination);

    monitorElement = new Audio();
    monitorElement.autoplay = true;
    monitorElement.muted = false;
    monitorElement.volume = 1;
    monitorElement.srcObject = mixDestination.stream;
    monitorElement.playsInline = true;

    appPlaybackElement = new Audio();
    appPlaybackElement.autoplay = true;
    appPlaybackElement.muted = false;
    appPlaybackElement.volume = 1;
    appPlaybackElement.srcObject = appPlaybackDestination.stream;
    appPlaybackElement.playsInline = true;

    meterAnimationFrame = window.requestAnimationFrame(updateLevelMeter);
    ensureMicGateUpdater();
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  if (requestMic && !micStream) {
    const selectedInputLabel = inputDeviceSelect.selectedOptions?.[0]?.textContent || "";
    const selectedInputDevice = getSelectedInputDevice();
    const selectedOutputDevice = getSelectedOutputDevice();

    if (isLikelyLoopbackInput(selectedInputLabel) || isLikelyVirtualCaptureInput(selectedInputLabel)) {
      throw new Error("Blocked loopback/system audio input.");
    }

    if (selectedInputDevice && !isSafeMicInputDevice(selectedInputDevice, selectedOutputDevice)) {
      throw new Error("Blocked loopback/system audio input.");
    }

    if (!selectedInputDeviceId) {
      throw new Error("No safe microphone input selected.");
    }

    const constraints = {
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };

    if (selectedInputDeviceId) {
      constraints.deviceId = { exact: selectedInputDeviceId };
    }

    micNoiseFloorDb = -62;

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: constraints,
      video: false
    });

    const micTrack = micStream.getAudioTracks()[0];
    if (micTrack) {
      if (isLikelyLoopbackInput(micTrack.label) || isLikelyVirtualCaptureInput(micTrack.label)) {
        micStream.getTracks().forEach((track) => track.stop());
        micStream = null;
        throw new Error("Blocked loopback/system audio input.");
      }

      micTrack.contentHint = "speech";
    }

    micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(micGainNode);
  }

  if (monitorElement) {
    try {
      await monitorElement.play();
    } catch (error) {
    }
  }

  if (appPlaybackElement) {
    try {
      await appPlaybackElement.play();
    } catch (error) {
    }
  }

  await applyOutputDevice();
  await applyLocalPlaybackDevice({ silent: true });

  updateMixerGains();
  updateGainLabels();
}

async function ensureDeviceLabels() {
  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasLabeledInput = devices.some((device) => device.kind === "audioinput" && device.label);
    if (hasLabeledInput) {
      return;
    }

    const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    probeStream.getTracks().forEach((track) => track.stop());
  } catch (error) {
  }
}

function stopMicCapture() {
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  if (audioContext && micGateGainNode) {
    isMicGateOpen = false;
    micGateGainNode.gain.setTargetAtTime(micGateClosedGain, audioContext.currentTime, 0.02);
  }
}

function isTextEditingElement(element) {
  if (!element) {
    return false;
  }

  const tag = element.tagName;
  return element.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function handleKeybindKeydown(event) {
  if (event.repeat) {
    return;
  }

  if (keybindCapturePath) {
    event.preventDefault();

    if (event.code === "Escape") {
      cancelKeybindCapture();
      setLibraryState("Keybind capture canceled.");
      return;
    }

    if (event.code === "Backspace" || event.code === "Delete") {
      clearKeybind(keybindCapturePath);
      cancelKeybindCapture();
      setLibraryState("Keybind cleared.");
      return;
    }

    if (isModifierOnlyCode(event.code)) {
      setLibraryState("Modifier-only keys (Ctrl/Shift/Alt/Win) are not supported as global keybinds.");
      return;
    }

    assignKeybind(keybindCapturePath, event.code);
    const label = importedKeybinds[keybindCapturePath]?.label || event.code;
    cancelKeybindCapture();
    setLibraryState(`Keybind saved: ${label}.`);
    return;
  }

  if (isTextEditingElement(document.activeElement)) {
    return;
  }

  const stopped = triggerStopByCode(event.code);
  if (stopped) {
    event.preventDefault();
    return;
  }

  const triggered = triggerImportedSoundByCode(event.code);
  if (triggered) {
    event.preventDefault();
  }
}

function triggerStopByCode(code) {
  if (!code || importedKeybinds[stopKeybindId]?.code !== code) {
    return false;
  }

  stopAllSounds();
  return true;
}

function triggerImportedSoundByCode(code) {
  const targetPath = Object.keys(importedKeybinds).find((path) => importedKeybinds[path]?.code === code);
  if (!targetPath) {
    return false;
  }

  const targetItem = importedLibraryItems.find((item) => item.path === targetPath);
  if (!targetItem) {
    return false;
  }

  playImportedSound(targetItem);
  return true;
}

async function setMicCaptureEnabled(enabled) {
  if (enabled) {
    try {
      await setupMixer({ requestMic: true });
      isMicCaptureEnabled = true;
    } catch (error) {
      const isLoopbackError = /loopback|system\s*audio/i.test(String(error?.message || ""));

      if (isLoopbackError) {
        await refreshOutputDevices();

        if (selectedInputDeviceId) {
          try {
            await setupMixer({ requestMic: true });
            isMicCaptureEnabled = true;
            setRouteState("Loopback input blocked. Auto-switched to a safer microphone endpoint.");
            updateMixStateText();
            updateToggleButtonLabels();
            return;
          } catch (retryError) {
            error = retryError;
          }
        }
      }

      isMicCaptureEnabled = false;
      if (/loopback|system\s*audio/i.test(String(error?.message || ""))) {
        mixState.textContent = "Mic capture blocked: selected input is loopback/system audio.";
      } else {
        mixState.textContent = "Failed to enable mic capture. Check system microphone permissions.";
      }
      updateToggleButtonLabels();
      return;
    }
  } else {
    stopMicCapture();
    isMicCaptureEnabled = false;
  }

  updateMixStateText();
  updateToggleButtonLabels();
}

async function setMixToOutputEnabled(enabled) {
  if (!audioContext && enabled) {
    try {
      await setupMixer({ requestMic: false });
    } catch (error) {
      mixState.textContent = "Failed to start audio engine for mix output.";
      return;
    }
  }

  isMixToOutputEnabled = enabled;

  if (audioContext && soundToMixGainNode) {
    soundToMixGainNode.gain.setTargetAtTime(enabled ? soundToMixBoost : 0, audioContext.currentTime, 0.02);
  }

  updateMixStateText();
  updateToggleButtonLabels();
}

async function setSoundPlaybackEnabled(enabled) {
  if (!audioContext && enabled) {
    try {
      await setupMixer({ requestMic: false });
    } catch (error) {
      mixState.textContent = "Failed to start audio engine for local playback.";
      return;
    }
  }

  isSoundPlaybackEnabled = enabled;

  if (audioContext && appPlaybackGainNode) {
    appPlaybackGainNode.gain.setTargetAtTime(enabled ? 1 : 0, audioContext.currentTime, 0.02);
  }

  if (enabled) {
    await applyLocalPlaybackDevice({ silent: true });
  }

  syncMonitorAudibility();
  saveMixerSettings();
  updateMixStateText();
  updateToggleButtonLabels();
}

async function switchMicInput() {
  selectedInputDeviceId = inputDeviceSelect.value;

  const selectedLabel = inputDeviceSelect.selectedOptions?.[0]?.textContent || "";
  const selectedInputDevice = getSelectedInputDevice();
  const selectedOutputDevice = getSelectedOutputDevice();
  if (isLikelyLoopbackInput(selectedLabel) || isLikelyVirtualCaptureInput(selectedLabel) || (selectedInputDevice && !isSafeMicInputDevice(selectedInputDevice, selectedOutputDevice))) {
    setRouteState("Blocked loopback/system input. Select a real microphone endpoint.");
    selectedInputDeviceId = "";
    stopMicCapture();
    isMicCaptureEnabled = false;
    updateMixStateText();
    updateToggleButtonLabels();
    return;
  }

  if (!isMicCaptureEnabled) {
    setRouteState("Mic device selected. Enable Mic Capture to reconnect.");
    return;
  }

  try {
    stopMicCapture();

    await setupMixer({ requestMic: true });
    setRouteState("Mic input switched and reconnected.");
  } catch (error) {
    if (/loopback|system\s*audio/i.test(String(error?.message || ""))) {
      mixState.textContent = "Mic input blocked: selected device captures desktop/system audio.";
    } else {
      mixState.textContent = "Failed to switch selected microphone.";
    }
  }
}

toggleMicCaptureButton?.addEventListener("click", () => {
  setMicCaptureEnabled(!isMicCaptureEnabled);
});
toggleMixToOutputButton?.addEventListener("click", () => {
  setMixToOutputEnabled(!isMixToOutputEnabled);
});
toggleSoundPlaybackButton?.addEventListener("click", () => {
  setSoundPlaybackEnabled(!isSoundPlaybackEnabled);
});
stopAllSoundsButton?.addEventListener("click", stopAllSounds);
stopKeybindButton?.addEventListener("click", () => {
  if (keybindCapturePath === stopKeybindId) {
    cancelKeybindCapture();
    setLibraryState("Stop keybind capture canceled.");
  } else {
    beginKeybindCapture(stopKeybindId);
  }
});
refreshDevicesButton.addEventListener("click", refreshOutputDevices);
sendToneButton.addEventListener("click", sendTestTone);
inputDeviceSelect.addEventListener("change", switchMicInput);
outputDeviceSelect.addEventListener("change", applyOutputDevice);
localPlaybackDeviceSelect?.addEventListener("change", applyLocalPlaybackDevice);
keepRunningInTrayCheckbox?.addEventListener("change", () => {
  saveBackgroundSettings({ keepRunningInTray: keepRunningInTrayCheckbox.checked });
});
launchOnStartupCheckbox?.addEventListener("change", () => {
  const launchOnStartup = launchOnStartupCheckbox.checked;
  saveBackgroundSettings({
    launchOnStartup,
    startHidden: launchOnStartup ? Boolean(startHiddenCheckbox?.checked) : false
  });
});
startHiddenCheckbox?.addEventListener("change", () => {
  saveBackgroundSettings({ startHidden: startHiddenCheckbox.checked });
});
importAudioButton.addEventListener("click", importAudioFiles);
if (openLibraryButton) {
  openLibraryButton.addEventListener("click", async () => {
    if (window.soundmuncher?.openLibraryFolder) {
      await window.soundmuncher.openLibraryFolder();
    }
  });
}

[
  [micGainSlider, updateMixerGains],
  [soundGainSlider, updateMixerGains],
  [masterGainSlider, updateMixerGains]
].forEach(([slider, handler]) => {
  slider.addEventListener("input", () => {
    updateGainLabels();
    saveMixerSettings();
    handler();
  });
});

loadMixerSettings();
updateGainLabels();
updateToggleButtonLabels();
loadKeybinds();
renderStopKeybindButton();
syncGlobalKeybinds();

async function initializeApp() {
  await loadBackgroundSettings();
  await ensureDeviceLabels();
  await refreshOutputDevices();
  await setMicCaptureEnabled(true);
  await setMixToOutputEnabled(true);
  await loadImportedLibrary();
}

initializeApp();
window.addEventListener("keydown", handleKeybindKeydown);
window.soundmuncher?.onGlobalKeybindTriggered?.((payload) => {
  const code = payload?.code;
  if (!code) {
    return;
  }

  if (document.hasFocus()) {
    return;
  }

  if (triggerStopByCode(code)) {
    return;
  }

  triggerImportedSoundByCode(code);
});
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", refreshOutputDevices);
}
