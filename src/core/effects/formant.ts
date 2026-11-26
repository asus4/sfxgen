import type { EffectDef } from '../nodes';
import { isBreakpoints } from '../params';
import { Svf } from '../dsp/filters';
import { clamp, type Buf } from '../dsp/math';
import { energy } from '../dsp/dynamics';

/**
 * Five formants (centre Hz, level dB, bandwidth Hz) of the vowels a, e, i, o, u: a tenor voice, from the formant
 * table in the Csound manual (after Peterson and Barney's measurements). Then the rounded front vowels ü and ö,
 * with the voice source's frequencies (src/core/dsp/formants.ts) and levels that fall off like i's and o's.
 */
const VOWELS: { f: number[]; a: number[]; bw: number[] }[] = [
  { f: [650, 1080, 2650, 2900, 3250], a: [0, -6, -7, -8, -22], bw: [80, 90, 120, 130, 140] },
  { f: [400, 1700, 2600, 3200, 3580], a: [0, -14, -12, -14, -20], bw: [70, 80, 100, 120, 120] },
  { f: [290, 1870, 2800, 3250, 3540], a: [0, -15, -18, -20, -30], bw: [40, 90, 100, 120, 120] },
  { f: [400, 800, 2600, 2800, 3000], a: [0, -10, -12, -12, -26], bw: [40, 80, 100, 120, 120] },
  { f: [350, 600, 2700, 2900, 3300], a: [0, -20, -17, -14, -26], bw: [40, 60, 100, 120, 120] },
  { f: [270, 1650, 2100, 3200, 3550], a: [0, -15, -20, -24, -32], bw: [40, 80, 90, 120, 120] },
  { f: [370, 1450, 2200, 3100, 3500], a: [0, -12, -18, -22, -30], bw: [50, 80, 100, 120, 120] },
];
const LAST = VOWELS.length - 1;
const FORMANTS = 5;

/** The highest value a parameter reaches (for the tail estimate). */
function highest(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  const obj = v as { env?: unknown; value?: unknown } | undefined;
  const pts = isBreakpoints(v) ? v : obj?.env;
  if (isBreakpoints(pts)) return Math.max(...pts.map((p) => p[1]));
  return typeof obj?.value === 'number' ? obj.value : fallback;
}

/** Vowel (formant) filter for any input. */
export const formant: EffectDef = {
  kind: 'effect',
  type: 'formant',
  label: 'Formant filter',
  category: 'filter',
  doc:
    'Makes any sound speak a vowel: five resonances of a voice (a, e, i, o, u, ü, ö) filter the input, so a saw buzz ' +
    'becomes a talkbox, noise a whispered vowel and a growl a creature\'s throat. Sweep `vowel` for talking, wah ' +
    'and yowling mouths ([[0, 4], [0.3, 0]] goes u-o-i-e-a); `size` scales the throat, from a tiny gremlin (0.6) ' +
    'to a giant (2 to 3). Richer inputs (saw, pulse, noise, drive) speak more clearly than sines. The output is ' +
    'matched to the input\'s loudness.',
  params: {
    vowel: {
      kind: 'signal',
      doc: 'Vowel, 0 to 6: 0 a (open "ah"), 1 e, 2 i (bright "ee"), 3 o, 4 u (dark "oo"), 5 ü (German "über"), 6 ö (German "schön"; ü and ö are covered and darker than i and e); fractions morph between neighbours.',
      default: 0,
      min: 0,
      max: 6,
      hardMin: 0,
      hardMax: 6,
      unit: '',
    },
    size: {
      kind: 'signal',
      doc: 'Size of the vocal tract: 1 an adult voice, 0.5 to 0.7 a child or gremlin, 1.5 a big brute, 2 to 4 a giant or monster (formants an octave or two down).',
      default: 1,
      min: 0.4,
      max: 3,
      hardMin: 0.25,
      hardMax: 4,
      unit: 'x',
      scale: 'log',
    },
    resonance: {
      kind: 'number',
      doc: 'Sharpness of the formants: 1 natural, 0.5 soft and breathy, 2 to 4 ringing and whistling (synthetic, alien).',
      default: 1,
      min: 0.3,
      max: 4,
      hardMin: 0.1,
      hardMax: 10,
      unit: 'x',
      scale: 'log',
    },
  },
  example: { type: 'formant', vowel: [[0, 4], [0.4, 0]], size: 1.2 },
  tail(p) {
    const res = clamp(typeof p.resonance === 'number' ? p.resonance : 1, 0.1, 10);
    const size = clamp(highest(p.size, 1), 0.25, 4);
    // The narrowest band (40 Hz) rings longest: 60 dB in 6.9 Q / (pi f) = 6.9 / (pi bw).
    return Math.min((6.9 * res * size) / (Math.PI * 40), 2);
  },
  process(input, _p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const vowel = ctx.signal('vowel', n);
    const size = ctx.signal('size', n);
    const res = ctx.num('resonance');
    const before = energy(input);
    if (before <= 0) return input;
    const nyq = 0.45 * sr;
    const fc = new Float64Array(FORMANTS);
    const q = new Float64Array(FORMANTS);
    const amp = new Float64Array(FORMANTS);
    const filters = input.map(() => Array.from({ length: FORMANTS }, () => new Svf('bandpass', sr)));
    const out: Buf[] = input.map(() => new Float64Array(n));
    let lastV = NaN;
    let lastS = NaN;
    for (let i = 0; i < n; i++) {
      const v = clamp(vowel[i], 0, LAST);
      const s = size[i];
      if (v !== lastV || s !== lastS) {
        lastV = v;
        lastS = s;
        const lo = Math.min(Math.floor(v), LAST - 1);
        const t = v - lo;
        const A = VOWELS[lo];
        const B = VOWELS[lo + 1];
        for (let k = 0; k < FORMANTS; k++) {
          const f = A.f[k] * Math.pow(B.f[k] / A.f[k], t);
          const bw = A.bw[k] + (B.bw[k] - A.bw[k]) * t;
          fc[k] = clamp(f / s, 20, nyq);
          q[k] = (f / bw) * res;
          amp[k] = Math.pow(10, (A.a[k] + (B.a[k] - A.a[k]) * t) / 20);
        }
      }
      for (let c = 0; c < input.length; c++) {
        const x = input[c][i];
        const bank = filters[c];
        let y = 0;
        for (let k = 0; k < FORMANTS; k++) y += amp[k] * bank[k].tick(x, fc[k], q[k]);
        out[c][i] = y;
      }
    }
    const after = energy(out);
    if (after > 0) {
      const g = Math.min(Math.sqrt(before / after), 100);
      for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= g;
    }
    return out;
  },
};
