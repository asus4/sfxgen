import type { ParamMeta, SourceDef } from '../nodes';
import type { ParamValue } from '../format/types';
import { constantOf } from '../params';
import { TAU } from '../dsp/math';

const ADDITIVE_PARTIAL_FIELDS: Record<string, ParamMeta> = {
  id: { kind: 'string', doc: 'Name for paths and controls: `tracks.glass.source.partials.<id>.amp`.', hint: 'Name to reach this partial from controls' },
  ratio: {
    kind: 'number',
    doc: 'Frequency as a multiple of `freq`. Measured bars and bells: 1, 2.76, 5.40, 8.93 (a free bar), 1, 2.32, 4.25, 6.63 (a glass).',
    hint: 'Pitch as a multiple of the base',
    default: 1,
    min: 0.25,
    max: 32,
    hardMin: 0.001,
    hardMax: 512,
    unit: 'x',
    scale: 'log',
  },
  amp: { kind: 'number', doc: 'Level of this partial, linear: 1 full, 0.5 is -6 dB.', hint: 'Level of this partial', default: 1, min: 0, max: 1, hardMin: 0, hardMax: 16 },
  decay: {
    kind: 'number',
    doc: 'Seconds for this partial to fall 60 dB; 0 sustains. Default: the source `decay` scaled by `damping`.',
    hint: 'How long this partial rings',
    min: 0,
    max: 10,
    hardMin: 0,
    hardMax: 120,
    unit: 's',
    scale: 'log',
  },
};

const PARAMS: Record<string, ParamMeta> = {
  freq: {
    kind: 'signal',
    doc: 'Fundamental frequency: every partial is a multiple of it. Breakpoints glide exponentially.',
    hint: 'Base pitch',
    default: 440,
    min: 20,
    max: 8000,
    hardMin: 1,
    hardMax: 20000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  harmonics: {
    kind: 'number',
    doc: 'How many harmonics, when `partials` is not given. 1 is a sine, 3 to 6 a soft beep or flute, 12 to 30 a full organ or brass-like tone.',
    hint: 'How many harmonics: a sine to a full organ',
    default: 8,
    min: 1,
    max: 32,
    step: 1,
    hardMin: 1,
    hardMax: 128,
  },
  tilt: {
    kind: 'signal',
    doc:
      'Spectral slope in dB per octave above `freq`: -3 bright and buzzy, -6 like a saw, -12 soft like a flute, ' +
      '-18 nearly a sine. It can move (a tone that opens up). Default -6; with explicit `partials`, 0 (their amps as written).',
    hint: 'Bright and buzzy to soft and pure',
    default: -6,
    min: -24,
    max: 6,
    hardMin: -60,
    hardMax: 24,
    unit: 'dB',
  },
  odd: {
    kind: 'number',
    doc: 'Odd/even balance of the harmonic series: 0.5 all harmonics, 1 odd only (hollow, clarinet or square-like), 0 the fundamental and even ones only (open, octave-like).',
    hint: 'Hollow like a clarinet, or open',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  stretch: {
    kind: 'number',
    doc:
      'Inharmonicity of the series, as in a stiff string: harmonic k sits at k * sqrt(1 + stretch k^2). 0 is exact, ' +
      '0.0005 a piano string, 0.005 a stiff wire, 0.05 a metal rod.',
    hint: 'Bends the harmonics out of tune, like a stiff wire',
    default: 0,
    min: 0,
    max: 0.02,
    hardMin: 0,
    hardMax: 0.5,
  },
  partials: {
    kind: 'array',
    doc:
      'Explicit partials instead of the harmonic series: `[{ "ratio": 1 }, { "ratio": 2.76, "amp": 0.6 }, { "ratio": 5.4, "amp": 0.3, "decay": 0.4 }]`.',
    hint: 'Pick each partial by hand, for bells and glass',
    item: { kind: 'object', doc: 'One partial: { ratio, amp, decay, id }.', hint: 'One partial', fields: ADDITIVE_PARTIAL_FIELDS },
  },
  decay: {
    kind: 'number',
    doc:
      'Seconds for the fundamental to fall 60 dB on its own; higher partials die sooner by `damping`. 0 makes every ' +
      'partial sustain, so the envelope alone shapes the sound (then give `env` a decay or the event a `dur`).',
    hint: 'How long it rings',
    default: 1.5,
    min: 0,
    max: 10,
    hardMin: 0,
    hardMax: 120,
    unit: 's',
    scale: 'log',
  },
  damping: {
    kind: 'number',
    doc:
      'How much faster higher partials die: a partial\'s decay is `decay` / ratio^damping. 0 all ring equally (glass, ' +
      'an organ), 1 natural for struck wood and metal, 2 dull and woody.',
    hint: 'How much sooner the high partials fade',
    default: 1,
    min: 0,
    max: 3,
    hardMin: 0,
    hardMax: 6,
  },
  beat: {
    kind: 'number',
    doc: 'Doubles each partial a few cents apart so it beats slowly like a real bell or glass: 2 to 6 cents shimmer, 15+ a chorus. 0 is off.',
    hint: 'A slow shimmer, like a real bell',
    default: 0,
    min: 0,
    max: 20,
    hardMin: 0,
    hardMax: 200,
    unit: 'cents',
  },
  width: {
    kind: 'number',
    doc: 'Stereo spread: each partial gets its own place, 0 (mono) to 1 (wide). Stereo output only.',
    hint: 'Spreads the partials left and right',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
};

interface Partial {
  ratio: number;
  amp: number;
  /** Seconds to fall 60 dB; 0 sustains. */
  decay: number;
}

type NumOf = (value: ParamValue | undefined, meta: ParamMeta) => number;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The partials an additive spec describes, before beating and tilt. */
function planPartials(p: Record<string, unknown>, num: NumOf): { list: Partial[]; explicit: boolean } {
  const baseDecay = num(p.decay as ParamValue | undefined, PARAMS.decay);
  const damping = num(p.damping as ParamValue | undefined, PARAMS.damping);
  const inherited = (ratio: number) => (baseDecay > 0 ? baseDecay * Math.pow(ratio, -damping) : 0);
  const given = Array.isArray(p.partials) ? (p.partials as unknown[]).filter(isObj) : [];
  const list: Partial[] = [];
  if (given.length > 0) {
    for (const item of given.slice(0, 256)) {
      const ratio = num(item.ratio as ParamValue | undefined, ADDITIVE_PARTIAL_FIELDS.ratio);
      const amp = num(item.amp as ParamValue | undefined, ADDITIVE_PARTIAL_FIELDS.amp);
      const decay = item.decay !== undefined ? num(item.decay as ParamValue, ADDITIVE_PARTIAL_FIELDS.decay) : inherited(ratio);
      list.push({ ratio, amp, decay });
    }
    return { list, explicit: true };
  }
  const count = Math.round(num(p.harmonics as ParamValue | undefined, PARAMS.harmonics));
  const b = num(p.stretch as ParamValue | undefined, PARAMS.stretch);
  const odd = num(p.odd as ParamValue | undefined, PARAMS.odd);
  const evenGain = Math.min(1, 2 * (1 - odd));
  const oddGain = Math.min(1, 2 * odd);
  const root = Math.sqrt(1 + b);
  for (let k = 1; k <= count; k++) {
    const ratio = (k * Math.sqrt(1 + b * k * k)) / root;
    const amp = k === 1 ? 1 : k % 2 === 0 ? evenGain : oddGain;
    list.push({ ratio, amp, decay: inherited(ratio) });
  }
  return { list, explicit: false };
}

export const additive: SourceDef = {
  kind: 'source',
  type: 'additive',
  label: 'Additive',
  category: 'tone',
  doc:
    'Sums of sine partials, each with its own level and decay. Use the harmonic series (`harmonics`, `tilt`, `odd`, ' +
    '`stretch`) for beeps, UI tones, organ and flute-like tones and drones, or explicit `partials` for chimes, glass, ' +
    'bars and bells with measured ratios. `decay` with `damping` makes the highs die first, the signature of a real ' +
    'struck object; `beat` adds the slow shimmer of a bell. When the partials decay on their own, leave the envelope ' +
    'without a decay (the default) so they ring out.',
  hint: 'Built from pure tones: beeps, organs, chimes and bells',
  defaultEnv: { attack: 0.003 },
  params: PARAMS,
  example: {
    type: 'additive',
    freq: 1320,
    partials: [{ ratio: 1 }, { ratio: 2.32, amp: 0.7 }, { ratio: 4.25, amp: 0.45 }, { ratio: 6.63, amp: 0.3 }],
    decay: 2.5,
    damping: 0.8,
    beat: 3,
    env: { attack: 0.001 },
  },
  naturalLength(p) {
    const { list } = planPartials(p, (v, m) => constantOf(v, m));
    let longest = 0;
    for (const q of list) {
      if (q.amp <= 0) continue;
      if (q.decay <= 0) return Infinity;
      longest = Math.max(longest, q.decay);
    }
    return longest + 0.02;
  },
  render(p, ctx) {
    const { n, sr } = ctx;
    const { list, explicit } = planPartials(p, (v, m) => ctx.numOf(v, m));
    const freq = ctx.signal('freq');
    const tilt = ctx.signal('tilt', (p.tilt ?? (explicit ? 0 : -6)) as ParamValue);
    const beat = ctx.num('beat');
    const width = ctx.num('width');

    // With `beat`, each partial becomes a pair a few cents apart, the second a little softer.
    const ratio: number[] = [];
    const amp: number[] = [];
    const decay: number[] = [];
    for (const q of list) {
      if (q.amp <= 0) continue;
      if (beat > 0) {
        const d = Math.pow(2, beat / 2400);
        ratio.push(q.ratio / d, q.ratio * d);
        amp.push(q.amp, q.amp * 0.7);
        decay.push(q.decay, q.decay);
      } else {
        ratio.push(q.ratio);
        amp.push(q.amp);
        decay.push(q.decay);
      }
    }
    const count = ratio.length;
    const out = new Float64Array(n);
    if (count === 0) return out;

    const phaseRng = ctx.rng.fork('phases');
    const panRng = ctx.rng.fork('pan');
    const phase = new Float64Array(count);
    const level = new Float64Array(count).fill(1);
    const perSample = new Float64Array(count);
    const octaves = new Float64Array(count);
    const panL = new Float64Array(count);
    const panR = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      phase[k] = phaseRng.next();
      perSample[k] = decay[k] > 0 ? Math.exp(-6.907755 / (decay[k] * sr)) : 1;
      octaves[k] = Math.log2(Math.max(ratio[k], 1e-6));
      const pan = width * panRng.uniform(-1, 1);
      panL[k] = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      panR[k] = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    }
    const stereo = width > 0;
    const right = stereo ? new Float64Array(n) : null;
    const nyqLo = 0.44 * sr;
    const nyqHi = 0.48 * sr;
    const gainAt = (k: number, i: number) => {
      const f = freq[i] * ratio[k];
      const fade = f < nyqLo ? 1 : f > nyqHi ? 0 : (nyqHi - f) / (nyqHi - nyqLo);
      return fade === 0 ? 0 : amp[k] * fade * Math.pow(10, (tilt[i] * octaves[k]) / 20);
    };

    // Level: a measure between the RMS and the worst-case sum of the partials keeps the peak near 1 for any count.
    // It is taken at the loudest moment (every 5 ms), so a glide into range or a tilt that opens up stays bounded
    // while still getting louder than where it started.
    const start = new Float64Array(count);
    for (let k = 0; k < count; k++) start[k] = gainAt(k, 0);
    let loudest = 0;
    for (let i = 0; ; i = Math.min(i + 256, n - 1)) {
      let sum = 0;
      let sumSq = 0;
      for (let k = 0; k < count; k++) {
        const g = i === 0 ? start[k] : gainAt(k, i);
        sum += g;
        sumSq += g * g;
      }
      loudest = Math.max(loudest, Math.sqrt(sum * Math.sqrt(sumSq)));
      if (i >= n - 1) break;
    }
    const norm = loudest > 0 ? 1 / loudest : 0;

    // Blocks of 32 samples: within a block each partial is a rotating phasor at the block's frequency, with its
    // gain (tilt, Nyquist fade) interpolated, so long series stay cheap while freq and tilt move.
    const B = 32;
    const gPrev = start.slice();
    for (let b0 = 0; b0 < n; b0 += B) {
      const len = Math.min(B, n - b0);
      const f0 = freq[b0 + (len >> 1)];
      const iEnd = Math.min(b0 + len, n - 1);
      for (let k = 0; k < count; k++) {
        const gA = gPrev[k];
        const gB = gainAt(k, iEnd);
        gPrev[k] = gB;
        const step = (f0 * ratio[k]) / sr;
        const e0 = level[k];
        const d = perSample[k];
        if ((gA === 0 && gB === 0) || e0 < 1e-7) {
          level[k] = e0 * Math.pow(d, len);
          phase[k] = (phase[k] + step * len) % 1;
          continue;
        }
        const w = TAU * step;
        const cw = Math.cos(w);
        const sw = Math.sin(w);
        let c = Math.cos(TAU * phase[k]);
        let s = Math.sin(TAU * phase[k]);
        let g = gA * norm;
        const dg = ((gB - gA) * norm) / len;
        let e = e0;
        if (right) {
          const l = panL[k];
          const r = panR[k];
          for (let j = 0; j < len; j++) {
            const v = s * g * e;
            out[b0 + j] += v * l;
            right[b0 + j] += v * r;
            const c2 = c * cw - s * sw;
            s = s * cw + c * sw;
            c = c2;
            g += dg;
            e *= d;
          }
        } else {
          for (let j = 0; j < len; j++) {
            out[b0 + j] += s * g * e;
            const c2 = c * cw - s * sw;
            s = s * cw + c * sw;
            c = c2;
            g += dg;
            e *= d;
          }
        }
        level[k] = e;
        phase[k] = (phase[k] + step * len) % 1;
        if (phase[k] < 0) phase[k] += 1;
      }
    }
    if (right) return [out, right];
    return out;
  },
};

