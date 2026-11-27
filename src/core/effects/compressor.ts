import type { EffectDef, ParamMeta } from '../nodes';
import { clamp, dbToGain, type Buf } from '../dsp/math';
import { advance, compressionDb, energy, maxOf, onePoleCoef, runningMax, withPreroll } from '../dsp/dynamics';

/** The peak detector holds each peak this long, so it does not ripple on low notes (and distort them). */
const PEAK_HOLD = 0.012;
/** Averaging time of the rms detector. */
const RMS_TIME = 0.01;

/** Detector level (linear) of a group of channels: the loudest channel's peak (held) or rms. */
function detect(chs: Buf[], rms: boolean, sr: number): Buf {
  const n = chs[0].length;
  const out = new Float64Array(n);
  if (rms) {
    const a = onePoleCoef(RMS_TIME, sr);
    let s = 0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const ch of chs) {
        const v = ch[i] * ch[i];
        if (v > m) m = v;
      }
      s = a * s + (1 - a) * m;
      out[i] = Math.sqrt(s);
    }
    return out;
  }
  for (const ch of chs) {
    for (let i = 0; i < n; i++) {
      const v = Math.abs(ch[i]);
      if (v > out[i]) out[i] = v;
    }
  }
  return runningMax(out, Math.max(1, Math.round(PEAK_HOLD * sr)));
}

/**
 * Gain reduction in dB per sample: the static curve, then attack and release smoothing in the dB domain (the
 * smooth branching detector of Giannoulis, Massberg and Reiss, 2012), then the lookahead shift.
 */
function reduction(
  level: Buf,
  refDb: number,
  threshold: Buf,
  ratio: Buf,
  knee: number,
  attack: number,
  release: number,
  lookahead: number,
  sr: number,
  preroll: number,
): Buf {
  const n = level.length;
  const aA = onePoleCoef(attack, sr);
  const aR = onePoleCoef(release, sr);
  const ext = withPreroll(level, preroll);
  const pre = ext.length - n;
  const out = new Float64Array(n);
  let s = 0;
  for (let j = 0; j < ext.length; j++) {
    const i = j < pre ? n - pre + j : j - pre;
    const lv = ext[j];
    const gr = lv > 1e-12 ? compressionDb(20 * Math.log10(lv), refDb + threshold[i], ratio[i], knee) : 0;
    s = gr > s ? aA * s + (1 - aA) * gr : aR * s + (1 - aR) * gr;
    if (j >= pre) out[i] = s;
  }
  return advance(out, lookahead);
}

const time = (doc: string, hint: string, def: number, min: number, max: number, hardMin: number, hardMax: number): ParamMeta => ({
  kind: 'number',
  doc,
  hint,
  default: def,
  min,
  max,
  hardMin,
  hardMax,
  unit: 's',
  scale: 'log',
});

export const compressor: EffectDef = {
  kind: 'effect',
  type: 'compressor',
  label: 'Compressor',
  category: 'dynamics',
  doc:
    'Turns the loud parts down by `ratio` above `threshold`. Reach for it to make a hit punchier (attack 0.01 to ' +
    '0.03 s lets the crack through, then clamps the body; add `autoMakeup` and the hit stands out), to glue layers ' +
    'on a bus (ratio 2, threshold -10, attack 0.02, release 0.2: they move as one), or to bring up a tail (fast ' +
    'attack, high ratio: the ring and room come forward). By default the threshold is measured from the loudest ' +
    'moment of its input (`reference: "peak"`), so it acts the same whatever the layer\'s level.',
  hint: 'Evens out the level: punchier hits, glued layers',
  params: {
    threshold: {
      kind: 'signal',
      doc:
        'Level above which the gain comes down, dB below the loudest moment of the input (or dBFS with `reference: ' +
        '"dbfs"`). -6 touches only the peaks, -12 to -20 works the body, -30 and below squashes everything.',
      hint: 'How loud a part must be before it is turned down',
      default: -12,
      min: -48,
      max: 0,
      hardMin: -100,
      hardMax: 24,
      unit: 'dB',
    },
    ratio: {
      kind: 'signal',
      doc: 'dB in for each dB out above the threshold. 1.5 to 2 gentle glue, 3 to 4 firm and punchy, 8+ squashed, 20+ a limiter.',
      hint: 'How hard the loud parts are squashed',
      default: 3,
      min: 1,
      max: 20,
      hardMin: 1,
      hardMax: 100,
      unit: 'x',
      scale: 'log',
    },
    attack: time(
      'Time constant for the gain to come down. 0.0005 to 0.003 catches the transient (flatter, smoother), 0.01 to ' +
        '0.03 lets the crack through before clamping (punchier), 0.05+ barely touches short hits.',
      'How fast it clamps down: slow lets the hit punch through',
      0.01,
      0.0002,
      0.1,
      0.00002,
      1,
    ),
    release: time(
      'Time constant for the gain to recover. 0.05 to 0.1 lively (can pump on dense sounds), 0.15 to 0.3 smooth ' +
        'glue, 0.5+ slow and steady. Short releases bring tails and room up between hits.',
      'How fast it lets go after a loud part',
      0.12,
      0.02,
      1,
      0.002,
      5,
    ),
    knee: { kind: 'number', doc: 'Width of the soft knee around the threshold, dB: 0 hard and obvious, 6 natural, 12+ very gradual.', hint: 'How gently it starts to act', default: 6, min: 0, max: 24, hardMin: 0, hardMax: 48, unit: 'dB' },
    makeup: { kind: 'number', doc: 'Gain after compression, dB (added to `autoMakeup`).', hint: 'Turns the result back up', default: 0, min: -12, max: 24, hardMin: -48, hardMax: 48, unit: 'dB' },
    autoMakeup: {
      kind: 'bool',
      doc: 'Raise the output to the loudness (rms) of the input, so the layer keeps its place in the mix and only its dynamics change.',
      hint: 'Keep the overall loudness the same',
      default: false,
    },
    detector: {
      kind: 'enum',
      doc: 'peak reacts to every peak (tight control, catches clicks); rms follows the average level over about 10 ms (smoother, lets fast transients slip through: punchier).',
      hint: 'Peak catches every spike, RMS is smoother and punchier',
      options: ['peak', 'rms'],
      default: 'peak',
    },
    lookahead: {
      kind: 'number',
      doc: 'Seconds the detector sees ahead, so the gain is already down when a peak arrives (no latency offline). 0 keeps the punch; 0.001 to 0.005 catches it cleanly.',
      hint: 'Reacts just before a peak arrives',
      default: 0,
      min: 0,
      max: 0.01,
      hardMin: 0,
      hardMax: 0.05,
      unit: 's',
      scale: 'log',
    },
    link: { kind: 'number', doc: 'Stereo link, 0 to 1: 1 one gain for both channels (the image stays put), 0 each channel on its own.', hint: 'Treat left and right as one, so the image stays put', default: 1, min: 0, max: 1, hardMin: 0, hardMax: 1, unit: '' },
    reference: {
      kind: 'enum',
      doc: 'What `threshold` is measured from: peak (the loudest moment of this input: predictable at any level) or dbfs (absolute, like a hardware unit).',
      hint: 'Measure from this sound’s own peak, or from full scale',
      options: ['peak', 'dbfs'],
      default: 'peak',
    },
  },
  example: { type: 'compressor', threshold: -18, ratio: 4, attack: 0.015, release: 0.12, autoMakeup: true },
  process(input, p, ctx) {
    const n = input[0].length;
    if (n === 0) return input;
    const sr = ctx.sr;
    const threshold = ctx.signal('threshold', n);
    const ratio = ctx.signal('ratio', n);
    const attack = ctx.num('attack');
    const release = ctx.num('release');
    const knee = ctx.num('knee');
    const lookahead = Math.round(ctx.num('lookahead') * sr);
    const link = clamp(ctx.num('link'), 0, 1);
    const rms = p.detector === 'rms';
    const before = p.autoMakeup === true ? energy(input) : 0;
    // One detector for linked channels, or one each.
    const linked = detect(input, rms, sr);
    const groups: Buf[] =
      input.length === 1 || link >= 1
        ? [linked]
        : input.map((ch) => {
            const own = detect([ch], rms, sr);
            for (let i = 0; i < n; i++) own[i] = link * linked[i] + (1 - link) * own[i];
            return own;
          });
    let refDb = 0;
    if (p.reference !== 'dbfs') {
      const top = maxOf(linked);
      if (top <= 1e-9) return input;
      refDb = 20 * Math.log10(top);
    }
    const preroll = ctx.loop ? Math.min(n, Math.round(5 * release * sr)) : 0;
    const makeup = ctx.num('makeup');
    // With autoMakeup, makeup goes on after the loudness match, which would otherwise undo it.
    const inline = before > 0 ? 0 : makeup;
    const gains = groups.map((level) => {
      const gr = reduction(level, refDb, threshold, ratio, knee, attack, release, lookahead, sr, preroll);
      for (let i = 0; i < n; i++) gr[i] = dbToGain(inline - gr[i]);
      return gr;
    });
    input.forEach((ch, c) => {
      const g = gains[Math.min(c, gains.length - 1)];
      for (let i = 0; i < n; i++) ch[i] *= g[i];
    });
    if (before > 0) {
      const after = energy(input);
      if (after > 0) {
        const g = Math.min(Math.sqrt(before / after), 100) * dbToGain(makeup);
        for (const ch of input) for (let i = 0; i < n; i++) ch[i] *= g;
      }
    }
    return input;
  },
};
