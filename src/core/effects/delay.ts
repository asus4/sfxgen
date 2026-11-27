import type { EffectDef, ParamMeta } from '../nodes';
import { DelayLine } from '../dsp/fracdelay';
import { Svf } from '../dsp/filters';
import { wander } from '../dsp/noise';
import { isBreakpoints, isSignalObject } from '../params';
import type { Buf } from '../dsp/math';

const PARAMS: Record<string, ParamMeta> = {
  mix: { kind: 'number', doc: 'Wet amount, 0 to 1. Default 0.35 on a track or the master, where the dry sound passes too; on a bus (sends) every effect defaults to fully wet.', hint: 'How loud the echoes are against the dry sound', default: 0.35, min: 0, max: 1, hardMin: 0, hardMax: 1 },
  time: {
    kind: 'signal',
    doc:
      'Milliseconds between echoes. 30 to 90 is slapback (a hard wall nearby), 150 to 400 a clear echo, 500+ a ' +
      'canyon. It may move: the echoes bend in pitch like a tape echo whose speed changes.',
    hint: 'Time between echoes: short is slapback, long a canyon',
    default: 250,
    min: 20,
    max: 1000,
    hardMin: 0.5,
    hardMax: 4000,
    unit: 'ms',
    scale: 'log',
  },
  feedback: {
    kind: 'signal',
    doc:
      'How much of each echo comes back as the next one: 0 a single echo, 0.35 a few, 0.7 a long trail, 0.9 ' +
      'almost endless. Negative flips the polarity on every repeat (hollower).',
    hint: 'How many echoes: one to almost endless',
    default: 0.35,
    min: 0,
    max: 0.95,
    hardMin: -0.98,
    hardMax: 0.98,
  },
  tone: {
    kind: 'number',
    doc: 'Low-pass in the loop, Hz: every repeat gets darker. 2000 to 4000 for a tape echo, 20000 for a clean digital one.',
    hint: 'Each echo gets darker',
    default: 6000,
    min: 500,
    max: 20000,
    hardMin: 100,
    hardMax: 24000,
    unit: 'Hz',
    scale: 'log',
  },
  highpass: {
    kind: 'number',
    doc: 'High-pass in the loop, Hz: every repeat gets thinner. 300 to 800 keeps a long trail from muddying the lows.',
    hint: 'Each echo gets thinner',
    default: 60,
    min: 20,
    max: 2000,
    hardMin: 10,
    hardMax: 8000,
    unit: 'Hz',
    scale: 'log',
  },
  pingpong: {
    kind: 'bool',
    doc: 'Echoes bounce between left and right (stereo output only).',
    hint: 'Echoes bounce between left and right',
    default: false,
  },
  modulation: {
    kind: 'number',
    doc: 'Wobble of the echoes, cents of pitch: 5 is analog warmth, 15 to 30 a worn tape echo, 60 seasick.',
    hint: 'Wobbles the echoes like worn tape',
    default: 0,
    min: 0,
    max: 30,
    hardMin: 0,
    hardMax: 100,
    unit: 'cents',
  },
  rate: {
    kind: 'number',
    doc: 'Speed of the wobble, Hz.',
    hint: 'How fast the echoes wobble',
    default: 0.8,
    min: 0.1,
    max: 8,
    hardMin: 0.01,
    hardMax: 20,
    unit: 'Hz',
    scale: 'log',
  },
  drive: {
    kind: 'number',
    doc: 'Saturation inside the loop, 0 to 1: each repeat comes back a little grittier and rounder, like tape.',
    hint: 'Each echo comes back grittier',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
};

/** The largest magnitude a parameter value can take (number, breakpoints or signal object), ignoring modulators. */
function maxAbs(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v);
  if (isBreakpoints(v)) return Math.max(...v.map((p) => Math.abs(p[1])));
  if (isSignalObject(v)) {
    const s = v as { value?: number; env?: [number, number][] };
    if (s.env && s.env.length) return Math.max(...s.env.map((p) => Math.abs(p[1])));
    if (typeof s.value === 'number') return Math.abs(s.value);
  }
  return fallback;
}

/** Soft saturation that never adds gain, so the loop stays stable: clean on quiet echoes, rounding loud ones. */
function saturate(x: number, drive: number): number {
  if (drive <= 0) return x;
  const k = 0.5 + 2.5 * drive;
  return Math.tanh(x * k) / k;
}

export const delay: EffectDef = {
  kind: 'effect',
  type: 'delay',
  label: 'Delay',
  category: 'time',
  widens: true,
  doc:
    'Discrete echoes: slapback off a wall, a canyon call, a dub trail. `time` (ms) sets the gap, `feedback` how ' +
    'many repeats, `tone` and `highpass` how each repeat darkens and thins. It returns only the echoes: set ' +
    '`mix` to 0.3 to 0.5 to keep the dry sound in front, or use it on a bus.',
  hint: 'Echoes, from a slapback to a canyon',
  params: PARAMS,
  example: { type: 'delay', time: 320, feedback: 0.45, tone: 3500, mix: 0.4 },
  tail(params) {
    const time = Math.min(maxAbs(params.time, 250), 4000) / 1000;
    const fb = Math.min(maxAbs(params.feedback, 0.35), 0.98);
    const repeats = fb < 1e-3 ? 1 : Math.log(1e-3) / Math.log(fb) + 1;
    return Math.min(time * repeats, 30);
  },
  process(input, p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    const timeMs = ctx.signal('time', n);
    const fb = ctx.signal('feedback', n);
    const tone = ctx.num('tone');
    const hp = ctx.num('highpass');
    const depthCents = ctx.num('modulation');
    const rate = ctx.num('rate');
    const drive = ctx.num('drive');
    const ping = p.pingpong === true && input.length === 2;

    // The delay in samples per sample: the time plus the wobble (a sine with a little smooth drift on top).
    const d = new Float64Array(n);
    let maxD = 1;
    // Peak delay swing (samples) for a peak pitch deviation of `depthCents`: ratio - 1 = 2π f A.
    const amp = depthCents > 0 ? Math.min(((Math.pow(2, depthCents / 1200) - 1) / (2 * Math.PI * rate)) * sr, 0.05 * sr) : 0;
    const drift = amp > 0 ? wander(n, sr, rate * 0.7, ctx.rng.fork('drift')) : null;
    const phase = ctx.rng.fork('phase').next() * 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      let v = (timeMs[i] / 1000) * sr;
      if (amp > 0) v += amp * (Math.sin(phase + (2 * Math.PI * rate * i) / sr) + 0.3 * drift![i]);
      v = Math.max(v, 2);
      d[i] = v;
      if (v > maxD) maxD = v;
    }
    const chans = input.length;
    const lines = Array.from({ length: chans }, () => new DelayLine(maxD + 4));
    const lps = Array.from({ length: chans }, () => new Svf('lowpass', sr));
    const hps = Array.from({ length: chans }, () => new Svf('highpass', sr));
    const useLp = tone < sr * 0.45;
    const out: Buf[] = Array.from({ length: chans }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      const di = d[i];
      const g = fb[i];
      if (ping) {
        const yl = lines[0].read(di);
        const yr = lines[1].read(di);
        out[0][i] = yl;
        out[1][i] = yr;
        // The left line takes the input and the right line's echo; the right line takes the left's.
        let fl = hps[0].tick(useLp ? lps[0].tick(yr, tone, 0.707) : yr, hp, 0.707) * g;
        let fr = hps[1].tick(useLp ? lps[1].tick(yl, tone, 0.707) : yl, hp, 0.707) * g;
        fl = saturate(fl, drive);
        fr = saturate(fr, drive);
        lines[0].write(0.5 * (input[0][i] + input[1][i]) + fl);
        lines[1].write(fr);
      } else {
        for (let c = 0; c < chans; c++) {
          const y = lines[c].read(di);
          out[c][i] = y;
          let f = hps[c].tick(useLp ? lps[c].tick(y, tone, 0.707) : y, hp, 0.707) * g;
          f = saturate(f, drive);
          lines[c].write(input[c][i] + f);
        }
      }
    }
    return out;
  },
};

