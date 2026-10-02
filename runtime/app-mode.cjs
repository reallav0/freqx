'use strict';
// A branded development executable can report isPackaged=true. Electron's
// default application loader sets defaultApp for source launches only.
function isPackagedApp(app, runtimeProcess = process) {
  return Boolean(app.isPackaged && !runtimeProcess.defaultApp);
}
module.exports = { isPackagedApp };
