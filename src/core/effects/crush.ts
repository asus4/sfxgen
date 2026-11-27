import type { EffectDef } from '../nodes';
import { filterBuffer } from '../dsp/filters';
import { clamp, type Buf } from '../dsp/math';
import { absMax, maxOf } from '../dsp/dynamics';

/** At or above this rate (or the sample rate) there is no rate reduction. */
const RATE_OFF = 48000;

export const crush: EffectDef = {
  kind: 'effect',
  type: 'crush',
  label: 'Bitcrusher',
  category: 'color',
  doc:
    'Lo-fi grit: fewer bits (a coarse, noisy staircase, measured from the input\'s own peak so the same `bits` ' +
    'sound the same at any level) and a lower sample rate (sample and hold: metallic aliasing). Chiptune: bits 4, ' +
    'rate 8000. Old sampler: bits 12, rate 22050, antialias. Broken radio or a dying robot: bits 3, rate 3000, ' +
    'jitter 0.5. Sweep `bits` or `rate` with breakpoints for a sound that degrades or powers down.',
  hint: 'Lo-fi grit: fewer bits and a lower sample rate',
  params: {
    bits: {
      kind: 'signal',
      doc: 'Bit depth, fractions allowed. 12 to 16 subtle hiss on quiet parts, 8 gritty, 4 to 6 chiptune crunch, 1 to 3 a buzzing, broken square.',
      hint: 'Fewer bits, more crunch',
      default: 8,
      min: 1,
      max: 16,
      hardMin: 1,
      hardMax: 24,
      unit: '',
    },
    rate: {
      kind: 'signal',
      doc:
        'Sample rate the sound is held at, Hz: 22050 dull and a little crunchy, 8000 to 11025 chiptune and old games, ' +
        '2000 to 4000 a buzzing wreck. 48000 or more (or the output rate) leaves the rate alone.',
      hint: 'Lower is grittier and more metallic',
      default: 48000,
      min: 500,
      max: 48000,
      hardMin: 50,
      hardMax: 192000,
      unit: 'Hz',
      scale: 'log',
    },
    jitter: {
      kind: 'number',
      doc: 'Randomness of the sample clock, 0 to 1: a cheap, unstable converter. 0.1 grainy, 0.5 noisy and broken.',
      hint: 'Makes the grit unstable and noisy',
      default: 0,
      min: 0,
      max: 1,
      hardMin: 0,
      hardMax: 1,
      unit: '',
    },
    antialias: {
      kind: 'bool',
      doc: 'Low-pass before and after the rate reduction, like a real sampler: darker and cleaner, without the metallic aliasing.',
      hint: 'Smoother and darker, like a real old sampler',
      default: false,
    },
  },
  example: { type: 'crush', bits: 5, rate: 9000 },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const top = maxOf(absMax(input));
    if (top <= 1e-12) return input;
    const bits = ctx.signal('bits', n);
    const rate = ctx.signal('rate', n);
    const jitter = clamp(ctx.num('jitter'), 0, 1);
    const off = Math.min(RATE_OFF, sr);
    let reduces = false;
    for (let i = 0; i < n; i++) if (rate[i] < off) reduces = true;
    const aa = reduces && p.antialias === true;
    // A steep (48 dB per octave) low-pass a little under the new Nyquist, before and after, like a sampler's
    // anti-alias and reconstruction filters.
    const cutoff = aa ? rate.map((r) => clamp(0.4 * r, 20, 0.45 * sr)) : null;
    const smooth = (ch: Buf) => {
      filterBuffer(ch, 'lowpass', cutoff!, 0.707, sr, { slope: 24 });
      filterBuffer(ch, 'lowpass', cutoff!, 0.707, sr, { slope: 24 });
    };
    if (cutoff) input.forEach(smooth);
    if (reduces) {
      // One clock for every channel, so a stereo image holds together.
      const rng = ctx.rng.fork('clock');
      const held = new Float64Array(input.length);
      let phase = 1;
      let stretch = 1;
      for (let i = 0; i < n; i++) {
        const r = rate[i];
        if (r >= off) {
          phase = 1;
          continue;
        }
        if (phase >= 1) {
          phase -= Math.floor(phase);
          for (let c = 0; c < input.length; c++) held[c] = input[c][i];
          stretch = jitter > 0 ? 1 + jitter * 0.9 * (2 * rng.next() - 1) : 1;
        }
        for (let c = 0; c < input.length; c++) input[c][i] = held[c];
        phase += r / sr / stretch;
      }
    }
    // Quantise against the input's peak (mid-tread: silence stays silent).
    let lastBits = NaN;
    let step = 0;
    let inv = 0;
    for (let i = 0; i < n; i++) {
      if (bits[i] !== lastBits) {
        lastBits = bits[i];
        step = top * Math.pow(2, 1 - lastBits);
        inv = 1 / step;
      }
      for (const ch of input) ch[i] = Math.round(ch[i] * inv) * step;
    }
    if (cutoff) input.forEach(smooth);
    return input;
  },
};
