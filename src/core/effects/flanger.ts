import type { EffectDef } from '../nodes';
import { clamp } from '../dsp/math';
import { ModDelayLine } from '../dsp/moddelay';
import { renderFxLfo } from '../dsp/fxlfo';

const SHAPES = ['triangle', 'sine'] as const;
/** Hz; keeps the feedback loop from building up DC and sub rumble. */
const FEEDBACK_HIGHPASS = 20;

/** Flanger with feedback: comb-filter sweeps, from a gentle swirl to a jet. */
export const flanger: EffectDef = {
  kind: 'effect',
  type: 'flanger',
  label: 'Flanger',
  category: 'modulation',
  doc:
    'Mixes the sound with a copy delayed by a few milliseconds while the delay sweeps, so a comb of notches ' +
    'slides up and down: a swirling, whooshing sweep. Feedback sharpens the notches into ringing peaks: the jet ' +
    'plane (feedback 0.7 to 0.9, rate 0.1 to 0.3 on noise or a rumble), metallic robots and sci-fi doors ' +
    '(negative feedback is hollower). For one sweep instead of a cycle, set `depth: 0` and draw `delay` with ' +
    'breakpoints: [[0, 0.008], [2, 0.0003]] is a jet passing. The output already contains the original.',
  widens: true,
  params: {
    delay: {
      kind: 'signal',
      doc: 'Centre of the sweep, seconds: 0.001 bright and zingy, 0.003 classic, 0.008 lower and chorus-like. Breakpoints draw the sweep by hand.',
      default: 0.003,
      min: 0.0003,
      max: 0.012,
      hardMin: 0.00005,
      hardMax: 0.03,
      unit: 's',
      scale: 'log',
    },
    depth: {
      kind: 'signal',
      doc: 'How far the LFO sweeps the delay either side of its centre, 0 to 1: 0.3 a gentle swirl, 0.7 classic, 0.95 near zero and back (the full jet).',
      default: 0.7,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
    rate: {
      kind: 'signal',
      doc: 'Sweep speed, Hz: 0.05 to 0.3 slow jet, 0.5 to 2 swirling, 3+ wobbly.',
      default: 0.25,
      min: 0.02,
      max: 5,
      hardMin: 0.001,
      hardMax: 20,
      unit: 'Hz',
      scale: 'log',
    },
    feedback: {
      kind: 'number',
      doc: 'How much of the delayed sound goes round again, -0.95 to 0.95: 0 soft notches, 0.5 pronounced, 0.8+ resonant and metallic; negative is hollower.',
      default: 0.5,
      min: -0.95,
      max: 0.95,
      hardMin: -0.98,
      hardMax: 0.98,
      unit: '',
    },
    shape: { kind: 'enum', doc: 'Sweep shape: triangle (even, classic) or sine (lingers at the ends).', options: SHAPES, default: 'triangle' },
    stereo: {
      kind: 'number',
      doc: 'Phase offset of the right channel\'s sweep in cycles (stereo output only): 0 the same, 0.25 swirling width, 0.5 opposite.',
      default: 0.25,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
  },
  example: { type: 'flanger', rate: 0.15, depth: 0.9, feedback: 0.8 },
  tail(p) {
    const d = typeof p.delay === 'number' ? p.delay : 0.003;
    const fb = clamp(Math.abs(typeof p.feedback === 'number' ? p.feedback : 0.5), 0, 0.98);
    // Round trips for the feedback to fall 60 dB.
    const trips = fb > 0.01 ? Math.log(1000) / -Math.log(fb) : 1;
    return Math.min(2 * clamp(d, 0, 0.03) * (trips + 1), 3);
  },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const delay = ctx.signal('delay', n);
    const depth = ctx.signal('depth', n);
    const rate = ctx.signal('rate', n);
    const fb = clamp(ctx.num('feedback'), -0.98, 0.98);
    const shape = p.shape === 'sine' ? 'sine' : 'triangle';
    const stereo = clamp(ctx.num('stereo'), 0, 1);
    let longest = 0;
    for (let i = 0; i < n; i++) if (delay[i] > longest) longest = delay[i];
    // Keeps broadband material about as loud as it went in, whatever the feedback (white-noise power gain of the comb).
    const norm = 1 / Math.sqrt(1 + 1 / (1 - fb * fb));
    // A high-pass in the feedback path: one comb peak sits at 0 Hz, and strong feedback would pile up DC there.
    const dcA = 1 - Math.exp((-2 * Math.PI * FEEDBACK_HIGHPASS) / sr);
    input.forEach((ch, c) => {
      const lfo = renderFxLfo(shape, rate, sr, c * stereo, ctx.rng.fork('lfo'));
      const line = new ModDelayLine(longest * 2 * sr + 8);
      let low = 0;
      for (let i = 0; i < n; i++) {
        const x = ch[i];
        const d = line.read(delay[i] * sr * (1 + clamp(depth[i], 0, 1) * lfo[i]));
        low += (d - low) * dcA;
        line.write(x + fb * (d - low));
        ch[i] = (x + d) * norm;
      }
    });
    return input;
  },
};
