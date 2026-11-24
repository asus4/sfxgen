import { Svf } from './filters';
import type { Buf } from './math';

/**
 * Runs a sample-by-sample nonlinearity at `factor` times the rate, so the harmonics it creates above the original
 * Nyquist are filtered out instead of folding back as aliasing.
 */
export function oversampled(x: Buf, sr: number, factor: number, fn: (v: number, i: number) => number): Buf {
  if (factor <= 1) {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = fn(x[i], i);
    return out;
  }
  const hi = sr * factor;
  const cutoff = sr * 0.45;
  const up1 = new Svf('lowpass', hi);
  const up2 = new Svf('lowpass', hi);
  const dn1 = new Svf('lowpass', hi);
  const dn2 = new Svf('lowpass', hi);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    for (let k = 0; k < factor; k++) {
      // Zero-stuffing, with the gain made up so the interpolated signal keeps its level.
      const s = k === 0 ? x[i] * factor : 0;
      const interp = up2.tick(up1.tick(s, cutoff, 0.5412), cutoff, 1.3066);
      const shaped = fn(interp, i);
      const y = dn2.tick(dn1.tick(shaped, cutoff, 0.5412), cutoff, 1.3066);
      if (k === 0) out[i] = y;
    }
  }
  return out;
}
