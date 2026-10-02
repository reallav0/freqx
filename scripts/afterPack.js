const path = require("path");
const { brandWindowsExecutable } = require("./windows-branding.cjs");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appExePath = path.join(context.appOutDir, `${productFilename}.exe`);
  console.log(`Branding Windows application and child processes as freqx: ${appExePath}`);
  brandWindowsExecutable(appExePath, context.packager.projectDir);
};
