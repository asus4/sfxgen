/**
 * Spring reverb: each spring is a loop of a dispersive allpass chain, a round-trip delay and the tank's losses.
 *
 * The chain is a cascade of stretched first-order allpasses, H(z^K) with H(z) = (a + z^-1) / (1 + a z^-1) and a < 0.
 * Below fs / 2K its group delay falls with frequency, so a click comes out as a falling chirp (the "drip"), and every
 * round trip through the loop smears it further. A steep low-pass at the spring's transition frequency removes the
 * chain's mirrored responses above it, as the transducers of a real tank do.
 */
import { Svf } from './filters';
import type { Buf } from './math';

export interface SpringSettings {
  sr: number;
  /** Decay (60 dB) in seconds. */
  t60: number;
  /** Round trip of the first spring, seconds; one other is a little longer, one a little shorter. */
  roundTrip: number;
  /** 0 bright and splashy, 1 dark and dull. */
  damping: number;
  /** Allpass coefficient magnitude: more is more chirp. */
  chirp: number;
}

const TRANSITION_HZ = 4400;

class Spring {
  private readonly k: number;
  private readonly stages: number;
  private readonly a: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private idx = 0;
  private readonly loop: Float64Array;
  private readonly loopMask: number;
  private w = 0;
  private readonly loopLen: number;
  private readonly lp1: Svf;
  private readonly lp2: Svf;
  private readonly fc: number;
  private hpState = 0;
  private readonly hpA: number;
  readonly g: number;
  private fb = 0;

  constructor(s: SpringSettings, roundTrip: number) {
    const sr = s.sr;
    this.k = Math.max(1, Math.round(sr / (2 * TRANSITION_HZ)));
    this.stages = 30;
    this.a = -Math.min(Math.max(s.chirp, 0.3), 0.85);
    this.xs = new Float64Array(this.k * this.stages);
    this.ys = new Float64Array(this.k * this.stages);
    // The chain's own delay at 1 kHz is part of the round trip.
    const am = -this.a;
    const w = (2 * Math.PI * 1000 * this.k) / sr;
    const chainDelay = (this.stages * this.k * (1 - am * am)) / (1 - 2 * am * Math.cos(w) + am * am);
    this.loopLen = Math.max(8, Math.round(roundTrip * sr - chainDelay));
    let size = 1;
    while (size < this.loopLen + 2) size <<= 1;
    this.loop = new Float64Array(size);
    this.loopMask = size - 1;
    this.lp1 = new Svf('lowpass', sr);
    this.lp2 = new Svf('lowpass', sr);
    this.fc = Math.min(TRANSITION_HZ * Math.pow(2, -1.6 * s.damping), sr * 0.45);
    this.hpA = Math.exp((-2 * Math.PI * 70) / sr);
    const pass = (this.loopLen + chainDelay) / sr;
    this.g = Math.pow(10, (-3 * pass) / Math.max(s.t60, 0.05));
  }

  /** One sample in, one out (the signal after each trip along the spring). */
  tick(x: number): number {
    let v = x + this.fb;
    const k = this.k;
    const a = this.a;
    const xs = this.xs;
    const ys = this.ys;
    const idx = this.idx;
    for (let s = 0, o = idx; s < this.stages; s++, o += k) {
      const xo = xs[o];
      const yo = ys[o];
      const y = a * (v - yo) + xo;
      xs[o] = v;
      ys[o] = y;
      v = y;
    }
    this.idx = idx + 1 === k ? 0 : idx + 1;
    // Round trip, then the losses: a steep low-pass at the transition, a gentle high-pass, the decay gain.
    this.loop[this.w] = v;
    this.w = (this.w + 1) & this.loopMask;
    let z = this.loop[(this.w - this.loopLen) & this.loopMask];
    z = this.lp2.tick(this.lp1.tick(z, this.fc, 0.5412), this.fc, 1.3066);
    this.hpState = (1 - this.hpA) * z + this.hpA * this.hpState;
    z -= this.hpState;
    this.fb = this.g * z;
    return v;
  }
}

/** Renders a tank of springs from a mono input: one channel, or two from springs of different lengths. */
export function renderSpring(x: Buf, n: number, s: SpringSettings, stereoOut: boolean): Buf[] {
  const springs = [new Spring(s, s.roundTrip), new Spring(s, s.roundTrip * 1.23), new Spring(s, s.roundTrip * 0.87)];
  // The input transducer: band-limited to what a spring can carry.
  const pre = new Svf('lowpass', s.sr);
  const pre2 = new Svf('lowpass', s.sr);
  const fc = Math.min(TRANSITION_HZ, s.sr * 0.45);
  const outL = new Float64Array(n);
  const outR = stereoOut ? new Float64Array(n) : outL;
  let lastIn = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (x[i] !== 0) {
      lastIn = i;
      break;
    }
  }
  if (lastIn < 0) return stereoOut ? [outL, outR] : [outL];
  let peakSoFar = 0;
  let blockPeak = 0;
  const settle = lastIn + Math.round(s.roundTrip * 1.3 * s.sr) + 4096;
  for (let i = 0; i < n; i++) {
    const xin = i <= lastIn ? pre2.tick(pre.tick(x[i], fc, 0.5412), fc, 1.3066) : pre2.tick(pre.tick(0, fc, 0.5412), fc, 1.3066);
    const a = springs[0].tick(xin);
    const b = springs[1].tick(xin);
    const c = springs[2].tick(xin);
    if (stereoOut) {
      outL[i] = a + 0.45 * c;
      outR[i] = b - 0.45 * c;
    } else outL[i] = (a + b + c) * 0.6;
    const ay = Math.abs(a) + Math.abs(b);
    if (ay > blockPeak) blockPeak = ay;
    if ((i & 1023) === 1023) {
      if (blockPeak > peakSoFar) peakSoFar = blockPeak;
      if (i > settle && blockPeak <= peakSoFar * 1e-10) break;
      blockPeak = 0;
    }
  }
  return stereoOut ? [outL, outR] : [outL];
}
