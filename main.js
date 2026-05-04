const { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

let portAudio = null;
let globalKeybindRegistrations = [];
let mainWindow;
let keyHook = null;
let tray = null;
let isQuitting = false;
let appSettings = {
  launchOnStartup: false,
  startHidden: false,
  keepRunningInTray: true
};

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

function emitGlobalKeyCode(code) {
  const targetWindow = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows()[0];
  const webContents = targetWindow?.webContents;
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("keybinds:trigger", { code });
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
    callback(permission === "media");
  });
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
      launchOnStartup: Boolean(parsed.launchOnStartup),
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
      label: "Show SoundMuncher",
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
  tray.setToolTip("SoundMuncher");
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
    title: "SoundMuncher",
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
  ipcMain.handle("audio:list-output-devices", () => {
    return {
      hasNaudiodon: Boolean(portAudio),
      devices: getOutputDevices()
    };
  });

  ipcMain.handle("audio:send-test-tone", (event, deviceId) => {
    writeTestTone(Number(deviceId));
    return { ok: true };
  });

  ipcMain.handle("audio:open-library-folder", async () => {
    const libraryDir = getLibraryDirectory();
    shell.openPath(libraryDir);
    return { ok: true };
  });

  ipcMain.handle("audio:import-files", async () => {
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

  ipcMain.handle("audio:list-imported-files", async () => {
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
    for (const entry of globalKeybindRegistrations) {
      globalShortcut.unregister(entry.accelerator);
    }

    globalKeybindRegistrations = [];
    if (keyHook) {
      keyHook.clearAll();
    }

    const list = Array.isArray(entries) ? entries : [];
    const failed = [];
    const native = [];
    const globalShortcutResults = [];

    list.forEach((entry) => {
      const accelerators = Array.isArray(entry?.accelerators)
        ? entry.accelerators.filter(Boolean)
        : [entry?.accelerator].filter(Boolean);
      const code = entry?.code;

      if (!code) {
        return;
      }

      if (keyHook?.available) {
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
            emitGlobalKeyCode(code);
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

  ipcMain.handle("app-settings:get", () => ({
    ...appSettings,
    loginItem: app.getLoginItemSettings()
  }));

  ipcMain.handle("app-settings:set", (event, updates) => {
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
