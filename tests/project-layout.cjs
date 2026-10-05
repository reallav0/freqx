'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('desktop package and CI are independent of backend deployment and PostgreSQL', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json');
  for (const name of ['server', 'website', 'Dockerfile', 'heroku.yml', 'compose.yml', 'load-tests']) assert.equal(fs.existsSync(path.join(root, name)), false, name);
  assert.equal(pkg.dependencies.pg, undefined);
  assert.equal(pkg.dependencies.express, undefined);
  for (const script of Object.values(pkg.scripts)) assert.doesNotMatch(script, /server\/|test:server|scripts\/(?:local-postgres|load-test|test-backend-container)/);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /backend-container:|--prefix server|test:server|ci-services\.ps1/);
  function checkClientImports(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) checkClientImports(filename);
      else if (/\.(?:cjs|js|mjs)$/.test(filename)) assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /require\(['"][^'"]*(?:\.\.\/server\/|\.\.\/freqxback\/)[^'"]*['"]\)/, filename);
    }
  }
  checkClientImports(path.join(root, 'tests'));
  checkClientImports(path.join(root, 'runtime'));
  assert.ok(pkg.build.files.includes('account.js'));
  assert.ok(pkg.build.files.includes('runtime/**/*'));
  assert.equal(require('../runtime/desktop-config.cjs').config.network.apiBaseUrl, 'https://api.freqx.app');
});
