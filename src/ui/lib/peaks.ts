/** Waveform peaks: min and max per column, on the patch's timeline, and blending between two sets. */

export interface Peaks {
  /** Interleaved [min0, max0, min1, max1, ...]. */
  data: Float32Array;
  bins: number;
}

/** Peaks of a buffer that starts `start` seconds into a timeline `duration` seconds long. */
export function computePeaks(buffer: Float32Array, sampleRate: number, start: number, duration: number, bins: number): Peaks {
  const data = new Float32Array(bins * 2);
  const total = Math.max(1, duration * sampleRate);
  const offset = Math.round(start * sampleRate);
  const n = buffer.length;
  for (let b = 0; b < bins; b++) {
    const i0 = Math.floor((b / bins) * total) - offset;
    const i1 = Math.floor(((b + 1) / bins) * total) - offset;
    const from = Math.max(0, i0);
    const to = Math.min(n, Math.max(i1, i0 + 1));
    if (to <= from) continue;
    let lo = Infinity;
    let hi = -Infinity;
    // Long buffers: stride so a column never costs more than a few hundred reads.
    const stride = Math.max(1, Math.floor((to - from) / 256));
    for (let i = from; i < to; i += stride) {
      const v = buffer[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    data[b * 2] = lo;
    data[b * 2 + 1] = hi;
  }
  return { data, bins };
}

/** `a` moved a fraction `t` of the way to `b`. A missing or differently sized `a` snaps. */
export function lerpPeaks(a: Peaks | undefined, b: Peaks, t: number): Peaks {
  if (!a || a.bins !== b.bins || t >= 1) return b;
  const data = new Float32Array(b.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.data[i] + (b.data[i] - a.data[i]) * t;
  return { data, bins: b.bins };
}
