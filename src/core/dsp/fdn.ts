/**
 * The reverb engine: a feedforward multichannel diffuser feeding a 16-line feedback delay network.
 *
 * - The diffuser (8 channels, a few steps of random delays, an 8-point Hadamard mix and polarity flips) turns each
 *   input sample into hundreds of echoes within a few tens of milliseconds without any feedback, so it adds density
 *   without colour.
 * - The FDN's 16 lines are mutually prime, spread over a 1:3 range around the space's mean free path, mixed by a
 *   16-point Hadamard (every line feeds every other equally, the fastest-building orthogonal mix).
 * - Each line carries a low shelf and a high shelf whose gains are set from the line's length, so the decay time is
 *   `t60` at 700 Hz, `t60 * bassRatio` in the lows and `t60 * highRatio` in the highs.
 * - Half the lines are slowly modulated (a fraction of a millisecond, allpass-interpolated so no highs are lost) so
 *   the modes drift instead of ringing.
 * - An onset tap of the diffuser's own output gives a dense start before the loop's first pass.
 * - Early reflections come from image sources of a box (or a flutter axis, or scattered points), panned by angle,
 *   with the delay between the ears in stereo.
 *
 * Measured at 48 kHz: RT60 within a few percent of `t60` in the mids, a normalised echo density
 * near 1 within 20 to 130 ms, and spectral peaks that do not persist from one tail segment to the next.
 */
import { Rng } from './rng';
import { pow2Above } from './fracdelay';
import type { Buf } from './math';

const LINES = 16;
const CH = 8;
/** Weights of the diffuser steps in the onset tap (unit energy in total). */
const ONSET_WEIGHTS = [0.42, 0.52, 0.74];

export interface LateSettings {
  sr: number;
  /** Mean length of the loop lines, seconds. */
  meanDelay: number;
  /** Longest line over the shortest. */
  spread: number;
  /** Mid-band decay time (60 dB), seconds. */
  t60: number;
  bassRatio: number;
  highRatio: number;
  /** Crossovers of the low and high shelves, Hz. */
  crossLow: number;
  crossHigh: number;
  /** Peak modulation of the moving lines, seconds. */
  modDepth: number;
  /** Mean modulation rate, Hz. */
  modRate: number;
  /** Total length of the diffuser, seconds. */
  diffusionTime: number;
  /** 0 feeds the network with the bare input (discrete echoes), 1 with the fully diffused input. */
  diffusion: number;
  /** Level of the diffuser's own output, heard before the loop's first pass: a dense, immediate onset. */
  earlyDiffuse: number;
  /** Fixed seed for line lengths and diffuser delays: the same space always sounds the same. */
  seed: number;
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}

/** The nearest prime at or above `n` that is not taken yet. */
function freshPrime(n: number, taken: Set<number>): number {
  let k = Math.max(2, Math.round(n));
  while (!isPrime(k) || taken.has(k)) k++;
  taken.add(k);
  return k;
}

/** Sign of entry (r, c) of the Sylvester Hadamard matrix. */
function hadamardSign(r: number, c: number): number {
  let x = r & c;
  let bits = 0;
  while (x) {
    bits ^= x & 1;
    x >>= 1;
  }
  return bits ? -1 : 1;
}

export interface LateDesign {
  delays: Int32Array;
  /** Lines that move, and their depth (samples), rate (rad/sample) and phase. */
  modDepth: Float64Array;
  modOmega: Float64Array;
  modPhase: Float64Array;
  gMid: Float64Array;
  gHigh: Float64Array;
  bassMul: Float64Array;
  cHigh: number;
  cLow: number;
  /** Diffuser delays [step][channel] in samples, and polarity flips. */
  diffDelays: Int32Array[];
  diffFlips: Float64Array[];
  inSign: Float64Array;
  injSign: Float64Array;
  tapL: Float64Array;
  tapR: Float64Array;
  diffusion: number;
  earlyDiffuse: number;
  /** Diffuser output taps for the immediate onset. */
  dTapL: Float64Array;
  dTapR: Float64Array;
  /** Seconds, mean loop delay actually used. */
  meanDelay: number;
}

export function designLate(s: LateSettings): LateDesign {
  const rng = new Rng(s.seed);
  const sr = s.sr;
  // Line lengths: log-spaced bands around the mean, a random point in each band, then mutually prime.
  const lo = s.meanDelay / Math.sqrt(s.spread);
  const ratio = s.spread;
  const taken = new Set<number>();
  const lengths: number[] = [];
  for (let k = 0; k < LINES; k++) {
    const x = (k + 0.25 + 0.5 * rng.next()) / LINES;
    lengths.push(freshPrime(Math.max(lo * Math.pow(ratio, x) * sr, 7), taken));
  }
  // Shuffle so neighbouring lines (which share diffuser channels) don't also share lengths.
  for (let k = LINES - 1; k > 0; k--) {
    const j = Math.floor(rng.next() * (k + 1));
    [lengths[k], lengths[j]] = [lengths[j], lengths[k]];
  }
  const delays = Int32Array.from(lengths);
  const modDepth = new Float64Array(LINES);
  const modOmega = new Float64Array(LINES);
  const modPhase = new Float64Array(LINES);
  for (let k = 0; k < LINES; k++) {
    if (k % 2 === 1 && s.modDepth > 0) {
      modDepth[k] = Math.min(s.modDepth * sr * (0.7 + 0.6 * rng.next()), delays[k] * 0.25);
      modOmega[k] = (2 * Math.PI * s.modRate * (0.55 + 0.9 * rng.next())) / sr;
      modPhase[k] = rng.next() * 2 * Math.PI;
    } else rng.next();
  }
  const gMid = new Float64Array(LINES);
  const gHigh = new Float64Array(LINES);
  const bassMul = new Float64Array(LINES);
  const g = (len: number, t60: number) => Math.pow(10, (-3 * len) / (sr * Math.max(t60, 1e-3)));
  const cHigh = 1 - Math.exp((-2 * Math.PI * Math.min(s.crossHigh, sr * 0.45)) / sr);
  const cLow = 1 - Math.exp((-2 * Math.PI * Math.min(s.crossLow, sr * 0.45)) / sr);
  // The shelves reach into the mids, so each line's gains are scaled to give exactly `t60` at 700 Hz.
  const wm = (2 * Math.PI * 700) / sr;
  const lp = (c: number): [number, number] => {
    // c / (1 - (1 - c) e^{-jw})
    const re = 1 - (1 - c) * Math.cos(wm);
    const im = (1 - c) * Math.sin(wm);
    const d = re * re + im * im;
    return [(c * re) / d, (-c * im) / d];
  };
  const [hr, hi] = lp(cHigh);
  const [lr, li] = lp(cLow);
  let sum = 0;
  for (let k = 0; k < LINES; k++) {
    const len = delays[k];
    sum += len;
    const target = g(len, s.t60);
    let gm = target;
    let gh = g(len, s.t60 * s.highRatio);
    const bm = g(len, s.t60 * s.bassRatio) / gm - 1;
    const aRe = gh + (gm - gh) * hr;
    const aIm = (gm - gh) * hi;
    const bRe = 1 + bm * lr;
    const bIm = bm * li;
    const mag = Math.hypot(aRe * bRe - aIm * bIm, aRe * bIm + aIm * bRe);
    let kappa = target / mag;
    const bound = Math.max(gm, gh) * Math.max(1, 1 + bm);
    kappa = Math.min(kappa, 0.99999 / bound);
    gm *= kappa;
    gh *= kappa;
    gMid[k] = gm;
    gHigh[k] = gh;
    bassMul[k] = bm;
  }
  const steps = 3;
  const diffDelays: Int32Array[] = [];
  const diffFlips: Float64Array[] = [];
  for (let st = 0; st < steps; st++) {
    const span = (s.diffusionTime * Math.pow(2, st)) / (Math.pow(2, steps) - 1);
    const order = Array.from({ length: CH }, (_, c) => c);
    for (let c = CH - 1; c > 0; c--) {
      const j = Math.floor(rng.next() * (c + 1));
      [order[c], order[j]] = [order[j], order[c]];
    }
    const d = new Int32Array(CH);
    const f = new Float64Array(CH);
    for (let c = 0; c < CH; c++) {
      // Stratified over the span; the shortest channel of each step has no delay, so there is a direct path.
      const u = order[c] === 0 ? 0 : rng.next();
      d[c] = Math.max(0, Math.round(((order[c] + u) / CH) * span * sr));
      f[c] = rng.next() < 0.5 ? -1 : 1;
    }
    diffDelays.push(d);
    diffFlips.push(f);
  }
  const inSign = new Float64Array(CH);
  for (let c = 0; c < CH; c++) inSign[c] = hadamardSign(5, c);
  const injSign = new Float64Array(LINES);
  const tapL = new Float64Array(LINES);
  const tapR = new Float64Array(LINES);
  for (let k = 0; k < LINES; k++) {
    injSign[k] = hadamardSign(9, k) * Math.SQRT1_2;
    tapL[k] = hadamardSign(6, k) / 4;
    tapR[k] = hadamardSign(11, k) / 4;
  }
  const dTapL = new Float64Array(CH);
  const dTapR = new Float64Array(CH);
  for (let c = 0; c < CH; c++) {
    dTapL[c] = (hadamardSign(3, c) * s.earlyDiffuse) / Math.sqrt(CH);
    dTapR[c] = (hadamardSign(6, c) * s.earlyDiffuse) / Math.sqrt(CH);
  }
  return {
    delays,
    modDepth,
    modOmega,
    modPhase,
    gMid,
    gHigh,
    bassMul,
    cHigh,
    cLow,
    diffDelays,
    diffFlips,
    inSign,
    injSign,
    tapL,
    tapR,
    diffusion: Math.min(Math.max(s.diffusion, 0), 1),
    earlyDiffuse: s.earlyDiffuse,
    dTapL,
    dTapR,
    meanDelay: sum / LINES / sr,
  };
}

/**
 * Walsh-Hadamard butterflies across `count` blocks of `len` samples that sit `stride` apart in `buf`: the same
 * orthogonal mix as a per-sample transform, done as tight loops over each pair of blocks.
 */
function hadamardBlocks(buf: Float64Array, count: number, stride: number, len: number): void {
  for (let h = 1; h < count; h <<= 1) {
    for (let a = 0; a < count; a += h << 1) {
      for (let j = a; j < a + h; j++) {
        const p = j * stride;
        const q = (j + h) * stride;
        for (let i = 0; i < len; i++) {
          const x = buf[p + i];
          const y = buf[q + i];
          buf[p + i] = x + y;
          buf[q + i] = x - y;
        }
      }
    }
  }
}

/**
 * Renders the late reverb of `inL` (and `inR` for a stereo input) over `n` samples. Returns one channel, or two
 * decorrelated ones when `stereoOut`. Stops computing once the input has ended and the tail is below -200 dB.
 *
 * It runs in blocks shorter than the shortest line, so every read in a block was written in an earlier block and
 * each stage can sweep a whole block of one line at a time.
 */
export function renderLate(inL: Buf, inR: Buf | null, n: number, d: LateDesign, stereoOut: boolean): Buf[] {
  const outL = new Float64Array(n);
  const outR = stereoOut ? new Float64Array(n) : outL;
  // Diffuser rings: one region per step and channel, a shared power-of-two size.
  const steps = d.diffDelays.length;
  let maxDiff = 1;
  for (const st of d.diffDelays) for (let c = 0; c < CH; c++) maxDiff = Math.max(maxDiff, st[c] + 1);
  // Loop lines.
  let maxLine = 1;
  let minRead = Infinity;
  for (let k = 0; k < LINES; k++) {
    maxLine = Math.max(maxLine, d.delays[k] + Math.ceil(d.modDepth[k]) + 4);
    minRead = Math.min(minRead, d.delays[k] - Math.ceil(d.modDepth[k]) - 2);
  }
  const B = Math.max(1, Math.min(256, minRead - 1));
  const dSize = pow2Above(maxDiff + B + 1);
  const dMask = dSize - 1;
  const dBuf = new Float64Array(dSize * CH * steps);
  const lSize = pow2Above(maxLine + B);
  const lMask = lSize - 1;
  const lBuf = new Float64Array(lSize * LINES);

  // Block work areas: CH channel blocks, LINES line blocks.
  const u = new Float64Array(CH * B);
  const r = new Float64Array(LINES * B);
  const ol = new Float64Array(B);
  const or = new Float64Array(B);

  const lpH = new Float64Array(LINES);
  const lpL = new Float64Array(LINES);
  const dCur = new Float64Array(LINES);
  const apY = new Float64Array(LINES);
  for (let k = 0; k < LINES; k++) dCur[k] = d.delays[k] + d.modDepth[k] * Math.sin(d.modPhase[k]);
  const { gMid, gHigh, bassMul, cHigh, cLow, tapL, tapR, injSign, inSign, delays, dTapL, dTapR, earlyDiffuse } = d;
  const cosD = Math.cos((d.diffusion * Math.PI) / 2);
  const sinD = Math.sin((d.diffusion * Math.PI) / 2);
  const stereoIn = inR !== null;
  const inScale = stereoIn ? 0.5 : 0.35355339059327373;
  const s8 = 0.35355339059327373;

  // Where the input ends, for the early stop.
  let lastIn = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (inL[i] !== 0 || (inR && inR[i] !== 0)) {
      lastIn = i;
      break;
    }
  }
  if (lastIn < 0) return stereoOut ? [outL, outR] : [outL];
  const settle = lastIn + maxDiff * 2 + maxLine;
  let peakSoFar = 0;
  let quiet = 0;

  let w = 0; // shared write index of every ring
  for (let i0 = 0; i0 < n; i0 += B) {
    const len = Math.min(B, n - i0);
    // The first diffusion step reads its delayed taps straight from the input (it is all there, offline).
    ol.fill(0, 0, len);
    or.fill(0, 0, len);
    for (let c = 0; c < CH; c++) {
      const src = (c & 1) === 1 && stereoIn ? inR! : inL;
      const g = inSign[c] * inScale * d.diffFlips[0][c] * s8;
      const dl = d.diffDelays[0][c];
      const o = c * B;
      for (let j = 0; j < len; j++) {
        const i = i0 + j - dl;
        u[o + j] = i >= 0 && i <= lastIn ? src[i] * g : 0;
      }
    }
    for (let st = 0; st < steps; st++) {
      if (st > 0) {
        for (let c = 0; c < CH; c++) {
          const region = (st * CH + c) * dSize;
          const o = c * B;
          const dl = d.diffDelays[st][c];
          const fl = d.diffFlips[st][c] * s8;
          // Write then read in one sweep: a delay shorter than the block reads what this sweep just wrote.
          for (let j = 0; j < len; j++) {
            const wi = w + j;
            dBuf[region + (wi & dMask)] = u[o + j];
            u[o + j] = dBuf[region + ((wi - dl) & dMask)] * fl;
          }
        }
      }
      hadamardBlocks(u, CH, B, len);
      if (earlyDiffuse > 0) {
        // The onset taps every step, earlier steps lighter: dense from the first milliseconds, then smoother.
        const ws = ONSET_WEIGHTS[st];
        for (let c = 0; c < CH; c++) {
          const gl = ws * dTapL[c];
          const gr = ws * dTapR[c];
          const o = c * B;
          if (stereoOut) {
            for (let j = 0; j < len; j++) {
              ol[j] += gl * u[o + j];
              or[j] += gr * u[o + j];
            }
          } else for (let j = 0; j < len; j++) ol[j] += gl * u[o + j];
        }
      }
    }
    // Read each loop line for the block into its slot of `r`.
    for (let k = 0; k < LINES; k++) {
      const region = k * lSize;
      const o = k * B;
      if (d.modDepth[k] > 0) {
        // First-order allpass interpolation (flat magnitude, so the moving lines lose no highs): an integer delay
        // and an allpass delay of 0.5 to 1.5 samples, the delay gliding linearly to its target at the block's end.
        const target = delays[k] + d.modDepth[k] * Math.sin(d.modPhase[k] + d.modOmega[k] * (i0 + len));
        const step = (target - dCur[k]) / len;
        let dp = dCur[k];
        let y = apY[k];
        for (let j = 0; j < len; j++) {
          dp += step;
          const di = Math.floor(dp - 0.5);
          const frac = dp - di;
          const a = (1 - frac) / (1 + frac);
          const pos = w + j - di;
          y = a * (lBuf[region + (pos & lMask)] - y) + lBuf[region + ((pos - 1) & lMask)];
          r[o + j] = y;
        }
        dCur[k] = dp;
        apY[k] = y;
      } else {
        const dl = delays[k];
        for (let j = 0; j < len; j++) r[o + j] = lBuf[region + ((w + j - dl) & lMask)];
      }
    }
    // Damping shelves and output taps, a pair of lines at a time, ending with the Hadamard's first butterfly.
    for (let k = 0; k < LINES; k += 2) {
      const oa = k * B;
      const ob = oa + B;
      let ha = lpH[k];
      let la = lpL[k];
      let hb = lpH[k + 1];
      let lb = lpL[k + 1];
      const gha = gHigh[k];
      const dga = gMid[k] - gha;
      const bma = bassMul[k];
      const ghb = gHigh[k + 1];
      const dgb = gMid[k + 1] - ghb;
      const bmb = bassMul[k + 1];
      const tla = tapL[k];
      const tlb = tapL[k + 1];
      const tra = tapR[k];
      const trb = tapR[k + 1];
      for (let j = 0; j < len; j++) {
        let xa = r[oa + j];
        ha += cHigh * (xa - ha);
        xa = gha * xa + dga * ha;
        la += cLow * (xa - la);
        xa += bma * la;
        let xb = r[ob + j];
        hb += cHigh * (xb - hb);
        xb = ghb * xb + dgb * hb;
        lb += cLow * (xb - lb);
        xb += bmb * lb;
        ol[j] += tla * xa + tlb * xb;
        or[j] += tra * xa + trb * xb;
        r[oa + j] = xa + xb;
        r[ob + j] = xa - xb;
      }
      lpH[k] = ha;
      lpL[k] = la;
      lpH[k + 1] = hb;
      lpL[k + 1] = lb;
    }
    let blockPeak = 0;
    for (let j = 0; j < len; j++) {
      outL[i0 + j] = ol[j];
      if (stereoOut) outR[i0 + j] = or[j];
      const ay = Math.abs(ol[j]) + Math.abs(or[j]);
      if (ay > blockPeak) blockPeak = ay;
    }
    // The rest of the 16-point Hadamard (orthonormal with the 1/4): its middle stages here, the last one while
    // writing, with the diffused input injected.
    for (let h = 2; h < 8; h <<= 1) {
      for (let a = 0; a < LINES; a += h << 1) {
        for (let jj = a; jj < a + h; jj++) {
          const p = jj * B;
          const q = (jj + h) * B;
          for (let j = 0; j < len; j++) {
            const x = r[p + j];
            const y = r[q + j];
            r[p + j] = x + y;
            r[q + j] = x - y;
          }
        }
      }
    }
    for (let k = 0; k < 8; k++) {
      const ra = k * lSize;
      const rb = (k + 8) * lSize;
      const oa = k * B;
      const ob = oa + 8 * B;
      const c = k * B;
      const ga = injSign[k];
      const gb = injSign[k + 8];
      // The bare input for the low-diffusion blend.
      const src = (k & 1) === 1 && stereoIn ? inR! : inL;
      const gRaw = cosD * inSign[k] * inScale;
      for (let j = 0; j < len; j++) {
        const x = r[oa + j];
        const y = r[ob + j];
        const i = i0 + j;
        const inj = (i <= lastIn ? gRaw * src[i] : 0) + sinD * u[c + j];
        const wi = (w + j) & lMask;
        lBuf[ra + wi] = (x + y) * 0.25 + inj * ga;
        lBuf[rb + wi] = (x - y) * 0.25 + inj * gb;
      }
    }
    w += len;
    // Early stop once the tail has died away.
    if (blockPeak > peakSoFar) peakSoFar = blockPeak;
    if (i0 > settle && blockPeak <= peakSoFar * 1e-10) {
      if (++quiet >= 8) break;
    } else quiet = 0;
  }
  return stereoOut ? [outL, outR] : [outL];
}

// ---- Early reflections ---------------------------------------------------------------------------

export interface Tap {
  /** Seconds after the direct sound. */
  t: number;
  gain: number;
  /** -1 left to 1 right. */
  pan: number;
  /** Reflection order: higher orders are filtered darker. */
  order: number;
}

export type EarlyShape =
  | { kind: 'box'; width: number; height: number; absorb: number; jitter?: number }
  | { kind: 'flutter'; width: number; height: number; absorb: number; axis: 'x' | 'z'; count: number }
  | { kind: 'scatter'; count: number; spread: number; absorb: number }
  | { kind: 'none' };

const C = 343;

/**
 * Early reflections of a space `size` metres long. `box` uses image sources of a shoebox room up to the second
 * order; `flutter` adds a train of reflections between two parallel walls; `scatter` places random reflectors
 * (trees, rocks) around the listener.
 */
export function earlyTaps(size: number, shape: EarlyShape, seed: number): Tap[] {
  if (shape.kind === 'none') return [];
  const rng = new Rng(seed);
  const taps: Tap[] = [];
  if (shape.kind === 'scatter') {
    for (let k = 0; k < shape.count; k++) {
      const dist = size * (0.15 + shape.spread * Math.pow(rng.next(), 0.7));
      const az = rng.uniform(-Math.PI, Math.PI);
      const t = (2 * dist) / C;
      taps.push({ t, gain: shape.absorb * (1 + 0.5 * rng.next()) / (1 + dist), pan: Math.sin(az), order: 1 + (k % 2) });
    }
    return taps.sort((a, b) => a.t - b.t);
  }
  const L = size;
  const W = size * shape.width;
  const H = size * shape.height;
  const src = [0.38 * W, 0.68 * L, 0.42 * H];
  const lis = [0.55 * W, 0.3 * L, 0.38 * H];
  const dims = [W, L, H];
  const direct = Math.hypot(src[0] - lis[0], src[1] - lis[1], src[2] - lis[2]);
  const image = (axis: number, nIdx: number) => nIdx * dims[axis] + (nIdx % 2 === 0 ? src[axis] : dims[axis] - src[axis]);
  const add = (nx: number, ny: number, nz: number) => {
    const order = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
    if (order === 0) return;
    const x = image(0, nx) - lis[0];
    const y = image(1, ny) - lis[1];
    const z = image(2, nz) - lis[2];
    const dist = Math.hypot(x, y, z);
    let t = (dist - direct) / C;
    if (shape.kind === 'box' && shape.jitter) t *= 1 + shape.jitter * rng.uniform(-1, 1);
    if (t <= 0) return;
    const gain = (Math.pow(shape.absorb, order) * direct) / dist;
    // Azimuth from the listener facing +y; x is to the right.
    const pan = x / Math.max(Math.hypot(x, y), 1e-6);
    taps.push({ t, gain, pan, order });
  };
  for (let nx = -2; nx <= 2; nx++)
    for (let ny = -2; ny <= 2; ny++)
      for (let nz = -2; nz <= 2; nz++) if (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) <= 2) add(nx, ny, nz);
  if (shape.kind === 'flutter') {
    // Higher orders along one pair of parallel walls: the flutter echo of stairwells and corridors.
    const axis = shape.axis === 'x' ? 0 : 2;
    for (let k = 3; k <= shape.count; k++) {
      for (const sgn of [-1, 1]) {
        const idx = [0, 0, 0];
        idx[axis] = sgn * k;
        add(idx[0], idx[1], idx[2]);
      }
    }
  }
  return taps.sort((a, b) => a.t - b.t);
}

/**
 * Renders taps from a mono input into one or two channels. In stereo each tap reaches the far ear up to 0.66 ms
 * later and quieter (interaural time and level differences), which keeps small rooms from sounding mono. Taps of
 * order ≥ 2 pass a one-pole low-pass at `darkHz`; the set is normalised to unit energy, then scaled by `level`.
 */
export function renderEarly(x: Buf, n: number, taps: Tap[], sr: number, stereoOut: boolean, darkHz: number, level: number): Buf[] {
  const chans = stereoOut ? 2 : 1;
  const bright = Array.from({ length: chans }, () => new Float64Array(n));
  const dark = Array.from({ length: chans }, () => new Float64Array(n));
  let energy = 0;
  for (const t of taps) energy += t.gain * t.gain;
  if (energy <= 0 || level <= 0) return bright;
  const norm = level / Math.sqrt(energy);
  const itd = 0.00033 * sr;
  // Only the input's active span needs mixing in.
  let last = -1;
  for (let i = x.length - 1; i >= 0; i--) {
    if (x[i] !== 0) {
      last = i;
      break;
    }
  }
  if (last < 0) return bright;
  const add = (dst: Buf, at: number, g: number) => {
    if (at >= n || g === 0) return;
    const end = Math.min(n, at + last + 1);
    for (let i = at; i < end; i++) dst[i] += g * x[i - at];
  };
  for (const tap of taps) {
    const at = tap.t * sr;
    const g = tap.gain * norm;
    const dst = tap.order >= 2 ? dark : bright;
    if (stereoOut) {
      const p = Math.max(-1, Math.min(1, tap.pan));
      add(dst[0], Math.round(at + itd * (1 + p)), g * Math.cos(((p + 1) * Math.PI) / 4) * Math.SQRT2);
      add(dst[1], Math.round(at + itd * (1 - p)), g * Math.sin(((p + 1) * Math.PI) / 4) * Math.SQRT2);
    } else add(dst[0], Math.round(at), g);
  }
  const a = Math.exp((-2 * Math.PI * Math.min(darkHz, sr * 0.45)) / sr);
  for (let c = 0; c < chans; c++) {
    const o = bright[c];
    const dk = dark[c];
    let y = 0;
    for (let i = 0; i < n; i++) {
      y = (1 - a) * dk[i] + a * y;
      o[i] += y;
    }
  }
  return bright;
}
