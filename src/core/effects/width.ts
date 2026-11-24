import type { EffectDef } from '../nodes';
import { clamp } from '../dsp/math';

/** Stereo width (mid/side) and a Haas delay. */
export const width: EffectDef = {
  kind: 'effect',
  type: 'width',
  label: 'Width',
  category: 'space',
  doc:
    'Stereo width, in stereo output only. `width` scales the difference between left and right (mid/side): 0 ' +
    'folds to mono, 1 leaves it, 2 is extra wide. A mono layer has no difference to widen, so give it `haas`: the ' +
    'right channel is delayed by a few milliseconds and the ears hear two copies, which sounds wide. The image ' +
    'leans toward the left (the earlier ear; pan the track a little right to centre it), and the mono sum is ' +
    'comb-filtered, so keep haas under about 0.015 for sounds that must also work in mono.',
  widens: true,
  params: {
    width: {
      kind: 'signal',
      doc: 'Side level: 0 mono, 0.5 narrower, 1 unchanged, 1.5 wider (default), 2 very wide. Breakpoints open the image up over time.',
      default: 1.5,
      min: 0,
      max: 2,
      hardMin: 0,
      hardMax: 4,
      unit: 'x',
    },
    haas: {
      kind: 'number',
      doc: 'Seconds the right channel is delayed, before the width: 0 off, 0.005 to 0.012 wide and still focused, 0.02 to 0.03 very wide (and a near-echo).',
      default: 0,
      min: 0,
      max: 0.03,
      hardMin: 0,
      hardMax: 0.05,
      unit: 's',
      scale: 'log',
    },
  },
  example: { type: 'width', haas: 0.008, width: 1.3 },
  tail(p) {
    return clamp(typeof p.haas === 'number' ? p.haas : 0, 0, 0.05);
  },
  process(input, _p, ctx) {
    if (input.length < 2) return input;
    const n = input[0].length;
    const [l, r] = input;
    const d = Math.round(ctx.num('haas') * ctx.sr);
    if (d > 0) {
      r.copyWithin(d, 0, Math.max(0, n - d));
      r.fill(0, 0, Math.min(d, n));
    }
    const w = ctx.signal('width', n);
    for (let i = 0; i < n; i++) {
      const mid = 0.5 * (l[i] + r[i]);
      const side = 0.5 * (l[i] - r[i]) * w[i];
      l[i] = mid + side;
      r[i] = mid - side;
    }
    return input;
  },
};
