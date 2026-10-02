const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("soundmuncher", {
  appName: "freqx",
  websiteUrl: "https://freqx.app",
  authStatus: () => ipcRenderer.invoke('auth:status'),
  login: input => ipcRenderer.invoke('auth:login', input),
  signup: input => ipcRenderer.invoke('auth:signup', input),
  logout: () => ipcRenderer.invoke('auth:logout'),
  logoutAll: () => ipcRenderer.invoke('auth:logout-all'),
  verifyEmail: input => ipcRenderer.invoke('auth:email-verify', input),
  resendEmail: () => ipcRenderer.invoke('auth:email-resend'),
  forgotPassword: input => ipcRenderer.invoke('auth:password-forgot', input),
  resetPassword: input => ipcRenderer.invoke('auth:password-reset', input),
  oauthLogin: provider => ipcRenderer.invoke('auth:oauth-start', provider),
  requestPhoneCode: input => ipcRenderer.invoke('auth:phone-request', input),
  verifyPhone: input => ipcRenderer.invoke('auth:phone-verify', input),
  listCloudSounds: () => ipcRenderer.invoke('cloud:list'),
  uploadCloudSound: input => ipcRenderer.invoke('cloud:upload', input),
  deleteCloudSound: id => ipcRenderer.invoke('cloud:delete', id),
  updateProfile: input => ipcRenderer.invoke('account:profile', input),
  changePassword: input => ipcRenderer.invoke('account:password', input),
  syncFavorites: ids => ipcRenderer.invoke('account:favorites-sync', ids),
  setCloudFavorite: input => ipcRenderer.invoke('account:favorite', input),
  onAuthState: handler => {
    const listener = (event, state) => handler(state);
    ipcRenderer.on('auth:state', listener);
    return () => ipcRenderer.removeListener('auth:state', listener);
  },
  reportCrash: (payload) => ipcRenderer.invoke("app:report-crash", payload),
  getCrashReport: () => ipcRenderer.invoke("app:get-crash-report"),
  openCrashLog: () => ipcRenderer.invoke("app:open-crash-log"),
  reloadAfterCrash: () => ipcRenderer.invoke("app:reload-after-crash"),
  quitAfterCrash: () => ipcRenderer.invoke("app:quit-after-crash"),
  openWebsite: () => ipcRenderer.invoke("app:open-website"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  updateStatus: () => ipcRenderer.invoke('app:update-status'),
  installUpdate: () => ipcRenderer.invoke('app:update-install'),
  onUpdateState: handler => { const listener = (event, state) => handler(state); ipcRenderer.on('app:update-state', listener); return () => ipcRenderer.removeListener('app:update-state', listener); },
  openUpdatePage: (url) => ipcRenderer.invoke("app:open-update-page", url),
  listOutputDevices: () => ipcRenderer.invoke("audio:list-output-devices"),
  listReferenceDevices: () => ipcRenderer.invoke('audio:reference-devices'),
  startReference: endpointId => ipcRenderer.invoke('audio:reference-start', endpointId),
  stopReference: id => ipcRenderer.invoke('audio:reference-stop', id),
  cancelReference: () => ipcRenderer.invoke('audio:reference-cancel'),
  onReferenceData: handler => {
    const listener = (event, packet) => {
      try { handler(packet); } finally { if (packet?.type === 'pcm') ipcRenderer.send('audio:reference-ack', packet.id); }
    };
    ipcRenderer.on('audio:reference-data', listener);
    return () => ipcRenderer.removeListener('audio:reference-data', listener);
  },
  sendTestTone: (deviceId) => ipcRenderer.invoke("audio:send-test-tone", deviceId),
  importAudioFiles: () => ipcRenderer.invoke("audio:import-files"),
  getPublicLibrary: () => ipcRenderer.invoke("library:catalog"),
  previewPublicSound: (id) => ipcRenderer.invoke("library:preview", id),
  importPublicSound: (id) => ipcRenderer.invoke("library:import", id),
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
