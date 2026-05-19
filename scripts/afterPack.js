const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appExePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, "logo.ico");
  const rceditPath = path.join(context.packager.projectDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

  if (!fs.existsSync(appExePath) || !fs.existsSync(iconPath) || !fs.existsSync(rceditPath)) {
    return;
  }

  execFileSync(rceditPath, [appExePath, "--set-icon", iconPath], {
    stdio: "inherit"
  });
};
