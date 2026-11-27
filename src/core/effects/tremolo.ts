import type { EffectDef } from '../nodes';
import { clamp } from '../dsp/math';
import { FX_LFO_SHAPES, lfoIsSmooth, renderFxLfo, softenLfo, type FxLfoShape } from '../dsp/fxlfo';

/** Tremolo and auto-pan. */
export const tremolo: EffectDef = {
  kind: 'effect',
  type: 'tremolo',
  label: 'Tremolo',
  category: 'modulation',
  doc:
    'Level wobble from an LFO: shimmer and pulse (sine, 4 to 8 Hz), throb (sine, 1 to 3 Hz), helicopter or ' +
    'rotor chop (square, 10 to 25 Hz), stutter and glitch (square or random, depth 1), alarm pulses. In stereo, ' +
    '`stereo: 0.5` swings the sound between left and right (auto-pan). Above about 30 Hz it turns into a rough, ' +
    'buzzing amplitude modulation. `rate` can move: a rotor spinning up is [[0, 4], [1.5, 22]].',
  hint: 'Pulses the volume: shimmer, throb or chop',
  widens: true,
  params: {
    rate: {
      kind: 'signal',
      doc: 'LFO speed, Hz. 0.5 to 3 slow throb, 4 to 8 classic tremolo, 10 to 25 chop and flutter, 30+ buzzing.',
      hint: 'How fast it pulses',
      default: 6,
      min: 0.1,
      max: 40,
      hardMin: 0.01,
      hardMax: 2000,
      unit: 'Hz',
      scale: 'log',
    },
    depth: {
      kind: 'signal',
      doc: 'How deep the dips go, 0 to 1: 0.2 a subtle shimmer, 0.5 clear, 1 down to silence (a chop with square).',
      hint: 'How deep the dips go',
      default: 0.5,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
    shape: {
      kind: 'enum',
      doc: 'LFO shape: sine smooth, triangle even, square on-off chop, saw a pulse that fades, ramp one that swells, random a new level each cycle (flicker).',
      hint: 'Smooth, choppy or random pulses',
      options: FX_LFO_SHAPES,
      default: 'sine',
    },
    phase: {
      kind: 'number',
      doc:
        'Where in the cycle it starts, 0 to 1. Sine and triangle: 0 halfway and rising, 0.25 full level, 0.75 the ' +
        'deepest dip. Square and saw start at full level, ramp at the dip; 0.5 flips them.',
      hint: 'Where in the pulse it starts',
      default: 0,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
    stereo: {
      kind: 'number',
      doc: 'Phase offset of the right channel in cycles (stereo output only): 0 both pulse together, 0.5 they alternate (auto-pan), 0.25 a circling motion.',
      hint: 'Alternate left and right',
      default: 0,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
  },
  example: { type: 'tremolo', rate: 18, depth: 0.9, shape: 'square' },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const rate = ctx.signal('rate', n);
    const depth = ctx.signal('depth', n);
    const shape: FxLfoShape = FX_LFO_SHAPES.includes(p.shape as FxLfoShape) ? (p.shape as FxLfoShape) : 'sine';
    const phase = ctx.num('phase');
    const stereo = clamp(ctx.num('stereo'), 0, 1);
    input.forEach((ch, c) => {
      const lfo = renderFxLfo(shape, rate, sr, phase + c * stereo, ctx.rng.fork('lfo'));
      if (!lfoIsSmooth(shape)) softenLfo(lfo, sr);
      for (let i = 0; i < n; i++) ch[i] *= 1 - clamp(depth[i], 0, 1) * 0.5 * (1 - lfo[i]);
    });
    return input;
  },
};
