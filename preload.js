const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("soundmuncher", {
  appName: "Freqx",
  websiteUrl: "https://freqx.app",
  openWebsite: () => ipcRenderer.invoke("app:open-website"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  openUpdatePage: (url) => ipcRenderer.invoke("app:open-update-page", url),
  listOutputDevices: () => ipcRenderer.invoke("audio:list-output-devices"),
  sendTestTone: (deviceId) => ipcRenderer.invoke("audio:send-test-tone", deviceId),
  importAudioFiles: () => ipcRenderer.invoke("audio:import-files"),
  listImportedFiles: () => ipcRenderer.invoke("audio:list-imported-files"),
  removeImportedFile: (filePath) => ipcRenderer.invoke("audio:remove-imported-file", filePath),
  openLibraryFolder: () => ipcRenderer.invoke("audio:open-library-folder"),
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
  }
});
