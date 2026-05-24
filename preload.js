const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("soundmuncher", {
  appName: "Freqx",
  websiteUrl: "https://freqx.app",
  reportCrash: (payload) => ipcRenderer.invoke("app:report-crash", payload),
  getCrashReport: () => ipcRenderer.invoke("app:get-crash-report"),
  openCrashLog: () => ipcRenderer.invoke("app:open-crash-log"),
  reloadAfterCrash: () => ipcRenderer.invoke("app:reload-after-crash"),
  quitAfterCrash: () => ipcRenderer.invoke("app:quit-after-crash"),
  openWebsite: () => ipcRenderer.invoke("app:open-website"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  openUpdatePage: (url) => ipcRenderer.invoke("app:open-update-page", url),
  listOutputDevices: () => ipcRenderer.invoke("audio:list-output-devices"),
  sendTestTone: (deviceId) => ipcRenderer.invoke("audio:send-test-tone", deviceId),
  importAudioFiles: () => ipcRenderer.invoke("audio:import-files"),
  importAudioFilePaths: (filePaths) => ipcRenderer.invoke("audio:import-file-paths", filePaths),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      return "";
    }
  },
  listImportedFiles: () => ipcRenderer.invoke("audio:list-imported-files"),
  removeImportedFile: (filePath) => ipcRenderer.invoke("audio:remove-imported-file", filePath),
  openLibraryFolder: () => ipcRenderer.invoke("audio:open-library-folder"),
  externalImportsReady: () => ipcRenderer.invoke("audio:external-imports-ready"),
  getAppSettings: () => ipcRenderer.invoke("app-settings:get"),
  setAppSettings: (updates) => ipcRenderer.invoke("app-settings:set", updates),
  registerGlobalKeybinds: (entries) => ipcRenderer.invoke("keybinds:register-global", entries),
  onGlobalKeybindTriggered: (handler) => {
    const listener = (event, payload) => {
      handler(payload);
    };

    ipcRenderer.on("keybinds:trigger", listener);
    return () => {
      ipcRenderer.removeListener("keybinds:trigger", listener);
    };
  },
  onExternalImportStarted: (handler) => {
    const listener = (event, payload) => {
      handler(payload);
    };

    ipcRenderer.on("audio:external-import-started", listener);
    return () => {
      ipcRenderer.removeListener("audio:external-import-started", listener);
    };
  },
  onExternalImportCompleted: (handler) => {
    const listener = (event, payload) => {
      handler(payload);
    };

    ipcRenderer.on("audio:external-import-completed", listener);
    return () => {
      ipcRenderer.removeListener("audio:external-import-completed", listener);
    };
  },
  onFatalError: (handler) => {
    const listener = (event, payload) => {
      handler(payload);
    };

    ipcRenderer.on("app:fatal-error", listener);
    return () => {
      ipcRenderer.removeListener("app:fatal-error", listener);
    };
  }
});
