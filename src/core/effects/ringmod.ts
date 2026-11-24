import type { EffectDef } from '../nodes';
import { dcBlock } from '../dsp/filters';
import { clamp } from '../dsp/math';
import { oscillator, type Waveform } from '../dsp/oscillators';

const CARRIERS = ['sine', 'triangle', 'square', 'saw'] as const;

/** Ring modulation and amplitude modulation by an audio-rate carrier. */
export const ringmod: EffectDef = {
  kind: 'effect',
  type: 'ringmod',
  label: 'Ring modulator',
  category: 'modulation',
  doc:
    'Multiplies the sound by a carrier wave: every frequency in the input is replaced by its sum and difference ' +
    'with the carrier, which is inharmonic and metallic. Robot and dalek voices: sine at 30 to 80 Hz. Metallic, ' +
    'bell-like and alien tones from anything: 300 to 1500 Hz. Sci-fi radio: square carrier. `bias` keeps some of ' +
    'the original (amplitude modulation). Sweep `freq` for a sound that bends strangely.',
  params: {
    freq: {
      kind: 'signal',
      doc: 'Carrier frequency, Hz. 20 to 80 a robotic buzz, 100 to 400 a growling metal ring, 500 to 2000 bells and clangs, 2000+ a thin, whistling shimmer.',
      default: 220,
      min: 10,
      max: 5000,
      hardMin: 0.1,
      hardMax: 20000,
      unit: 'Hz',
      scale: 'log',
    },
    shape: {
      kind: 'enum',
      doc: 'Carrier wave: sine the cleanest (two sidebands), triangle a little richer, square and saw harsh and buzzy (many sidebands).',
      options: CARRIERS,
      default: 'sine',
    },
    bias: {
      kind: 'signal',
      doc: 'Keeps the original under the sidebands, 0 to 1: 0 pure ring modulation (the original pitch vanishes), 0.5 amplitude modulation, 1 no effect.',
      default: 0,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
  },
  example: { type: 'ringmod', freq: 55, shape: 'sine' },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const freq = ctx.signal('freq', n);
    const bias = ctx.signal('bias', n);
    const wave: Waveform = CARRIERS.includes(p.shape as (typeof CARRIERS)[number]) ? (p.shape as Waveform) : 'sine';
    const carrier = oscillator(wave, freq, ctx.sr, 0);
    for (const ch of input) {
      for (let i = 0; i < n; i++) {
        const b = clamp(bias[i], 0, 1);
        ch[i] *= b + (1 - b) * carrier[i];
      }
      // A carrier at a frequency the input also has makes a DC offset; take it out.
      dcBlock(ch, ctx.sr);
    }
    return input;
  },
};
