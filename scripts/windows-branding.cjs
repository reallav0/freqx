const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function brandWindowsExecutable(executable, root) {
  const editor = path.join(root, 'node_modules/rcedit/bin/rcedit-x64.exe');
  const icon = path.join(root, 'logo.ico');
  for (const target of [executable, editor, icon]) {
    if (!fs.existsSync(target)) throw new Error(`Cannot brand freqx: missing ${target}`);
  }
  execFileSync(editor, [executable,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', 'freqx',
    '--set-version-string', 'FileDescription', 'freqx',
    '--set-version-string', 'InternalName', 'freqx',
    '--set-version-string', 'OriginalFilename', 'freqx.exe'
  ], { stdio: 'inherit', windowsHide: true });
}

module.exports = { brandWindowsExecutable };
