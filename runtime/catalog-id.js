(function exposeCatalogId(root) {
  'use strict';
  const MAX_LENGTH = 200;
  const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const valid = value => typeof value === 'string' && value.length <= MAX_LENGTH
    && (slug.test(value) || uuid.test(value));
  const api = Object.freeze({ MAX_LENGTH, valid });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FreqxCatalogId = api;
})(globalThis);
