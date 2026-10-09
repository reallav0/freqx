'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const { prepareLinkTools } = require('../runtime/audio-link-tools.cjs');
const exec = promisify(execFile);
(async () => {
  const directory = path.resolve(__dirname, '../output/link-tools-security');
  await fs.mkdir(directory, { recursive: true });
  const tools = await prepareLinkTools(directory);
  const version = await exec(tools['yt-dlp'], ['--version'], { windowsHide: true, timeout: 10000 });
  assert.equal(version.stdout.trim(), '2026.08.19');
  const script = `
    const attempts = {
      files: () => Deno.readTextFile('private.txt'),
      writes: () => Deno.writeTextFile('forbidden.txt', 'x'),
      environment: () => Deno.env.get('SystemRoot'),
      network: () => Deno.connect({hostname:'127.0.0.1',port:1}),
      subprocess: () => new Deno.Command(Deno.execPath(), {args:['--version']}).output()
    };
    const results = {};
    for (const [name, attempt] of Object.entries(attempts)) {
      try { await attempt(); results[name] = false; }
      catch (error) { results[name] = error.name === 'NotCapable' || error.name === 'PermissionDenied'; }
    }
    console.log(JSON.stringify(results));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(tools.deno, ['run', '--ext=js', '--no-code-cache', '--no-prompt', '--no-remote', '--no-lock', '--node-modules-dir=none', '--no-config', '--no-npm', '--cached-only', '-'], { cwd: directory, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
    let out = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Sandbox permission probe timed out.')); }, 10000);
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(errors)); else resolve(JSON.parse(out)); });
    child.stdin.end(script);
  });
  assert.deepEqual(result, { files: true, writes: true, environment: true, network: true, subprocess: true });
  console.log('Verified helper versions/hashes and denied file, write, environment, network and subprocess permissions.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
