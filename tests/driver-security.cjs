'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const installer = fs.readFileSync(path.join(__dirname, '../installer/vbcable.nsh'), 'utf8');
assert.ok(!installer.includes('vbcable_run_setup'));
assert.ok(!/ExecWait[^\n]*VBCableSetupPath/.test(installer));
assert.ok(installer.includes('driver-policy.json'));
if (process.platform === 'win32') {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'driver-security.ps1')], {
    stdio: 'inherit', windowsHide: true, timeout: 60000
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else console.log('PASS installer has no verification bypass; PowerShell execution cases require Windows');
