import type { EffectDef, ParamMeta } from '../nodes';
import type { ParamValue } from '../format/types';
import { constantOf } from '../params';
import { cubicAt, cubicAtWrapped } from '../dsp/fracdelay';
import { Svf } from '../dsp/filters';
import { peak } from '../dsp/math';

const PARAMS: Record<string, ParamMeta> = {
  rate: {
    kind: 'signal',
    doc:
      'Playback speed, measured over the output time: 1 normal, 0.5 an octave down and twice as long, 2 an octave ' +
      'up and half as long. A ramp to 0 is a tape stop ([[0, 1], [0.6, 1], [1.4, 0]]); a ramp up from 0 a ' +
      'spin-up. Below a quarter speed the level falls with the speed, as a real tape or turntable does, so a stop ends in silence.',
    hint: 'Playback speed: slower is lower and longer',
    default: 1,
    min: 0.25,
    max: 2,
    hardMin: 0,
    hardMax: 4,
    unit: 'x',
    scale: 'log',
  },
};

/** Level of a tape head (or stylus) moving at `rate`: full from a quarter speed up, then falling with the speed. */
function speedLevel(rate: number): number {
  return rate >= 0.25 ? 1 : rate <= 0 ? 0 : rate / 0.25;
}

/** Seconds a stalled transport may sit at zero speed before it counts as stopped. */
const STALL = 0.25;
const MAX_SECONDS = 60;

/** Tape-speed change: pitch and length together, from tape stops to spin-ups and slowed-down monsters. */
export const varispeed: EffectDef = {
  kind: 'effect',
  type: 'varispeed',
  label: 'Varispeed',
  category: 'pitch',
  doc:
    'Plays the sound back at another speed, like tape or a record: pitch and length change together (use ' +
    '`pitch` to keep the length). Slow it for huge, heavy versions of a sound; speed it up for small, frantic ones; ' +
    'ramp `rate` to 0 for a tape stop, up from 0 for a spin-up. The output is longer or shorter than the input; the ' +
    'silence after the sound is kept for later effects. Cubic interpolation, anti-aliased when faster than 1.',
  hint: 'Plays at another speed, like tape: pitch and length change together',
  params: PARAMS,
  example: { type: 'varispeed', rate: [[0, 1], [0.5, 1], [1.3, 0]] },
  length(params, seconds) {
    const v = params.rate as ParamValue | undefined;
    const step = 0.001;
    let t = 0;
    let pos = 0;
    let stall = 0;
    while (pos < seconds && t < MAX_SECONDS) {
      const r = constantOf(v, PARAMS.rate, 1, t);
      pos += r * step;
      t += step;
      if (r <= 1e-6) {
        stall += step;
        if (stall > STALL) break;
      } else stall = 0;
    }
    return t;
  },
  process(input, _p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    if (n === 0) return input;
    if (ctx.loop) {
      // A loop keeps its length: the read head runs round the loop at the given speed.
      const rate = ctx.signal('rate', n);
      return input.map((x) => {
        const out = new Float64Array(n);
        let pos = 0;
        for (let i = 0; i < n; i++) {
          out[i] = cubicAtWrapped(x, pos) * speedLevel(rate[i]);
          pos += rate[i];
        }
        return out;
      });
    }
    // Where the sound ends; the silence after it (room for later effects' tails) is kept, not stretched.
    const p = Math.max(...input.map(peak));
    if (p <= 0) return input;
    const floor = p * 1e-7;
    let lastIn = 0;
    for (const x of input) {
      for (let i = n - 1; i > lastIn; i--) {
        if (Math.abs(x[i]) > floor) {
          lastIn = i;
          break;
        }
      }
    }
    const room = n - 1 - lastIn;
    const maxOut = Math.min(8 * (lastIn + 1) + room, MAX_SECONDS * sr);

    // March the read head over output time, compiling the rate curve further as needed.
    let m = Math.min(Math.max(lastIn + 2, 1024), maxOut);
    let rate = ctx.signal('rate', m);
    let posArr = new Float64Array(m);
    let pos = 0;
    let stall = 0;
    let end = 0;
    let maxRate = 0;
    const stallMax = Math.round(STALL * sr);
    for (let i = 0; ; i++) {
      if (i >= maxOut) {
        end = maxOut;
        ctx.warn(`the slowed sound runs past ${(maxOut / sr).toFixed(1)} s and was cut`);
        break;
      }
      if (i >= m) {
        m = Math.min(m * 2, maxOut);
        rate = ctx.signal('rate', m);
        const grown = new Float64Array(m);
        grown.set(posArr);
        posArr = grown;
      }
      if (pos > lastIn + 2) {
        end = i;
        break;
      }
      const r = rate[i];
      posArr[i] = pos;
      pos += r;
      if (r > maxRate) maxRate = r;
      if (r <= 1e-6) {
        if (++stall > stallMax) {
          end = i - stallMax;
          break;
        }
      } else stall = 0;
    }
    const length = Math.min(end + room, MAX_SECONDS * sr);

    // Faster than 1x, low-pass the input under the new Nyquist first, following the speed at each input sample.
    let sources = input;
    if (maxRate > 1.02) {
      const rIn = new Float64Array(n).fill(1);
      for (let i = 0; i < end; i++) {
        const a = Math.floor(posArr[i]);
        const b = Math.min(n - 1, Math.floor(posArr[i] + rate[i]));
        for (let j = Math.max(a, 0); j <= b; j++) rIn[j] = rate[i];
      }
      sources = input.map((x) => {
        const y = x.slice();
        const f1 = new Svf('lowpass', sr);
        const f2 = new Svf('lowpass', sr);
        let fc = sr * 0.45;
        for (let j = 0; j < n; j++) {
          if ((j & 15) === 0) fc = (sr * 0.45) / Math.max(rIn[j], 1);
          y[j] = f2.tick(f1.tick(x[j], fc, 0.5412), fc, 1.3066);
        }
        return y;
      });
    }
    return sources.map((x) => {
      const out = new Float64Array(length);
      for (let i = 0; i < end; i++) out[i] = cubicAt(x, posArr[i]) * speedLevel(rate[i]);
      return out;
    });
  },
};
