const { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, session, shell } = require("electron");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { pathToFileURL } = require("url");
const packageMetadata = require("./package.json");

let portAudio = null;
let globalKeybindRegistrations = [];
let mainWindow;
let keyHook = null;
let tray = null;
let isQuitting = false;
const websiteUrl = "https://freqx.app";
const githubUpdateRepository = getConfiguredGitHubRepository();
let appSettings = {
  launchOnStartup: true,
  startHidden: false,
  keepRunningInTray: true
};

configureDevelopmentStoragePaths();

try {
  portAudio = require("naudiodon");
} catch (error) {
  portAudio = null;
}

try {
  const { uIOhook, UiohookKey } = require("uiohook-napi");
  keyHook = createUiohookBridge(uIOhook, UiohookKey);
} catch (error) {
  keyHook = null;
}

function configureDevelopmentStoragePaths() {
  if (app.isPackaged) {
    return;
  }

  const devUserDataPath = path.join(app.getPath("appData"), "freqx-dev");
  app.setPath("userData", devUserDataPath);
  app.setPath("sessionData", path.join(devUserDataPath, "session"));
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

function getRendererUrl() {
  return pathToFileURL(path.join(__dirname, "index.html")).href;
}

function isTrustedIpcSender(event) {
  const frameUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  return frameUrl === getRendererUrl();
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

function createTray() {
  if (tray) {
    return;
  }

  const trayIcon = nativeImage.createFromPath(path.join(__dirname, "logo.png")).resize({
    width: 16,
    height: 16
  });
  tray = new Tray(trayIcon);
  tray.setToolTip("freqx");
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function createWindow() {
  const shouldStartHidden = appSettings.startHidden || process.argv.includes("--hidden");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#f5f4ef",
    title: "freqx",
    icon: path.join(__dirname, "logo.png"),
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
    if (url !== getRendererUrl()) {
      event.preventDefault();
    }
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

  mainWindow.loadFile("index.html");
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

function registerAudioIpc() {
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

  ipcMain.handle("audio:open-library-folder", async (event) => {
    assertTrustedIpcSender(event);
    const libraryDir = getLibraryDirectory();
    shell.openPath(libraryDir);
    return { ok: true };
  });

  ipcMain.handle("audio:import-files", async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Import Audio Files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Audio Files",
          extensions: ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]
        }
      ]
    });

    if (canceled || filePaths.length === 0) {
      return { imported: [], canceled: true };
    }

    const imported = [];
    const libraryDir = getLibraryDirectory();

    for (const sourcePath of filePaths) {
      const destinationPath = createUniqueDestinationPath(libraryDir, sourcePath);
      await fs.promises.copyFile(sourcePath, destinationPath);
      imported.push(toLibraryItem(destinationPath));
    }

    return { imported, canceled: false };
  });

  ipcMain.handle("audio:list-imported-files", async (event) => {
    assertTrustedIpcSender(event);
    const libraryDir = getLibraryDirectory();
    const dirEntries = await fs.promises.readdir(libraryDir, { withFileTypes: true });
    const supportedExtensions = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"]);

    const files = dirEntries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(libraryDir, entry.name))
      .filter((filePath) => supportedExtensions.has(path.extname(filePath).toLowerCase()))
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
    const supportedExtensions = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"]);

    if (!isPathInsideDirectory(resolvedLibraryDir, resolvedTargetPath)) {
      return { ok: false, error: "outside-library" };
    }

    if (!supportedExtensions.has(path.extname(resolvedTargetPath).toLowerCase())) {
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

app.whenReady().then(() => {
  loadAppSettings();
  applyLoginItemSettings();
  configurePermissions();
  registerAudioIpc();
  createTray();
  createWindow();

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !appSettings.keepRunningInTray) {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (keyHook) {
    keyHook.stop();
  }
});
