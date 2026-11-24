/**
 * Delay lines with fractional reads: the shared plumbing of echoes, combs, moving read heads (wow, Doppler,
 * varispeed) and grain pitch shifting.
 */
import type { Buf } from './math';

/** Smallest power of two that holds `n`. */
export function pow2Above(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Catmull-Rom cubic through four neighbours, at fraction `f` (0..1) between `x0` and `x1`. */
export function hermite(xm1: number, x0: number, x1: number, x2: number, f: number): number {
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** Cubic read of a whole buffer at a fractional position; silence outside it. */
export function cubicAt(x: Buf, pos: number): number {
  const i = Math.floor(pos);
  const n = x.length;
  const f = pos - i;
  if (i >= 1 && i + 2 < n) return hermite(x[i - 1], x[i], x[i + 1], x[i + 2], f);
  if (i < -2 || i > n) return 0;
  const a = i - 1 >= 0 && i - 1 < n ? x[i - 1] : 0;
  const b = i >= 0 && i < n ? x[i] : 0;
  const c = i + 1 >= 0 && i + 1 < n ? x[i + 1] : 0;
  const d = i + 2 >= 0 && i + 2 < n ? x[i + 2] : 0;
  return hermite(a, b, c, d, f);
}

/** Cubic read that wraps around the buffer, for loops. */
export function cubicAtWrapped(x: Buf, pos: number): number {
  const n = x.length;
  const i = Math.floor(pos);
  const f = pos - i;
  const k = ((i % n) + n) % n;
  return hermite(x[(k - 1 + n) % n], x[k], x[(k + 1) % n], x[(k + 2) % n], f);
}

/**
 * A ring-buffer delay line. Read before writing each sample: `read(1)` is the sample written last.
 * Fractional delays below 3 samples are read linearly (the cubic needs a sample on each side).
 */
export class DelayLine {
  readonly buf: Float64Array;
  readonly mask: number;
  w = 0;

  constructor(maxDelaySamples: number) {
    const size = pow2Above(Math.ceil(Math.max(maxDelaySamples, 1)) + 4);
    this.buf = new Float64Array(size);
    this.mask = size - 1;
  }

  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /** The input of `d` samples ago, `d` ≥ 1 and fractional. */
  read(d: number): number {
    const buf = this.buf;
    const mask = this.mask;
    if (d < 2) {
      const dd = d < 1 ? 1 : d;
      const di = Math.floor(dd);
      const f = dd - di;
      const a = buf[(this.w - di) & mask];
      const b = buf[(this.w - di - 1) & mask];
      return a + (b - a) * f;
    }
    // Position w - d sits between the older sample (w - di - 1) and the newer one (w - di).
    const di = Math.floor(d);
    const base = this.w - di - 1;
    return hermite(buf[(base - 1) & mask], buf[base & mask], buf[(base + 1) & mask], buf[(base + 2) & mask], 1 - (d - di));
  }

  /** Integer delay read, `d` ≥ 1. */
  tap(d: number): number {
    return this.buf[(this.w - d) & this.mask];
  }
}
