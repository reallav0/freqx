/* Only the packaged developer-owned JSON is read. There is no configuration IPC. */
(() => {
  'use strict';
  const url = new URL('desktop-config.json', document.currentScript.src);
  let current;
  const ready = fetch(url).then(response => {
    if (!response.ok) throw new Error('Cannot load packaged desktop configuration.');
    return response.json();
  }).then(value => {
    current = window.FreqxConfigSchema.validateConfig(value);
    return current;
  });
  Object.defineProperty(window, 'FreqxDesktopConfig', { value: Object.freeze({ ready, get current() { return current; } }), writable: false, configurable: false });
})();
