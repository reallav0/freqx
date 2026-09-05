const { app, BrowserWindow, Menu, Tray, crashReporter, dialog, globalShortcut, ipcMain, nativeImage, session, shell } = require("electron");
const dns = require("dns");
const { execFile } = require("child_process");
const fs = require("fs");
const https = require("https");
const net = require("net");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { pathToFileURL } = require("url");
const packageMetadata = require("./package.json");

let portAudio = null;
let globalKeybindRegistrations = [];
let mainWindow;
let keyHook = null;
let tray = null;
let isQuitting = false;
let isShowingCrashScreen = false;
let shouldShowCrashScreenOnReady = false;
let lastCrashReport = null;
let nativeCrashReporterStarted = false;
const appUserModelId = "app.freqx.desktop";
const websiteUrl = "https://freqx.app";
const protocolScheme = "freqx";
const protocolUrlPrefix = `${protocolScheme}:`;
const protocolImportAction = "import-sound";
const githubUpdateRepository = getConfiguredGitHubRepository();
const normalWindowsChildProcessExitCode = 0x40010004;
const recoverableElectronServiceNames = new Set([
  "GPU",
  "audio.mojom.AudioService",
  "network.mojom.NetworkService",
  "video_capture.mojom.VideoCaptureService"
]);
const supportedAudioExtensions = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"]);
const remoteAudioContentTypeExtensions = new Map([
  ["audio/aac", ".aac"],
  ["audio/aacp", ".aac"],
  ["audio/flac", ".flac"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp3", ".mp3"],
  ["audio/mpeg3", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/opus", ".opus"],
  ["audio/vnd.wave", ".wav"],
  ["audio/wav", ".wav"],
  ["audio/wave", ".wav"],
  ["audio/x-flac", ".flac"],
  ["audio/x-m4a", ".m4a"],
  ["audio/x-mp3", ".mp3"],
  ["audio/x-mpeg", ".mp3"],
  ["audio/x-mpeg-3", ".mp3"],
  ["audio/x-wav", ".wav"],
  ["application/ogg", ".ogg"]
]);
const genericRemoteAudioContentTypes = new Set([
  "application/octet-stream",
  "application/x-binary",
  "application/x-download",
  "binary/octet-stream"
]);
const maxProtocolUrlLength = 8192;
const maxRemoteAudioBytes = 100 * 1024 * 1024;
const maxRemoteAudioRedirects = 5;
const remoteAudioRequestTimeoutMs = 30000;
const enableNativeKeyHook = process.env.FREQX_ENABLE_NATIVE_KEY_HOOK === "1";
let appSettings = {
  launchOnStartup: true,
  startHidden: false,
  keepRunningInTray: true
};
const pendingProtocolUrls = [];
const pendingExternalImportEvents = [];
let externalImportQueue = Promise.resolve();
let isMainRendererLoaded = false;
let isRendererReadyForExternalImports = false;

configureDevelopmentStoragePaths();
configureRuntimeStability();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

if (hasSingleInstanceLock) {
  nativeCrashReporterStarted = startNativeCrashReporter();
  registerProcessCrashHandlers();
}

try {
  portAudio = require("naudiodon");
} catch (error) {
  portAudio = null;
}

if (enableNativeKeyHook) {
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    keyHook = createUiohookBridge(uIOhook, UiohookKey);
  } catch (error) {
    keyHook = null;
  }
}

function configureDevelopmentStoragePaths() {
  if (app.isPackaged) {
    return;
  }

  const devUserDataPath = path.join(app.getPath("appData"), "freqx-dev");
  app.setPath("userData", devUserDataPath);
  app.setPath("sessionData", path.join(devUserDataPath, "session"));
}

function configureRuntimeStability() {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

function startNativeCrashReporter() {
  try {
    crashReporter.start({
      uploadToServer: false
    });
    return true;
  } catch (error) {
    return false;
  }
}

function registerProcessCrashHandlers() {
  process.on("uncaughtException", (error) => {
    handleMainProcessCrash("main-uncaught-exception", error);
  });

  process.on("unhandledRejection", (reason) => {
    handleMainProcessCrash("main-unhandled-rejection", reason);
  });

  app.on("child-process-gone", (event, details) => {
    if (isQuitting || details?.reason === "clean-exit") {
      return;
    }

    const processType = String(details?.type || "").toLowerCase();
    if (processType === "renderer") {
      return;
    }

    const isRecoverable = isRecoverableElectronServiceExit(details);
    recordCrashReport(createElectronChildProcessGoneReport(details, isRecoverable), {
      remember: !isRecoverable
    });
  });
}

function handleMainProcessCrash(type, error) {
  const report = recordCrashReport(createCrashReport(type, error));
  sendFatalErrorToRenderer(report);
  loadCrashScreen(report);
}

function limitCrashText(value, maxLength = 20000) {
  const text = value === undefined || value === null ? "" : String(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n... truncated ...`;
}

function normalizeCrashError(error) {
  if (error instanceof Error) {
    return {
      name: limitCrashText(error.name || "Error", 240),
      message: limitCrashText(error.message || "Unknown error"),
      stack: limitCrashText(error.stack || "")
    };
  }

  if (error && typeof error === "object") {
    return {
      name: limitCrashText(error.name || "Error", 240),
      message: limitCrashText(error.message || JSON.stringify(toCrashSafeValue(error))),
      stack: limitCrashText(error.stack || "")
    };
  }

  return {
    name: "Error",
    message: limitCrashText(error || "Unknown error"),
    stack: ""
  };
}

function toCrashSafeValue(value, seen = new WeakSet(), depth = 0) {
  if (value instanceof Error) {
    return normalizeCrashError(value);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return limitCrashText(value, 4000);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (typeof value !== "object") {
    return limitCrashText(value, 4000);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= 5) {
    return "[MaxDepth]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => toCrashSafeValue(item, seen, depth + 1));
  }

  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [
    limitCrashText(key, 120),
    toCrashSafeValue(item, seen, depth + 1)
  ]));
}

function getCrashLogDirectory() {
  return path.join(app.getPath("userData"), "crash-logs");
}

function getCrashLogPath() {
  return path.join(getCrashLogDirectory(), "freqx-crash.log");
}

function getCrashDumpsPath() {
  try {
    return app.getPath("crashDumps");
  } catch (error) {
    return "";
  }
}

function createCrashReport(type, error, details = {}) {
  const normalizedError = normalizeCrashError(error);
  const crashType = limitCrashText(type || "app-error", 160);

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    type: crashType,
    process: crashType.startsWith("renderer") ? "renderer" : "main",
    timestamp: new Date().toISOString(),
    name: normalizedError.name,
    message: normalizedError.message,
    stack: normalizedError.stack,
    details: toCrashSafeValue(details),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged
    },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch
    },
    diagnostics: {
      hardwareAccelerationDisabled: true,
      nativeKeyHookEnabled: enableNativeKeyHook,
      nativeKeyHookLoaded: Boolean(keyHook?.available)
    }
  };
}

function getElectronServiceName(details) {
  return String(details?.serviceName || details?.name || details?.type || "Electron child process");
}

function isRecoverableElectronServiceExit(details) {
  const processType = String(details?.type || "").toLowerCase();
  const reason = String(details?.reason || "").toLowerCase();
  const serviceName = getElectronServiceName(details);
  const exitCode = Number(details?.exitCode);

  if (!recoverableElectronServiceNames.has(serviceName)) {
    return false;
  }

  if (reason === "killed" && exitCode === normalWindowsChildProcessExitCode) {
    return true;
  }

  return (processType === "gpu" || processType === "utility") && (reason === "killed" || reason === "crashed");
}

function createElectronChildProcessGoneReport(details, isRecoverable) {
  const serviceName = getElectronServiceName(details);
  const reason = details?.reason || "exited";
  const type = isRecoverable ? "electron-service-exit" : "electron-child-process-gone";
  const message = isRecoverable
    ? `${serviceName} ${reason}; Electron can recreate this service.`
    : `${serviceName} ${reason} unexpectedly.`;

  return createCrashReport(type, {
    name: isRecoverable ? "ElectronServiceExit" : "ElectronChildProcessGone",
    message
  }, {
    details,
    recoverable: isRecoverable,
    severity: isRecoverable ? "warning" : "error"
  });
}

function formatCrashReportForLog(report) {
  const parts = [
    "",
    "============================================================",
    `[${report.timestamp}] ${report.type} (${report.id})`,
    `Process: ${report.process}`,
    `App: ${report.app?.name || "freqx"} ${report.app?.version || ""}`,
    `Runtime: Electron ${report.runtime?.electron || ""}, Node ${report.runtime?.node || ""}, ${report.runtime?.platform || ""}/${report.runtime?.arch || ""}`,
    `Message: ${report.message || "Unknown error"}`
  ];

  if (report.stack) {
    parts.push("Stack:");
    parts.push(report.stack);
  }

  if (report.details && Object.keys(report.details).length > 0) {
    parts.push("Details:");
    parts.push(JSON.stringify(report.details, null, 2));
  }

  if (report.diagnostics && Object.keys(report.diagnostics).length > 0) {
    parts.push("Diagnostics:");
    parts.push(JSON.stringify(report.diagnostics, null, 2));
  }

  if (report.crashDumpsPath) {
    parts.push(`Native crash dumps: ${report.crashDumpsPath}`);
  }

  return `${parts.join("\n")}\n`;
}

function appendCrashLog(report) {
  try {
    fs.mkdirSync(getCrashLogDirectory(), { recursive: true });
    fs.appendFileSync(getCrashLogPath(), formatCrashReportForLog(report), "utf8");
  } catch (error) {
  }
}

function recordCrashReport(report, options = {}) {
  const completeReport = {
    ...report,
    logPath: getCrashLogPath(),
    crashDumpsPath: getCrashDumpsPath(),
    nativeCrashReporterStarted
  };

  if (options.remember !== false) {
    lastCrashReport = completeReport;
  }
  appendCrashLog(completeReport);
  return completeReport;
}

function getCrashReportForRenderer(report = lastCrashReport) {
  if (!report) {
    return {
      ok: true,
      report: null,
      logPath: getCrashLogPath(),
      crashDumpsPath: getCrashDumpsPath(),
      nativeCrashReporterStarted
    };
  }

  return {
    ok: true,
    report,
    logPath: getCrashLogPath(),
    crashDumpsPath: getCrashDumpsPath(),
    nativeCrashReporterStarted
  };
}

function normalizeRendererCrashPayload(payload) {
  const safePayload = toCrashSafeValue(payload || {});
  const type = typeof safePayload.type === "string" && safePayload.type.startsWith("renderer-")
    ? safePayload.type
    : "renderer-error";

  return createCrashReport(type, {
    name: safePayload.name || "RendererError",
    message: safePayload.message || "Renderer error",
    stack: safePayload.stack || ""
  }, {
    renderer: safePayload
  });
}

function sendFatalErrorToRenderer(report) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("app:fatal-error", getCrashReportForRenderer(report));
}

function emitGlobalKeyCode(code, modifiers = {}) {
  const targetWindow = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows()[0];
  const webContents = targetWindow?.webContents;
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("keybinds:trigger", { code, modifiers });
  }
}

function createUiohookBridge(uiohook, uiohookKey) {
  if (!uiohook || !uiohookKey) {
    return null;
  }

  const watchedCodes = new Map();
  const pressedCodes = new Set();
  let onKey = null;
  let listenersBound = false;
  let started = false;

  const specialMap = {
    Space: "Space",
    Enter: "Enter",
    Backspace: "Backspace",
    Tab: "Tab",
    Escape: "Escape",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    CapsLock: "CapsLock",
    NumLock: "NumLock",
    ScrollLock: "ScrollLock",
    PrintScreen: "PrintScreen",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Backquote: "Backquote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    NumpadMultiply: "NumpadMultiply",
    NumpadAdd: "NumpadAdd",
    NumpadSubtract: "NumpadSubtract",
    NumpadDecimal: "NumpadDecimal",
    NumpadDivide: "NumpadDivide",
    NumpadEnter: "NumpadEnter",
    ControlLeft: "Ctrl",
    ControlRight: "CtrlRight",
    ShiftLeft: "Shift",
    ShiftRight: "ShiftRight",
    AltLeft: "Alt",
    AltRight: "AltRight",
    MetaLeft: "Meta",
    MetaRight: "MetaRight"
  };

  const numpadAliasMap = {
    Numpad0: ["Numpad0", "NumpadInsert"],
    Numpad1: ["Numpad1", "NumpadEnd"],
    Numpad2: ["Numpad2", "NumpadArrowDown"],
    Numpad3: ["Numpad3", "NumpadPageDown"],
    Numpad4: ["Numpad4", "NumpadArrowLeft"],
    Numpad5: ["Numpad5"],
    Numpad6: ["Numpad6", "NumpadArrowRight"],
    Numpad7: ["Numpad7", "NumpadHome"],
    Numpad8: ["Numpad8", "NumpadArrowUp"],
    Numpad9: ["Numpad9", "NumpadPageUp"],
    NumpadDecimal: ["NumpadDecimal", "NumpadDelete"]
  };

  function resolveKeyNames(domCode) {
    if (!domCode) {
      return [];
    }

    if (/^Key[A-Z]$/.test(domCode)) {
      return [domCode.slice(3)];
    }

    if (/^Digit\d$/.test(domCode)) {
      return [domCode.slice(5)];
    }

    if (numpadAliasMap[domCode]) {
      return numpadAliasMap[domCode];
    }

    if (/^Numpad\d$/.test(domCode)) {
      return [domCode];
    }

    if (/^F\d{1,2}$/.test(domCode)) {
      return [domCode];
    }

    return specialMap[domCode] ? [specialMap[domCode]] : [];
  }

  function resolveKeyCodes(domCode) {
    const names = resolveKeyNames(domCode);
    return Array.from(new Set(names
      .map((name) => uiohookKey[name])
      .filter((value) => Number.isFinite(value))));
  }

  function bindListeners() {
    if (listenersBound) {
      return;
    }

    uiohook.on("keydown", (event) => {
      const keycode = Number(event?.keycode);
      if (!Number.isFinite(keycode)) {
        return;
      }

      if (pressedCodes.has(keycode)) {
        return;
      }

      pressedCodes.add(keycode);
      const domCodes = watchedCodes.get(keycode);
      if (!domCodes || !onKey) {
        return;
      }

      for (const domCode of domCodes) {
        onKey(domCode);
      }
    });

    uiohook.on("keyup", (event) => {
      const keycode = Number(event?.keycode);
      if (Number.isFinite(keycode)) {
        pressedCodes.delete(keycode);
      }
    });

    listenersBound = true;
  }

  function ensureStarted() {
    if (started) {
      return;
    }

    bindListeners();
    uiohook.start();
    started = true;
  }

  return {
    watch(domCode, listener) {
      const resolvedCodes = resolveKeyCodes(domCode);
      if (!resolvedCodes.length) {
        return false;
      }

      for (const keycode of resolvedCodes) {
        if (!watchedCodes.has(keycode)) {
          watchedCodes.set(keycode, new Set());
        }
        watchedCodes.get(keycode).add(domCode);
      }

      onKey = listener;
      ensureStarted();
      return true;
    },

    clearAll() {
      watchedCodes.clear();
      pressedCodes.clear();
    },

    stop() {
      if (!started) {
        return;
      }

      uiohook.stop();
      started = false;
      pressedCodes.clear();
    },

    get available() {
      return true;
    }
  };
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const isMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents);
    callback(isMainWindow && permission === "media");
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const isMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents);
    return isMainWindow && permission === "media";
  });
}

function getRendererUrl(fileName = "index.html") {
  return pathToFileURL(path.join(__dirname, fileName)).href;
}

function stripUrlState(url) {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.href;
  } catch (error) {
    return "";
  }
}

function isTrustedRendererUrl(url) {
  const baseUrl = stripUrlState(url);
  return baseUrl === getRendererUrl("index.html") || baseUrl === getRendererUrl("crash.html");
}

function isCrashScreenUrl(url) {
  return stripUrlState(url) === getRendererUrl("crash.html");
}

function isTrustedIpcSender(event) {
  const frameUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  return isTrustedRendererUrl(frameUrl);
}

function assertTrustedIpcSender(event) {
  if (!isTrustedIpcSender(event)) {
    throw new Error("Blocked IPC call from untrusted renderer.");
  }
}

function getConfiguredGitHubRepository() {
  const candidates = [
    process.env.FREQX_UPDATE_REPOSITORY,
    packageMetadata?.repository?.url,
    packageMetadata?.repository
  ];

  for (const candidate of candidates) {
    const repository = normalizeGitHubRepository(candidate);
    if (repository) {
      return repository;
    }
  }

  return "";
}

function normalizeGitHubRepository(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "object") {
    return normalizeGitHubRepository(value.url);
  }

  const raw = String(value).trim();
  const shorthandMatch = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthandMatch) {
    return `${shorthandMatch[1]}/${shorthandMatch[2]}`;
  }

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`;
  }

  try {
    const parsedUrl = new URL(raw.replace(/^git\+/, ""));
    if (parsedUrl.hostname.toLowerCase() !== "github.com") {
      return "";
    }

    const parts = parsedUrl.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/");

    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch (error) {
  }

  return "";
}

function normalizeVersion(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = raw.match(/\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : "";
}

function parseComparableVersion(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) {
    return null;
  }

  const [numberPart, prereleasePart = ""] = normalized.split("-", 2);
  const numbers = numberPart
    .split(".")
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

  while (numbers.length < 4) {
    numbers.push(0);
  }

  return {
    numbers,
    prerelease: prereleasePart
  };
}

function compareVersions(currentVersion, latestVersion) {
  const current = parseComparableVersion(currentVersion);
  const latest = parseComparableVersion(latestVersion);

  if (!current || !latest) {
    return String(currentVersion || "").localeCompare(String(latestVersion || ""));
  }

  for (let index = 0; index < current.numbers.length; index += 1) {
    if (current.numbers[index] < latest.numbers[index]) {
      return -1;
    }

    if (current.numbers[index] > latest.numbers[index]) {
      return 1;
    }
  }

  if (current.prerelease && !latest.prerelease) {
    return -1;
  }

  if (!current.prerelease && latest.prerelease) {
    return 1;
  }

  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${packageMetadata.name || "freqx"}-${app.getVersion()}`
      },
      timeout: 12000
    }, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(new Error("GitHub response was too large."));
        }
      });

      response.on("end", () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch (error) {
          reject(new Error("GitHub returned an invalid response."));
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const rateLimited = response.statusCode === 403 && response.headers["x-ratelimit-remaining"] === "0";
          const message = rateLimited
            ? "GitHub rate limit reached. Try again later."
            : parsed?.message || `GitHub returned HTTP ${response.statusCode}.`;
          reject(new Error(message));
          return;
        }

        resolve(parsed);
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("GitHub update check timed out."));
    });

    request.on("error", reject);
  });
}

function findReleaseDownloadUrl(release) {
  const releaseUrl = typeof release?.html_url === "string" ? release.html_url : "";
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const installerAsset = assets.find((asset) => {
    const name = typeof asset?.name === "string" ? asset.name : "";
    return /\.(exe|msi)$/i.test(name) && /(setup|installer|freqx|xoundboard)/i.test(name);
  }) || assets.find((asset) => {
    const name = typeof asset?.name === "string" ? asset.name : "";
    return /\.(exe|msi)$/i.test(name);
  });

  return typeof installerAsset?.browser_download_url === "string"
    ? installerAsset.browser_download_url
    : releaseUrl;
}

async function getLatestGitHubRelease(repository) {
  const [owner, repo] = repository.split("/");
  let release;

  try {
    release = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`);
  } catch (error) {
    if (error?.message === "Not Found") {
      throw new Error(`No public GitHub release found for ${repository}.`);
    }
    throw error;
  }

  const latestVersion = normalizeVersion(release?.tag_name || release?.name || "");

  if (!latestVersion) {
    throw new Error("Latest GitHub release has no version tag.");
  }

  return {
    tagName: release.tag_name || latestVersion,
    latestVersion,
    releaseName: release.name || release.tag_name || latestVersion,
    releaseUrl: release.html_url || `https://github.com/${repository}/releases/latest`,
    downloadUrl: findReleaseDownloadUrl(release),
    publishedAt: release.published_at || ""
  };
}

function isAllowedGitHubUpdateUrl(url) {
  if (!githubUpdateRepository || typeof url !== "string") {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    const [owner, repo] = githubUpdateRepository.split("/");
    const allowedPrefix = `/${owner}/${repo}/`.toLowerCase();
    return parsedUrl.protocol === "https:"
      && parsedUrl.hostname.toLowerCase() === "github.com"
      && parsedUrl.pathname.toLowerCase().startsWith(allowedPrefix);
  } catch (error) {
    return false;
  }
}

function registerProtocolClient() {
  try {
    if (process.defaultApp) {
      const appPathArg = process.argv.find((arg, index) => (
        index > 0
        && typeof arg === "string"
        && !arg.toLowerCase().startsWith(protocolUrlPrefix)
      ));
      app.setAsDefaultProtocolClient(protocolScheme, process.execPath, [
        path.resolve(appPathArg || __dirname)
      ]);
      return;
    }

    app.setAsDefaultProtocolClient(protocolScheme);
  } catch (error) {
  }
}

function collectProtocolUrlsFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return args.filter((arg) => (
    typeof arg === "string"
    && arg.length > 0
    && arg.length <= maxProtocolUrlLength
    && arg.toLowerCase().startsWith(protocolUrlPrefix)
  ));
}

function queueProtocolUrlsFromArgv(argv, options = {}) {
  return queueProtocolUrls(collectProtocolUrlsFromArgv(argv), options);
}

function queueProtocolUrls(urls, options = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter((url) => (
    typeof url === "string"
    && url.length > 0
    && url.length <= maxProtocolUrlLength
    && url.toLowerCase().startsWith(protocolUrlPrefix)
  ));

  if (!list.length) {
    return false;
  }

  pendingProtocolUrls.push(...list);

  if (app.isReady()) {
    if (options.revealWindow !== false) {
      showMainWindow();
    }
    startPendingProtocolImports();
  }

  return true;
}

function startPendingProtocolImports() {
  if (!isMainRendererLoaded || !isRendererReadyForExternalImports || !pendingProtocolUrls.length) {
    return;
  }

  const urls = pendingProtocolUrls.splice(0, pendingProtocolUrls.length);

  urls.forEach((url) => {
    externalImportQueue = externalImportQueue
      .then(() => processProtocolImportUrl(url))
      .catch((error) => {
        sendExternalImportEvent("audio:external-import-completed", createExternalImportFailureResult(null, error));
      });
  });
}

function sendExternalImportEvent(channel, payload) {
  const canSend = Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && !mainWindow.webContents.isDestroyed()
    && isMainRendererLoaded
    && isRendererReadyForExternalImports
  );

  if (canSend) {
    mainWindow.webContents.send(channel, payload);
    return;
  }

  pendingExternalImportEvents.push({ channel, payload });
  if (pendingExternalImportEvents.length > 50) {
    pendingExternalImportEvents.shift();
  }
}

function flushExternalImportEvents() {
  if (!isMainRendererLoaded || !isRendererReadyForExternalImports || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  while (pendingExternalImportEvents.length > 0) {
    const event = pendingExternalImportEvents.shift();
    mainWindow.webContents.send(event.channel, event.payload);
  }
}

function createExternalImportError(message, code = "external-import-failed") {
  const error = new Error(message);
  error.code = code;
  error.userMessage = message;
  return error;
}

function normalizeExternalImportError(error) {
  if (error?.userMessage) {
    return error;
  }

  return createExternalImportError(
    "Could not download the audio link. Check that the link is reachable and points to a supported audio file.",
    "download-failed"
  );
}

function readProtocolTextParam(searchParams, name, maxLength) {
  const value = searchParams.get(name);
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function parseProtocolImportUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > maxProtocolUrlLength) {
    throw createExternalImportError("This freqx link is invalid.", "invalid-protocol-url");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (error) {
    throw createExternalImportError("This freqx link is invalid.", "invalid-protocol-url");
  }

  if (parsedUrl.protocol.toLowerCase() !== `${protocolScheme}:`) {
    throw createExternalImportError("This link does not use the freqx protocol.", "invalid-protocol");
  }

  const pathAction = parsedUrl.pathname.replace(/^\/+/, "").split("/")[0];
  const action = (parsedUrl.hostname || pathAction || "").toLowerCase();
  if (action !== protocolImportAction) {
    throw createExternalImportError("This freqx link uses an unsupported action.", "unsupported-protocol-action");
  }

  const sourceUrl = readProtocolTextParam(parsedUrl.searchParams, "url", 4096);
  if (!sourceUrl) {
    throw createExternalImportError("This freqx import link is missing an audio URL.", "missing-audio-url");
  }

  return {
    rawUrl,
    sourceUrl,
    filename: readProtocolTextParam(parsedUrl.searchParams, "filename", 180),
    title: readProtocolTextParam(parsedUrl.searchParams, "title", 120),
    board: readProtocolTextParam(parsedUrl.searchParams, "board", 40)
  };
}

function createExternalImportSource(request, details = {}) {
  return {
    url: request?.sourceUrl || "",
    title: request?.title || "",
    filename: request?.filename || "",
    board: request?.board || "",
    ...details
  };
}

function createExternalImportFailureResult(request, error) {
  const normalizedError = normalizeExternalImportError(error);
  return {
    ok: false,
    canceled: false,
    imported: [],
    skipped: [],
    error: normalizedError.code || "external-import-failed",
    message: normalizedError.userMessage || normalizedError.message || "Import from link failed.",
    source: request ? createExternalImportSource(request) : {}
  };
}

function getExternalImportLabel(request) {
  return String(request?.title || request?.filename || "linked sound")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80)
    .trim() || "linked sound";
}

async function processProtocolImportUrl(rawUrl) {
  let request;

  try {
    request = parseProtocolImportUrl(rawUrl);
  } catch (error) {
    sendExternalImportEvent("audio:external-import-completed", createExternalImportFailureResult(null, error));
    return;
  }

  sendExternalImportEvent("audio:external-import-started", {
    source: createExternalImportSource(request),
    message: `Importing ${getExternalImportLabel(request)}...`
  });

  try {
    const result = await importAudioFromProtocolRequest(request);
    sendExternalImportEvent("audio:external-import-completed", result);
  } catch (error) {
    sendExternalImportEvent("audio:external-import-completed", createExternalImportFailureResult(request, error));
  }
}

function normalizeHostName(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").trim().toLowerCase();
}

function isBlockedIpAddress(address) {
  const normalized = normalizeHostName(address);
  const version = net.isIP(normalized);

  if (version === 4) {
    const octets = normalized.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return true;
    }

    const [first, second] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 192 && second === 0)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }

  if (version === 6) {
    const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4) {
      return isBlockedIpAddress(mappedIpv4[1]);
    }

    if (normalized === "::" || normalized === "::1") {
      return true;
    }

    const firstSegment = normalized.split(":").find(Boolean) || "0";
    const first = Number.parseInt(firstSegment, 16);
    return Number.isFinite(first) && (
      (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00
    );
  }

  return false;
}

function isBlockedRemoteAudioHost(hostname) {
  const normalized = normalizeHostName(hostname);
  if (!normalized) {
    return true;
  }

  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || (net.isIP(normalized) && isBlockedIpAddress(normalized));
}

function parseRemoteAudioUrl(rawUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (error) {
    throw createExternalImportError("The audio URL in this freqx link is invalid.", "invalid-audio-url");
  }

  if (parsedUrl.protocol.toLowerCase() !== "https:") {
    throw createExternalImportError("Only HTTPS audio links can be imported.", "unsupported-audio-url");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw createExternalImportError("Audio links with embedded credentials are not supported.", "blocked-audio-url");
  }

  if (isBlockedRemoteAudioHost(parsedUrl.hostname)) {
    throw createExternalImportError("That audio link points to a local or private network address.", "blocked-audio-host");
  }

  parsedUrl.hash = "";
  return parsedUrl;
}

function publicDnsLookup(hostname, options, callback) {
  dns.lookup(hostname, {
    ...options,
    all: true
  }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }

    const resolvedAddresses = Array.isArray(addresses) ? addresses : [];
    const blockedAddress = resolvedAddresses.find((entry) => isBlockedIpAddress(entry.address));
    if (blockedAddress) {
      callback(createExternalImportError(
        "That audio link points to a local or private network address.",
        "blocked-audio-host"
      ));
      return;
    }

    if (!resolvedAddresses.length) {
      callback(createExternalImportError("The audio link host could not be resolved.", "audio-host-not-found"));
      return;
    }

    if (options?.all) {
      callback(null, resolvedAddresses);
      return;
    }

    callback(null, resolvedAddresses[0].address, resolvedAddresses[0].family);
  });
}

function getHeaderText(header) {
  if (Array.isArray(header)) {
    return String(header[0] || "");
  }

  return String(header || "");
}

function normalizeContentTypeHeader(header) {
  return getHeaderText(header).split(";")[0].trim().toLowerCase();
}

function getRemoteAudioExtensionFromContentType(contentType) {
  return remoteAudioContentTypeExtensions.get(contentType) || "";
}

function getSupportedAudioExtension(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return supportedAudioExtensions.has(extension) ? extension : "";
}

function getFileNameFromUrlPath(parsedUrl) {
  const rawName = path.posix.basename(parsedUrl.pathname || "");
  if (!rawName || rawName === "/" || rawName === ".") {
    return "";
  }

  try {
    return decodeURIComponent(rawName);
  } catch (error) {
    return rawName;
  }
}

function getFileNameFromContentDisposition(header) {
  const value = getHeaderText(header);
  if (!value) {
    return "";
  }

  const encodedMatch = value.match(/filename\*=[^']*''([^;]+)/i);
  if (encodedMatch) {
    try {
      return decodeURIComponent(encodedMatch[1].replace(/^"|"$/g, ""));
    } catch (error) {
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1] : "";
}

function isAllowedRemoteAudioResponse(contentType, extension) {
  if (!contentType) {
    return supportedAudioExtensions.has(extension);
  }

  if (remoteAudioContentTypeExtensions.has(contentType)) {
    return true;
  }

  return genericRemoteAudioContentTypes.has(contentType) && supportedAudioExtensions.has(extension);
}

function sanitizeExternalFileBase(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 96)
    .trim() || "imported-audio";
}

function getExternalImportFileName(request, parsedUrl, contentType, contentDisposition) {
  const urlFileName = getFileNameFromUrlPath(parsedUrl);
  const dispositionFileName = getFileNameFromContentDisposition(contentDisposition);
  const preferredName = request.filename || dispositionFileName || urlFileName || request.title || "imported-audio";
  const contentTypeExtension = getRemoteAudioExtensionFromContentType(contentType);
  const candidateExtension = [
    request.filename,
    dispositionFileName,
    urlFileName
  ].map(getSupportedAudioExtension).find(Boolean) || "";
  const extension = contentTypeExtension || candidateExtension;

  if (!supportedAudioExtensions.has(extension)) {
    throw createExternalImportError("The audio link does not point to a supported audio file.", "unsupported-audio-file");
  }

  const preferredExtension = getSupportedAudioExtension(preferredName);
  const baseNameSource = preferredExtension
    ? path.basename(preferredName, preferredExtension)
    : preferredName;

  return `${sanitizeExternalFileBase(baseNameSource)}${extension}`;
}

function createByteLimitTransform(maxBytes) {
  let receivedBytes = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(createExternalImportError(
          `Audio links must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`,
          "audio-too-large"
        ));
        return;
      }

      callback(null, chunk);
    }
  });
}

async function removeFileQuietly(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
  }
}

async function downloadRemoteAudioToLibrary(request, rawUrl = request.sourceUrl, redirectCount = 0) {
  const parsedUrl = parseRemoteAudioUrl(rawUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(normalizeExternalImportError(error));
    };

    const requestOptions = {
      headers: {
        Accept: "audio/*,application/octet-stream;q=0.8,*/*;q=0.1",
        "User-Agent": `${packageMetadata.name || "freqx"}/${app.getVersion()}`
      },
      lookup: publicDnsLookup,
      timeout: remoteAudioRequestTimeoutMs
    };

    const remoteRequest = https.get(parsedUrl, requestOptions, (response) => {
      (async () => {
        const statusCode = Number(response.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          response.resume();
          if (redirectCount >= maxRemoteAudioRedirects) {
            throw createExternalImportError("The audio link redirected too many times.", "too-many-redirects");
          }

          const location = getHeaderText(response.headers.location);
          if (!location) {
            throw createExternalImportError("The audio link returned an invalid redirect.", "invalid-redirect");
          }

          const nextUrl = new URL(location, parsedUrl).href;
          succeed(await downloadRemoteAudioToLibrary(request, nextUrl, redirectCount + 1));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          throw createExternalImportError(`The audio link returned HTTP ${statusCode}.`, "audio-http-error");
        }

        const contentLength = Number.parseInt(getHeaderText(response.headers["content-length"]), 10);
        if (Number.isFinite(contentLength) && contentLength > maxRemoteAudioBytes) {
          response.resume();
          throw createExternalImportError(
            `Audio links must be ${Math.round(maxRemoteAudioBytes / (1024 * 1024))} MB or smaller.`,
            "audio-too-large"
          );
        }

        const contentType = normalizeContentTypeHeader(response.headers["content-type"]);
        const fileName = getExternalImportFileName(request, parsedUrl, contentType, response.headers["content-disposition"]);
        const extension = path.extname(fileName).toLowerCase();

        if (!isAllowedRemoteAudioResponse(contentType, extension)) {
          response.resume();
          throw createExternalImportError("The audio link did not return a supported audio file.", "unsupported-audio-response");
        }

        const libraryDir = getLibraryDirectory();
        const destinationPath = createUniqueDestinationPath(libraryDir, fileName);

        try {
          await pipeline(
            response,
            createByteLimitTransform(maxRemoteAudioBytes),
            fs.createWriteStream(destinationPath, { flags: "wx" })
          );

          const stat = await fs.promises.stat(destinationPath);
          if (!stat.isFile() || stat.size <= 0) {
            await removeFileQuietly(destinationPath);
            throw createExternalImportError("The audio link returned an empty file.", "empty-audio-file");
          }

          succeed({
            destinationPath,
            finalUrl: parsedUrl.href,
            contentType,
            sizeBytes: Number(stat.size)
          });
        } catch (error) {
          await removeFileQuietly(destinationPath);
          throw error;
        }
      })().catch(fail);
    });

    remoteRequest.setTimeout(remoteAudioRequestTimeoutMs, () => {
      remoteRequest.destroy(createExternalImportError("The audio link timed out while downloading.", "download-timeout"));
    });
    remoteRequest.on("error", fail);
  });
}

async function importAudioFromProtocolRequest(request) {
  const downloaded = await downloadRemoteAudioToLibrary(request);
  const item = toLibraryItem(downloaded.destinationPath);
  const itemMetadata = {};

  if (request.title) {
    itemMetadata.name = request.title;
  }

  if (request.board) {
    itemMetadata.board = request.board;
  }

  const metadata = Object.keys(itemMetadata).length > 0
    ? { [item.path]: itemMetadata }
    : {};

  return {
    ok: true,
    canceled: false,
    imported: [item],
    skipped: [],
    source: createExternalImportSource(request, {
      finalUrl: downloaded.finalUrl,
      contentType: downloaded.contentType,
      sizeBytes: downloaded.sizeBytes
    }),
    metadata
  };
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadAppSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    appSettings = {
      ...appSettings,
      launchOnStartup: parsed.launchOnStartup !== false,
      startHidden: Boolean(parsed.startHidden),
      keepRunningInTray: parsed.keepRunningInTray !== false
    };
  } catch (error) {
  }
}

function saveAppSettings() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(appSettings, null, 2));
  } catch (error) {
  }
}

function applyLoginItemSettings() {
  if (!app.isPackaged && process.platform !== "win32") {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(appSettings.launchOnStartup),
      path: process.execPath,
      args: appSettings.startHidden ? ["--hidden"] : []
    });
  } catch (error) {
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }

  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Show freqx",
      click: showMainWindow
    },
    {
      label: "Hide to tray",
      click: hideMainWindow
    },
    { type: "separator" },
    {
      label: appSettings.launchOnStartup ? "Launch on startup: On" : "Launch on startup: Off",
      enabled: false
    },
    {
      label: appSettings.keepRunningInTray ? "Keep running in tray: On" : "Keep running in tray: Off",
      enabled: false
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function getAppIconPath() {
  return path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png");
}

function createTray() {
  if (tray) {
    return;
  }

  const trayIcon = nativeImage.createFromPath(getAppIconPath()).resize({
    width: 16,
    height: 16
  });
  tray = new Tray(trayIcon);
  tray.setToolTip("freqx");
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function loadCrashScreen(report) {
  if (!app.isReady()) {
    shouldShowCrashScreenOnReady = true;
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ showCrashScreen: true });
    return;
  }

  isShowingCrashScreen = true;
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  loadWindowFile("crash.html", {
    originalReportId: report?.id
  });
}

function loadWindowFile(fileName, details = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  isMainRendererLoaded = false;
  isRendererReadyForExternalImports = false;
  mainWindow.loadFile(fileName).catch((error) => {
    const isCrashFile = fileName === "crash.html";
    const report = recordCrashReport(createCrashReport(
      isCrashFile ? "crash-screen-load-failed" : "renderer-load-promise-failed",
      error,
      {
        fileName,
        ...details
      }
    ));

    if (!isCrashFile) {
      loadCrashScreen(report);
    }
  });
}

function createWindow(options = {}) {
  const shouldStartHidden = !options.forceShow && !options.showCrashScreen && (appSettings.startHidden || process.argv.includes("--hidden"));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#111111",
    title: "freqx",
    icon: getAppIconPath(),
    autoHideMenuBar: true,
    show: !shouldStartHidden,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    isShowingCrashScreen = isCrashScreenUrl(mainWindow.webContents.getURL());
    isMainRendererLoaded = !isShowingCrashScreen && stripUrlState(mainWindow.webContents.getURL()) === getRendererUrl("index.html");
    flushExternalImportEvents();
    startPendingProtocolImports();
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || isShowingCrashScreen || isCrashScreenUrl(validatedURL)) {
      return;
    }

    const report = recordCrashReport(createCrashReport("renderer-load-failed", null, {
      errorCode,
      errorDescription,
      validatedURL
    }));
    loadCrashScreen(report);
  });

  mainWindow.webContents.on("preload-error", (event, preloadPath, error) => {
    const report = recordCrashReport(createCrashReport("renderer-preload-error", error, {
      preloadPath
    }));
    loadCrashScreen(report);
  });

  mainWindow.webContents.on("render-process-gone", (event, details) => {
    if (isQuitting || details?.reason === "clean-exit") {
      return;
    }

    const report = recordCrashReport(createCrashReport("renderer-process-gone", null, {
      details
    }));
    loadCrashScreen(report);
  });

  mainWindow.on("unresponsive", () => {
    recordCrashReport(createCrashReport("renderer-unresponsive", null, {
      url: mainWindow?.webContents?.getURL?.() || ""
    }));
  });

  mainWindow.on("minimize", (event) => {
    if (!appSettings.keepRunningInTray) {
      return;
    }

    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting || !appSettings.keepRunningInTray) {
      return;
    }

    event.preventDefault();
    hideMainWindow();
  });

  if (options.showCrashScreen || shouldShowCrashScreenOnReady) {
    shouldShowCrashScreenOnReady = false;
    isShowingCrashScreen = true;
    loadWindowFile("crash.html");
  } else {
    isShowingCrashScreen = false;
    loadWindowFile("index.html");
  }

  return mainWindow;
}

function getOutputDevices() {
  if (!portAudio) {
    return [];
  }

  return portAudio
    .getDevices()
    .filter((device) => Number(device.maxOutputChannels) > 0)
    .map((device) => ({
      id: Number(device.id),
      name: device.name,
      maxOutputChannels: Number(device.maxOutputChannels),
      defaultSampleRate: Number(device.defaultSampleRate || 48000)
    }));
}

function writeTestTone(deviceId) {
  if (!portAudio) {
    throw new Error("naudiodon is not available in this Electron runtime.");
  }

  if (!Number.isFinite(deviceId)) {
    throw new Error("A valid output device id is required.");
  }

  const sampleRate = 48000;
  const durationSeconds = 1.1;
  const channelCount = 2;
  const frameCount = Math.floor(sampleRate * durationSeconds);
  const frequency = 440;
  const amplitude = 0.22;
  const data = new Float32Array(frameCount * channelCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * amplitude;
    const offset = frame * channelCount;
    data[offset] = sample;
    data[offset + 1] = sample;
  }

  const output = new portAudio.AudioOutput({
    deviceId,
    channelCount,
    sampleFormat: portAudio.SampleFormatFloat32,
    sampleRate,
    closeOnError: true
  });

  output.start();
  output.write(Buffer.from(data.buffer));

  setTimeout(() => {
    try {
      output.quit();
    } catch (error) {
    }
  }, Math.ceil(durationSeconds * 1000) + 120);
}

function isLikelyLocalWindowsPath(filePath) {
  if (process.platform !== "win32") {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(filePath || "");
}

function getImportDialogDefaultPath() {
  const candidates = ["music", "downloads", "documents", "home"];

  for (const name of candidates) {
    try {
      const candidatePath = app.getPath(name);
      if (candidatePath && isLikelyLocalWindowsPath(candidatePath) && fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    } catch (error) {
    }
  }

  return app.getPath("home");
}

function isSupportedAudioPath(filePath) {
  return supportedAudioExtensions.has(path.extname(filePath).toLowerCase());
}

function getPowerShellPath() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powerShellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(powerShellPath) ? powerShellPath : "powershell.exe";
}

function showWindowsAudioImportDialog() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Import Audio Files'
$dialog.InitialDirectory = [Environment]::GetEnvironmentVariable('FREQX_IMPORT_INITIAL_DIR', 'Process')
$dialog.Filter = 'Audio Files (*.mp3;*.wav;*.ogg;*.m4a;*.flac;*.aac;*.opus)|*.mp3;*.wav;*.ogg;*.m4a;*.flac;*.aac;*.opus|All Files (*.*)|*.*'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  $dialog.FileNames | ConvertTo-Json -Compress
}
`;

  return new Promise((resolve, reject) => {
    execFile(getPowerShellPath(), [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], {
      env: {
        ...process.env,
        FREQX_IMPORT_INITIAL_DIR: getImportDialogDefaultPath()
      },
      maxBuffer: 1024 * 1024,
      timeout: 30 * 60 * 1000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message || "Windows file picker failed."));
        return;
      }

      const output = stdout.trim().replace(/^\uFEFF/, "");
      if (!output) {
        resolve({ canceled: true, filePaths: [] });
        return;
      }

      try {
        const parsed = JSON.parse(output);
        const filePaths = (Array.isArray(parsed) ? parsed : [parsed])
          .filter((filePath) => typeof filePath === "string" && filePath.length > 0);
        resolve({ canceled: filePaths.length === 0, filePaths });
      } catch (parseError) {
        reject(new Error("Windows file picker returned invalid file paths."));
      }
    });
  });
}

function showAudioImportDialog() {
  if (process.platform === "win32") {
    return showWindowsAudioImportDialog();
  }

  const dialogOptions = {
    title: "Import Audio Files",
    defaultPath: getImportDialogDefaultPath(),
    properties: ["openFile", "multiSelections", "dontAddToRecent"],
    filters: [
      {
        name: "Audio Files",
        extensions: ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]
      }
    ]
  };
  const dialogParent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return dialogParent
    ? dialog.showOpenDialog(dialogParent, dialogOptions)
    : dialog.showOpenDialog(dialogOptions);
}

async function importAudioFilePaths(filePaths) {
  const seen = new Set();
  const sourcePaths = [];
  const rawPaths = Array.isArray(filePaths) ? filePaths : [];

  rawPaths.forEach((filePath) => {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 4096) {
      return;
    }

    const resolvedPath = path.resolve(filePath);
    const key = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    sourcePaths.push(resolvedPath);
  });

  const imported = [];
  const skipped = [];
  const libraryDir = getLibraryDirectory();

  for (const sourcePath of sourcePaths) {
    if (!isSupportedAudioPath(sourcePath)) {
      skipped.push({ path: sourcePath, reason: "unsupported-file" });
      continue;
    }

    try {
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) {
        skipped.push({ path: sourcePath, reason: "not-a-file" });
        continue;
      }

      const destinationPath = createUniqueDestinationPath(libraryDir, sourcePath);
      await fs.promises.copyFile(sourcePath, destinationPath);
      imported.push(toLibraryItem(destinationPath));
    } catch (error) {
      skipped.push({
        path: sourcePath,
        reason: "copy-failed",
        message: error?.message || "Could not import file."
      });
    }
  }

  return { imported, skipped, canceled: false };
}

function registerAudioIpc() {
  ipcMain.handle("app:report-crash", (event, payload) => {
    assertTrustedIpcSender(event);
    const report = recordCrashReport(normalizeRendererCrashPayload(payload));
    return getCrashReportForRenderer(report);
  });

  ipcMain.handle("app:get-crash-report", (event) => {
    assertTrustedIpcSender(event);
    return getCrashReportForRenderer();
  });

  ipcMain.handle("app:open-crash-log", async (event) => {
    assertTrustedIpcSender(event);
    const logPath = getCrashLogPath();

    try {
      fs.mkdirSync(getCrashLogDirectory(), { recursive: true });
      if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, "", "utf8");
      }
      shell.showItemInFolder(logPath);
      return { ok: true, logPath };
    } catch (error) {
      return {
        ok: false,
        logPath,
        message: error?.message || "Could not open crash log."
      };
    }
  });

  ipcMain.handle("app:reload-after-crash", (event) => {
    assertTrustedIpcSender(event);
    if (mainWindow && !mainWindow.isDestroyed()) {
      isShowingCrashScreen = false;
      loadWindowFile("index.html");
    }
    return { ok: true };
  });

  ipcMain.handle("app:quit-after-crash", (event) => {
    assertTrustedIpcSender(event);
    isQuitting = true;
    app.quit();
    return { ok: true };
  });

  ipcMain.handle("app:open-website", async (event) => {
    assertTrustedIpcSender(event);
    await shell.openExternal(websiteUrl);
    return { ok: true };
  });

  ipcMain.handle("app:check-for-updates", async (event) => {
    assertTrustedIpcSender(event);
    const currentVersion = app.getVersion();

    if (!githubUpdateRepository) {
      return {
        ok: false,
        configured: false,
        currentVersion,
        error: "missing-repository",
        message: "No GitHub update repository is configured."
      };
    }

    try {
      const latestRelease = await getLatestGitHubRelease(githubUpdateRepository);
      return {
        ok: true,
        configured: true,
        repository: githubUpdateRepository,
        currentVersion,
        updateAvailable: compareVersions(currentVersion, latestRelease.latestVersion) < 0,
        ...latestRelease
      };
    } catch (error) {
      return {
        ok: false,
        configured: true,
        repository: githubUpdateRepository,
        currentVersion,
        error: "check-failed",
        message: error?.message || "Could not check GitHub for updates."
      };
    }
  });

  ipcMain.handle("app:open-update-page", async (event, url) => {
    assertTrustedIpcSender(event);

    if (!isAllowedGitHubUpdateUrl(url)) {
      return { ok: false, error: "blocked-url" };
    }

    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("audio:list-output-devices", (event) => {
    assertTrustedIpcSender(event);
    return {
      hasNaudiodon: Boolean(portAudio),
      devices: getOutputDevices()
    };
  });

  ipcMain.handle("audio:send-test-tone", (event, deviceId) => {
    assertTrustedIpcSender(event);
    writeTestTone(Number(deviceId));
    return { ok: true };
  });

  ipcMain.handle("audio:external-imports-ready", (event) => {
    assertTrustedIpcSender(event);
    isRendererReadyForExternalImports = true;
    flushExternalImportEvents();
    startPendingProtocolImports();
    return { ok: true };
  });

  ipcMain.handle("audio:open-library-folder", async (event) => {
    assertTrustedIpcSender(event);
    const libraryDir = getLibraryDirectory();
    shell.openPath(libraryDir);
    return { ok: true };
  });

  ipcMain.handle("audio:import-files", async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePaths } = await showAudioImportDialog();

    if (canceled || filePaths.length === 0) {
      return { imported: [], canceled: true };
    }

    return importAudioFilePaths(filePaths);
  });

  ipcMain.handle("audio:import-file-paths", async (event, filePaths) => {
    assertTrustedIpcSender(event);
    return importAudioFilePaths(filePaths);
  });

  ipcMain.handle("audio:list-imported-files", async (event) => {
    assertTrustedIpcSender(event);
    const libraryDir = getLibraryDirectory();
    const dirEntries = await fs.promises.readdir(libraryDir, { withFileTypes: true });

    const files = dirEntries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(libraryDir, entry.name))
      .filter((filePath) => isSupportedAudioPath(filePath))
      .map((filePath) => toLibraryItem(filePath));

    files.sort((first, second) => first.name.localeCompare(second.name));
    return files;
  });

  ipcMain.handle("audio:remove-imported-file", async (event, filePath) => {
    assertTrustedIpcSender(event);
    const targetPath = typeof filePath === "string" ? filePath : "";
    if (!targetPath) {
      return { ok: false, error: "invalid-path" };
    }

    const libraryDir = getLibraryDirectory();
    const resolvedLibraryDir = path.resolve(libraryDir);
    const resolvedTargetPath = path.resolve(targetPath);

    if (!isPathInsideDirectory(resolvedLibraryDir, resolvedTargetPath)) {
      return { ok: false, error: "outside-library" };
    }

    if (!isSupportedAudioPath(resolvedTargetPath)) {
      return { ok: false, error: "unsupported-file" };
    }

    try {
      await fs.promises.unlink(resolvedTargetPath);
      return { ok: true, removed: true };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: true, removed: false };
      }

      return {
        ok: false,
        error: "delete-failed",
        message: error?.message || "Could not delete file."
      };
    }
  });

  ipcMain.handle("keybinds:register-global", (event, entries) => {
    assertTrustedIpcSender(event);
    for (const entry of globalKeybindRegistrations) {
      globalShortcut.unregister(entry.accelerator);
    }

    globalKeybindRegistrations = [];
    if (keyHook) {
      keyHook.clearAll();
    }

    const list = Array.isArray(entries) ? entries.slice(0, 256) : [];
    const failed = [];
    const native = [];
    const globalShortcutResults = [];

    list.forEach((entry) => {
      const accelerators = (Array.isArray(entry?.accelerators)
        ? entry.accelerators
        : [entry?.accelerator])
        .filter((accelerator) => typeof accelerator === "string" && accelerator.length <= 80);
      const code = typeof entry?.code === "string" && entry.code.length <= 40 ? entry.code : "";

      if (!code) {
        return;
      }

      if (keyHook?.available && !entry?.preferGlobalShortcut) {
        const hooked = keyHook.watch(code, (domCode) => {
          emitGlobalKeyCode(domCode);
        });

        if (hooked) {
          native.push(code);
          return;
        }
      }

      if (!accelerators.length) {
        failed.push({ code, accelerators: [] });
        return;
      }

      let registered = false;

      for (const accelerator of accelerators) {
        try {
          const success = globalShortcut.register(accelerator, () => {
            emitGlobalKeyCode(code, entry?.modifiers || {});
          });

          if (success) {
            globalKeybindRegistrations.push({ accelerator, code });
            globalShortcutResults.push({ code, accelerator });
            registered = true;
            break;
          }
        } catch (error) {
        }
      }

      if (!registered) {
        failed.push({ code, accelerators });
      }
    });

    return {
      ok: true,
      mode: keyHook?.available ? "uiohook" : "globalShortcut",
      registeredCount: globalKeybindRegistrations.length,
      native,
      globalShortcut: globalShortcutResults,
      failed
    };
  });

  ipcMain.handle("app-settings:get", (event) => {
    assertTrustedIpcSender(event);
    return {
      ...appSettings,
      loginItem: app.getLoginItemSettings()
    };
  });

  ipcMain.handle("app-settings:set", (event, updates) => {
    assertTrustedIpcSender(event);
    const allowedKeys = new Set(["launchOnStartup", "startHidden", "keepRunningInTray"]);
    const next = typeof updates === "object" && updates ? updates : {};

    Object.keys(next).forEach((key) => {
      if (allowedKeys.has(key)) {
        appSettings[key] = Boolean(next[key]);
      }
    });

    if (!appSettings.launchOnStartup) {
      appSettings.startHidden = false;
    }

    saveAppSettings();
    applyLoginItemSettings();
    updateTrayMenu();

    return {
      ok: true,
      settings: appSettings,
      loginItem: app.getLoginItemSettings()
    };
  });
}

function getLibraryDirectory() {
  const dirPath = path.join(app.getPath("userData"), "audio-library");
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function isPathInsideDirectory(directoryPath, candidatePath) {
  const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function createUniqueDestinationPath(directoryPath, sourcePath) {
  const sourceExtension = path.extname(sourcePath);
  const sourceBaseName = path.basename(sourcePath, sourceExtension);
  const safeBaseName = sourceBaseName.replace(/[^a-z0-9-_ ]/gi, "_").trim() || "imported-audio";

  let attempt = 0;

  while (attempt < 9999) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const fileName = `${safeBaseName}${suffix}${sourceExtension.toLowerCase()}`;
    const candidatePath = path.join(directoryPath, fileName);

    if (!fs.existsSync(candidatePath)) {
      return candidatePath;
    }

    attempt += 1;
  }

  throw new Error("Could not create a unique file name in audio library.");
}

function toLibraryItem(filePath) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    fileUrl: pathToFileURL(filePath).href,
    sizeBytes: Number(stat.size),
    updatedAt: stat.mtimeMs
  };
}

if (hasSingleInstanceLock) {
  queueProtocolUrlsFromArgv(process.argv, { revealWindow: false });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    queueProtocolUrls([url], { revealWindow: true });
  });

  app.on("second-instance", (event, argv) => {
    const hasProtocolUrl = queueProtocolUrlsFromArgv(argv, { revealWindow: true });
    if (app.isReady()) {
      showMainWindow();
      if (!hasProtocolUrl) {
        startPendingProtocolImports();
      }
    }
  });

  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId(appUserModelId);
    }

    registerProtocolClient();
    loadAppSettings();
    applyLoginItemSettings();
    configurePermissions();
    registerAudioIpc();
    createTray();
    createWindow({ forceShow: pendingProtocolUrls.length > 0 });
    startPendingProtocolImports();

    app.on("activate", () => {
      showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !appSettings.keepRunningInTray) {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("will-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (keyHook) {
      keyHook.stop();
    }
  });
}
