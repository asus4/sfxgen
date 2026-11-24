import type { SourceDef } from '../nodes';
import { noise as makeNoise, type NoiseColor } from '../dsp/noise';
import type { Buf } from '../dsp/math';

/** Coloured noise, the raw material of air, hiss, impacts' crack, rain and static. */
export const noise: SourceDef = {
  kind: 'source',
  type: 'noise',
  label: 'Noise',
  category: 'noise',
  doc:
    'Noise of a colour. white is bright hiss, pink is natural (wind, surf), brown is a dark rumble, blue and ' +
    'violet are thin fizz, velvet is smooth sparse clicks, crackle is random pops (fire, vinyl, static), digital is ' +
    'stepped random values (computer babble). Shape it with the voice `filter` (sweep its cutoff for whooshes) ' +
    'and the envelope.',
  defaultEnv: { attack: 0.002, decay: 0.3 },
  params: {
    color: {
      kind: 'enum',
      doc: 'Noise colour.',
      options: ['white', 'pink', 'brown', 'blue', 'violet', 'velvet', 'crackle', 'digital'],
      default: 'white',
    },
    density: {
      kind: 'signal',
      doc: 'Events per second for velvet, crackle and digital: from a few sparse pops to a dense fizz.',
      default: 1500,
      min: 5,
      max: 20000,
      hardMin: 0.1,
      hardMax: 48000,
      unit: 'Hz',
      scale: 'log',
    },
    width: { kind: 'number', doc: 'Stereo width, 0 (mono) to 1 (independent left and right).', default: 0, min: 0, max: 1 },
  },
  example: { type: 'noise', color: 'pink', filter: { mode: 'bandpass', cutoff: [[0, 300], [0.2, 3000], [0.5, 400]], q: 1.2 } },
  render(p, ctx) {
    const color = (p.color as NoiseColor) ?? 'white';
    const density = ctx.signal('density');
    const left = makeNoise(color, ctx.n, ctx.sr, ctx.rng.fork('l'), density);
    const width = ctx.num('width');
    if (width <= 0) return left;
    const other = makeNoise(color, ctx.n, ctx.sr, ctx.rng.fork('r'), density);
    const right = new Float64Array(ctx.n);
    // Blend the right channel from the left toward an independent one, keeping the level.
    const a = Math.cos((width * Math.PI) / 2);
    const b = Math.sin((width * Math.PI) / 2);
    for (let i = 0; i < ctx.n; i++) right[i] = a * left[i] + b * other[i];
    return [left, right] as [Buf, Buf];
  },
};
