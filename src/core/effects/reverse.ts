import type { EffectDef } from '../nodes';
import { absMax, maxOf } from '../dsp/dynamics';

/** Where 'start' alignment cuts: the part above -80 dB of the peak, as `duration: "auto"` trims. */
const SOUNDING_FLOOR = 1e-4;
/** Fade-in at the start of a 'start'-aligned reversal, seconds. */
const FADE_IN = 0.002;

/** Plays the buffer backwards. */
export const reverse: EffectDef = {
  kind: 'effect',
  type: 'reverse',
  label: 'Reverse',
  category: 'time',
  doc:
    'Plays the sound backwards: a hit becomes a swell that is sucked in and stops dead (reverse cymbals, ' +
    'time-rewind, ghostly inhales, sci-fi charge-ups). A track\'s buffer runs from its `start` to the end of the ' +
    'patch, silence included. By default (`align: "start"`) only the part that sounds (above -80 dB) is reversed, ' +
    'so the swell begins at the track\'s start and its climax lands one sound-length later: to hit a moment t, ' +
    'start the track at t minus the sound\'s length. `align: "end"` reverses the whole buffer, so the climax lands ' +
    'exactly at the end of the patch (then set `master.fadeOut` to about 0.005 so it is not faded). Pre-verb, a ' +
    'swell of reverb into the hit: `reverse`, `reverb`, `reverse` in one chain.',
  params: {
    align: {
      kind: 'enum',
      doc: 'start: reverse only the part that sounds, so it begins at the track\'s start. end: reverse the whole buffer, so the sound finishes at the end of the patch.',
      options: ['start', 'end'],
      default: 'start',
    },
  },
  example: { type: 'reverse' },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const whole = p.align === 'end';
    let len = n;
    if (!whole) {
      const level = absMax(input);
      const floor = maxOf(level) * SOUNDING_FLOOR;
      len = 0;
      for (let i = n - 1; i >= 0; i--) {
        if (level[i] > floor) {
          len = i + 1;
          break;
        }
      }
      if (len === 0) return input;
    }
    const fade = whole ? 0 : Math.min(len, Math.round(FADE_IN * ctx.sr));
    for (const ch of input) {
      ch.subarray(0, len).reverse();
      for (let i = 0; i < fade; i++) ch[i] *= i / fade;
    }
    return input;
  },
};
