/**
 * Level detection and gain smoothing for the dynamics effects (compressor, limiter, gate, transient shaper).
 * Rendering is offline, so a detector may look ahead for free and a gain curve may be smoothed without lag.
 */
import type { Buf } from './math';

/** One-pole coefficient for a time constant in seconds: a step is 63% done after that time. */
export function onePoleCoef(seconds: number, sr: number): number {
  return seconds > 0 ? Math.exp(-1 / (seconds * sr)) : 0;
}

/** The largest |x| of all channels at each sample: one detector for linked stereo. */
export function absMax(channels: Buf[]): Buf {
  const n = channels[0].length;
  const out = new Float64Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]);
      if (a > out[i]) out[i] = a;
    }
  }
  return out;
}

/** Running maximum over the last `w` samples, the current one included. O(n) with a monotonic queue. */
export function runningMax(x: Buf, w: number): Buf {
  const n = x.length;
  const out = new Float64Array(n);
  if (w <= 1) {
    out.set(x);
    return out;
  }
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    while (tail > head && x[q[tail - 1]] <= v) tail--;
    q[tail++] = i;
    if (q[head] <= i - w) head++;
    out[i] = x[q[head]];
  }
  return out;
}

/** Running minimum over samples i to i + span: what a lookahead has to allow for already at sample i. */
export function minAhead(x: Buf, span: number): Buf {
  const n = x.length;
  const out = new Float64Array(n);
  if (span <= 0) {
    out.set(x);
    return out;
  }
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = x[i];
    while (tail > head && x[q[tail - 1]] >= v) tail--;
    q[tail++] = i;
    if (q[head] > i + span) head++;
    out[i] = x[q[head]];
  }
  return out;
}

/** Moving average over the last `len` samples, holding the first value before the start. */
export function boxAverage(x: Buf, len: number): Buf {
  const n = x.length;
  const out = new Float64Array(n);
  if (len <= 1 || n === 0) {
    out.set(x);
    return out;
  }
  const first = x[0];
  let sum = first * len;
  for (let i = 0; i < n; i++) {
    sum += x[i] - (i >= len ? x[i - len] : first);
    out[i] = sum / len;
  }
  return out;
}

/**
 * Zero-phase one-pole smoothing in place: forward, then backward. A gain curve loses its corners (no clicks)
 * without lagging behind the sound. `seconds` is the time constant of each pass.
 */
export function smoothTwoWay(x: Buf, seconds: number, sr: number): Buf {
  const n = x.length;
  if (n === 0 || seconds <= 0) return x;
  const a = onePoleCoef(seconds, sr);
  const b = 1 - a;
  let y = x[0];
  for (let i = 0; i < n; i++) {
    y = a * y + b * x[i];
    x[i] = y;
  }
  y = x[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    y = a * y + b * x[i];
    x[i] = y;
  }
  return x;
}

/** Moves a curve `ahead` samples earlier, holding its last value: a lookahead without latency. */
export function advance(x: Buf, ahead: number): Buf {
  const n = x.length;
  if (ahead <= 0 || n === 0) return x;
  const k = Math.min(ahead, n);
  x.copyWithin(0, k);
  x.fill(x[n - 1 - k] ?? x[n - 1], n - k);
  return x;
}

/**
 * The static compressor curve: dB of gain reduction (0 or more) for an input level in dB, with a soft knee `knee`
 * dB wide centred on the threshold.
 */
export function compressionDb(levelDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
  const over = levelDb - thresholdDb;
  const slope = 1 - 1 / ratio;
  if (kneeDb > 0) {
    if (2 * over <= -kneeDb) return 0;
    if (2 * over < kneeDb) {
      const d = over + kneeDb / 2;
      return (slope * d * d) / (2 * kneeDb);
    }
    return slope * over;
  }
  return over > 0 ? slope * over : 0;
}

/** The largest value of a curve (0 for an empty one). */
export function maxOf(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
  return m;
}

/**
 * A curve with the last `pre` samples of itself in front: for loops, a detector runs over the end first so its
 * state at the start is what it would be if the sound had been going round. Drop the first `pre` outputs.
 */
export function withPreroll(x: Buf, pre: number): Buf {
  if (pre <= 0) return x;
  const n = x.length;
  const k = Math.min(pre, n);
  const out = new Float64Array(n + k);
  out.set(x.subarray(n - k), 0);
  out.set(x, k);
  return out;
}

/** Sum of squares over every channel: for matching levels. */
export function energy(channels: Buf[]): number {
  let s = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
  return s;
}
