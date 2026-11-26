/**
 * analyze(): the numbers an agent reads instead of listening. Everything is measured from the samples alone, so a
 * WAV from anywhere is measured the same way as a render. See ./index.ts for what each field means.
 */
import type { Analysis, BandEnergy, SpectralPeak } from './index';
import { loudness } from './loudness';
import { fft, nextPow2 } from '../dsp/fft';

/** Every level in dB is floored here, so silence reads as a number (JSON has no -Infinity). */
export const FLOOR_DB = -120;
/** At or above this a sample is at full scale (16-bit's largest positive sample, 32767/32768, counts). */
const FULL_SCALE = 0.9999;

export const BANDS: readonly { band: string; lo: number; hi: number }[] = [
  { band: 'sub <60', lo: 0, hi: 60 },
  { band: 'low 60-250', lo: 60, hi: 250 },
  { band: 'low-mid 250-800', lo: 250, hi: 800 },
  { band: 'mid 800-2.5k', lo: 800, hi: 2500 },
  { band: 'high-mid 2.5k-6k', lo: 2500, hi: 6000 },
  { band: 'high 6k-12k', lo: 6000, hi: 12000 },
  { band: 'air >12k', lo: 12000, hi: Infinity },
];

const ampDb = (a: number): number => (a > 1e-6 ? Math.max(FLOOR_DB, 20 * Math.log10(a)) : FLOOR_DB);
const powDb = (p: number): number => (p > 1e-12 ? Math.max(FLOOR_DB, 10 * Math.log10(p)) : FLOOR_DB);
const round = (x: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(x * k) / k || 0; // `|| 0` turns -0 into 0
};
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Math.max over a long array (spreading one overflows the stack on long files). */
function maxOf(x: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
  return m;
}

// ---- Envelope ------------------------------------------------------------------------------------

interface Envelope {
  /** Samples per frame (0.25 ms). */
  hop: number;
  /** Mean square of each frame (loudest channel). */
  energy: Float64Array;
  /** The longest half cycle within 10 ms of each frame, samples: what a tone there needs to show its amplitude. */
  halfCycle: Float64Array;
  /** Peak amplitude per frame. */
  env: Float64Array;
  max: number;
}

/** Max of x over [i - back, i + ahead] for every i. */
function slidingMax(x: Float64Array, back: number, ahead: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.max(0, i - back);
    const b = Math.min(n - 1, i + ahead);
    for (let k = a; k <= b; k++) if (x[k] > m) m = x[k];
    out[i] = m;
  }
  return out;
}

/**
 * The peak of every 0.25 ms frame (loudest channel), then the smaller of a look-ahead and a look-back maximum. On a
 * rise the look-back max is the level now, on a fall the look-ahead max is, so neither is shifted. Each window is
 * as long as the longest half cycle nearby (1 to 10 ms, from the zero crossings of `zc`): long enough that a tone
 * reads its amplitude at any pitch above ~45 Hz without ripple, short enough that a steep decay isn't held up
 * before the next hit. Its maximum is the sample peak.
 */
function envelope(chs: ArrayLike<number>[], n: number, sr: number, zc: ArrayLike<number>): Envelope {
  const hop = Math.max(1, Math.round(sr / 4000));
  const nf = Math.max(1, Math.ceil(n / hop));
  const framePeak = new Float64Array(nf);
  const energy = new Float64Array(nf);
  for (const ch of chs) {
    for (let f = 0; f < nf; f++) {
      const a = f * hop;
      const b = Math.min(n, a + hop);
      let m = framePeak[f];
      let e = 0;
      for (let i = a; i < b; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > m) m = v;
        e += v * v;
      }
      framePeak[f] = m;
      e /= Math.max(1, b - a);
      if (e > energy[f]) energy[f] = e;
    }
  }
  // Longest half cycle overlapping each frame, then the longest within 10 ms either side.
  const maxK = Math.max(1, Math.round((0.01 * sr) / hop));
  const minK = Math.max(1, Math.round((0.001 * sr) / hop));
  const halfCycle = new Float64Array(nf);
  let last = 0;
  let loudest = 0;
  // Digital silence has no zero crossings; it is not a long half cycle.
  const quiet = 1e-5 * maxOf(framePeak);
  const mark = (from: number, to: number) => {
    if (loudest <= quiet) return;
    const len = to - from;
    for (let f = Math.floor(from / hop); f <= Math.min(nf - 1, Math.floor(to / hop)); f++) if (len > halfCycle[f]) halfCycle[f] = len;
  };
  for (let i = 1; i < n; i++) {
    const a = zc[i] < 0 ? -zc[i] : zc[i];
    if (a <= quiet) {
      // Silence ends a half cycle and doesn't start one.
      mark(last, i);
      last = i;
      loudest = 0;
    } else if (zc[i - 1] < 0 !== zc[i] < 0) {
      mark(last, i);
      last = i;
      loudest = a;
    } else if (a > loudest) loudest = a;
  }
  mark(last, n);
  const near = slidingMax(halfCycle, maxK, maxK);
  const env = new Float64Array(nf);
  let max = 0;
  for (let f = 0; f < nf; f++) {
    const k = Math.min(maxK, Math.max(minK, Math.ceil((1.1 * near[f]) / hop)));
    let ahead = 0;
    let behind = 0;
    for (let j = f; j <= Math.min(nf - 1, f + k); j++) if (framePeak[j] > ahead) ahead = framePeak[j];
    for (let j = Math.max(0, f - k); j <= f; j++) if (framePeak[j] > behind) behind = framePeak[j];
    env[f] = Math.min(ahead, behind);
    if (env[f] > max) max = env[f];
  }
  return { hop, energy, halfCycle: near, env, max };
}

/** Time (frames, fractional) where the envelope crosses `level` between frames a and a + 1. */
function crossing(env: Float64Array, a: number, level: number): number {
  if (a < 0) return 0;
  if (a + 1 >= env.length) return a;
  const y0 = env[a];
  const y1 = env[a + 1];
  if (y1 === y0) return a;
  return a + clamp((level - y0) / (y1 - y0), 0, 1);
}

/**
 * Onsets, the starts of hits. Detected on the energy envelope averaged over at least 3 ms (and a whole period of a
 * low tone, so its ripple doesn't count): it rises 8 dB or more within 30 ms, and the rise from its floor to within
 * 1 dB of its top takes no longer than the averaging window plus 3 ms. Beating partials and tremolo dip and rise
 * too, but slowly, so they don't count. Each onset is then placed on the peak envelope, at the start of its
 * steepest rise. After a hit the energy must fall 4 dB to re-arm.
 */
/** The 20 ms loudness, dB, per envelope frame. */
function loudnessCurve(energy: Float64Array, hop: number, sr: number): Float64Array {
  const nf = energy.length;
  const half = Math.max(1, Math.round(0.01 / (hop / sr)));
  const prefix = new Float64Array(nf + 1);
  for (let f = 0; f < nf; f++) prefix[f + 1] = prefix[f] + energy[f];
  const loud = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = Math.max(0, f - half);
    const b = Math.min(nf, f + half + 1);
    const e = (prefix[b] - prefix[a]) / (b - a);
    loud[f] = e > 1e-12 ? 10 * Math.log10(e) : FLOOR_DB;
  }
  return loud;
}

/**
 * The main repeat period, if the sound has one (steps, a gallop, a ratchet, a loop's beat): the autocorrelation of
 * its loudness rises, 5 ms at a time, between 50 ms and 2 s. The shortest strong period is taken, so a walk is its
 * step, not its stride. Zero when nothing repeats at least three times.
 */
function findPulse(loud: Float64Array, hop: number, sr: number, seconds: number): { period: number; strength: number } {
  const step = Math.max(1, Math.round(0.005 / (hop / sr)));
  const n = Math.floor(loud.length / step);
  if (n < 30) return { period: 0, strength: 0 };
  const rise = new Float64Array(n);
  // How far each moment stands above the lowest of the 30 ms before it: a step's rise, not a texture's flicker.
  for (let i = 1; i < n; i++) {
    let lo = Infinity;
    for (let k = Math.max(0, i - 6); k < i; k++) lo = Math.min(lo, loud[k * step]);
    rise[i] = Math.max(0, loud[i * step] - lo);
  }
  // Something must rise more than 3 dB at least three times for there to be a pulse at all.
  let rises = 0;
  for (let i = 1; i < n; i++) if (rise[i] > 3 && rise[i - 1] <= 3) rises++;
  if (rises < 3) return { period: 0, strength: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += rise[i];
  mean /= n;
  for (let i = 0; i < n; i++) rise[i] -= mean;
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += rise[i] * rise[i];
  if (!(r0 > 1e-12)) return { period: 0, strength: 0 };
  const minLag = 10;
  const maxLag = Math.min(400, Math.floor(n / 3));
  if (maxLag <= minLag + 2) return { period: 0, strength: 0 };
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += rise[i] * rise[i - lag];
    // Fewer pairs at long lags: scale back up so they compete fairly.
    r[lag] = (acc / r0) * (n / (n - lag));
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > r[best]) best = lag;
  let pick = best;
  for (let lag = minLag; lag < best; lag++) {
    if (r[lag] >= 0.6 * r[best] && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      pick = lag;
      break;
    }
  }
  const period = (pick * step * hop) / sr;
  const strength = r[pick];
  if (strength < 0.25 || period * 3 > seconds) return { period: 0, strength: Math.max(0, strength) };
  return { period, strength };
}

/**
 * The main events (steps, knocks, shots): where the 20 ms loudness jumps at least 9 dB (6 with a pulse) above its
 * lowest point of the 60 ms before, reaching within 30 dB of the loudest. Where `onsets` lists every sharp rise (a heel and then its toe,
 * a crackle's grains), this is what a listener would count. Rises closer than 60 % of the sound's pulse (60 ms when
 * it has none) are one event, the louder kept, so a step's heel, sole and grit count once and a faint scuff just
 * before a step does not stand in for it. Each event's time is where its rise begins: the first moment after the dip
 * that the peak envelope comes within 20 dB of the event's own peak.
 */
function findEvents(envDb: Float64Array, loud: Float64Array, hop: number, sr: number, pulse: number): number[] {
  const nf = loud.length;
  const frameSec = hop / sr;
  let top = FLOOR_DB;
  for (let f = 0; f < nf; f++) if (loud[f] > top) top = loud[f];
  const look = Math.max(1, Math.round(0.06 / frameSec));
  const ahead = Math.max(1, Math.round(0.1 / frameSec));
  const merge = Math.round((pulse > 0 ? 0.6 * pulse : 0.06) / frameSec);
  const found: { at: number; peak: number; from: number }[] = [];
  let rising = false;
  for (let f = 0; f < nf; f++) {
    // The lowest point of the last 60 ms (before the file starts: silence).
    let lo = f - look < 0 ? FLOOR_DB : Infinity;
    let loAt = Math.max(0, f - look);
    for (let k = Math.max(0, f - look); k <= f; k++) {
      if (loud[k] < lo) {
        lo = loud[k];
        loAt = k;
      }
    }
    // With a pulse to group by, a smaller rise is enough (a ratchet's teeth over its own ring).
    const up = loud[f] - lo >= (pulse > 0 ? 6 : 9);
    if (up && !rising) {
      let peak = FLOOR_DB;
      for (let k = f; k < Math.min(nf, f + ahead); k++) if (loud[k] > peak) peak = loud[k];
      if (peak >= top - 30) {
        // Where the rise begins: the first moment out of the dip within 20 dB of this event's own peak (6 dB above
        // the dip at least), so a faint tail of the last event in the dip doesn't pull it early.
        let peakEnv = FLOOR_DB;
        for (let k = f; k < Math.min(nf, f + ahead); k++) if (envDb[k] > peakEnv) peakEnv = envDb[k];
        const level = Math.max(lo + 6, peakEnv - 20);
        let at = f;
        for (let k = loAt; k < Math.min(nf, f + ahead); k++) {
          if (envDb[k] >= level) {
            at = k;
            break;
          }
        }
        const last = found[found.length - 1];
        if (last && f - last.from < merge) {
          if (peak > last.peak + 3) found[found.length - 1] = { at: Math.max(at, last.at), peak, from: f };
        } else found.push({ at: last ? Math.max(at, last.at + 1) : at, peak, from: f });
      }
    }
    rising = up;
  }
  return found.slice(0, 256).map((e) => e.at * frameSec);
}

function findOnsets(envDb: Float64Array, energy: Float64Array, halfCycle: Float64Array, hop: number, sr: number, maxDb: number): number[] {
  const RISE = 8;
  const FALL = 4;
  const nf = envDb.length;
  const frameSec = hop / sr;
  const look = Math.max(1, Math.round(0.03 / frameSec));
  // Smoothed energy, in dB, over a centred window of half-width w[f] frames.
  const prefix = new Float64Array(nf + 1);
  for (let f = 0; f < nf; f++) prefix[f + 1] = prefix[f] + energy[f];
  const w = new Int32Array(nf);
  const det = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    w[f] = Math.min(Math.round(0.01 / frameSec), Math.max(Math.round(0.0015 / frameSec), Math.ceil((1.1 * halfCycle[f]) / hop)));
    const a = Math.max(0, f - w[f]);
    const b = Math.min(nf, f + w[f] + 1);
    const e = (prefix[b] - prefix[a]) / (2 * w[f] + 1);
    det[f] = e > 1e-12 ? 10 * Math.log10(e) : FLOOR_DB;
  }
  const detMax = maxOf(det);
  const out: number[] = [];
  let armed = true;
  let top = -Infinity;
  let topAt = -Infinity;
  for (let m = 0; m < nf; m++) {
    const v = det[m];
    if (armed) {
      if (v < detMax - 40) continue;
      // Lowest point in the last 30 ms since the previous hit's top (silence before the file is the floor).
      let lo = Infinity;
      let loAt = m;
      for (let k = Math.max(m - look, topAt); k <= m; k++) {
        const x = k < 0 ? FLOOR_DB : det[k];
        if (x <= lo) {
          lo = x;
          loAt = k;
        }
      }
      if (v - lo < RISE) continue;
      let a = m;
      while (a > Math.max(0, loAt) && det[a - 1] >= lo + 1) a--;
      const end = Math.min(nf - 1, m + 2 * w[m] + Math.round(0.005 / frameSec));
      let peak = v;
      for (let k = m; k <= end; k++) if (det[k] > peak) peak = det[k];
      let b = m;
      while (b < end && det[b] < peak - 1) b++;
      if ((b - a) * frameSec <= (2 * w[m] + 1) * frameSec + 0.003 && out.length < 64) {
        // The start of the steepest 1 ms rise of the peak envelope near it, walked back to where that rise began.
        const from = Math.max(1, a - w[m]);
        const to = Math.min(nf - 1, b);
        const step = Math.max(1, Math.round(0.001 / frameSec));
        let s = from;
        let best = -Infinity;
        for (let f = from; f <= to; f++) {
          const inc = envDb[f] - (f - step >= 0 ? envDb[f - step] : FLOOR_DB);
          if (inc > best) {
            best = inc;
            s = f;
          }
        }
        let floor = Infinity;
        for (let f = Math.max(0, from - step); f <= s; f++) floor = Math.min(floor, envDb[f]);
        while (s > 0 && envDb[s - 1] < envDb[s] + 1 && envDb[s - 1] > floor + 3) s--;
        // Two detections that land on the same rise are one hit.
        if (envDb[s] >= maxDb - 50 && (out.length === 0 || s * frameSec > out[out.length - 1] + 0.005)) out.push(s * frameSec);
      }
      armed = false;
      top = v;
      topAt = m;
    } else {
      if (v > top) {
        top = v;
        topAt = m;
      }
      if (v <= top - FALL) armed = true;
    }
  }
  return out;
}

// ---- Spectra ----------------------------------------------------------------------------------------

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Power spectrum summed over frames and channels; frames start at the given sample positions. */
function powerSpectrum(chs: Float64Array[], starts: number[], nfft: number): Float64Array {
  const win = hann(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const power = new Float64Array(nfft / 2 + 1);
  for (const ch of chs) {
    const n = ch.length;
    for (const s of starts) {
      for (let i = 0; i < nfft; i++) {
        const j = s + i;
        re[i] = j >= 0 && j < n ? ch[j] * win[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k <= nfft / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    }
  }
  return power;
}

/** At most `max` values spread evenly over [a, b] in steps of `step`. */
function framePositions(a: number, b: number, step: number, max: number): number[] {
  const out: number[] = [];
  if (b < a) return [a];
  const count = Math.floor((b - a) / step) + 1;
  if (count <= max) {
    for (let s = a; s <= b; s += step) out.push(Math.round(s));
  } else {
    for (let k = 0; k < max; k++) out.push(Math.round(a + ((b - a) * k) / (max - 1)));
  }
  return out;
}

/** Welch average over the whole sound with ~170 ms Hann frames: fine enough to split off the sub band. */
function averageSpectrum(chs: Float64Array[], n: number, sr: number): { power: Float64Array; binHz: number } {
  const nfft = Math.max(256, nextPow2(Math.round(sr * 0.17)));
  const hop = nfft / 2;
  const starts = framePositions(-hop, n - 1, hop, 160);
  return { power: powerSpectrum(chs, starts, nfft), binHz: sr / nfft };
}

function centroidOf(power: Float64Array, binHz: number): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k < power.length; k++) {
    num += k * binHz * power[k];
    den += power[k];
  }
  return den > 0 ? num / den : 0;
}

function rolloffOf(power: Float64Array, binHz: number, share = 0.85): number {
  let total = 0;
  for (let k = 1; k < power.length; k++) total += power[k];
  if (total <= 0) return 0;
  let acc = 0;
  for (let k = 1; k < power.length; k++) {
    const next = acc + power[k];
    if (next >= share * total) {
      const frac = power[k] > 0 ? (share * total - acc) / power[k] : 0;
      return (k - 0.5 + frac) * binHz;
    }
    acc = next;
  }
  return (power.length - 1) * binHz;
}

function bandsOf(power: Float64Array, binHz: number, sr: number): BandEnergy[] {
  const sums = BANDS.map(() => 0);
  let total = 0;
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    const b = BANDS.findIndex((band) => f >= band.lo && f < band.hi);
    if (b >= 0) sums[b] += power[k];
    total += power[k];
  }
  return BANDS.map((band, i) => ({
    band: band.band,
    lo: band.lo,
    hi: Number.isFinite(band.hi) ? band.hi : sr / 2,
    db: round(total > 0 ? powDb(sums[i] / total) : FLOOR_DB, 1),
  }));
}

/** Tonal peaks: local maxima 15 dB or more above the median of the third of an octave around them. */
function peaksOf(power: Float64Array, binHz: number): SpectralPeak[] {
  const n = power.length;
  const db = new Float64Array(n);
  for (let k = 0; k < n; k++) db[k] = 10 * Math.log10(power[k] + 1e-30);
  const local: number[] = [];
  for (let k = 3; k < n - 3; k++) {
    if (k * binHz < 25) continue;
    if (db[k] > db[k - 1] && db[k] >= db[k + 1] && db[k] > db[k - 2] && db[k] >= db[k + 2]) local.push(k);
  }
  local.sort((a, b) => db[b] - db[a]);
  const chosen: { hz: number; level: number; k: number }[] = [];
  for (const k of local.slice(0, 48)) {
    if (chosen.length >= 5) break;
    if (chosen.length > 0 && db[k] < chosen[0].level - 24) break;
    const lo = Math.max(1, Math.min(k - 8, Math.floor(k / 1.26)));
    const hi = Math.min(n - 1, Math.max(k + 8, Math.ceil(k * 1.26)));
    const around = Array.from(db.subarray(lo, hi + 1)).sort((a, b) => a - b);
    const median = around[Math.floor(around.length / 2)];
    if (db[k] - median < 15) continue;
    if (chosen.some((c) => Math.abs(c.k - k) < 4 || Math.abs(c.k - k) < c.k * 0.02)) continue;
    const y0 = db[k - 1];
    const y1 = db[k];
    const y2 = db[k + 1];
    const den = y0 - 2 * y1 + y2;
    const off = den < 0 ? clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5) : 0;
    chosen.push({ hz: (k + off) * binHz, level: y1 - 0.25 * (y0 - y2) * off, k });
  }
  if (chosen.length === 0) return [];
  const top = chosen[0].level;
  return chosen.map((c) => ({ hz: round(c.hz, 1), db: round(c.level - top, 1) }));
}

/** Centroid in each third of [a, b) (samples), from short frames whose centres fall in that third. */
function centroidThirds(chs: Float64Array[], a: number, b: number, sr: number): [number, number, number] {
  const len = b - a;
  if (len < 6) return [0, 0, 0];
  const third = len / 3;
  const scale = sr / 48000;
  const minN = nextPow2(Math.round(256 * scale));
  const maxN = nextPow2(Math.round(2048 * scale));
  let nfft = minN;
  while (nfft * 2 <= Math.min(maxN, third)) nfft *= 2;
  const out: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < 3; t++) {
    const c0 = a + t * third;
    const c1 = a + (t + 1) * third;
    const centres = framePositions(c0, Math.max(c0, c1 - 1), nfft / 4, 48);
    const power = powerSpectrum(
      chs,
      centres.map((c) => c - nfft / 2),
      nfft,
    );
    out[t] = round(centroidOf(power, sr / nfft), 1);
  }
  return out;
}

// ---- Pitch (YIN) -------------------------------------------------------------------------------------

interface PitchFrame {
  t: number;
  hz: number;
  clarity: number;
  power: number;
}

/** Low-pass (windowed sinc at 0.45 of the new rate) and keep every D-th sample, without delay. */
function decimate(x: Float64Array, D: number): Float64Array {
  const half = 8 * D;
  const fc = 0.45 / D;
  const h = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let k = 0; k <= 2 * half; k++) {
    const t = k - half;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((Math.PI * k) / half) + 0.08 * Math.cos((2 * Math.PI * k) / half);
    h[k] = sinc * w;
    sum += h[k];
  }
  for (let k = 0; k < h.length; k++) h[k] /= sum;
  const m = Math.floor(x.length / D);
  const out = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = i * D;
    let acc = 0;
    const k0 = Math.max(0, half - c);
    const k1 = Math.min(2 * half, x.length - 1 - c + half);
    for (let k = k0; k <= k1; k++) acc += h[k] * x[c + k - half];
    out[i] = acc;
  }
  return out;
}

/** One YIN analysis window: lags up to tauMax over an integration window of W = tauMax samples. */
class Yin {
  readonly span: number;
  private readonly F: number;
  private readonly aRe: Float64Array;
  private readonly aIm: Float64Array;
  private readonly bRe: Float64Array;
  private readonly bIm: Float64Array;
  private readonly cum: Float64Array;
  private readonly d: Float64Array;
  private readonly cmnd: Float64Array;

  constructor(
    readonly tauMax: number,
    private readonly tauMin: number,
  ) {
    this.span = 2 * tauMax;
    this.F = nextPow2(this.span);
    this.aRe = new Float64Array(this.F);
    this.aIm = new Float64Array(this.F);
    this.bRe = new Float64Array(this.F);
    this.bIm = new Float64Array(this.F);
    this.cum = new Float64Array(this.span + 1);
    this.d = new Float64Array(tauMax + 2);
    this.cmnd = new Float64Array(tauMax + 2);
  }

  /** Lag (fractional samples), clarity and mean power of the window starting at `s`; lag 0 when silent. */
  at(x: Float64Array, s: number): { tau: number; clarity: number; power: number } {
    const { F, aRe, aIm, bRe, bIm, cum, d, cmnd, tauMax, tauMin } = this;
    const W = tauMax;
    bRe.fill(0);
    bIm.fill(0);
    aRe.fill(0);
    aIm.fill(0);
    for (let j = 0; j < this.span; j++) bRe[j] = s + j < x.length ? x[s + j] : 0;
    for (let j = 0; j < W; j++) aRe[j] = bRe[j];
    cum[0] = 0;
    for (let j = 0; j < this.span; j++) cum[j + 1] = cum[j] + bRe[j] * bRe[j];
    const e0 = cum[W];
    if (e0 <= 1e-20) return { tau: 0, clarity: 0, power: 0 };
    fft(aRe, aIm);
    fft(bRe, bIm);
    for (let k = 0; k < F; k++) {
      const re = aRe[k] * bRe[k] + aIm[k] * bIm[k];
      const im = aRe[k] * bIm[k] - aIm[k] * bRe[k];
      aRe[k] = re;
      aIm[k] = im;
    }
    fft(aRe, aIm, true);
    let running = 0;
    cmnd[0] = 1;
    for (let tau = 0; tau <= tauMax; tau++) {
      const et = cum[tau + W] - cum[tau];
      d[tau] = Math.max(0, e0 + et - 2 * aRe[tau]);
      if (tau > 0) {
        running += d[tau];
        cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
      }
    }
    // The first dip under the threshold (which avoids octave errors), else the deepest one.
    let tau = -1;
    for (let k = tauMin; k <= tauMax; k++) {
      if (cmnd[k] < 0.2) {
        while (k + 1 <= tauMax && cmnd[k + 1] < cmnd[k]) k++;
        tau = k;
        break;
      }
    }
    if (tau < 0) {
      let best = Infinity;
      for (let k = tauMin; k <= tauMax; k++) {
        if (cmnd[k] < best) {
          best = cmnd[k];
          tau = k;
        }
      }
    }
    let tauF = tau;
    if (tau > tauMin && tau < tauMax) {
      const y0 = d[tau - 1];
      const y1 = d[tau];
      const y2 = d[tau + 1];
      const den = y0 - 2 * y1 + y2;
      if (den > 1e-20) tauF = tau + clamp((0.5 * (y0 - y2)) / den, -1, 1);
    }
    return { tau: tauF, clarity: clamp(1 - cmnd[tau], 0, 1), power: e0 / W };
  }
}

/**
 * YIN (de Cheveigné & Kawahara 2002) every 5 ms between `from` and `to` (samples), at about 16 kHz: pitch from 40 Hz
 * to 4 kHz. Each frame is measured with a 25 ms window (down to 40 Hz) and a 6 ms one, which follows fast glides
 * that smear the long window; the clearer of the two wins (the short one only above 180 Hz, where it can see a
 * whole period). Clarity is 1 minus the cumulative-mean-normalised difference at the chosen lag.
 */
function yinFrames(x: Float64Array, sr: number, from: number, to: number): PitchFrame[] {
  const D = Math.max(1, Math.floor(sr / 16000));
  const xd = D > 1 ? decimate(x, D) : x;
  const srd = sr / D;
  const a = Math.max(0, Math.floor(from / D));
  const b = Math.min(xd.length, Math.ceil(to / D));
  const len = b - a;
  const tauMin = Math.max(2, Math.floor(srd / 4000));
  const longMax = Math.min(Math.ceil(srd / 40), Math.floor(len / 2));
  if (longMax < tauMin + 4) return [];
  const long = new Yin(longMax, tauMin);
  const shortMax = Math.ceil(srd * 0.006);
  const short = shortMax < longMax && shortMax >= tauMin + 4 ? new Yin(shortMax, tauMin) : null;
  // Full-rate energy, to tell when most of a frame lies above the pitch range (a 12 kHz whistle has no pitch here).
  let full: Float64Array | null = null;
  if (D > 1) {
    full = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) full[i + 1] = full[i] + x[i] * x[i];
  }
  const firstCentre = a + long.span / 2;
  const lastCentre = b - long.span / 2;
  let hop = Math.max(1, Math.round(srd * 0.005));
  if ((lastCentre - firstCentre) / hop > 399) hop = Math.ceil((lastCentre - firstCentre) / 399);
  const frames: PitchFrame[] = [];
  for (let c = firstCentre; c <= lastCentre; c += hop) {
    const s = Math.round(c - long.span / 2);
    const t = (c * D) / sr;
    const fullPower = full ? (full[Math.min(x.length, (s + longMax) * D)] - full[s * D]) / (longMax * D) : 0;
    const L = long.at(xd, s);
    if (L.power <= 0 || (full && L.power < 0.05 * fullPower)) {
      frames.push({ t, hz: 0, clarity: 0, power: Math.max(L.power, fullPower) });
      continue;
    }
    let best = { hz: srd / L.tau, clarity: L.clarity };
    if (short) {
      const S = short.at(xd, Math.round(c - short.span / 2));
      const hz = S.tau > 0 ? srd / S.tau : 0;
      if (hz >= 180 && S.clarity > L.clarity + 0.02) best = { hz, clarity: S.clarity };
    }
    frames.push({ t, hz: best.hz, clarity: best.clarity, power: L.power });
  }
  return frames;
}

interface PitchResult {
  hz: number | null;
  clarity: number;
  track: [number, number][];
}

const semitones = (a: number, b: number): number => 12 * Math.log2(a / b);

function weightedMedian(values: { v: number; w: number }[]): number {
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return sorted[sorted.length - 1]?.v ?? 0;
}

/**
 * The strongest pitched stretch: voiced frames (clarity 0.5 or more, within 50 dB of the loudest frame) that follow
 * on from each other within 2 semitones per 5 ms hop (glides are fine, octave jumps are not; one stray frame is
 * skipped). Strongest means the most power times clarity squared.
 */
function pitchOf(frames: PitchFrame[]): PitchResult {
  const maxPower = frames.reduce((m, f) => Math.max(m, f.power), 0);
  const audible = frames.filter((f) => f.power >= maxPower * 1e-5 && f.power > 0);
  const meanClarity = (fs: PitchFrame[]) => {
    const w = fs.reduce((s, f) => s + f.power, 0);
    return w > 0 ? fs.reduce((s, f) => s + f.power * f.clarity, 0) / w : 0;
  };
  const voiced = (f: PitchFrame) => f.clarity >= 0.5 && f.power >= maxPower * 1e-5 && f.hz > 0;
  const segments: PitchFrame[][] = [];
  let cur: PitchFrame[] = [];
  let gap = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const prev = cur[cur.length - 1];
    const follows = (g: PitchFrame) => prev !== undefined && Math.abs(semitones(g.hz, prev.hz)) <= 2 * (gap + 1);
    if (!voiced(f) || (prev && !follows(f))) {
      // A single stray frame between two that agree is skipped.
      const next = frames[i + 1];
      if (prev && next && voiced(next) && follows(next) && gap === 0) {
        gap = 1;
        continue;
      }
      if (cur.length) segments.push(cur);
      cur = voiced(f) ? [f] : [];
      gap = 0;
      continue;
    }
    cur.push(f);
    gap = 0;
  }
  if (cur.length) segments.push(cur);
  const score = (seg: PitchFrame[]) => seg.reduce((s, f) => s + f.power * f.clarity * f.clarity, 0);
  let best: PitchFrame[] | null = null;
  for (const seg of segments) {
    if (seg.length < 4 || seg[seg.length - 1].t - seg[0].t < 0.015) continue;
    if (meanClarity(seg) < 0.6) continue;
    if (!best || score(seg) > score(best)) best = seg;
  }
  if (!best) return { hz: null, clarity: round(meanClarity(audible), 3), track: [] };
  const hz = weightedMedian(best.map((f) => ({ v: f.hz, w: f.power })));
  const points = Math.min(8, best.length);
  const track: [number, number][] = [];
  for (let p = 0; p < points; p++) {
    const chunk = best.slice(Math.floor((p * best.length) / points), Math.floor(((p + 1) * best.length) / points));
    const t = (chunk[0].t + chunk[chunk.length - 1].t) / 2;
    track.push([round(t, 3), round(weightedMedian(chunk.map((f) => ({ v: f.hz, w: 1 }))), 1)]);
  }
  return { hz: round(hz, 1), clarity: round(meanClarity(best), 3), track };
}

/**
 * Squares YIN with the spectrum. A tonal peak within 6% of 1 to 4 times the pitch pins it to that peak's precise
 * frequency (YIN drifts on inharmonic tones). With two or more peaks and none near a low multiple, nor two peaks
 * the pitch apart, the "pitch" is a subharmonic that happens to fit inharmonic partials (a struck plate): none.
 */
function checkPitch(p: PitchResult, peaks: SpectralPeak[]): PitchResult {
  if (p.hz === null || peaks.length === 0) return p;
  const f0 = p.hz;
  for (let k = 1; k <= 4; k++) {
    const near = peaks.filter((q) => Math.abs(q.hz / (k * f0) - 1) < 0.06).sort((x, y) => y.db - x.db)[0];
    if (near) return { ...p, hz: round(near.hz / k, 1) };
  }
  if (peaks.length < 2) return p;
  const spaced = peaks.some((x, i) => peaks.some((y, j) => j > i && Math.abs(Math.abs(x.hz - y.hz) / f0 - 1) < 0.04));
  return spaced ? p : { hz: null, clarity: p.clarity, track: [] };
}

// ---- True peak ---------------------------------------------------------------------------------------

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * 4x oversampling taps: phase p interpolates at i + p/4 from x[i-11 .. i+12], a Kaiser-windowed sinc that is flat
 * within 0.02 dB to 0.4 of the sample rate (BS.1770-4's own 48-tap filter is coarser).
 */
const TP_HALF = 12;
const TRUE_PEAK_TAPS: Float64Array[] = [1, 2, 3].map((p) => {
  const mu = p / 4;
  const h = new Float64Array(2 * TP_HALF);
  let sum = 0;
  for (let j = 1 - TP_HALF; j <= TP_HALF; j++) {
    const dist = mu - j;
    const sinc = Math.sin(Math.PI * dist) / (Math.PI * dist);
    const w = besselI0(6 * Math.sqrt(Math.max(0, 1 - (dist / (TP_HALF + 0.5)) ** 2))) / besselI0(6);
    h[j + TP_HALF - 1] = sinc * w;
    sum += h[j + TP_HALF - 1];
  }
  for (let k = 0; k < h.length; k++) h[k] /= sum;
  return h;
});

function truePeak(x: ArrayLike<number>, n: number, samplePeak: number): number {
  const taps = 2 * TP_HALF;
  const padded = new Float64Array(n + taps);
  for (let i = 0; i < n; i++) padded[i + TP_HALF - 1] = x[i];
  let tp = samplePeak;
  for (const h of TRUE_PEAK_TAPS) {
    for (let i = 0; i < n; i++) {
      let y = 0;
      for (let j = 0; j < taps; j++) y += padded[i + j] * h[j];
      const a = y < 0 ? -y : y;
      if (a > tp) tp = a;
    }
  }
  return tp;
}

// ---- The whole analysis ------------------------------------------------------------------------------

function silent(sr: number, nCh: number, n: number): Analysis {
  return {
    sampleRate: sr,
    channels: nCh,
    duration: round(n / sr, 4),
    peakDb: FLOOR_DB,
    truePeakDb: FLOOR_DB,
    rmsDb: FLOOR_DB,
    lufs: FLOOR_DB,
    lufsMomentaryMax: FLOOR_DB,
    crestDb: 0,
    peakTimeMs: 0,
    attackMs: 0,
    startSeconds: 0,
    audibleSeconds: 0,
    decay20Seconds: 0,
    tailDb: FLOOR_DB,
    firstSampleDb: FLOOR_DB,
    lastSampleDb: FLOOR_DB,
    seamDb: FLOOR_DB,
    maxStepDb: FLOOR_DB,
    onsets: [],
    events: [],
    pulseSeconds: 0,
    pulseStrength: 0,
    centroidHz: 0,
    centroidThirds: [0, 0, 0],
    rolloffHz: 0,
    bands: BANDS.map((b) => ({ band: b.band, lo: b.lo, hi: Number.isFinite(b.hi) ? b.hi : sr / 2, db: FLOOR_DB })),
    peaks: [],
    pitchHz: null,
    pitchClarity: 0,
    pitchTrack: [],
    zeroCrossRate: 0,
    dcOffset: 0,
    clippedSamples: 0,
    stereoCorrelation: nCh === 2 ? 0 : null,
    envelopeDb: new Array(40).fill(FLOOR_DB),
  };
}

/** Measures one or two channels of audio. */
export function analyze(channels: ArrayLike<number>[], sampleRate: number): Analysis {
  const sr = sampleRate;
  const input = channels.filter((c) => c && c.length !== undefined);
  const nCh = input.length;
  const n = nCh > 0 ? Math.min(...input.map((c) => c.length)) : 0;
  if (n === 0 || !(sr > 0)) return silent(sr, nCh, n);

  // Level, DC, clipping.
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let dc = 0;
  let first = 0;
  let lastS = 0;
  let seam = 0;
  let maxStep = 0;
  const centred: Float64Array[] = [];
  for (const ch of input) {
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      mean += v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= FULL_SCALE) clipped++;
      sumSq += v * v;
      if (i > 0) {
        const step = Math.abs(v - ch[i - 1]);
        if (step > maxStep) maxStep = step;
      }
    }
    mean /= n;
    if (Math.abs(mean) > Math.abs(dc)) dc = mean;
    first = Math.max(first, Math.abs(ch[0]));
    lastS = Math.max(lastS, Math.abs(ch[n - 1]));
    seam = Math.max(seam, Math.abs(ch[0] - ch[n - 1]));
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = ch[i] - mean;
    centred.push(c);
  }
  if (peak < 1e-7) return silent(sr, nCh, n);
  const rms = Math.sqrt(sumSq / (n * nCh));
  let tp = peak;
  for (const ch of input) tp = Math.max(tp, truePeak(ch, n, peak));
  const loud = loudness(input, sr);

  // Envelope and the time measures; zero crossings of the loudest channel set its window. The raw samples, not the
  // DC-free copy: removing the mean would turn digital silence into a small constant that never crosses zero.
  let loudest = 0;
  let loudestEnergy = -1;
  centred.forEach((c, k) => {
    let e = 0;
    for (let i = 0; i < n; i++) e += c[i] * c[i];
    if (e > loudestEnergy) {
      loudestEnergy = e;
      loudest = k;
    }
  });
  const { hop, env, max, halfCycle, energy } = envelope(input, n, sr, input[loudest]);
  const nf = env.length;
  const frameSec = hop / sr;
  let argmax = 0;
  for (let f = 1; f < nf; f++) if (env[f] > env[argmax]) argmax = f;
  const firstAt = (level: number) => {
    for (let f = 0; f < nf; f++) if (env[f] >= level) return f;
    return argmax;
  };
  const envDb = new Float64Array(nf);
  for (let f = 0; f < nf; f++) envDb[f] = ampDb(env[f]);
  const onsetTimes = findOnsets(envDb, energy, halfCycle, hop, sr, ampDb(max));
  const loudCurve = loudnessCurve(energy, hop, sr);
  const pulse = findPulse(loudCurve, hop, sr, n / sr);
  const eventTimes = findEvents(envDb, loudCurve, hop, sr, pulse.period);
  const peakFrame = firstAt(max * 10 ** (-0.5 / 20));
  const i90 = firstAt(0.9 * max);
  // The attack is the rise of the hit that gets loudest: it starts no earlier than the last onset before it, so
  // earlier, quieter hits don't count as a slow attack.
  let floor = 0;
  for (const t of onsetTimes) if (Math.round(t / frameSec) <= i90) floor = Math.round(t / frameSec);
  let i10 = i90;
  while (i10 > floor && env[i10] >= 0.1 * max) i10--;
  const t10 = env[i10] >= 0.1 * max ? i10 : crossing(env, i10, 0.1 * max);
  const t90 = i90 > 0 ? crossing(env, i90 - 1, 0.9 * max) : 0;
  const attack = Math.max(0, t90 - t10) * frameSec;
  const startFrame = firstAt(max * 0.01);
  let endFrame = 0;
  for (let f = nf - 1; f >= 0; f--) {
    if (env[f] >= max * 1e-3) {
      endFrame = f;
      break;
    }
  }
  const audible = Math.min(n / sr, (endFrame + 1) * frameSec);
  // Decay on the dB envelope averaged over 10 ms (centred): exact for an exponential decay, steady on noise.
  const smooth = new Float64Array(nf);
  {
    const half = Math.max(1, Math.round(0.005 / frameSec));
    let acc = 0;
    let count = 0;
    for (let f = 0; f < Math.min(nf, half); f++) {
      acc += envDb[f];
      count++;
    }
    for (let f = 0; f < nf; f++) {
      if (f + half < nf) {
        acc += envDb[f + half];
        count++;
      }
      if (f - half - 1 >= 0) {
        acc -= envDb[f - half - 1];
        count--;
      }
      smooth[f] = acc / count;
    }
  }
  let sArg = 0;
  for (let f = 1; f < nf; f++) if (smooth[f] > smooth[sArg]) sArg = f;
  const sMax = smooth[sArg];
  let loudEnd = sArg;
  for (let f = nf - 1; f >= sArg; f--) {
    if (smooth[f] >= sMax - 1) {
      loudEnd = f;
      break;
    }
  }
  // The fall from -1 dB to -20 dB, scaled by 20/19: a steady decay's 20 dB time, measured from the end of the
  // loud part so a sustained sound with a release reads its release.
  let decay20 = n / sr - loudEnd * frameSec;
  for (let f = loudEnd + 1; f < nf; f++) {
    if (smooth[f] < sMax - 20) {
      decay20 = ((crossing(smooth, f - 1, sMax - 20) - crossing(smooth, loudEnd, sMax - 1)) * frameSec * 20) / 19;
      break;
    }
  }
  // The last 5% of the sound, 2 to 200 ms: long enough to read a level, short enough not to be the whole sound.
  // Its level is the quietest point of its first half: what is still sounding as it begins. A sound cut off keeps
  // going right through it (the final fade comes after); a sparse one whose last grain or tick lands in it, and
  // dies, does not.
  const tailFrames = Math.max(1, Math.round(clamp(0.05 * (n / sr), 0.002, 0.2) / frameSec));
  const tailFrom = Math.max(0, nf - tailFrames);
  const tailTo = Math.min(nf, tailFrom + Math.max(1, Math.floor(tailFrames / 2)));
  let tail = Infinity;
  for (let f = tailFrom; f < tailTo; f++) tail = Math.min(tail, env[f]);
  if (!Number.isFinite(tail)) tail = 0;
  const onsets = onsetTimes.map((t) => round(t, 4));
  const envelopeDb: number[] = [];
  for (let p = 0; p < 40; p++) {
    const a = Math.floor((p * nf) / 40);
    const b = Math.max(a + 1, Math.floor(((p + 1) * nf) / 40));
    let m = 0;
    for (let f = a; f < Math.min(b, nf); f++) m = Math.max(m, env[f]);
    envelopeDb.push(round(ampDb(m), 1));
  }

  // Spectrum.
  const { power, binHz } = averageSpectrum(centred, n, sr);
  const a0 = Math.min(n - 1, startFrame * hop);
  const a1 = Math.max(a0 + 1, Math.min(n, Math.round(audible * sr)));
  const thirds = centroidThirds(centred, a0, a1, sr);

  // Pitch and zero crossings on one channel: the mid, unless the sides cancel in it.
  let mono = centred[0];
  if (nCh === 2) {
    const mid = new Float64Array(n);
    let eMid = 0;
    let eL = 0;
    let eR = 0;
    for (let i = 0; i < n; i++) {
      mid[i] = 0.5 * (centred[0][i] + centred[1][i]);
      eMid += mid[i] * mid[i];
      eL += centred[0][i] * centred[0][i];
      eR += centred[1][i] * centred[1][i];
    }
    mono = eMid >= 0.125 * (eL + eR) ? mid : eL >= eR ? centred[0] : centred[1];
  }
  const peaks = peaksOf(power, binHz);
  const pitch = checkPitch(pitchOf(yinFrames(mono, sr, a0, a1)), peaks);
  let crossings = 0;
  for (let i = a0 + 1; i < a1; i++) if (mono[i - 1] < 0 !== mono[i] < 0) crossings++;
  const zcr = crossings / Math.max(1e-9, (a1 - a0) / sr);

  let correlation: number | null = null;
  if (nCh === 2) {
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = a0; i < a1; i++) {
      lr += centred[0][i] * centred[1][i];
      ll += centred[0][i] * centred[0][i];
      rr += centred[1][i] * centred[1][i];
    }
    correlation = ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 3) : 0;
  }

  const peakDb = ampDb(peak);
  const rmsDb = ampDb(rms);
  return {
    sampleRate: sr,
    channels: nCh,
    duration: round(n / sr, 4),
    peakDb: round(peakDb, 2),
    truePeakDb: round(ampDb(tp), 2),
    rmsDb: round(rmsDb, 2),
    lufs: round(Number.isFinite(loud.integrated) ? Math.max(FLOOR_DB, loud.integrated) : FLOOR_DB, 2),
    lufsMomentaryMax: round(Number.isFinite(loud.momentaryMax) ? Math.max(FLOOR_DB, loud.momentaryMax) : FLOOR_DB, 2),
    crestDb: round(peakDb - rmsDb, 2),
    peakTimeMs: round((peakFrame + 0.5) * frameSec * 1000, 2),
    attackMs: round(attack * 1000, 2),
    startSeconds: round(startFrame * frameSec, 4),
    audibleSeconds: round(audible, 4),
    decay20Seconds: round(Math.max(0, decay20), 4),
    tailDb: round(Math.max(FLOOR_DB, ampDb(tail) - ampDb(max)), 1),
    firstSampleDb: round(ampDb(first), 1),
    lastSampleDb: round(ampDb(lastS), 1),
    seamDb: round(ampDb(seam), 1),
    maxStepDb: round(ampDb(maxStep), 1),
    onsets,
    events: eventTimes.map((t) => round(t, 4)),
    pulseSeconds: round(pulse.period, 4),
    pulseStrength: round(pulse.strength, 2),
    centroidHz: round(centroidOf(power, binHz), 1),
    centroidThirds: thirds,
    rolloffHz: round(rolloffOf(power, binHz), 1),
    bands: bandsOf(power, binHz, sr),
    peaks,
    pitchHz: pitch.hz,
    pitchClarity: pitch.clarity,
    pitchTrack: pitch.track,
    zeroCrossRate: Math.round(zcr),
    dcOffset: round(dc, 5),
    clippedSamples: clipped,
    stereoCorrelation: correlation,
    envelopeDb,
  };
}
