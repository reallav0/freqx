'use strict';
module.exports = [{
  ignores: ['node_modules/**', '.local/**', '.audit-tools/**', 'output/**', 'dist/**', 'audio/vendor/**', '.archify/**'],
}, {
  files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
  rules: {
    'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'no-duplicate-case': 'error',
    'no-unreachable': 'error', 'no-constant-binary-expression': 'error', 'valid-typeof': 'error',
    'constructor-super': 'error', 'no-this-before-super': 'error', 'no-unsafe-finally': 'error',
    'no-async-promise-executor': 'error', 'no-eval': 'error', 'no-implied-eval': 'error',
    'no-new-func': 'error', 'no-prototype-builtins': 'error', 'no-sparse-arrays': 'error',
    'no-loss-of-precision': 'error', 'no-unexpected-multiline': 'error'
  }
}, { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } }];
