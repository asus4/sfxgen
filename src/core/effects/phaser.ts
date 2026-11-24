import type { EffectDef } from '../nodes';
import { clamp, TAU } from '../dsp/math';

const STAGES = ['2', '4', '6', '8', '10', '12'] as const;
/** Hz; keeps the feedback loop from building up DC and sub rumble. */
const FEEDBACK_HIGHPASS = 20;

/** Allpass phaser with feedback. */
export const phaser: EffectDef = {
  kind: 'effect',
  type: 'phaser',
  label: 'Phaser',
  category: 'modulation',
  doc:
    'A chain of allpass filters mixed with the original makes a few soft notches that sweep up and down: a ' +
    'smooth, vocal swirl, gentler and more liquid than a flanger. Reach for it on synth tones, engines, sci-fi ' +
    'hums, force fields and tired machinery. More `stages` make more notches; `feedback` makes them sing. For a ' +
    'single sweep set `depth: 0` and draw `freq` with breakpoints. The output already contains the original.',
  widens: true,
  params: {
    freq: {
      kind: 'signal',
      doc: 'Centre of the sweep, Hz: 300 to 600 dark and throaty, 800 to 1500 classic, 2000+ airy.',
      default: 800,
      min: 100,
      max: 5000,
      hardMin: 20,
      hardMax: 20000,
      unit: 'Hz',
      scale: 'log',
    },
    depth: {
      kind: 'signal',
      doc: 'How far the sweep goes either side of `freq`, octaves: 0.5 subtle, 1.5 classic, 3+ dramatic.',
      default: 1.5,
      min: 0,
      max: 4,
      hardMin: 0,
      hardMax: 6,
      unit: '',
    },
    rate: {
      kind: 'signal',
      doc: 'Sweep speed, Hz: 0.05 to 0.3 slow and hypnotic, 0.5 to 1 classic, 2 to 6 bubbling.',
      default: 0.4,
      min: 0.02,
      max: 8,
      hardMin: 0.001,
      hardMax: 30,
      unit: 'Hz',
      scale: 'log',
    },
    stages: {
      kind: 'enum',
      doc: 'Allpass stages; half as many notches: 2 a single gentle notch, 4 classic, 8 to 12 deep and dense.',
      options: STAGES,
      default: '4',
    },
    feedback: {
      kind: 'number',
      doc: 'Resonance, -0.95 to 0.95: 0 soft and subtle, 0.5 vocal, 0.8+ a singing whistle; negative moves the peaks between the notches.',
      default: 0.5,
      min: -0.95,
      max: 0.95,
      hardMin: -0.97,
      hardMax: 0.97,
      unit: '',
    },
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
  example: { type: 'phaser', freq: 700, depth: 2, rate: 0.25, stages: '6', feedback: 0.6 },
  tail(p) {
    const fb = clamp(Math.abs(typeof p.feedback === 'number' ? p.feedback : 0.5), 0, 0.97);
    return 0.02 + 0.05 * fb / (1 - fb);
  },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const freq = ctx.signal('freq', n);
    const depth = ctx.signal('depth', n);
    const rate = ctx.signal('rate', n);
    const stages = STAGES.includes(String(p.stages ?? '4') as (typeof STAGES)[number]) ? Number(p.stages ?? 4) : 4;
    const fb = clamp(ctx.num('feedback'), -0.97, 0.97);
    const stereo = clamp(ctx.num('stereo'), 0, 1);
    const lo = 20;
    const hi = 0.45 * sr;
    // Feedback raises resonant peaks between the notches; this keeps broadband material about as loud.
    const norm = 0.5 * Math.pow(1 - fb * fb, 0.25);
    // A high-pass in the feedback path: allpasses pass DC unchanged, and strong feedback would pile it up.
    const dcA = 1 - Math.exp((-2 * Math.PI * FEEDBACK_HIGHPASS) / sr);
    input.forEach((ch, c) => {
      const s = new Float64Array(stages);
      let phase = c * stereo;
      let last = 0;
      let low = 0;
      for (let i = 0; i < n; i++) {
        const f = clamp(freq[i] * Math.pow(2, depth[i] * Math.sin(TAU * phase)), lo, hi);
        phase += rate[i] / sr;
        if (phase >= 1) phase -= Math.floor(phase);
        const g = Math.tan((Math.PI * f) / sr);
        const G = g / (1 + g);
        const x = ch[i];
        low += (last - low) * dcA;
        let u = x + fb * (last - low);
        for (let k = 0; k < stages; k++) {
          // First-order allpass from a trapezoidal one-pole: 2 * lowpass - input.
          const v = (u - s[k]) * G;
          const lp = v + s[k];
          s[k] = lp + v;
          u = 2 * lp - u;
        }
        last = u;
        ch[i] = (x + u) * norm;
      }
    });
    return input;
  },
};
