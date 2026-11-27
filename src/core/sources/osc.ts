import type { SourceDef } from '../nodes';
import { oscillator, type Waveform } from '../dsp/oscillators';
import { wander } from '../dsp/noise';
import type { Buf } from '../dsp/math';

/** The classic synth oscillator: one waveform, optional unison stack and slow analog drift. */
export const osc: SourceDef = {
  kind: 'source',
  type: 'osc',
  label: 'Oscillator',
  category: 'tone',
  doc:
    'A band-limited waveform: sine for pure tones and sub thumps, triangle for soft chip tones, saw for buzzy ' +
    'and brassy sounds, square/pulse for hollow 8-bit tones. Sweep `freq` with breakpoints for lasers, risers ' +
    'and drops; stack `unison` voices with `detune` for width; `drift` adds slow analog pitch wander.',
  hint: 'A basic waveform: pure, soft, buzzy or hollow',
  defaultEnv: { attack: 0.002, decay: 0.4 },
  params: {
    wave: {
      kind: 'enum',
      doc: 'Waveform.',
      hint: 'Waveform',
      options: ['sine', 'triangle', 'saw', 'square', 'pulse'],
      default: 'sine',
    },
    freq: {
      kind: 'signal',
      doc: 'Frequency. Breakpoints glide exponentially by default.',
      hint: 'Pitch',
      default: 440,
      min: 20,
      max: 12000,
      hardMin: 0.01,
      hardMax: 24000,
      unit: 'Hz',
      scale: 'log',
      pitch: true,
    },
    pw: { kind: 'signal', doc: 'Pulse width for `pulse`, 0.05 (thin, nasal) to 0.5 (square).', hint: 'Thin and nasal to square', default: 0.25, min: 0.02, max: 0.98, hardMin: 0.01, hardMax: 0.99 },
    unison: { kind: 'number', doc: 'Voices stacked, 1 to 9.', hint: 'Stacked voices for a thicker tone', default: 1, min: 1, max: 9, step: 1, hardMin: 1, hardMax: 16 },
    detune: { kind: 'number', doc: 'Spread of the unison voices, cents.', hint: 'How far the stacked voices spread', default: 12, min: 0, max: 100, unit: 'cents' },
    width: { kind: 'number', doc: 'Stereo spread of unison voices, 0 to 1 (stereo output only).', hint: 'Spreads the stacked voices left and right', default: 0.6, min: 0, max: 1 },
    drift: { kind: 'number', doc: 'Slow random pitch wander, cents. 3 to 10 sounds alive; 50+ sounds broken.', hint: 'Slow pitch wander: alive to broken', default: 0, min: 0, max: 100, unit: 'cents' },
    phase: { kind: 'number', doc: 'Start phase 0 to 1. Unison voices other than the first start at random phases.', hint: 'Where the wave starts', default: 0, min: 0, max: 1 },
  },
  example: { type: 'osc', wave: 'saw', freq: [[0, 880], [0.25, 110]], env: { attack: 0.002, decay: 0.3 } },
  render(p, ctx) {
    const wave = (p.wave as Waveform) ?? 'sine';
    const freq = ctx.signal('freq');
    const pw = ctx.signal('pw');
    const voices = Math.max(1, Math.round(ctx.num('unison')));
    const detune = ctx.num('detune');
    const drift = ctx.num('drift');
    const width = ctx.num('width');
    const n = ctx.n;
    const left = new Float64Array(n);
    const right = new Float64Array(n);
    const f = new Float64Array(n);
    for (let v = 0; v < voices; v++) {
      const spread = voices > 1 ? (v / (voices - 1)) * 2 - 1 : 0;
      const cents = spread * detune;
      const rng = ctx.rng.fork('voice', v);
      const drifting = drift > 0 ? wander(n, ctx.sr, 1.5 + v * 0.37, rng.fork('drift')) : null;
      for (let i = 0; i < n; i++) {
        const c = cents + (drifting ? drifting[i] * drift : 0);
        f[i] = freq[i] * Math.pow(2, c / 1200);
      }
      const phase0 = v === 0 ? ctx.num('phase') : rng.next();
      const y = oscillator(wave, f, ctx.sr, phase0, pw);
      // Equal-power placement across the stereo field.
      const pan = spread * width;
      const gl = Math.cos(((pan + 1) * Math.PI) / 4);
      const gr = Math.sin(((pan + 1) * Math.PI) / 4);
      for (let i = 0; i < n; i++) {
        left[i] += y[i] * gl;
        right[i] += y[i] * gr;
      }
    }
    const norm = Math.SQRT2 / Math.sqrt(voices);
    for (let i = 0; i < n; i++) {
      left[i] *= norm;
      right[i] *= norm;
    }
    if (voices > 1 && width > 0) return [left, right] as [Buf, Buf];
    for (let i = 0; i < n; i++) left[i] = (left[i] + right[i]) * 0.5;
    return left;
  },
};
