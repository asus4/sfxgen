import type { ParamMeta, SourceDef } from '../nodes';
import type { Envelope, ParamValue } from '../format/types';
import { renderEnvelope } from '../params';
import { TAU, clamp, type Buf } from '../dsp/math';
import { dcBlock } from '../dsp/filters';
import { decimate2, upsampleCurve } from '../dsp/halfband';

type Algorithm = 'stack' | 'parallel' | 'pairs';

const MAX_OPS = 4;

/** Fields of one operator. */
const FM_OP_FIELDS: Record<string, ParamMeta> = {
  id: { kind: 'string', doc: 'Name for paths and controls: `tracks.bell.source.ops.<id>.index`.' },
  ratio: {
    kind: 'signal',
    doc:
      'Frequency as a multiple of `freq`. Whole numbers (1, 2, 3) give harmonic, musical tones; others (1.41, ' +
      '2.76, 3.5) give inharmonic bells, gongs and clangs. Breakpoints sweep the sidebands: a sci-fi "bwow".',
    default: 1,
    min: 0.25,
    max: 16,
    hardMin: 0,
    hardMax: 64,
    unit: 'x',
    scale: 'log',
  },
  fixed: {
    kind: 'signal',
    doc:
      'A fixed frequency instead of `ratio`; the operator then ignores the note and `pitch` (DX7 fixed mode). A slow ' +
      'fixed modulator (5 to 40 Hz) with a high index warbles or growls; a high one keeps the same clang under any note.',
    min: 1,
    max: 8000,
    hardMin: 0,
    hardMax: 24000,
    unit: 'Hz',
    scale: 'log',
  },
  detune: {
    kind: 'number',
    doc: 'Fine offset in cents. 2 to 8 cents on a second carrier makes slow beating; on a modulator the timbre shimmers.',
    default: 0,
    min: -50,
    max: 50,
    hardMin: -1200,
    hardMax: 1200,
    unit: 'cents',
  },
  index: {
    kind: 'signal',
    doc:
      'How hard this operator modulates its target, as peak phase deviation in radians (ignored on carriers). 0 is ' +
      'a pure sine, 1 to 2 warm, 3 to 6 bright and brassy, 8 to 15 metallic, 20+ noisy. Make it fall over time ' +
      '(breakpoints or `env`) for a struck sound that mellows.',
    default: 1,
    min: 0,
    max: 15,
    hardMin: 0,
    hardMax: 100,
  },
  env: {
    kind: 'envelope',
    doc:
      'Envelope on this operator. On a modulator it scales `index`: `{ "decay": 0.6, "sustain": 0.1 }` starts bright ' +
      'and mellows like a bell, `{ "attack": 0.08, "sustain": 1 }` swells like brass. On a carrier it scales `level`. ' +
      'Default: constant.',
  },
  feedback: {
    kind: 'signal',
    doc:
      'The operator modulates itself: 0 is a sine, 0.5 adds harmonics, 1 is close to a sawtooth (buzzy, brassy), ' +
      '1.5 and up breaks into noise. Lowered automatically at high pitch so it never aliases.',
    default: 0,
    min: 0,
    max: 1.5,
    hardMin: 0,
    hardMax: 4,
  },
  level: {
    kind: 'number',
    doc: 'Output level of a carrier, 0 to 1 (with two carriers, their balance); ignored on modulators.',
    default: 1,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 4,
  },
};

const DEFAULT_OPS = [{ ratio: 1 }, { ratio: 3.5, index: 4, env: { decay: 0.8, sustain: 0.15 } }];

/** Which operator each one modulates (-1: a carrier, heard). Always an earlier operator, so later ones run first. */
function targetsFor(algorithm: Algorithm, count: number): number[] {
  const t: number[] = [];
  for (let k = 0; k < count; k++) {
    if (k === 0) t.push(-1);
    else if (algorithm === 'parallel') t.push(0);
    else if (algorithm === 'pairs') t.push(k % 2 === 1 ? k - 1 : -1);
    else t.push(k - 1);
  }
  return t;
}

/** Harmonics a feedback operator makes before they fall 60 dB (its spectrum is 2 J_n(n b) / (n b)). */
function feedbackHarmonics(b: number): number {
  if (b <= 1e-4) return 1;
  if (b >= 1) return 400;
  const s = Math.sqrt(1 - b * b);
  const g = Math.atanh(s) - s;
  return clamp(6.9 / g, 1, 400);
}

/** The largest feedback whose harmonics stay below 60 dB down by the `allowed`-th harmonic. */
function feedbackLimit(allowed: number): number {
  if (allowed >= 400) return 1;
  if (allowed <= 1) return 0;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 14; it++) {
    const mid = 0.5 * (lo + hi);
    if (feedbackHarmonics(mid) > allowed) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * How far past the peak frequency deviation a modulator's sidebands still matter, in multiples of its own
 * frequency: beyond 1 + 2 * cbrt(index) they are 40 to 60 dB down (Bessel functions fall fast past their order).
 */
function sidebandTail(index: number): number {
  return 1 + 2 * Math.cbrt(index);
}

/** The operators of one event as per-sample curves. */
interface OpCurves {
  count: number;
  target: number[];
  freq: Buf[];
  /** Modulators: index x envelope x brightness. Carriers: their level envelope. */
  depth: Buf[];
  fb: Buf[];
  level: number[];
  hasFb: boolean[];
}

interface Guard {
  index: Float64Array;
  fb: Float64Array[];
  reduced: boolean;
}

/**
 * The alias guard, once per block: one scale for every modulation index so the widest carrier's significant
 * sidebands stay below `limit` Hz, and a cap on each feedback so its harmonics do too. Interpolated across blocks.
 */
function guardOf(v: OpCurves, n: number, limit: number, block: number): Guard {
  const { count, target } = v;
  const blocks = Math.ceil(n / block) + 1;
  const index = new Float64Array(blocks);
  const fb = v.freq.map(() => new Float64Array(blocks).fill(1));
  // Each operator's highest instantaneous frequency (its own, times its feedback harmonics, plus the deviation its
  // modulators push it to) and the sideband tail beyond it. Measured against renders at 192 kHz, this bounds the
  // -50 dB edge of 2 to 4 operator stacks within about 10 to 50 % above the true edge.
  const top = new Float64Array(count);
  const tail = new Float64Array(count);
  const fbEff = new Float64Array(count);
  let reduced = false;
  const widest = (i: number, s: number): number => {
    for (let k = 0; k < count; k++) {
      top[k] = Math.abs(v.freq[k][i]) * feedbackHarmonics(fbEff[k]);
      tail[k] = 0;
    }
    for (let j = count - 1; j >= 1; j--) {
      const t = target[j];
      const I = s * v.depth[j][i];
      if (t < 0 || I <= 1e-6) continue;
      top[t] += I * top[j];
      tail[t] += sidebandTail(I) * top[j];
    }
    let w = 0;
    for (let k = 0; k < count; k++) if (target[k] < 0) w = Math.max(w, top[k] + tail[k]);
    return w;
  };
  for (let b = 0; b < blocks; b++) {
    const i = Math.min(b * block, n - 1);
    for (let k = 0; k < count; k++) {
      const beta = v.fb[k][i];
      if (!v.hasFb[k] || beta <= 0) {
        fbEff[k] = 0;
        continue;
      }
      const f = Math.abs(v.freq[k][i]);
      const cap = f > 0 ? feedbackLimit(limit / f) : 1;
      // Up to 1 the cap is a ceiling; above 1 (the noisy region) it scales the amount down in proportion.
      const eff = beta <= 1 ? Math.min(beta, cap) : beta * cap;
      fbEff[k] = eff;
      fb[k][b] = eff / beta;
      if (fb[k][b] < 0.999) reduced = true;
    }
    let s = 1;
    if (widest(i, 1) > limit) {
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 14; it++) {
        const mid = 0.5 * (lo + hi);
        if (widest(i, mid) > limit) hi = mid;
        else lo = mid;
      }
      s = lo;
      if (s < 0.999) reduced = true;
    }
    index[b] = s;
  }
  return { index, fb, reduced };
}

/** Runs the operators sample by sample at rate `sr`. */
function synth(v: OpCurves, n: number, sr: number, g: Guard, block: number): Buf {
  const { count, target } = v;
  let norm = 0;
  for (let k = 0; k < count; k++) if (target[k] < 0) norm += v.level[k];
  norm = norm > 1 ? 1 / norm : 1;
  const out = new Float64Array(n);
  const phase = new Float64Array(count);
  const y1 = new Float64Array(count);
  const y2 = new Float64Array(count);
  const mod = new Float64Array(count);
  const invSr = 1 / sr;
  const fadeLo = 0.42 * sr;
  const fadeHi = 0.48 * sr;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / block);
    const x = (i - b * block) / block;
    const s = g.index[b] + (g.index[b + 1] - g.index[b]) * x;
    mod.fill(0);
    let sum = 0;
    for (let k = count - 1; k >= 0; k--) {
      const f = v.freq[k][i];
      let ph = phase[k] + f * invSr;
      if (ph >= 1 || ph < 0) ph -= Math.floor(ph);
      phase[k] = ph;
      let arg = TAU * ph + mod[k];
      if (v.hasFb[k]) {
        const fs = g.fb[k][b] + (g.fb[k][b + 1] - g.fb[k][b]) * x;
        arg += v.fb[k][i] * fs * 0.5 * (y1[k] + y2[k]);
      }
      const out1 = Math.sin(arg);
      y2[k] = y1[k];
      y1[k] = out1;
      const t = target[k];
      if (t >= 0) mod[t] += s * v.depth[k][i] * out1;
      else {
        // A carrier above the Nyquist limit would alias: fade it out instead.
        const af = Math.abs(f);
        const fade = af < fadeLo ? 1 : af > fadeHi ? 0 : (fadeHi - af) / (fadeHi - fadeLo);
        sum += v.level[k] * v.depth[k][i] * fade * out1;
      }
    }
    out[i] = sum * norm;
  }
  return out;
}

/** 2 to 4 operator phase-modulation synthesis: bells, gongs, zaps, metal, FM brass and alien tones. */
export const fm: SourceDef = {
  kind: 'source',
  type: 'fm',
  label: 'FM',
  category: 'tone',
  doc:
    'Phase-modulation (DX7-style FM) with up to 4 sine operators. Reach for it for bells, gongs, tubular chimes, ' +
    'metallic hits, electric zaps, FM brass and alien tones: anything bright whose overtones should move. Inharmonic ' +
    'ratios (3.5, 1.41, 2.76) ring like metal; whole-number ratios sound like instruments. A decaying modulator ' +
    'index makes a strike that mellows; a rising one, a swell. Softer events (vel < 1) are darker as well as quieter. ' +
    'High notes with big indices render at twice the rate, and the index only gives way where its sidebands would ' +
    'still alias, so nothing folds back.',
  defaultEnv: { attack: 0.001, decay: 2 },
  params: {
    freq: {
      kind: 'signal',
      doc: 'Base frequency; each operator runs at `freq` times its `ratio`. Breakpoints glide exponentially.',
      default: 440,
      min: 20,
      max: 8000,
      hardMin: 0.5,
      hardMax: 20000,
      unit: 'Hz',
      scale: 'log',
      pitch: true,
    },
    algorithm: {
      kind: 'enum',
      doc:
        'How the operators connect; ops[0] is always heard. stack: each operator modulates the one before it ' +
        '(ops[3] > ops[2] > ops[1] > ops[0]), the brightest and most complex. parallel: all the others modulate ops[0], ' +
        'a rich single tone. pairs: ops[1] modulates ops[0] and ops[3] modulates ops[2], two tones heard together ' +
        '(a bell\'s strike and hum, layered brass); with 3 operators ops[2] is a plain second carrier.',
      options: ['stack', 'parallel', 'pairs'],
      default: 'stack',
    },
    ops: {
      kind: 'array',
      doc:
        'The operators, 1 to 4 sine oscillators: `[{ "ratio": 1 }, { "ratio": 3.5, "index": 4, "env": { "decay": 0.8 } }]`. ' +
        'A modulator\'s `index` and `env` shape the brightness; a carrier\'s `level` and `env` its loudness.',
      default: DEFAULT_OPS,
      item: { kind: 'object', doc: 'One operator: { ratio or fixed, detune, index, env, feedback, level, id }.', fields: FM_OP_FIELDS },
    },
  },
  example: {
    type: 'fm',
    freq: 220,
    algorithm: 'stack',
    ops: [{ ratio: 1 }, { ratio: 1.4, index: 7, env: { decay: 1.6, sustain: 0.05 } }, { ratio: 2.13, index: 2.5, env: { decay: 0.4 } }],
    env: { attack: 0.002, decay: 4 },
  },
  render(p, ctx) {
    const { n, sr } = ctx;
    const freq = ctx.signal('freq');
    const algorithm = (['stack', 'parallel', 'pairs'].includes(p.algorithm as string) ? p.algorithm : 'stack') as Algorithm;
    const given = Array.isArray(p.ops) ? (p.ops as unknown[]).filter((o) => o !== null && typeof o === 'object') : [];
    const ops = (given.length > 0 ? given : DEFAULT_OPS).slice(0, MAX_OPS) as Record<string, unknown>[];
    const count = ops.length;
    const target = targetsFor(algorithm, count);
    // Softer events modulate less: darker, like a lighter strike.
    const bright = clamp(Math.sqrt(Math.max(ctx.vel, 0)), 0, 1.5);

    const v: OpCurves = { count, target, freq: [], depth: [], fb: [], level: [], hasFb: [] };
    for (let k = 0; k < count; k++) {
      const o = ops[k];
      const detune = Math.pow(2, ctx.numOf(o.detune as ParamValue | undefined, FM_OP_FIELDS.detune) / 1200);
      let f: Buf;
      if (o.fixed !== undefined && o.fixed !== null) {
        f = ctx.signalOf(o.fixed as ParamValue, FM_OP_FIELDS.fixed, `op${k}.fixed`);
      } else {
        f = ctx.signalOf(o.ratio as ParamValue | undefined, FM_OP_FIELDS.ratio, `op${k}.ratio`);
        for (let i = 0; i < n; i++) f[i] *= freq[i];
      }
      if (detune !== 1) for (let i = 0; i < n; i++) f[i] *= detune;
      v.freq.push(f);
      const env = o.env && typeof o.env === 'object' ? renderEnvelope(o.env as Envelope, n, sr, ctx.gate) : null;
      if (target[k] >= 0) {
        const d = ctx.signalOf(o.index as ParamValue | undefined, FM_OP_FIELDS.index, `op${k}.index`);
        for (let i = 0; i < n; i++) d[i] *= bright * (env ? env[i] : 1);
        v.depth.push(d);
        v.level.push(0);
      } else {
        const d = new Float64Array(n);
        if (env) d.set(env);
        else d.fill(1);
        v.depth.push(d);
        v.level.push(ctx.numOf(o.level as ParamValue | undefined, FM_OP_FIELDS.level));
      }
      const fb = ctx.signalOf(o.feedback as ParamValue | undefined, FM_OP_FIELDS.feedback, `op${k}.feedback`);
      v.fb.push(fb);
      v.hasFb.push(fb.some((b) => b > 0));
    }

    // At the output rate the guard keeps every significant sideband below 0.45 * sr. When that would dull the
    // tone (high notes, big indices), render at twice the rate instead: sidebands up to 1.4 * sr then either
    // land above the output band or fold back into it above 0.55 * sr, and the half-band decimator removes both.
    const B = 64;
    const g1 = guardOf(v, n, 0.45 * sr, B);
    let out: Buf;
    if (!g1.reduced) out = synth(v, n, sr, g1, B);
    else {
      const v2: OpCurves = { ...v, freq: v.freq.map(upsampleCurve), depth: v.depth.map(upsampleCurve), fb: v.fb.map(upsampleCurve) };
      out = decimate2(synth(v2, 2 * n, 2 * sr, guardOf(v2, 2 * n, 1.4 * sr, 2 * B), 2 * B));
    }
    // Feedback in its noisy region, and some sub-audio ratios, leave a little DC.
    return dcBlock(out, sr);
  },
};
