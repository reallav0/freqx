'use strict';

// This page has no preload, Node access, network access, or audio output. The
// media parser runs in a disposable Chromium sandbox, never in Electron main.
window.normalizeLinkedAudio = async (fileUrl, limits) => {
  const context = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error('Could not read downloaded audio.');
    const data = await response.arrayBuffer();
    if (!data.byteLength || data.byteLength > limits.inputBytes) throw new Error('Audio download is too large.');
    const decoded = await context.decodeAudioData(data);
    const channels = decoded.numberOfChannels;
    const frames = decoded.length;
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > limits.durationSeconds
        || !Number.isSafeInteger(frames) || frames <= 0 || channels < 1 || channels > 2
        || decoded.sampleRate !== 48000 || frames * channels * 4 > limits.decodedBytes) {
      throw new Error('Audio must be at most five minutes with one or two channels.');
    }
    const bytes = new ArrayBuffer(44 + frames * channels * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, 48000, true);
    view.setUint32(28, 48000 * channels * 2, true); view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
    const channelData = Array.from({ length: channels }, (_, channel) => decoded.getChannelData(channel));
    let offset = 44;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = channelData[channel][frame];
        if (!Number.isFinite(sample)) throw new Error('Audio contains invalid samples.');
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
        offset += 2;
      }
    }
    return bytes;
  } finally {
    await context.close();
  }
};
