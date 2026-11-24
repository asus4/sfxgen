/**
 * Granular pitch shifting that keeps the duration: four overlapping Hann grains, each reading the input around its
 * own centre at the new speed, so there is no latency. Before a grain starts, its read position is nudged (within a
 * few milliseconds) to where the input best matches what the previous grain is playing, so periodic sounds stay in
 * phase from grain to grain and the overlap does not flutter.
 */
import { cubicAt, cubicAtWrapped } from './fracdelay';
import type { Buf } from './math';

export interface GrainShiftOptions {
  sr: number;
  /** Grain length in samples. */
  grain: number;
  /** Pitch ratio per output sample. */
  ratio: Buf;
  /** Search range for the phase alignment, samples. 0 turns it off. */
  search: number;
  /** Read around the buffer (a loop) instead of hearing silence outside it. */
  wrap?: boolean;
}

const OVERLAP = 4;
const DECIMATE = 4;

/** Normalised correlation of x[a..a+len) with x[b..b+len), read with stride `step` (0 outside the buffer). */
function correlation(x: Buf, a: number, b: number, len: number, step: number): number {
  let xy = 0;
  let yy = 0;
  let xx = 0;
  const n = x.length;
  for (let i = 0; i < len; i += step) {
    const ia = a + i;
    const ib = b + i;
    const va = ia >= 0 && ia < n ? x[ia] : 0;
    const vb = ib >= 0 && ib < n ? x[ib] : 0;
    xy += va * vb;
    yy += vb * vb;
    xx += va * va;
  }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
}

/**
 * Shifts every channel by the same grains (so a stereo image holds). `guide` is the signal the alignment listens to
 * (the mono mix).
 */
export function grainShift(channels: Buf[], guide: Buf, o: GrainShiftOptions): Buf[] {
  const n = guide.length;
  // A multiple of the overlap, so the hop and the grain centre fall on whole samples.
  const H = Math.max(4, Math.round(o.grain / OVERLAP));
  const G = H * OVERLAP;
  // Cumulative read speed: R[t] is where a continuous read head would be at output time t.
  const R = new Float64Array(n + G + 1);
  let acc = 0;
  for (let t = 0; t < R.length; t++) {
    R[t] = acc;
    acc += o.ratio[Math.min(t, n - 1)];
  }
  const Rat = (t: number) => (t <= 0 ? t * o.ratio[0] : t >= R.length ? R[R.length - 1] + (t - R.length + 1) * o.ratio[n - 1] : R[t]);
  // A low-passed, decimated copy of the guide for the coarse alignment search.
  const coarse = new Float64Array(Math.ceil(n / DECIMATE));
  for (let i = 0; i < coarse.length; i++) {
    let s = 0;
    for (let k = 0; k < DECIMATE; k++) s += guide[Math.min(i * DECIMATE + k, n - 1)];
    coarse[i] = s / DECIMATE;
  }
  const window = new Float64Array(G);
  for (let u = 0; u < G; u++) window[u] = 0.5 - 0.5 * Math.cos((2 * Math.PI * u) / G);
  const outs = channels.map(() => new Float64Array(n));
  const S = Math.max(0, Math.round(o.search));
  let prevDelta = 0;
  let prevCentre = -Infinity;
  // Grains start every hop, the first ones before the buffer so the start is covered by a full overlap.
  for (let start = -G + H; start < n; start += H) {
    const centre = start + G / 2;
    let delta = 0;
    if (S > 0 && Number.isFinite(prevCentre)) {
      // The new grain reads x[q + lag] while the previous one reads x[q]; find the lag near `lag0` that matches best.
      const lag0 = centre - prevCentre - (Rat(centre) - Rat(prevCentre)) - prevDelta;
      const q0 = Math.round(prevCentre + prevDelta + (Rat(start + H) - Rat(prevCentre)));
      const len = 2 * H;
      // Coarse search on the decimated guide, then refine around the best lag at full rate.
      let best = -Infinity;
      let bestShift = 0;
      const cq = Math.round(q0 / DECIMATE);
      const cl = Math.round(len / DECIMATE);
      const cs = Math.ceil(S / DECIMATE);
      const clag0 = Math.round(lag0 / DECIMATE);
      for (let s = -cs; s <= cs; s++) {
        const c = correlation(coarse, cq, cq + clag0 + s, cl, 1);
        if (c > best) {
          best = c;
          bestShift = s * DECIMATE;
        }
      }
      let fine = bestShift;
      if (best > 0) {
        let bestFine = -Infinity;
        for (let s = bestShift - DECIMATE; s <= bestShift + DECIMATE; s++) {
          const c = correlation(guide, q0, q0 + Math.round(lag0) + s, len, 1);
          if (c > bestFine) {
            bestFine = c;
            fine = s;
          }
        }
        // The best lag is lag0 + delta: delta is where this grain sits relative to its natural position.
        delta = Math.max(-S, Math.min(S, fine + Math.round(lag0) - lag0));
      }
    }
    const base = centre + delta - Rat(centre);
    const u0 = Math.max(0, -start);
    const u1 = Math.min(G, n - start);
    const read = o.wrap ? cubicAtWrapped : cubicAt;
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c];
      const out = outs[c];
      for (let u = u0; u < u1; u++) {
        const t = start + u;
        out[t] += window[u] * read(x, base + R[t]);
      }
    }
    prevDelta = delta;
    prevCentre = centre;
  }
  // Four Hann windows a quarter apart sum to 2.
  for (const out of outs) for (let i = 0; i < n; i++) out[i] *= 0.5;
  return outs;
}
