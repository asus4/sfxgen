import type { FilterType } from '../format/types';
import { clamp, type Buf } from './math';

/**
 * Trapezoidal state-variable filter (Andrew Simper, Cytomic), stable under fast cutoff and resonance sweeps.
 * Every filter type comes from the same two states, mixed: m0 * input + m1 * band + m2 * low.
 * `bandpass` peaks at unity, so changing Q changes the width, not the level.
 */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private m0 = 0;
  private m1 = 0;
  private m2 = 0;
  private lastCutoff = -1;
  private lastQ = -1;

  constructor(
    private readonly type: FilterType,
    private readonly sr: number,
    private readonly gainDb = 0,
  ) {}

  private setup(cutoff: number, q: number): void {
    if (cutoff === this.lastCutoff && q === this.lastQ) return;
    this.lastCutoff = cutoff;
    this.lastQ = q;
    const fc = clamp(cutoff, 5, this.sr * 0.49);
    const Q = clamp(q, 0.05, 200);
    const A = Math.pow(10, this.gainDb / 40);
    let g = Math.tan((Math.PI * fc) / this.sr);
    let k = 1 / Q;
    let m0 = 0;
    let m1 = 0;
    let m2 = 0;
    switch (this.type) {
      case 'lowpass':
        m2 = 1;
        break;
      case 'highpass':
        m0 = 1;
        m1 = -k;
        m2 = -1;
        break;
      case 'bandpass':
        m1 = k;
        break;
      case 'notch':
        m0 = 1;
        m1 = -k;
        break;
      case 'allpass':
        m0 = 1;
        m1 = -2 * k;
        break;
      case 'peak':
        k = 1 / (Q * A);
        m0 = 1;
        m1 = k * (A * A - 1);
        break;
      case 'lowshelf':
        g = g / Math.sqrt(A);
        m0 = 1;
        m1 = k * (A - 1);
        m2 = A * A - 1;
        break;
      case 'highshelf':
        g = g * Math.sqrt(A);
        m0 = A * A;
        m1 = k * (1 - A) * A;
        m2 = 1 - A * A;
        break;
    }
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    this.m0 = m0;
    this.m1 = m1;
    this.m2 = m2;
  }

  tick(x: number, cutoff: number, q: number): number {
    this.setup(cutoff, q);
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return this.m0 * x + this.m1 * v1 + this.m2 * v2;
  }

  /** Filters a buffer in place. Cutoff and Q may be constants or per-sample curves. */
  process(x: Buf, cutoff: number | Buf, q: number | Buf): Buf {
    const cArr = typeof cutoff === 'number' ? null : cutoff;
    const qArr = typeof q === 'number' ? null : q;
    const c0 = typeof cutoff === 'number' ? cutoff : 0;
    const q0 = typeof q === 'number' ? q : 0;
    for (let i = 0; i < x.length; i++) {
      x[i] = this.tick(x[i], cArr ? cArr[i] : c0, qArr ? qArr[i] : q0);
    }
    return x;
  }
}

/** Filters a buffer in place with one SVF, or two in series for a 24 dB slope (Butterworth when q is 0.707). */
export function filterBuffer(
  x: Buf,
  type: FilterType,
  cutoff: number | Buf,
  q: number | Buf,
  sr: number,
  opts: { gainDb?: number; slope?: 12 | 24 } = {},
): Buf {
  const slope = opts.slope ?? 12;
  const steep = slope === 24 && (type === 'lowpass' || type === 'highpass' || type === 'bandpass');
  if (!steep) {
    new Svf(type, sr, opts.gainDb ?? 0).process(x, cutoff, q);
    return x;
  }
  // Two stages: a fixed low-Q stage and a resonant one, which is a 4th-order Butterworth at q = 0.707.
  new Svf(type, sr).process(x, cutoff, 0.5412);
  const q2 = typeof q === 'number' ? q * 1.8478 : q.map((v) => v * 1.8478);
  new Svf(type, sr).process(x, cutoff, q2);
  return x;
}

/** One-pole low-pass, in place. Gentle 6 dB/oct tone control and smoother. */
export function onePoleLowpass(x: Buf, cutoff: number, sr: number): Buf {
  const a = Math.exp((-2 * Math.PI * clamp(cutoff, 1, sr * 0.49)) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    x[i] = y;
  }
  return x;
}

/** One-pole high-pass, in place. */
export function onePoleHighpass(x: Buf, cutoff: number, sr: number): Buf {
  const a = Math.exp((-2 * Math.PI * clamp(cutoff, 1, sr * 0.49)) / sr);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp = (1 - a) * x[i] + a * lp;
    x[i] = x[i] - lp;
  }
  return x;
}

/** Removes DC with a ~10 Hz high-pass that barely touches audible lows. In place. */
export function dcBlock(x: Buf, sr: number, cutoff = 10): Buf {
  const R = 1 - (2 * Math.PI * cutoff) / sr;
  let xPrev = 0;
  let yPrev = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - xPrev + R * yPrev;
    xPrev = x[i];
    yPrev = y;
    x[i] = y;
  }
  return x;
}

/**
 * Two-pole resonator tuned by frequency and decay time (time for the ring to fall 60 dB): the building block of
 * modal synthesis. Input is an excitation; output rings at `freq`. Normalised so an impulse of 1 gives a ring
 * of amplitude about 1.
 */
export class Resonator {
  private y1 = 0;
  private y2 = 0;
  private b0 = 0;
  private a1 = 0;
  private a2 = 0;

  constructor(
    freq: number,
    t60: number,
    private readonly sr: number,
  ) {
    this.tune(freq, t60);
  }

  tune(freq: number, t60: number): void {
    const f = clamp(freq, 1, this.sr * 0.49);
    const r = Math.exp(-6.907755 / (Math.max(t60, 1e-4) * this.sr)); // 6.9 = ln(1000): 60 dB
    const w = (2 * Math.PI * f) / this.sr;
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -r * r;
    // An impulse gives sin(w n) r^n / sin(w) times b0: scale so the ring starts near amplitude 1.
    this.b0 = Math.sin(w);
  }

  tick(x: number): number {
    const y = this.b0 * x + this.a1 * this.y1 + this.a2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
