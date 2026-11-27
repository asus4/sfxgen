import type { EffectDef } from '../nodes';
import type { FilterType } from '../format/types';
import { filterBuffer } from '../dsp/filters';

/** A resonant filter over the whole track, its cutoff and resonance free to move over the track's time. */
export const filter: EffectDef = {
  kind: 'effect',
  type: 'filter',
  label: 'Filter',
  category: 'filter',
  doc:
    'Resonant state-variable filter over the whole track (or bus/master). Use the voice `filter` instead when ' +
    'each event needs its own sweep. Breakpoints on `cutoff` are measured from the start of the track.',
  hint: 'A resonant filter over the whole layer',
  params: {
    mode: {
      kind: 'enum',
      doc: 'Filter shape.',
      hint: 'Filter type',
      options: ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'allpass', 'lowshelf', 'highshelf'],
      default: 'lowpass',
    },
    cutoff: {
      kind: 'signal',
      doc: 'Cutoff or centre frequency.',
      hint: 'Where the filter starts working',
      default: 2000,
      min: 20,
      max: 20000,
      hardMin: 5,
      hardMax: 24000,
      unit: 'Hz',
      scale: 'log',
    },
    q: { kind: 'signal', doc: 'Resonance: 0.707 flat, 2 to 10 rings.', hint: 'Resonance: higher rings', default: 0.707, min: 0.3, max: 20, hardMin: 0.05, hardMax: 200, scale: 'log' },
    gain: { kind: 'number', doc: 'dB for peak and shelf types.', hint: 'Boost or cut, for peak and shelf types', default: 0, min: -24, max: 24, unit: 'dB' },
    slope: { kind: 'enum', doc: '12 or 24 dB per octave.', hint: 'How steep the filter is', options: ['12', '24'], default: '12' },
  },
  example: { type: 'filter', mode: 'lowpass', cutoff: [[0, 8000], [0.5, 400]], q: 2 },
  process(input, p, ctx) {
    const n = input[0].length;
    const cutoff = ctx.signal('cutoff', n);
    const q = ctx.signal('q', n);
    const slope = String(p.slope ?? '12') === '24' ? 24 : 12;
    return input.map((ch) =>
      filterBuffer(ch, (p.mode as FilterType) ?? 'lowpass', cutoff, q, ctx.sr, { gainDb: ctx.num('gain'), slope }),
    );
  },
};
