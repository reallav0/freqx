// Real native activation against this silent Node process only. Never records
// desktop, another application, a microphone, or any user audio.
'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
async function run() {
  if (process.platform !== 'win32') { console.log('SKIP native Replay activation: Windows only.'); return; }
  const helper = path.join(__dirname, '../audio/native/ReplayCapture.exe');
  const { stdout } = await promisify(execFile)(helper, ['list'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  const sources = JSON.parse(stdout); assert.ok(Array.isArray(sources.sources));
  assert.ok(sources.sources.every(source => ['desktop', 'application', 'device'].includes(source.kind)));
  if (!sources.processCaptureSupported) { console.log('PASS source listing; process capture requires a newer Windows build.'); return; }
  const child = spawn(helper, ['capture', 'application', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false, heartbeat = false, pending = '', errors = [];
  child.stdout.resume();
  child.stderr.on('data', bytes => { pending += bytes.toString('utf8'); let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (message.type === 'ready') { assert.equal(message.channels, 2); assert.equal(message.sampleRate, 48000); assert.equal(message.id, String(process.pid)); ready = true; }
      if (message.type === 'heartbeat') { heartbeat = true; child.stdin.end('\n'); }
      if (message.type === 'error') errors.push(message.message);
    }
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, errors.join('; ')); assert.equal(ready, true); assert.equal(heartbeat, true);
    console.log('PASS real Windows source listing, stereo process activation, heartbeat, and graceful capture shutdown (silent owned process only).');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
