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
  const missingPaths = [
    [appExePath, "packaged executable"],
    [iconPath, "Windows icon"],
    [rceditPath, "rcedit"]
  ].filter(([filePath]) => !fs.existsSync(filePath));

  if (missingPaths.length > 0) {
    const missing = missingPaths
      .map(([filePath, label]) => `${label}: ${filePath}`)
      .join("; ");
    throw new Error(`Cannot stamp Windows executable icon. Missing ${missing}`);
  }

  console.log(`Stamping Windows icon on ${appExePath}`);
  execFileSync(rceditPath, [appExePath, "--set-icon", iconPath], {
    stdio: "inherit"
  });
};
