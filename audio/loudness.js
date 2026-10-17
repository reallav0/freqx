/* Local, non-destructive loudness analysis of decoded clips. Shared with tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreqxLoudness = api;
})(globalThis, () => {
  'use strict';
  const clamp = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const toLufs = power => -0.691 + 10 * Math.log10(power);

  function weighting(sampleRate) {
    // BS.1770 K weighting, bilinear form of the reference 48 kHz coefficients.
    // https://www.itu.int/rec/R-REC-BS.1770
    let k = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
    let q = 0.7071752369554196;
    const vh = 10 ** (3.999843853973347 / 20);
    const vb = vh ** 0.4996667741545416;
    let a0 = 1 + k / q + k * k;
    const shelf = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0,
      (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0];
    k = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
    q = 0.5003270373238773;
    a0 = 1 + k / q + k * k;
    return [shelf, [1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]];
  }
  function filter(coefficients) {
    const [b0, b1, b2, a1, a2] = coefficients;
    let z1 = 0, z2 = 0;
    return value => {
      const result = b0 * value + z1;
      z1 = b1 * value - a1 * result + z2;
      z2 = b2 * value - a2 * result;
      return result;
    };
  }

  async function analyze(buffer, options = {}) {
    const rate = buffer?.sampleRate;
    if (!Number.isFinite(rate) || rate < 8000 || rate > 384000 || !Number.isInteger(buffer?.length)
      || buffer.length < 1 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32) {
      throw new TypeError('Cannot analyze this audio buffer.');
    }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const duration = buffer.length / rate;
    const trimStart = clamp(options.trimStart, 0, 0, Math.max(0, duration - 0.01));
    const trimEnd = clamp(options.trimEnd, 0, 0, Math.max(0, duration - trimStart - 0.01));
    const start = Math.floor(trimStart * rate);
    const end = Math.max(start + 1, Math.min(buffer.length, Math.floor((duration - trimEnd) * rate)));
    const coefficients = weighting(rate);
    const leftShelf = filter(coefficients[0]), leftHighPass = filter(coefficients[1]);
    const rightShelf = filter(coefficients[0]), rightHighPass = filter(coefficients[1]);
    const hops = new Float64Array(4);
    const hopFrames = Math.round(rate * 0.1);
    const blocks = [];
    let hopEnergy = 0, hopCount = 0, hopsDone = 0, totalEnergy = 0, peak = 0;
    const yieldControl = options.yieldControl || (() => globalThis.scheduler?.yield
      ? globalThis.scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0)));
    const sample = (channel, frame) => Number.isFinite(channels[channel]?.[frame]) ? channels[channel][frame] : 0;
    // Measure the stereo speaker mix used by playback, including mono duplication.
    // Quad and 5.1 follow Web Audio's speaker downmix; LFE is not sent to stereo.
    for (let chunk = start; chunk < end; chunk += 32768) {
      const limit = Math.min(end, chunk + 32768);
      for (let frame = chunk; frame < limit; frame++) {
        let left = sample(0, frame), right = channels.length === 1 ? left : sample(1, frame);
        if (channels.length === 4) { left = 0.5 * (left + sample(2, frame)); right = 0.5 * (right + sample(3, frame)); }
        else if (channels.length === 6) {
          left += Math.SQRT1_2 * (sample(2, frame) + sample(4, frame));
          right += Math.SQRT1_2 * (sample(2, frame) + sample(5, frame));
        }
        peak = Math.max(peak, Math.abs(left), Math.abs(right));
        const weightedLeft = leftHighPass(leftShelf(left));
        const weightedRight = rightHighPass(rightShelf(right));
        const energy = weightedLeft * weightedLeft + weightedRight * weightedRight;
        hopEnergy += energy; totalEnergy += energy;
        if (++hopCount === hopFrames) {
          hops[hopsDone % 4] = hopEnergy;
          hopsDone++; hopEnergy = 0; hopCount = 0;
          if (hopsDone >= 4) blocks.push((hops[0] + hops[1] + hops[2] + hops[3]) / (4 * hopFrames));
        }
      }
      // Yield between bounded chunks so Stop and other controls remain responsive.
      if (limit < end) await yieldControl();
    }
    // Short effects still get a useful estimate instead of treating them as silence.
    if (!blocks.length) blocks.push(totalEnergy / (end - start));
    const absolute = blocks.filter(power => power > 0 && toLufs(power) >= -70);
    if (!absolute.length || peak < 1e-8) return { gain: 1, lufs: null, peak };
    const relativeGate = toLufs(absolute.reduce((sum, power) => sum + power, 0) / absolute.length) - 10;
    const gated = absolute.filter(power => toLufs(power) >= relativeGate);
    const lufs = toLufs(gated.reduce((sum, power) => sum + power, 0) / gated.length);
    const target = clamp(options.targetLufs, -18, -36, -10);
    const boost = clamp(options.maxBoostDb, 12, 0, 24);
    const cut = clamp(options.maxCutDb, 24, 0, 60);
    const ceiling = clamp(options.peakCeilingDb, -1, -12, 0);
    const gainDb = Math.min(clamp(target - lufs, 0, -cut, boost), ceiling - 20 * Math.log10(peak));
    return { gain: 10 ** (gainDb / 20), lufs, peak };
  }
  return Object.freeze({ analyze });
});
