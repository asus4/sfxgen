/**
 * Loudness per ITU-R BS.1770-4 (LUFS): K-weighting, 400 ms blocks with 75% overlap, absolute and relative gates.
 * Sounds shorter than one block are measured as a single block, which is what a listener hears anyway.
 */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// The two K-weighting stages in the form BS.1770 derives them from (as libebur128 does), so they reproduce the
// standard's published 48 kHz coefficients exactly and adapt to other sample rates. The high-pass keeps the
// standard's unnormalised [1, -2, 1] numerator: the -0.691 offset is calibrated against it.
function highShelf(sr: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

function highPass(sr: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sr);
  const a0 = 1 + K / Q + K * K;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
}

function runBiquad(x: ArrayLike<number>, c: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

export function kWeighted(x: ArrayLike<number>, sr: number): Float64Array {
  return runBiquad(runBiquad(x, highShelf(sr)), highPass(sr));
}

export interface Loudness {
  /** Integrated loudness, LUFS (-Infinity for silence). */
  integrated: number;
  /** Loudest 400 ms window, LUFS. */
  momentaryMax: number;
}

/** BS.1770 loudness of 1 or 2 channels. */
export function loudness(channels: ArrayLike<number>[], sr: number): Loudness {
  const weighted = channels.map((ch) => kWeighted(ch, sr));
  const n = weighted[0]?.length ?? 0;
  const block = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  const powers: number[] = [];
  const blockPower = (start: number, len: number) => {
    let total = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = start; i < start + len; i++) s += ch[i] * ch[i];
      total += s / len;
    }
    return total;
  };
  if (n === 0) return { integrated: -Infinity, momentaryMax: -Infinity };
  if (n < block) powers.push(blockPower(0, n));
  else for (let s = 0; s + block <= n; s += hop) powers.push(blockPower(s, block));
  const toLufs = (p: number) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
  const momentaryMax = powers.reduce((m, p) => Math.max(m, toLufs(p)), -Infinity);
  const absGated = powers.filter((p) => toLufs(p) > -70);
  if (absGated.length === 0) return { integrated: -Infinity, momentaryMax };
  const meanAbs = absGated.reduce((a, b) => a + b, 0) / absGated.length;
  const relThreshold = toLufs(meanAbs) - 10;
  const relGated = absGated.filter((p) => toLufs(p) > relThreshold);
  const mean = relGated.reduce((a, b) => a + b, 0) / Math.max(relGated.length, 1);
  return { integrated: toLufs(mean), momentaryMax };
}
