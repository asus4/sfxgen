/**
 * 2x oversampling helpers for sources that synthesise at twice the rate: linear upsampling of control curves and a
 * half-band decimator (Kaiser-windowed sinc, about 85 dB down from 0.55 of the output rate), zero phase.
 */
import type { Buf } from './math';

const HALF_TAPS = 47;
let taps: { centre: number; odd: Float64Array } | null = null;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** The centre tap and the odd-indexed taps h[1], h[3], ... (a half-band filter's even taps are zero). */
function halfbandTaps(): { centre: number; odd: Float64Array } {
  if (taps) return taps;
  const beta = 8;
  const odd = new Float64Array((HALF_TAPS + 1) / 2);
  const norm = besselI0(beta);
  let sum = 0.5;
  for (let j = 0; j < odd.length; j++) {
    const k = 2 * j + 1;
    const w = besselI0(beta * Math.sqrt(1 - (k / (HALF_TAPS + 1)) ** 2)) / norm;
    odd[j] = ((0.5 * Math.sin((Math.PI * k) / 2)) / ((Math.PI * k) / 2)) * w;
    sum += 2 * odd[j];
  }
  // Unity gain at 0 Hz.
  for (let j = 0; j < odd.length; j++) odd[j] /= sum;
  taps = { centre: 0.5 / sum, odd };
  return taps;
}

/** A curve at twice the rate, linearly interpolated (the last value is held). */
export function upsampleCurve(x: Buf): Buf {
  const n = x.length;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const a = x[i];
    const b = i + 1 < n ? x[i + 1] : a;
    out[2 * i] = a;
    out[2 * i + 1] = 0.5 * (a + b);
  }
  return out;
}

/** Low-passes a signal at twice the rate below the output Nyquist and keeps every other sample. */
export function decimate2(x: Buf): Buf {
  const { centre, odd } = halfbandTaps();
  const n = Math.floor(x.length / 2);
  const out = new Float64Array(n);
  const len = x.length;
  for (let i = 0; i < n; i++) {
    const c = 2 * i;
    let y = centre * x[c];
    for (let j = 0; j < odd.length; j++) {
      const k = 2 * j + 1;
      const a = c - k >= 0 ? x[c - k] : 0;
      const b = c + k < len ? x[c + k] : 0;
      y += odd[j] * (a + b);
    }
    out[i] = y;
  }
  return out;
}
