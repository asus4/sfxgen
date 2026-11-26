/**
 * Formant filtering for vocal sources: a vowel table that morphs a-e-i-o-u, natural formant levels and a
 * parallel formant bank.
 *
 * The bank sums one filter per formant: the lowest a resonant low-pass (so the body below the first formant is
 * kept, as in a real vocal tract), the rest band-passes, with alternating signs so neighbouring formants add
 * instead of cancelling in the valley between them. Unless a formant's level is given, it gets the level a
 * cascade (all-pole) vocal tract would give it, so the bank sounds like the classic cascade model while still
 * allowing explicit levels.
 */
import { clamp } from './math';

export interface FormantPattern {
  /** Centre frequencies, Hz, ascending. */
  freq: number[];
  /** Resonance (centre / bandwidth). */
  q: number[];
  /** Peak level of each formant, linear; NaN means "natural" (as in a cascade vocal tract). */
  gain: number[];
}

/**
 * Five formants (centre and bandwidth, Hz) of a neutral adult voice for the vowels a (ah), e (eh), i (ee), o (oh)
 * and u (oo), the classic tenor values of formant synthesis; then the rounded front vowels ü (German "über",
 * French "tu") and ö (German "schön", French "peu"), whose rounding pulls the third formant down to the second:
 * a covered, darker colour (male values after German vowel measurements). They come after u, so the positions of
 * a to u never move.
 */
export const VOWEL_FORMANTS: readonly { name: string; freq: readonly number[]; bw: readonly number[] }[] = [
  { name: 'a', freq: [650, 1080, 2650, 2900, 3250], bw: [80, 90, 120, 130, 140] },
  { name: 'e', freq: [400, 1700, 2600, 3200, 3580], bw: [70, 80, 100, 120, 120] },
  { name: 'i', freq: [290, 1870, 2800, 3250, 3540], bw: [40, 90, 100, 120, 120] },
  { name: 'o', freq: [400, 800, 2600, 2800, 3000], bw: [40, 80, 100, 120, 120] },
  { name: 'u', freq: [350, 600, 2700, 2900, 3300], bw: [40, 60, 100, 120, 120] },
  { name: 'ü', freq: [270, 1650, 2100, 3200, 3550], bw: [40, 80, 90, 120, 120] },
  { name: 'ö', freq: [370, 1450, 2200, 3100, 3500], bw: [50, 80, 100, 120, 120] },
];

/** The formants of a vowel position 0..6 (a, e, i, o, u, ü, ö; fractions blend neighbours), scaled by 1/size. */
export function vowelPattern(vowel: number, size: number, resonance: number, out?: FormantPattern): FormantPattern {
  const v = clamp(Number.isFinite(vowel) ? vowel : 0, 0, VOWEL_FORMANTS.length - 1);
  const i0 = Math.min(Math.floor(v), VOWEL_FORMANTS.length - 2);
  const t = v - i0;
  const a = VOWEL_FORMANTS[i0];
  const b = VOWEL_FORMANTS[i0 + 1];
  const p = out ?? { freq: [], q: [], gain: [] };
  p.freq.length = p.q.length = p.gain.length = a.freq.length;
  for (let k = 0; k < a.freq.length; k++) {
    // Frequencies blend on a log scale, bandwidths linearly.
    const f = Math.exp(Math.log(a.freq[k]) * (1 - t) + Math.log(b.freq[k]) * t);
    const bw = a.bw[k] * (1 - t) + b.bw[k] * t;
    p.freq[k] = f / size;
    p.q[k] = (f / bw) * resonance;
    p.gain[k] = NaN;
  }
  return p;
}

/** |H(f)| of a two-pole resonator normalised to unity gain at 0 Hz (one section of a cascade vocal tract). */
function resonatorMag(f: number, centre: number, q: number): number {
  const r = f / centre;
  const re = 1 - r * r;
  const im = r / q;
  return 1 / Math.sqrt(re * re + im * im);
}

/**
 * Fills in the natural levels (NaN entries) of a pattern: each formant's peak in an equivalent cascade, relative to
 * the loudest. Explicit levels are kept as given.
 */
export function naturalLevels(p: FormantPattern, out: number[] = []): number[] {
  const n = p.freq.length;
  out.length = n;
  let top = 0;
  for (let k = 0; k < n; k++) {
    let g = p.q[k];
    for (let j = 0; j < n; j++) if (j !== k) g *= resonatorMag(p.freq[k], p.freq[j], p.q[j]);
    out[k] = g;
    if (g > top) top = g;
  }
  for (let k = 0; k < n; k++) out[k] = Number.isNaN(p.gain[k]) ? (top > 0 ? out[k] / top : 0) : p.gain[k];
  return out;
}

/** A parallel bank of trapezoidal state-variable filters, retuned per block. Up to `max` formants. */
export class FormantBank {
  private readonly ic1: Float64Array;
  private readonly ic2: Float64Array;
  private readonly a1: Float64Array;
  private readonly a2: Float64Array;
  private readonly a3: Float64Array;
  private readonly g: Float64Array;
  private count = 0;
  private readonly levels: number[] = [];

  constructor(
    private readonly sr: number,
    max = 8,
  ) {
    this.ic1 = new Float64Array(max);
    this.ic2 = new Float64Array(max);
    this.a1 = new Float64Array(max);
    this.a2 = new Float64Array(max);
    this.a3 = new Float64Array(max);
    this.g = new Float64Array(max);
  }

  /** Retunes the bank. The pattern must be sorted by frequency. */
  set(p: FormantPattern): void {
    const n = Math.min(p.freq.length, this.g.length);
    const levels = naturalLevels(p, this.levels);
    for (let k = 0; k < n; k++) {
      const f = clamp(p.freq[k], 20, this.sr * 0.47);
      const q = clamp(p.q[k], 0.3, 80);
      const g = Math.tan((Math.PI * f) / this.sr);
      const kk = 1 / q;
      this.a1[k] = 1 / (1 + g * (g + kk));
      this.a2[k] = g * this.a1[k];
      this.a3[k] = g * this.a2[k];
      // Low-pass (k = 0) and band-pass outputs are both scaled to peak at the formant's level. The low-pass only
      // has a resonant peak (of about q) when q is above 1.
      const sign = k % 2 === 1 ? -1 : 1;
      this.g[k] = (sign * levels[k]) / (k === 0 ? Math.max(q, 1) : q);
    }
    for (let k = n; k < this.count; k++) {
      this.ic1[k] = 0;
      this.ic2[k] = 0;
    }
    this.count = n;
  }

  tick(x: number): number {
    let y = 0;
    for (let k = 0; k < this.count; k++) {
      const v3 = x - this.ic2[k];
      const v1 = this.a1[k] * this.ic1[k] + this.a2[k] * v3;
      const v2 = this.ic2[k] + this.a2[k] * this.ic1[k] + this.a3[k] * v3;
      this.ic1[k] = 2 * v1 - this.ic1[k];
      this.ic2[k] = 2 * v2 - this.ic2[k];
      y += this.g[k] * (k === 0 ? v2 : v1);
    }
    return y;
  }
}
