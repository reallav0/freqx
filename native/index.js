'use strict';

let addon = null;

const VK_TO_DOM_CODE = {
  65: 'KeyA', 66: 'KeyB', 67: 'KeyC', 68: 'KeyD', 69: 'KeyE', 70: 'KeyF',
  71: 'KeyG', 72: 'KeyH', 73: 'KeyI', 74: 'KeyJ', 75: 'KeyK', 76: 'KeyL',
  77: 'KeyM', 78: 'KeyN', 79: 'KeyO', 80: 'KeyP', 81: 'KeyQ', 82: 'KeyR',
  83: 'KeyS', 84: 'KeyT', 85: 'KeyU', 86: 'KeyV', 87: 'KeyW', 88: 'KeyX',
  89: 'KeyY', 90: 'KeyZ',
  48: 'Digit0', 49: 'Digit1', 50: 'Digit2', 51: 'Digit3', 52: 'Digit4',
  53: 'Digit5', 54: 'Digit6', 55: 'Digit7', 56: 'Digit8', 57: 'Digit9',
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
  118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  96: 'Numpad0', 97: 'Numpad1', 98: 'Numpad2', 99: 'Numpad3',
  100: 'Numpad4', 101: 'Numpad5', 102: 'Numpad6', 103: 'Numpad7',
  104: 'Numpad8', 105: 'Numpad9', 106: 'NumpadMultiply',
  107: 'NumpadAdd', 109: 'NumpadSubtract', 110: 'NumpadDecimal', 111: 'NumpadDivide',
  186: 'Semicolon', 187: 'Equal', 188: 'Comma', 189: 'Minus',
  190: 'Period', 191: 'Slash', 192: 'Backquote', 219: 'BracketLeft',
  220: 'Backslash', 221: 'BracketRight', 222: 'Quote',
  32: 'Space', 13: 'Enter', 8: 'Backspace', 9: 'Tab', 27: 'Escape',
  46: 'Delete', 45: 'Insert', 36: 'Home', 35: 'End', 33: 'PageUp',
  34: 'PageDown', 38: 'ArrowUp', 40: 'ArrowDown', 37: 'ArrowLeft', 39: 'ArrowRight',
  20: 'CapsLock', 144: 'NumLock', 145: 'ScrollLock',
  16: 'ShiftLeft', 160: 'ShiftLeft', 161: 'ShiftRight',
  17: 'ControlLeft', 162: 'ControlLeft', 163: 'ControlRight',
  18: 'AltLeft', 164: 'AltLeft', 165: 'AltRight',
  91: 'MetaLeft', 92: 'MetaRight'
};

try {
  addon = require('./build/Release/keyhook.node');
} catch (error) {
  addon = null;
}

class KeyHook {
  constructor() {
    this._watchedVK = new Map();
    this._onKey = null;
    this._started = false;
  }

  watch(domCode, onKey) {
    for (const [vk, dc] of Object.entries(VK_TO_DOM_CODE)) {
      if (dc === domCode) {
        const vkNum = Number(vk);
        if (!this._watchedVK.has(vkNum)) {
          this._watchedVK.set(vkNum, new Set());
        }
        this._watchedVK.get(vkNum).add(domCode);
      }
    }

    this._onKey = onKey;
    this._ensureStarted();
  }

  clearAll() {
    this._watchedVK.clear();
  }

  _ensureStarted() {
    if (this._started || !addon) {
      return;
    }

    addon.start((event) => {
      const vk = Number(event?.vkCode || -1);
      const codes = this._watchedVK.get(vk);
      if (!codes || !this._onKey) {
        return;
      }

      for (const domCode of codes) {
        this._onKey(domCode);
      }
    });

    this._started = true;
  }

  stop() {
    if (!this._started || !addon) {
      return;
    }

    addon.stop();
    this._started = false;
  }

  get available() {
    return Boolean(addon);
  }
}

module.exports = new KeyHook();
