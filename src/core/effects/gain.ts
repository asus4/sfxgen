import type { EffectDef } from '../nodes';
import { dbToGain } from '../dsp/math';

export const gain: EffectDef = {
  kind: 'effect',
  type: 'gain',
  label: 'Gain',
  category: 'utility',
  doc:
    'Level over time in dB: draw swells, fades and ducks with breakpoints measured from the start of the track ' +
    '(a riser that swells for 1.5 s and cuts: [[0, -30], [1.5, 0], [1.52, -90]]). `invert` flips polarity.',
  hint: 'Level over time: swells, fades and ducks',
  params: {
    gain: { kind: 'signal', doc: 'Level, dB.', hint: 'Level', default: 0, min: -60, max: 24, hardMin: -200, hardMax: 48, unit: 'dB' },
    invert: { kind: 'bool', doc: 'Flip the polarity.', hint: 'Flip the waveform upside down', default: false },
  },
  example: { type: 'gain', gain: [[0, -40], [1.2, 0]] },
  process(input, p, ctx) {
    const n = input[0].length;
    const g = ctx.signal('gain', n);
    const sign = p.invert ? -1 : 1;
    return input.map((ch) => {
      for (let i = 0; i < n; i++) ch[i] *= sign * dbToGain(g[i]);
      return ch;
    });
  },
};
