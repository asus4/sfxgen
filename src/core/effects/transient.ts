import type { EffectDef } from '../nodes';
import { clamp, dbToGain } from '../dsp/math';
import { absMax, onePoleCoef, runningMax, smoothTwoWay, withPreroll } from '../dsp/dynamics';

/** The level follower holds each peak this long, so low notes do not read as a string of onsets. */
const LEVEL_HOLD = 0.02;
/** How long the sustain detector remembers a peak (time constant). */
const SUSTAIN_MEMORY = 1;
/** Corner smoothing of the gain curve, zero-phase, so no change ever clicks. */
const GAIN_SMOOTH = 0.0006;

/** Transient shaper: more or less attack and sustain, whatever the level. */
export const transient: EffectDef = {
  kind: 'effect',
  type: 'transient',
  label: 'Transient shaper',
  category: 'dynamics',
  doc:
    'Shapes the attack and the body of a sound independently of its level, from the difference of fast and slow ' +
    'envelope followers. The key tool for punch: `attack` +6 to +12 makes a hit snap and cut through, -6 to -12 ' +
    'softens a click into a thud; `sustain` +6 rings out longer and brings up the room, -6 to -18 tightens a boomy ' +
    'hit until it is dry and short. Works on single hits, rolls and whole buses alike.',
  params: {
    attack: {
      kind: 'signal',
      doc: 'dB added at each onset, fading over `window`. +6 snappier, +12 a hard crack; negative softens the hit.',
      default: 6,
      min: -24,
      max: 24,
      hardMin: -48,
      hardMax: 36,
      unit: 'dB',
    },
    sustain: {
      kind: 'signal',
      doc: 'dB added to the body: what follows each onset, more as it decays. + rings longer and fuller, - tighter and drier.',
      default: 0,
      min: -24,
      max: 24,
      hardMin: -48,
      hardMax: 36,
      unit: 'dB',
    },
    window: {
      kind: 'number',
      doc: 'Seconds the onset emphasis lasts: 0.003 to 0.008 just the click, 0.015 to 0.03 a drum hit (default 0.02), 0.05+ a slow boom.',
      default: 0.02,
      min: 0.002,
      max: 0.1,
      hardMin: 0.0005,
      hardMax: 0.5,
      unit: 's',
      scale: 'log',
    },
  },
  example: { type: 'transient', attack: 9, sustain: -6 },
  process(input, _p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const attack = ctx.signal('attack', n);
    const sustain = ctx.signal('sustain', n);
    const window = ctx.num('window');
    const level = runningMax(absMax(input), Math.max(1, Math.round(LEVEL_HOLD * sr)));
    // Onset: a follower that rises slowly and falls at once lags behind each rise; 1 - slow / level is 1 at an
    // onset from silence and fades to 0 as it catches up.
    const aOn = onePoleCoef(window / 2, sr);
    // Body: a follower that rises at once and falls slowly remembers the peak; 1 - level / held grows as the sound
    // decays below it.
    const aSus = onePoleCoef(SUSTAIN_MEMORY, sr);
    const pre = ctx.loop ? Math.min(n, Math.round(2 * SUSTAIN_MEMORY * sr)) : 0;
    const ext = withPreroll(level, pre);
    const k = ext.length - n;
    const gain = new Float64Array(n);
    let slow = 0;
    let held = 0;
    for (let j = 0; j < ext.length; j++) {
      const lv = ext[j];
      slow = lv < slow ? lv : aOn * slow + (1 - aOn) * lv;
      held = lv > held ? lv : aSus * held + (1 - aSus) * lv;
      if (j < k) continue;
      const i = j - k;
      const onset = lv > 1e-12 ? 1 - slow / lv : 0;
      const body = held > 1e-12 ? 1 - lv / held : 0;
      gain[i] = clamp(attack[i] * onset + sustain[i] * body, -60, 36);
    }
    smoothTwoWay(gain, GAIN_SMOOTH, sr);
    for (let i = 0; i < n; i++) gain[i] = dbToGain(gain[i]);
    for (const ch of input) for (let i = 0; i < n; i++) ch[i] *= gain[i];
    return input;
  },
};
