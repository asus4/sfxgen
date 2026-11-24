import type { EffectDef, ParamMeta } from '../nodes';
import { DelayLine } from '../dsp/fracdelay';
import { Rng } from '../dsp/rng';
import { clamp, type Buf } from '../dsp/math';
import { isBreakpoints, isSignalObject } from '../params';

type Mode = 'comb' | 'tube' | 'string' | 'metal';
const MODES: readonly Mode[] = ['comb', 'tube', 'string', 'metal'];

/**
 * Inharmonic mode ratios for `metal`: zeros of the Bessel functions, the modes of a circular membrane or plate,
 * which is what makes struck metal sound clangorous rather than pitched.
 */
const METAL_RATIOS = [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501, 3.6, 4.06, 4.154, 4.601, 4.832, 4.903, 5.131, 5.412];

const PARAMS: Record<string, ParamMeta> = {
  mode: {
    kind: 'enum',
    doc:
      'What resonates. comb: every harmonic, buzzy and metallic-flanged. tube: odd harmonics only, hollow like a ' +
      'pipe, bottle or wind through a hole. string: a ringing string, warm, highs fading first. metal: inharmonic ' +
      'modes of a struck plate or bell, clangorous shimmer.',
    options: MODES,
    default: 'comb',
  },
  freq: {
    kind: 'signal',
    doc:
      'Fundamental (lowest mode) in Hz. Sweep it for wind through a moving hole or a resonant whoosh; a chord adds ' +
      'more notes above it.',
    default: 220,
    min: 40,
    max: 4000,
    hardMin: 20,
    hardMax: 8000,
    unit: 'Hz',
    scale: 'log',
  },
  decay: {
    kind: 'signal',
    doc: 'Seconds the resonance rings after the input stops (60 dB): 0.05 a short box tone, 1 a pipe, 4+ a bell or a long metal shimmer.',
    default: 1,
    min: 0.05,
    max: 10,
    hardMin: 0.005,
    hardMax: 30,
    unit: 's',
    scale: 'log',
  },
  brightness: {
    kind: 'number',
    doc: 'How long the upper harmonics or modes ring compared with the lowest, 0 to 1: 0 mellow and pure, 0.5 natural, 1 bright and buzzy.',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  chord: {
    kind: 'array',
    doc: 'More resonances, in semitones above `freq` (up to 8): [0, 7, 12] a power chord, [0, 3.86, 7.02] a just major triad, [0, 0.3] a slow beating pair.',
    item: { kind: 'number', doc: 'Semitones above `freq`.', min: -24, max: 36, hardMin: -48, hardMax: 48, unit: 'st' },
  },
};

function maxOf(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (isBreakpoints(v)) return Math.max(...v.map((p) => p[1]));
  if (isSignalObject(v)) {
    const s = v as { value?: number; env?: [number, number][] };
    if (s.env && s.env.length) return Math.max(...s.env.map((p) => p[1]));
    if (typeof s.value === 'number') return s.value;
  }
  return fallback;
}

function chordOf(p: Record<string, unknown>): number[] {
  const c = Array.isArray(p.chord) ? (p.chord as unknown[]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
  if (c.length === 0) return [0];
  return c.slice(0, 8).map((v) => clamp(v, -48, 48));
}

/** Pole of the one-pole loop low-pass for a fundamental and brightness, or 0 for none. */
function loopPole(f0: number, brightness: number, sr: number): number {
  if (brightness >= 0.999) return 0;
  const fc = Math.min(f0 * Math.pow(2, 1 + 8 * brightness), sr * 0.45);
  return Math.exp((-2 * Math.PI * fc) / sr);
}

/** Phase delay (samples) of the one-pole low-pass y = (1 - a) x + a y' at angular frequency w. */
function lpPhaseDelay(a: number, w: number): number {
  if (a <= 0) return 0;
  return Math.atan2(a * Math.sin(w), 1 - a * Math.cos(w)) / w;
}

/** Phase delay (samples) of the allpass (c + z^-1) / (1 + c z^-1) at w. */
function apPhaseDelay(c: number, w: number): number {
  const num = Math.atan2(-Math.sin(w), c + Math.cos(w));
  const den = Math.atan2(-c * Math.sin(w), 1 + c * Math.cos(w));
  return -(num - den) / w;
}

/**
 * Output scale that keeps white noise at about its own level: the inverse square root of the loop's mean power
 * gain, 1 / (1 - g² |H(f)|²) averaged over frequency.
 */
function combNorm(g: number, a: number): number {
  let sum = 0;
  const K = 24;
  for (let k = 0; k < K; k++) {
    const w = (Math.PI * (k + 0.5)) / K;
    const h2 = a > 0 ? ((1 - a) * (1 - a)) / (1 - 2 * a * Math.cos(w) + a * a) : 1;
    sum += 1 / Math.max(1 - g * g * h2, 1e-6);
  }
  return 1 / Math.sqrt(sum / K);
}

const CONTROL = 32;

/** One comb, tube or string voice on one channel. */
function renderLoop(x: Buf, out: Buf, mode: Mode, freq: Buf, decay: Buf, semis: number, detuneCents: number, brightness: number, sr: number, level: number): void {
  const n = x.length;
  const ratio = Math.pow(2, semis / 12 + detuneCents / 1200);
  const half = mode === 'tube';
  const sign = half ? -1 : 1;
  const disp = mode === 'string' ? -0.18 : 0;
  const fMax = sr / (half ? 8 : 4);
  const line = new DelayLine(sr / (20 * ratio) + 8);
  let lp = 0;
  let apX = 0;
  let apY = 0;
  let a = 0;
  let g = 0;
  let norm = 1;
  let len = 4;
  for (let i = 0; i < n; i++) {
    if (i % CONTROL === 0) {
      const f0 = clamp(freq[i] * ratio, 20, fMax);
      a = loopPole(f0, brightness, sr);
      const w = (2 * Math.PI * f0) / sr;
      // The loop is one period (half a period for the inverted tube), less what the filters delay.
      const period = (half ? 0.5 : 1) * (sr / f0);
      len = Math.max(period - lpPhaseDelay(a, w) - (disp !== 0 ? apPhaseDelay(disp, w) : 0), 2);
      g = Math.pow(10, (-3 * period) / (sr * Math.max(decay[i], 0.005)));
      // The loop low-pass also loses a little at the fundamental: make that up so `decay` holds there.
      if (a > 0) {
        const h = (1 - a) / Math.sqrt(1 - 2 * a * Math.cos(w) + a * a);
        g = Math.min(g / h, 0.99999);
      }
      norm = combNorm(g, a) * level;
    }
    let y = line.read(len);
    lp = (1 - a) * y + a * lp;
    y = lp;
    if (disp !== 0) {
      const v = disp * (y - apY) + apX;
      apX = y;
      apY = v;
      y = v;
    }
    const s = x[i] + sign * g * y;
    line.write(s);
    out[i] += s * norm;
  }
}

/** The inharmonic modal bank of `metal` for one voice on one channel. */
function renderMetal(x: Buf, out: Buf, freq: Buf, decay: Buf, semis: number, brightness: number, sr: number, level: number, rng: Rng): void {
  const n = x.length;
  const ratio = Math.pow(2, semis / 12);
  const M = METAL_RATIOS.length;
  const detune = METAL_RATIOS.map(() => 1 + rng.uniform(-0.008, 0.008));
  const amps = METAL_RATIOS.map((r) => Math.pow(r, -(1 - brightness)) * (0.7 + 0.6 * rng.next()));
  let ampNorm = 0;
  for (const v of amps) ampNorm += v * v;
  ampNorm = 1 / Math.sqrt(ampNorm);
  const y1 = new Float64Array(M);
  const y2 = new Float64Array(M);
  const b0 = new Float64Array(M);
  const a1 = new Float64Array(M);
  const a2 = new Float64Array(M);
  const nyq = sr * 0.45;
  for (let i = 0; i < n; i += CONTROL) {
    const f0 = freq[i] * ratio;
    const t60 = Math.max(decay[i], 0.005);
    for (let m = 0; m < M; m++) {
      const f = f0 * METAL_RATIOS[m] * detune[m];
      if (f >= nyq) {
        b0[m] = 0;
        a1[m] = 0;
        a2[m] = 0;
        continue;
      }
      // Higher modes die faster unless the metal is bright.
      const t = t60 * Math.pow(METAL_RATIOS[m], -1.5 * (1 - brightness));
      const r = Math.exp(-6.907755 / (Math.max(t, 0.002) * sr));
      const w = (2 * Math.PI * f) / sr;
      a1[m] = 2 * r * Math.cos(w);
      a2[m] = -r * r;
      // Unit noise gain per mode: the impulse response sin(w (n+1)) r^n has energy about 1 / (2 (1 - r²)).
      b0[m] = Math.sin(w) * Math.sqrt(2 * (1 - r * r)) * amps[m] * ampNorm * level;
    }
    const end = Math.min(n, i + CONTROL);
    for (let m = 0; m < M; m++) {
      const bb = b0[m];
      if (bb === 0 && y1[m] === 0 && y2[m] === 0) continue;
      const aa1 = a1[m];
      const aa2 = a2[m];
      let p1 = y1[m];
      let p2 = y2[m];
      for (let j = i; j < end; j++) {
        const y = bb * x[j] + aa1 * p1 + aa2 * p2;
        p2 = p1;
        p1 = y;
        out[j] += y;
      }
      y1[m] = p1;
      y2[m] = p2;
    }
  }
}

/** Tuned resonance on any input: combs, tubes, strings and metal modes that ring at chosen pitches. */
export const resonator: EffectDef = {
  kind: 'effect',
  type: 'resonator',
  label: 'Resonator',
  category: 'filter',
  doc:
    'Makes the input ring at chosen pitches: noise becomes a pipe or a bottle (tube), a whistle of wind through ' +
    'a hole (tube with a moving freq), a sympathetic string, or a metallic shimmer (metal); a click becomes a ' +
    'struck object. White noise comes out at about its own level; a tone at the resonance is boosted. Use `chord` ' +
    'for several pitches at once, and `mix` to keep some of the dry sound.',
  params: PARAMS,
  example: { type: 'resonator', mode: 'tube', freq: [[0, 300], [1.5, 520]], decay: 0.8, brightness: 0.3 },
  tail(params) {
    return Math.min(maxOf(params.decay, 1), 30) * 1.1;
  },
  process(input, p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    const mode: Mode = MODES.includes(p.mode as Mode) ? (p.mode as Mode) : 'comb';
    const freq = ctx.signal('freq', n);
    const decay = ctx.signal('decay', n);
    const brightness = ctx.num('brightness');
    const chord = chordOf(p);
    const level = 1 / Math.sqrt(chord.length);
    return input.map((x, c) => {
      const out = new Float64Array(n);
      chord.forEach((semis, v) => {
        if (mode === 'metal') renderMetal(x, out, freq, decay, semis, brightness, sr, level, new Rng(0x6d6574 + v * 7919));
        else if (mode === 'string') {
          // Two strings a hair apart, as in a piano's unison: a slow, shallow beat in the ring.
          renderLoop(x, out, mode, freq, decay, semis, -0.35 + 0.1 * c, brightness, sr, level * 0.8);
          renderLoop(x, out, mode, freq, decay, semis, 0.35 - 0.1 * c, brightness, sr, level * 0.6);
        } else renderLoop(x, out, mode, freq, decay, semis, 0, brightness, sr, level);
      });
      return out;
    });
  },
};
