'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('./config-schema.js');
function loadConfig(filename = path.join(__dirname, 'desktop-config.json')) {
  return validateConfig(JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')));
}
module.exports = Object.freeze({ config: loadConfig(), loadConfig, validateConfig });
