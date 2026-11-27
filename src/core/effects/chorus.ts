import type { EffectDef } from '../nodes';
import { clamp, TAU } from '../dsp/math';
import { ModDelayLine } from '../dsp/moddelay';

/** Each further voice runs a little faster, so the voices never line up into one obvious wobble. */
const VOICE_RATE_STEP = 0.13;

export const chorus: EffectDef = {
  kind: 'effect',
  type: 'chorus',
  label: 'Chorus',
  category: 'modulation',
  doc:
    'Copies of the sound, each slightly delayed and gently detuned by a slow wobble, mixed with the original: ' +
    'thicker, shimmering, ensemble-like. In stereo the copies are spread left and right, which widens a mono layer. ' +
    'Reach for it on pads, drones, magic shimmers, choirs and synth tones; with high `depth` and `rate` it turns ' +
    'seasick and warbly (a broken tape, an underwater feel). The output already contains the original; lower `mix` ' +
    'for a subtler effect.',
  hint: 'Thickens the sound with slowly wobbling, detuned copies',
  widens: true,
  params: {
    rate: {
      kind: 'signal',
      doc: 'Wobble speed, Hz. 0.2 to 0.6 slow and lush, 0.8 to 1.5 classic, 3 to 8 a fast warble.',
      hint: 'How fast the copies wobble',
      default: 0.8,
      min: 0.05,
      max: 8,
      hardMin: 0.01,
      hardMax: 20,
      unit: 'Hz',
      scale: 'log',
    },
    depth: {
      kind: 'signal',
      doc: 'How far the delay swings, as a fraction of `delay`: 0.1 subtle, 0.25 rich (default), 0.5+ seasick detuning.',
      hint: 'How far they detune: subtle to seasick',
      default: 0.25,
      min: 0,
      max: 0.9,
      hardMin: 0,
      hardMax: 0.95,
      unit: '',
    },
    delay: {
      kind: 'number',
      doc: 'Average delay of the copies, seconds: 0.006 to 0.01 tight and bright, 0.012 to 0.02 classic, 0.03 doubling.',
      hint: 'Short is tight and bright, long sounds doubled',
      default: 0.012,
      min: 0.004,
      max: 0.04,
      hardMin: 0.001,
      hardMax: 0.1,
      unit: 's',
      scale: 'log',
    },
    voices: { kind: 'number', doc: 'Delayed copies, 1 to 4: 1 is a simple chorus, 3 to 4 a dense ensemble.', hint: 'More copies make a denser ensemble', default: 2, min: 1, max: 4, step: 1, hardMin: 1, hardMax: 6, unit: '' },
    spread: {
      kind: 'number',
      doc: 'Stereo spread of the copies, 0 to 1 (stereo output only): 0 the same in both ears, 1 opposite wobbles left and right (widest).',
      hint: 'Spreads the copies left and right',
      default: 1,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
  },
  example: { type: 'chorus', rate: 0.6, depth: 0.3, voices: 3 },
  tail(p) {
    const d = typeof p.delay === 'number' ? p.delay : 0.012;
    return clamp(d, 0, 0.1) * 2;
  },
  process(input, _p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const rate = ctx.signal('rate', n);
    const depth = ctx.signal('depth', n);
    const base = ctx.num('delay') * sr;
    const voices = clamp(Math.round(ctx.num('voices')), 1, 6);
    const spread = clamp(ctx.num('spread'), 0, 1);
    // Phase per voice (cycles) and a shared phase increment; voices run at slightly different rates.
    const inc = new Float64Array(n);
    for (let i = 0; i < n; i++) inc[i] = rate[i] / sr;
    // The copies at about their own level beside the original; scaled so the sum is about as loud as the input.
    const wetGain = 1 / Math.sqrt(voices);
    const norm = Math.SQRT1_2;
    input.forEach((ch, c) => {
      const line = new ModDelayLine(base * 2 + 8);
      const phase = new Float64Array(voices);
      for (let v = 0; v < voices; v++) phase[v] = v / voices + (c === 1 ? (spread * 0.5) / voices : 0);
      for (let i = 0; i < n; i++) {
        const x = ch[i];
        const dep = clamp(depth[i], 0, 0.95);
        let wet = 0;
        for (let v = 0; v < voices; v++) {
          wet += line.read(base * (1 + dep * Math.sin(TAU * phase[v])));
          phase[v] += inc[i] * (1 + VOICE_RATE_STEP * v);
          if (phase[v] >= 1) phase[v] -= 1;
        }
        line.write(x);
        ch[i] = (x + wet * wetGain) * norm;
      }
    });
    return input;
  },
};
