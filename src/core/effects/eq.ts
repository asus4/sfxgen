import type { EffectDef, ParamMap } from '../nodes';
import type { ParamValue } from '../format/types';
import { compileSignal, isBreakpoints } from '../params';
import { clamp, dbToGain, type Buf } from '../dsp/math';

const BAND_MODES = ['lowcut', 'highcut', 'lowshelf', 'highshelf', 'peak', 'notch'] as const;
type BandMode = (typeof BAND_MODES)[number];
const SLOPES = ['6', '12', '18', '24', '36', '48'] as const;
const MAX_BANDS = 8;
const SQRT1_2 = Math.SQRT1_2;
const COEF_STRIDE = 4;

const BAND_FIELDS: ParamMap = {
  id: { kind: 'string', doc: 'Name for paths and controls, e.g. `tracks.x.fx.eq.bands.air.gain` for the band `"id": "air"`.', hint: 'Name to reach this band from controls' },
  mode: {
    kind: 'enum',
    doc:
      'Band shape. lowcut removes everything below `freq` (rumble, mud; `slope` sets how steep), highcut ' +
      'everything above (fizz, hiss: a darker, farther sound). lowshelf and highshelf tilt everything below or ' +
      'above `freq` by `gain` (weight, air). peak boosts or cuts a bell around `freq` (presence at 2 to 5 kHz, ' +
      'boxiness at 300 to 600 Hz). notch removes a narrow band (a whistle, a hum).',
    hint: 'Cut the lows or highs, tilt, boost or cut, or notch',
    options: BAND_MODES,
    default: 'peak',
  },
  freq: {
    kind: 'signal',
    doc:
      'Corner or centre frequency. 30 to 80 Hz sub and rumble, 100 to 250 body, 300 to 600 box and mud, 1 to 4 kHz ' +
      'presence and bite, 5 to 10 kHz sizzle, 10 to 16 kHz air. Breakpoints sweep it from the start of the buffer.',
    hint: 'Which frequency the band works on',
    default: 1000,
    min: 20,
    max: 20000,
    hardMin: 10,
    hardMax: 24000,
    unit: 'Hz',
    scale: 'log',
  },
  gain: {
    kind: 'signal',
    doc: 'Boost (+) or cut (-) for peak and shelf bands, dB. ±3 is a nudge, ±6 clear, ±12 drastic. Cuts and notches ignore it.',
    hint: 'Boost or cut',
    default: 0,
    min: -24,
    max: 24,
    hardMin: -48,
    hardMax: 36,
    unit: 'dB',
  },
  q: {
    kind: 'signal',
    doc:
      'Width or resonance. peak: 0.5 broad and gentle, 0.7 musical (default), 2 to 5 narrow, 10+ surgical. notch: 2 ' +
      'to 10 (higher is narrower). Cuts and shelves: 0.707 is flat; 1.5 to 4 adds a resonant bump at the corner (a ' +
      'cut that rings like an analog synth filter). Ignored by 6 dB cuts.',
    hint: 'Narrow or wide; on a cut, adds a resonant bump',
    default: 0.707,
    min: 0.3,
    max: 20,
    hardMin: 0.05,
    hardMax: 50,
    scale: 'log',
    unit: '',
  },
  slope: {
    kind: 'enum',
    doc: 'Steepness of lowcut and highcut, dB per octave: 6 gentle, 12 (default) and 24 clean, 36 and 48 a brick wall.',
    hint: 'How steep the cut is',
    options: SLOPES,
    default: '12',
  },
  bypass: { kind: 'bool', doc: 'Skip this band (for comparing with and without).', hint: 'Turn this band off to compare', default: false },
};

/** Q of each second-order section of an order-n Butterworth filter, the most resonant first. */
function butterworthQs(order: number): number[] {
  const qs: number[] = [];
  for (let k = 1; k <= Math.floor(order / 2); k++) qs.push(1 / (2 * Math.sin(((2 * k - 1) * Math.PI) / (2 * order))));
  return qs;
}

/**
 * Runs one band over every channel in place: up to four trapezoidal state-variable sections (Simper's SVF, stable
 * under fast sweeps) and, for odd cut slopes, a first-order section. Coefficients are recomputed only when a
 * parameter moves, at most every `COEF_STRIDE` samples (a 12 kHz control rate at 48 kHz: no audible steps).
 */
function runBand(chs: Buf[], mode: BandMode, order: number, freq: Buf, gain: Buf, q: Buf, sr: number): void {
  const n = chs[0].length;
  const nc = chs.length;
  const cut = mode === 'lowcut' || mode === 'highcut';
  const baseQ = cut ? butterworthQs(order) : [1];
  const sos = baseQ.length;
  const first = cut && order % 2 === 1;
  const ic1 = new Float64Array(nc * sos);
  const ic2 = new Float64Array(nc * sos);
  const s1 = new Float64Array(nc);
  const a1 = new Float64Array(sos);
  const a2 = new Float64Array(sos);
  const a3 = new Float64Array(sos);
  const m0 = new Float64Array(sos);
  const m1 = new Float64Array(sos);
  const m2 = new Float64Array(sos);
  let G1 = 0;
  let lastF = NaN;
  let lastG = NaN;
  let lastQ = NaN;
  const nyq = sr * 0.49;
  const highpass = mode === 'lowcut';
  const usesGain = mode === 'peak' || mode === 'lowshelf' || mode === 'highshelf';
  for (let i = 0; i < n; i++) {
    const f = freq[i];
    const gdb = usesGain ? gain[i] : 0;
    const qq = q[i];
    if (i % COEF_STRIDE === 0 && (f !== lastF || gdb !== lastG || qq !== lastQ)) {
      lastF = f;
      lastG = gdb;
      lastQ = qq;
      const w = Math.tan((Math.PI * clamp(f, 10, nyq)) / sr);
      const A = Math.pow(10, gdb / 40);
      for (let s = 0; s < sos; s++) {
        let g = w;
        let k: number;
        switch (mode) {
          case 'lowcut':
          case 'highcut': {
            // The resonance goes on the most resonant section, so q 0.707 stays a clean Butterworth.
            const Q = s === 0 && order >= 2 ? baseQ[0] * (qq / SQRT1_2) : baseQ[s];
            k = 1 / Q;
            if (highpass) {
              m0[s] = 1;
              m1[s] = -k;
              m2[s] = -1;
            } else {
              m0[s] = 0;
              m1[s] = 0;
              m2[s] = 1;
            }
            break;
          }
          case 'peak':
            k = 1 / (qq * A);
            m0[s] = 1;
            m1[s] = k * (A * A - 1);
            m2[s] = 0;
            break;
          case 'notch':
            k = 1 / qq;
            m0[s] = 1;
            m1[s] = -k;
            m2[s] = 0;
            break;
          case 'lowshelf':
            g = w / Math.sqrt(A);
            k = 1 / qq;
            m0[s] = 1;
            m1[s] = k * (A - 1);
            m2[s] = A * A - 1;
            break;
          case 'highshelf':
            g = w * Math.sqrt(A);
            k = 1 / qq;
            m0[s] = A * A;
            m1[s] = k * (1 - A) * A;
            m2[s] = 1 - A * A;
            break;
        }
        const d = 1 / (1 + g * (g + k));
        a1[s] = d;
        a2[s] = g * d;
        a3[s] = g * g * d;
      }
      G1 = w / (1 + w);
    }
    for (let c = 0; c < nc; c++) {
      const ch = chs[c];
      let x = ch[i];
      if (first) {
        const v = (x - s1[c]) * G1;
        const lp = v + s1[c];
        s1[c] = lp + v;
        x = highpass ? x - lp : lp;
      }
      for (let s = 0; s < sos; s++) {
        const j = c * sos + s;
        const v3 = x - ic2[j];
        const v1 = a1[s] * ic1[j] + a2[s] * v3;
        const v2 = ic2[j] + a2[s] * ic1[j] + a3[s] * v3;
        ic1[j] = 2 * v1 - ic1[j];
        ic2[j] = 2 * v2 - ic2[j];
        x = m0[s] * x + m1[s] * v1 + m2[s] * v2;
      }
      ch[i] = x;
    }
  }
}

function isZero(x: Buf): boolean {
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) return false;
  return true;
}

/** The lowest or highest value a parameter reaches (for the tail estimate). */
function extreme(v: unknown, fallback: number, pick: (...xs: number[]) => number): number {
  const obj = v as { env?: unknown; value?: unknown } | undefined;
  const pts = isBreakpoints(v) ? v : obj?.env;
  const r = typeof v === 'number' ? v : isBreakpoints(pts) ? pick(...pts.map((p) => p[1])) : obj?.value;
  return typeof r === 'number' && Number.isFinite(r) ? r : fallback;
}

type BandSpec = Record<string, unknown>;

export const eq: EffectDef = {
  kind: 'effect',
  type: 'eq',
  label: 'EQ',
  category: 'filter',
  doc:
    'Parametric EQ: up to 8 bands in series, each a lowcut, highcut, lowshelf, highshelf, peak or notch. Reach ' +
    'for it to fit a layer into the mix (cut the lows a layer does not need so the layers stop muddying each ' +
    'other), to shape tone (a presence peak for bite, a high shelf for air, a highcut for distance) or to remove a ' +
    'whistle with a notch. Every band\'s freq, gain and q can move over time. For one resonant sweep use `filter`.',
  hint: 'Shape the tone: cut, boost or remove frequencies',
  params: {
    bands: {
      kind: 'array',
      doc:
        'The bands, applied in order (8 at most; more are ignored): [{ "mode": "lowcut", "freq": 120, "slope": "24" }, ' +
        '{ "mode": "peak", "freq": 3000, "gain": 4, "q": 1.2 }, { "mode": "highshelf", "freq": 9000, "gain": -6 }]. ' +
        'Give a band an `id` to reach it by name from controls.',
      hint: 'The bands, applied in order',
      default: [],
      item: { kind: 'object', doc: 'One band: { mode, freq, gain, q, slope }.', hint: 'One band', fields: BAND_FIELDS },
    },
    output: { kind: 'number', doc: 'Level after the EQ, dB: make up for big cuts or boosts.', hint: 'Level after the EQ', default: 0, min: -24, max: 24, hardMin: -60, hardMax: 36, unit: 'dB' },
  },
  example: {
    type: 'eq',
    bands: [
      { mode: 'lowcut', freq: 90, slope: '24' },
      { mode: 'peak', freq: 400, gain: -4, q: 1.4 },
      { mode: 'highshelf', freq: 8000, gain: 3 },
    ],
  },
  tail(p) {
    // High-Q bands ring for about Q / (pi f) seconds per neper; 60 dB is 6.9 of those.
    let t = 0;
    for (const b of (Array.isArray(p.bands) ? p.bands : []).slice(0, MAX_BANDS) as BandSpec[]) {
      if (!b || typeof b !== 'object' || b.bypass) continue;
      const f = clamp(extreme(b.freq, 1000, Math.min), 10, 24000);
      const order = SLOPES.includes(String(b.slope ?? '12') as (typeof SLOPES)[number]) ? Number(b.slope ?? 12) / 6 : 2;
      const cut = b.mode === 'lowcut' || b.mode === 'highcut';
      const q = clamp(extreme(b.q, SQRT1_2, Math.max), 0.05, 50) * (cut ? butterworthQs(Math.max(order, 2))[0] / SQRT1_2 : 1);
      t = Math.max(t, (6.9 * q) / (Math.PI * f));
    }
    return Math.min(t, 2);
  },
  process(input, p, ctx) {
    const n = input[0].length;
    const sr = ctx.sr;
    const bands = (Array.isArray(p.bands) ? p.bands : []).slice(0, MAX_BANDS) as BandSpec[];
    bands.forEach((b, k) => {
      if (!b || typeof b !== 'object' || b.bypass === true) return;
      const mode: BandMode = BAND_MODES.includes(b.mode as BandMode) ? (b.mode as BandMode) : 'peak';
      const opts = (key: string) => ({ sr, n, rng: ctx.rng.fork('band', typeof b.id === 'string' ? b.id : k, key) });
      const freq = compileSignal(b.freq as ParamValue | undefined, BAND_FIELDS.freq, opts('freq'));
      const gain = compileSignal(b.gain as ParamValue | undefined, BAND_FIELDS.gain, opts('gain'));
      const q = compileSignal(b.q as ParamValue | undefined, BAND_FIELDS.q, opts('q'));
      const slope = SLOPES.includes(String(b.slope ?? '12') as (typeof SLOPES)[number]) ? Number(b.slope ?? 12) : 12;
      const usesGain = mode === 'peak' || mode === 'lowshelf' || mode === 'highshelf';
      if (usesGain && isZero(gain)) return;
      runBand(input, mode, slope / 6, freq, gain, q, sr);
    });
    const out = dbToGain(ctx.num('output'));
    if (out !== 1) for (const ch of input) for (let i = 0; i < n; i++) ch[i] *= out;
    return input;
  },
};
