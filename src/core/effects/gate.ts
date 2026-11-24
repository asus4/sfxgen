import type { EffectDef } from '../nodes';
import { dbToGain } from '../dsp/math';
import { absMax, advance, maxOf, runningMax, withPreroll } from '../dsp/dynamics';

/** The detector holds each peak this long, so the gate does not chatter on the zero crossings of a low note. */
const DETECT_HOLD = 0.005;

/** Noise gate and expander: chops tails, stutters and tightens. */
export const gate: EffectDef = {
  kind: 'effect',
  type: 'gate',
  label: 'Gate',
  category: 'dynamics',
  doc:
    'Closes when the sound falls below `threshold`, turning it down by `range`. Reach for it to chop a tail ' +
    'short (a gated boom, a dry hit from a ringing one), to cut the noise between hits, or for stutters on a ' +
    'rolling sound. By default the threshold is measured from the input\'s loudest moment (`reference: "peak"`): ' +
    '-20 keeps only the loud part of a hit, -40 trims the very end of a tail. A shallow `range` (-6 to -12) is a ' +
    'gentle expander that just pushes tails down.',
  params: {
    threshold: {
      kind: 'signal',
      doc: 'Level at which the gate opens, dB below the input\'s loudest moment (or dBFS with `reference: "dbfs"`). -10 to -20 chops hard, -30 to -50 trims tails.',
      default: -40,
      min: -80,
      max: 0,
      hardMin: -120,
      hardMax: 24,
      unit: 'dB',
    },
    range: {
      kind: 'number',
      doc: 'How far the closed gate turns the sound down, dB: -80 silence, -20 a clear dip, -6 a gentle expander.',
      default: -80,
      min: -90,
      max: 0,
      hardMin: -120,
      hardMax: 0,
      unit: 'dB',
    },
    attack: {
      kind: 'number',
      doc: 'Seconds to open fully. 0.0002 to 0.001 keeps the crack of a hit; 0.005 to 0.02 fades notes in softly.',
      default: 0.0005,
      min: 0.0001,
      max: 0.05,
      hardMin: 0.0001,
      hardMax: 1,
      unit: 's',
      scale: 'log',
    },
    hold: {
      kind: 'number',
      doc: 'Seconds the gate stays open after the sound drops below the threshold: stops it fluttering on a decaying note. 0.01 to 0.05.',
      default: 0.02,
      min: 0,
      max: 0.5,
      hardMin: 0,
      hardMax: 5,
      unit: 's',
      scale: 'log',
    },
    release: {
      kind: 'number',
      doc: 'Seconds to close (to fall 60 dB, or to `range` if that is shallower). 0.01 to 0.03 a hard chop, 0.1 to 0.3 a natural fade.',
      default: 0.08,
      min: 0.005,
      max: 1,
      hardMin: 0.002,
      hardMax: 10,
      unit: 's',
      scale: 'log',
    },
    lookahead: {
      kind: 'number',
      doc: 'Seconds the gate sees ahead, so it is already open when a hit arrives and the attack is never clipped (no latency offline).',
      default: 0.002,
      min: 0,
      max: 0.01,
      hardMin: 0,
      hardMax: 0.05,
      unit: 's',
      scale: 'log',
    },
    hysteresis: {
      kind: 'number',
      doc: 'dB below the threshold the level must fall before the gate closes again: stops chatter around the threshold.',
      default: 4,
      min: 0,
      max: 12,
      hardMin: 0,
      hardMax: 40,
      unit: 'dB',
      advanced: true,
    },
    reference: {
      kind: 'enum',
      doc: 'What `threshold` is measured from: peak (the input\'s loudest moment) or dbfs (absolute).',
      options: ['peak', 'dbfs'],
      default: 'peak',
    },
  },
  example: { type: 'gate', threshold: -24, hold: 0.04, release: 0.03 },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const threshold = ctx.signal('threshold', n);
    const level = runningMax(absMax(input), Math.max(1, Math.round(DETECT_HOLD * sr)));
    let ref = 1;
    if (p.reference !== 'dbfs') {
      ref = maxOf(level);
      if (ref <= 1e-12) return input;
    }
    const floor = dbToGain(ctx.num('range'));
    const attack = ctx.num('attack');
    const up = attack > 0 ? 1 / (attack * sr) : 1;
    const down = Math.pow(10, -3 / (ctx.num('release') * sr));
    const holdN = Math.round(ctx.num('hold') * sr);
    const hyst = dbToGain(-ctx.num('hysteresis'));
    const pre = ctx.loop ? Math.min(n, Math.round(sr)) : 0;
    const ext = withPreroll(level, pre);
    const k = ext.length - n;
    const g = new Float64Array(n);
    let open = false;
    let left = 0;
    let gain = floor;
    let lastThr = NaN;
    let openAt = 0;
    for (let j = 0; j < ext.length; j++) {
      const i = j < k ? n - k + j : j - k;
      const t = threshold[i];
      if (t !== lastThr) {
        lastThr = t;
        openAt = ref * dbToGain(t);
      }
      const lv = ext[j];
      if (lv >= openAt) {
        open = true;
        left = holdN;
      } else if (open) {
        if (lv >= openAt * hyst) left = holdN;
        else if (left > 0) left--;
        else open = false;
      }
      gain = open ? Math.min(1, gain + up) : Math.max(floor, gain * down);
      if (j >= k) g[i] = gain;
    }
    advance(g, Math.round(ctx.num('lookahead') * sr));
    for (const ch of input) for (let i = 0; i < n; i++) ch[i] *= g[i];
    return input;
  },
};
