/**
 * The parts of old media: a wobbling transport, surface crackle, mains hum, telephone companding, broadcast
 * compression. Used by the `medium` effect.
 */
import { cubicAt, cubicAtWrapped } from './fracdelay';
import type { Rng } from './rng';
import type { Buf } from './math';

/** RMS over the samples within 50 dB of the peak: the level of the sound itself, ignoring silence around it. */
export function activeRms(channels: Buf[]): number {
  let p = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  if (p <= 0) return 0;
  const floor = p * 0.003;
  let s = 0;
  let m = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > floor) {
        s += a * a;
        m++;
      }
    }
  }
  return m > 0 ? Math.sqrt(s / m) : 0;
}

export interface Wobble {
  /** Hz. */
  rate: number;
  /** Peak swing of the read position, seconds. */
  depth: number;
}

/**
 * Speed instability as a moving read head: the sum of sinusoidal swings (wow below ~4 Hz, flutter above) plus a
 * slow random drift, applied as a varying delay. In a loop each rate is rounded to whole cycles so it stays seamless.
 * Every channel shares one transport.
 */
export function wobbleHead(channels: Buf[], sr: number, parts: Wobble[], drift: number, rng: Rng, loop: boolean): Buf[] {
  const n = channels[0].length;
  const length = n / sr;
  const offset = new Float64Array(n);
  let maxDepth = 0;
  for (const w of parts) {
    if (w.depth <= 0) continue;
    const f = loop ? Math.max(1, Math.round(w.rate * length)) / length : w.rate;
    const ph = rng.uniform(0, 2 * Math.PI);
    for (let i = 0; i < n; i++) offset[i] += w.depth * Math.sin(ph + (2 * Math.PI * f * i) / sr);
    maxDepth += w.depth;
  }
  if (drift > 0 && !loop) {
    // A slow random wander, smoothed noise below 0.3 Hz.
    let a = rng.gauss();
    let b = rng.gauss();
    const step = Math.max(2, Math.round(sr * 1.7));
    let k = Math.floor(rng.next() * step);
    for (let i = 0; i < n; i++) {
      const x = k / step;
      offset[i] += drift * 0.5 * (a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * x)));
      if (++k >= step) {
        k = 0;
        a = b;
        b = rng.gauss();
      }
    }
    maxDepth += drift;
  }
  if (maxDepth <= 0) return channels;
  return channels.map((x) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i - offset[i] * sr;
      y[i] = loop ? cubicAtWrapped(x, pos) : cubicAt(x, pos);
    }
    return y;
  });
}

/**
 * Surface clicks and pops: impulses at random times (`density` per second) with heavy-tailed sizes, each a short
 * decaying transient. Returns about unit-RMS crackle while it is active, and the click times for stereo copies.
 */
export function crackle(n: number, sr: number, density: number, rng: Rng): { x: Buf; times: number[] } {
  const x = new Float64Array(n);
  const times: number[] = [];
  if (density <= 0) return { x, times };
  const decay = Math.exp(-1 / (0.00025 * sr));
  let t = rng.exponential(sr / density);
  while (t < n) {
    const at = Math.floor(t);
    const size = Math.pow(rng.next(), 2.5) * (rng.next() < 0.04 ? 6 : 1.5);
    const sign = rng.sign();
    // A click: a sharp edge that rings down over a fraction of a millisecond; big ones last longer (pops).
    const len = Math.min(n - at, Math.round((0.0004 + 0.002 * Math.min(size, 2)) * sr));
    let g = size * sign;
    for (let i = 0; i < len; i++) {
      x[at + i] += g * (i % 2 === 0 ? 1 : -0.6);
      g *= decay;
    }
    times.push(at);
    t += rng.exponential(sr / density);
  }
  return { x, times };
}

/** Mains hum through a speaker: `f0` and its harmonics, falling off, with a little slow beating. */
export function hum(n: number, sr: number, f0: number, harmonics: number, buzz: number, rng: Rng): Buf {
  const x = new Float64Array(n);
  for (let h = 1; h <= harmonics; h++) {
    const f = f0 * h;
    if (f >= sr * 0.45) break;
    // Odd harmonics carry the buzz of a rectifier or a transformer.
    const a = (h === 1 ? 0.6 : 1) / Math.pow(h, h % 2 === 1 ? 1 - 0.5 * buzz : 1.4);
    const ph = rng.uniform(0, 2 * Math.PI);
    const w = (2 * Math.PI * f) / sr;
    // A rotating phasor instead of a sine per sample, renormalised now and then against drift.
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = Math.cos(ph);
    let s = Math.sin(ph);
    for (let i = 0; i < n; i++) {
      x[i] += a * s;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
      if ((i & 4095) === 4095) {
        const r = 1 / Math.hypot(c, s);
        c *= r;
        s *= r;
      }
    }
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  const r = Math.sqrt(s / Math.max(n, 1));
  if (r > 0) for (let i = 0; i < n; i++) x[i] /= r;
  return x;
}

/** G.711-style μ-law companding to `bits` bits: the grain of a digital telephone line. Input about ±1. */
export function muLaw(x: number, bits: number): number {
  const mu = 255;
  const c = Math.max(-1, Math.min(1, x));
  const y = (Math.sign(c) * Math.log1p(mu * Math.abs(c))) / Math.log1p(mu);
  const steps = Math.pow(2, bits - 1);
  const q = Math.round(y * steps) / steps;
  return (Math.sign(q) * Math.expm1(Math.abs(q) * Math.log1p(mu))) / mu;
}

/**
 * Broadcast-style compressor: a smoothed level detector and gain reduction above `thresholdDb` at `ratio`, with
 * the gain applied at once (no look-ahead). In place.
 */
export function compress(x: Buf, sr: number, thresholdDb: number, ratio: number, attack: number, release: number): Buf {
  const at = Math.exp(-1 / (attack * sr));
  const rel = Math.exp(-1 / (release * sr));
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? at * env + (1 - at) * a : rel * env + (1 - rel) * a;
    const db = 20 * Math.log10(env + 1e-12);
    const over = db - thresholdDb;
    if (over > 0) x[i] *= Math.pow(10, (-over * (1 - 1 / ratio)) / 20);
  }
  return x;
}
