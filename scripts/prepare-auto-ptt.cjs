'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform === 'win32') {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'audio/native/AutoPushToTalk.cs');
  const output = path.join(root, 'audio/native/AutoPushToTalk.exe');
  if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/reference:System.Web.Extensions.dll', '/out:' + output, source], { windowsHide: true, stdio: 'pipe' });
  }
  console.log('Prepared Windows automatic push-to-talk helper.');
}
