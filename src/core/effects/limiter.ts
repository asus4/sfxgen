import type { EffectDef } from '../nodes';
import { dbToGain } from '../dsp/math';
import { absMax, boxAverage, maxOf, minAhead, onePoleCoef } from '../dsp/dynamics';

/** Brickwall lookahead peak limiter. */
export const limiter: EffectDef = {
  kind: 'effect',
  type: 'limiter',
  label: 'Limiter',
  category: 'dynamics',
  doc:
    'Brickwall peak limiter with lookahead: no sample ever goes over `ceiling`. Push `gain` into it to make a ' +
    'sound denser and louder (6 dB is firm, 12 dB squashed and loud, 18+ crushed). By default levels are measured ' +
    'from the input\'s own peak (`reference: "peak"`), so `{ "gain": 6 }` always takes 6 dB off the peaks and ' +
    'raises everything else by 6 dB, whatever the layer\'s level. Use `reference: "dbfs"` for an absolute safety ' +
    'ceiling, with the master\'s `normalize` set to none.',
  params: {
    gain: {
      kind: 'signal',
      doc: 'Input gain into the limiter, dB: the dB the peaks are pushed past the ceiling. 3 to 6 firm, 9 to 12 loud and dense, 18+ crushed. Breakpoints push harder over time.',
      default: 0,
      min: 0,
      max: 24,
      hardMin: -24,
      hardMax: 48,
      unit: 'dB',
    },
    ceiling: {
      kind: 'number',
      doc: 'Highest level the output may reach, dB relative to the input\'s peak (or dBFS with `reference: "dbfs"`, where -1 leaves room for export).',
      default: 0,
      min: -24,
      max: 0,
      hardMin: -60,
      hardMax: 24,
      unit: 'dB',
    },
    release: {
      kind: 'number',
      doc: 'Time constant for the gain to recover after a peak. 0.01 to 0.03 loud but gritty on low notes, 0.05 to 0.1 clean, 0.3+ smooth and slow.',
      default: 0.06,
      min: 0.005,
      max: 1,
      hardMin: 0.001,
      hardMax: 5,
      unit: 's',
      scale: 'log',
    },
    lookahead: {
      kind: 'number',
      doc: 'Seconds the gain starts coming down before a peak (no latency offline): the length of the gain ramp. 0.001 snappy, 0.003 clean, 0.01 smoothest.',
      default: 0.003,
      min: 0.0005,
      max: 0.01,
      hardMin: 0.0001,
      hardMax: 0.05,
      unit: 's',
      scale: 'log',
    },
    reference: {
      kind: 'enum',
      doc: 'What `ceiling` is measured from: peak (the input\'s own loudest sample) or dbfs (absolute full scale).',
      options: ['peak', 'dbfs'],
      default: 'peak',
    },
  },
  example: { type: 'limiter', gain: 8, release: 0.05 },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const gainDb = ctx.signal('gain', n);
    const level = absMax(input);
    let ceiling = dbToGain(ctx.num('ceiling'));
    if (p.reference !== 'dbfs') {
      const top = maxOf(level);
      if (top <= 1e-12) return input;
      ceiling *= top;
    }
    const g = new Float64Array(n);
    // The gain each sample needs on its own (input gain included).
    const need = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      g[i] = dbToGain(gainDb[i]);
      const v = level[i] * g[i];
      need[i] = v > ceiling ? ceiling / v : 1;
    }
    // Lookahead: the minimum over the next `la` samples, smoothed by two moving averages whose lengths add up to
    // la + 2. Every average then only mixes values that already allow for the peak, so nothing overshoots.
    const la = Math.max(1, Math.round(ctx.num('lookahead') * sr));
    const l1 = Math.ceil((la + 2) / 2);
    const l2 = la + 2 - l1;
    const ramp = boxAverage(boxAverage(minAhead(need, la), l1), l2);
    // Release: follow the ramp down at once, recover toward it at the release rate (never above it).
    const aR = onePoleCoef(ctx.num('release'), sr);
    let h = 1;
    for (let i = 0; i < n; i++) {
      const r = ramp[i];
      h = r < h ? r : h + (r - h) * (1 - aR);
      g[i] *= h;
    }
    for (const ch of input) {
      for (let i = 0; i < n; i++) {
        const y = ch[i] * g[i];
        // Float rounding in the running averages is the only way past the ceiling; clamp it away.
        ch[i] = y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
      }
    }
    return input;
  },
};
