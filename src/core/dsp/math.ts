/** Small numeric helpers shared by the DSP code. Buffers are Float64Array throughout; output is Float32. */

export const TAU = Math.PI * 2;

export type Buf = Float64Array;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function dbToGain(db: number): number {
  return db <= -200 ? 0 : Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 1e-10 ? -200 : 20 * Math.log10(gain);
}

export function smoothstep(x: number): number {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function semitonesToRatio(st: number): number {
  return Math.pow(2, st / 12);
}

/** Seconds to whole samples. */
export function samples(seconds: number, sr: number): number {
  return Math.max(0, Math.round(seconds * sr));
}

export function peak(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rms(x: ArrayLike<number>): number {
  if (x.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Adds `src * gain` into `dst` starting at sample `at`, cutting whatever runs past the end. */
export function mixInto(dst: Buf, src: ArrayLike<number>, at = 0, gain = 1): void {
  const start = Math.max(0, at);
  const skip = start - at;
  const n = Math.min(dst.length - start, src.length - skip);
  for (let i = 0; i < n; i++) dst[start + i] += gain * src[skip + i];
}

export function scale(x: Buf, gain: number): Buf {
  for (let i = 0; i < x.length; i++) x[i] *= gain;
  return x;
}

/** Soft saturation normalised so `drive` changes the colour, not the peak level. */
export function softClip(x: number, drive: number): number {
  if (drive <= 1e-6) return x;
  return Math.tanh(x * drive) / Math.tanh(drive);
}

/** Shapes a 0..1 position along a segment. `bend` from -1 (fast first) to 1 (slow first); 0 is linear. */
export function bendPosition(x: number, bend: number): number {
  if (bend === 0) return x;
  const e = Math.pow(2, 3 * clamp(bend, -1, 1));
  return Math.pow(clamp(x, 0, 1), e);
}

export function allFinite(x: ArrayLike<number>): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

/** Linear-interpolated read at a fractional sample position (0 outside). */
export function readLinear(x: ArrayLike<number>, pos: number): number {
  const i = Math.floor(pos);
  if (i < 0 || i >= x.length) return 0;
  const f = pos - i;
  const a = x[i];
  const b = i + 1 < x.length ? x[i + 1] : 0;
  return a + (b - a) * f;
}

/** Cubic (Catmull-Rom / Hermite) read at a fractional sample position (0 outside). */
export function readCubic(x: ArrayLike<number>, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const at = (k: number) => (k >= 0 && k < x.length ? x[k] : 0);
  const xm1 = at(i - 1);
  const x0 = at(i);
  const x1 = at(i + 1);
  const x2 = at(i + 2);
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}
