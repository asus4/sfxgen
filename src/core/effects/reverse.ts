import type { EffectDef } from '../nodes';
import { absMax, maxOf } from '../dsp/dynamics';

/** Where 'start' alignment cuts: the part above -80 dB of the peak. */
const SOUNDING_FLOOR = 1e-4;
/** Fade-in where a reversal cuts into the sound, seconds. */
const FADE_IN = 0.002;

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
    'exactly at the end of the patch (then set `master.fadeOut` to about 0.005 so it is not faded). `at` puts the ' +
    'climax at a time of your choosing, seconds from the track\'s start (from the patch start on a bus or the ' +
    'master): a swell timed into a hit. Pre-verb, a ' +
    'swell of reverb into the hit: `reverse`, `reverb`, `reverse` in one chain.',
  hint: 'Plays the sound backwards: a swell that stops dead',
  params: {
    align: {
      kind: 'enum',
      doc: 'start: reverse only the part that sounds, so it begins at the track\'s start. end: reverse the whole buffer, so the sound finishes at the end of the patch.',
      hint: 'Begin where the layer starts, or finish where the sound ends',
      options: ['start', 'end'],
      default: 'start',
    },
    at: {
      kind: 'number',
      doc:
        'Seconds from the start of the buffer at which the climax lands (the moment the original began), overriding ' +
        '`align`. The first `at` seconds of the sound are reversed into place; a longer sound loses its far tail (its ' +
        'swell then starts with a short fade), a shorter one starts after a silence. After the climax: silence.',
      hint: 'When the reversed sound peaks',
      min: 0.01,
      max: 10,
      hardMin: 0.001,
      hardMax: 60,
      unit: 's',
    },
  },
  example: { type: 'reverse' },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    if (typeof p.at === 'number' && Number.isFinite(p.at)) {
      // The climax at `at`: the first `at` seconds, reversed, end there; nothing after.
      const len = Math.max(1, Math.min(n, Math.round(ctx.num('at') * ctx.sr)));
      const level = absMax(input);
      const top = maxOf(level);
      let sounding = 0;
      for (let i = n - 1; i >= 0; i--) {
        if (level[i] > top * SOUNDING_FLOOR) {
          sounding = i + 1;
          break;
        }
      }
      // Only a sound cut short by `at` needs its new start faded in.
      const fade = sounding > len ? Math.min(len, Math.round(FADE_IN * ctx.sr)) : 0;
      for (const ch of input) {
        ch.subarray(0, len).reverse();
        ch.fill(0, len);
        for (let i = 0; i < fade; i++) ch[i] *= i / fade;
      }
      return input;
    }
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
