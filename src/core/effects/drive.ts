import type { EffectDef } from '../nodes';
import { onePoleLowpass } from '../dsp/filters';
import { oversampled } from '../dsp/oversample';
import { dbToGain, peak } from '../dsp/math';

type DriveMode = 'tanh' | 'soft' | 'hard' | 'fold' | 'tube' | 'fuzz' | 'rectify';

function shape(mode: DriveMode, x: number, bias: number): number {
  switch (mode) {
    case 'tanh':
      return Math.tanh(x + bias) - Math.tanh(bias);
    case 'soft': {
      // Cubic soft clip: gentle, mostly odd harmonics.
      const v = x + bias;
      const c = v > 1 ? 2 / 3 : v < -1 ? -2 / 3 : v - (v * v * v) / 3;
      const b = bias > 1 ? 2 / 3 : bias < -1 ? -2 / 3 : bias - (bias * bias * bias) / 3;
      return c - b;
    }
    case 'hard':
      return Math.max(-1, Math.min(1, x + bias)) - Math.max(-1, Math.min(1, bias));
    case 'fold': {
      // Wavefolding: the wave reflects off ±1 instead of flattening, which adds bright, metallic overtones.
      const v = x + bias;
      return Math.sin((Math.PI / 2) * v) - Math.sin((Math.PI / 2) * bias);
    }
    case 'tube': {
      // Asymmetric: the positive side saturates earlier, adding even harmonics like a triode.
      const v = x + bias + 0.15;
      const y = v >= 0 ? 1 - Math.exp(-v) : -(1 - Math.exp(v * 0.6)) / 0.6;
      const b = bias + 0.15;
      const yb = b >= 0 ? 1 - Math.exp(-b) : -(1 - Math.exp(b * 0.6)) / 0.6;
      return y - yb;
    }
    case 'fuzz': {
      // Hard, gated, asymmetric: a broken transistor fuzz.
      const v = x + bias;
      return Math.sign(v) * (1 - Math.exp(-Math.abs(v) * 3)) * (v > 0 ? 1 : 0.7);
    }
    case 'rectify':
      return Math.abs(x + bias) - Math.abs(bias);
  }
}

/** Saturation and distortion: warmth, grit, crunch and wavefolding. */
export const drive: EffectDef = {
  kind: 'effect',
  type: 'drive',
  label: 'Drive',
  category: 'color',
  doc:
    'Saturation and distortion, oversampled. tanh is warm tape-like saturation, soft is gentle, hard is digital ' +
    'clipping, fold is a wavefolder (bright and metallic), tube adds even harmonics, fuzz is broken-transistor grit, ' +
    'rectify jumps the pitch up an octave and sounds ring-modulated. `amount` is the gain into the shaper; the ' +
    'output is matched to the input peak unless `compensate` is off.',
  hint: 'Saturation and distortion, from warm to destroyed',
  params: {
    mode: { kind: 'enum', doc: 'Shaper.', hint: 'Kind of distortion', options: ['tanh', 'soft', 'hard', 'fold', 'tube', 'fuzz', 'rectify'], default: 'tanh' },
    amount: { kind: 'signal', doc: 'Gain into the shaper, dB. 6 is warm, 18 is crunchy, 30+ is destroyed.', hint: 'How hard it is driven: warm to destroyed', default: 12, min: 0, max: 48, hardMin: -24, hardMax: 72, unit: 'dB' },
    bias: { kind: 'number', doc: 'Asymmetry, -1 to 1: adds even harmonics and a sputtering edge.', hint: 'Uneven distortion with a sputtering edge', default: 0, min: -1, max: 1 },
    tone: { kind: 'number', doc: 'Low-pass after the shaper, Hz: tames fizz.', hint: 'Tames the fizz', default: 18000, min: 500, max: 20000, unit: 'Hz', scale: 'log' },
    output: { kind: 'number', doc: 'Level after the shaper, dB.', hint: 'Level after the distortion', default: 0, min: -24, max: 12, unit: 'dB' },
    compensate: { kind: 'bool', doc: 'Match the output peak to the input peak.', hint: 'Keep the level the same as the input', default: true },
    oversample: { kind: 'enum', doc: 'Oversampling: more is cleaner and slower.', hint: 'Higher is cleaner but slower', options: ['1', '2', '4'], default: '2', advanced: true },
  },
  example: { type: 'drive', mode: 'tube', amount: 14, tone: 6000 },
  process(input, p, ctx) {
    const n = input[0].length;
    const amount = ctx.signal('amount', n);
    const mode = (p.mode as DriveMode) ?? 'tanh';
    const bias = ctx.num('bias');
    const factor = Number(p.oversample ?? 2);
    const tone = ctx.num('tone');
    const out = ctx.num('output');
    const compensate = p.compensate !== false;
    return input.map((ch) => {
      const before = peak(ch);
      const y = oversampled(ch, ctx.sr, factor, (v, i) => shape(mode, v * dbToGain(amount[i]), bias));
      if (tone < ctx.sr * 0.45) onePoleLowpass(y, tone, ctx.sr);
      const after = peak(y);
      const g = (compensate && after > 0 ? before / after : 1) * dbToGain(out);
      for (let i = 0; i < n; i++) y[i] *= g;
      return y;
    });
  },
};
