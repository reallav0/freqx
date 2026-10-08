// Gentle peak-envelope compression with no lookahead or extra buffering.
export class MicCompressor {
  constructor({ threshold = -18, knee = 12, ratio = 2, attack = .003, release = .12 } = {}) {
    this.threshold = threshold;
    this.knee = knee;
    this.slope = 1 / ratio - 1;
    this.attack = 1 - Math.exp(-1 / (48000 * Math.max(.0001, attack)));
    this.release = 1 - Math.exp(-1 / (48000 * Math.max(.0001, release)));
    this.envelope = 0;
  }
  process(value) {
    const magnitude = Math.abs(value);
    this.envelope += (magnitude - this.envelope) * (magnitude > this.envelope ? this.attack : this.release);
    const level = 20 * Math.log10(Math.max(1e-12, this.envelope));
    const above = level - this.threshold;
    let reduction = 0;
    if (above >= this.knee / 2) reduction = this.slope * above;
    else if (above > -this.knee / 2 && this.knee > 0) reduction = this.slope * (above + this.knee / 2) ** 2 / (2 * this.knee);
    return value * 10 ** (reduction / 20);
  }
}
