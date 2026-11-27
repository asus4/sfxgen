import type { EffectDef, ParamMeta } from '../nodes';
import { grainShift } from '../dsp/grainshift';
import { rms, type Buf } from '../dsp/math';

const PARAMS: Record<string, ParamMeta> = {
  semitones: {
    kind: 'signal',
    doc:
      'Pitch shift in semitones; the length stays the same. -12 an octave down (bigger, heavier), +12 an octave up ' +
      '(smaller, cartoonish), 0.1 to 0.3 a subtle thickening. Breakpoints glide the pitch: [[0, 0], [1, -12]] ' +
      'sinks an octave over a second.',
    hint: 'Shift the pitch; the length stays the same',
    default: 0,
    min: -24,
    max: 24,
    hardMin: -36,
    hardMax: 36,
    unit: 'st',
  },
  grain: {
    kind: 'number',
    doc:
      'Grain length in ms. 30 to 60 suits most sounds; shorter keeps hits and clicks tight but roughens low tones, ' +
      'longer smooths sustained tones but smears attacks into short echoes.',
    hint: 'Short keeps hits tight, long smooths tones',
    default: 50,
    min: 15,
    max: 150,
    hardMin: 5,
    hardMax: 500,
    unit: 'ms',
    scale: 'log',
  },
};

/** Pitch shift that keeps the duration: overlapped grains that stay in phase from one to the next. */
export const pitch: EffectDef = {
  kind: 'effect',
  type: 'pitch',
  label: 'Pitch shift',
  category: 'pitch',
  doc:
    'Changes the pitch without changing the length (use `varispeed` for tape-style pitch and length together). ' +
    'Down for heavier, bigger versions of a sound; up for smaller, lighter ones; a moving `semitones` for sinking ' +
    'or rising pitch over a fixed sound. Granular: four overlapping grains, each aligned to the previous one so ' +
    'tones do not flutter; very large shifts of percussive sounds smear attacks a little.',
  hint: 'Changes the pitch, not the length',
  params: PARAMS,
  example: { type: 'pitch', semitones: -7, grain: 45 },
  tail(params) {
    const g = typeof params.grain === 'number' ? params.grain : 50;
    return Math.min(Math.max(g, 5), 500) / 2000;
  },
  process(input, _p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    const st = ctx.signal('semitones', n);
    let moving = false;
    for (let i = 0; i < n; i++) {
      if (st[i] !== 0) {
        moving = true;
        break;
      }
    }
    if (!moving) return input;
    const ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) ratio[i] = Math.pow(2, st[i] / 12);
    const grain = (ctx.num('grain') / 1000) * sr;
    let guide: Buf = input[0];
    if (input.length === 2) {
      guide = new Float64Array(n);
      for (let i = 0; i < n; i++) guide[i] = 0.5 * (input[0][i] + input[1][i]);
    }
    // Alignment search: half of the longest period it can lock to, up to 6 ms, and at most a quarter grain.
    const search = Math.min(0.006 * sr, grain / 4);
    const out = grainShift(input, guide, { sr, grain, ratio, search, wrap: ctx.loop });
    // Grains of noise overlap with less than full coherence and come out a little quieter: match the level.
    const before = rms(guide);
    let afterSum = 0;
    for (const ch of out) afterSum += rms(ch) ** 2;
    const after = Math.sqrt(afterSum / out.length);
    const g = after > 0 && before > 0 ? Math.min(Math.max(before / after, 0.5), 2) : 1;
    if (g !== 1) for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= g;
    return out;
  },
};
