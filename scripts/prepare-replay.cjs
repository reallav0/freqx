'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), source = path.join(root, 'audio/native/ReplayCapture.cs'), output = path.join(root, 'audio/native/ReplayCapture.exe');
if (process.platform === 'win32') {
  if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/reference:System.Web.Extensions.dll', '/out:' + output, source], { windowsHide: true, stdio: 'pipe' });
  }
  console.log('Prepared Windows stereo Instant Replay capture helper.');
}
