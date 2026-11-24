/**
 * Turns parameter values (numbers, breakpoint lists, signal objects) and envelopes into per-sample curves.
 */
import type {
  AdsrEnvelope,
  Breakpoint,
  Curve,
  Envelope,
  LfoShape,
  ModUnit,
  Modulator,
  ParamValue,
  PointsEnvelope,
  SignalObject,
} from './format/types';
import type { ParamMeta } from './nodes';
import { bendPosition, clamp, smoothstep, TAU, type Buf } from './dsp/math';
import { wander } from './dsp/noise';
import type { Rng } from './dsp/rng';

export function isBreakpoints(v: unknown): v is Breakpoint[] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

export function isSignalObject(v: unknown): v is SignalObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalises any ParamValue to a signal object. */
export function toSignalObject(v: ParamValue | undefined, fallback: number): SignalObject {
  if (v === undefined || v === null) return { value: fallback };
  if (typeof v === 'number') return { value: v };
  if (isBreakpoints(v)) return { env: v };
  return v;
}

/** True when the value cannot change over time. */
export function isConstant(v: ParamValue | undefined): boolean {
  if (v === undefined || typeof v === 'number') return true;
  if (isBreakpoints(v)) return v.length <= 1;
  const s = v as SignalObject;
  return (!s.env || s.env.length <= 1) && (!s.mod || s.mod.length === 0);
}

function sortedPoints(points: Breakpoint[]): Breakpoint[] {
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] < points[i - 1][0]) return [...points].sort((a, b) => a[0] - b[0]);
  }
  return points;
}

function interpolate(v0: number, v1: number, x: number, curve: Curve): number {
  switch (curve) {
    case 'hold':
      return v0;
    case 'smooth':
      return v0 + (v1 - v0) * smoothstep(x);
    case 'exp':
      if (v0 > 0 && v1 > 0) return v0 * Math.pow(v1 / v0, x);
      if (v0 < 0 && v1 < 0) return v0 * Math.pow(v1 / v0, x);
      return v0 + (v1 - v0) * x;
    case 'linear':
      return v0 + (v1 - v0) * x;
    default:
      return v0 + (v1 - v0) * bendPosition(x, typeof curve === 'number' ? curve : 0);
  }
}

/** Value of breakpoints at time t (seconds). Before the first point: its value; after the last: the last value. */
export function breakpointsAt(points: Breakpoint[], t: number, defaultCurve: Curve): number {
  const p = sortedPoints(points);
  if (t <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i][0]) {
      const [t0, v0] = p[i - 1];
      const [t1, v1] = p[i];
      const x = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return interpolate(v0, v1, x, p[i][2] ?? defaultCurve);
    }
  }
  return p[p.length - 1][1];
}

/** Fills `out` with breakpoints sampled at `sr`, starting at time `t0`. */
export function renderBreakpoints(points: Breakpoint[], out: Buf, sr: number, defaultCurve: Curve, t0 = 0): Buf {
  const p = sortedPoints(points);
  const n = out.length;
  let seg = 1;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / sr;
    if (t <= p[0][0]) {
      out[i] = p[0][1];
      continue;
    }
    while (seg < p.length && t > p[seg][0]) seg++;
    if (seg >= p.length) {
      out[i] = p[p.length - 1][1];
      continue;
    }
    const [ta, va] = p[seg - 1];
    const [tb, vb] = p[seg];
    const x = tb > ta ? (t - ta) / (tb - ta) : 1;
    out[i] = interpolate(va, vb, x, p[seg][2] ?? defaultCurve);
  }
  return out;
}

function lfoShape(shape: LfoShape, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'sine':
      return Math.sin(TAU * p);
    case 'triangle':
      return 1 - 4 * Math.abs(p - 0.5);
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'saw':
      return 1 - 2 * p;
    case 'ramp':
      return 2 * p - 1;
    default:
      return 0;
  }
}

function curveOrConstant(v: number | Breakpoint[], n: number, sr: number, curve: Curve, t0: number): Buf {
  const out = new Float64Array(n);
  if (typeof v === 'number') out.fill(v);
  else renderBreakpoints(v, out, sr, curve, t0);
  return out;
}

/** The modulator's own wave, -1..1 times depth (in its unit), per sample. */
function modulatorWave(m: Modulator, n: number, sr: number, rng: Rng, t0: number): Buf {
  const rate = curveOrConstant(m.rate ?? 1, n, sr, 'exp', t0);
  const depth = curveOrConstant(m.depth ?? 0, n, sr, 'linear', t0);
  const out = new Float64Array(n);
  if (m.type === 'wander') {
    const meanRate = rate.reduce((a, b) => a + b, 0) / Math.max(n, 1);
    const w = wander(n, sr, Math.max(meanRate, 0.01), rng);
    for (let i = 0; i < n; i++) out[i] = w[i] * depth[i];
  } else {
    const shape = m.shape ?? 'sine';
    let phase = (m.phase ?? 0) + (t0 * (typeof m.rate === 'number' ? m.rate : rate[0]));
    let held = rng.uniform(-1, 1);
    let next = rng.uniform(-1, 1);
    for (let i = 0; i < n; i++) {
      let s: number;
      if (shape === 'random') s = held;
      else if (shape === 'smooth-random') {
        const x = phase - Math.floor(phase);
        s = held + (next - held) * (0.5 - 0.5 * Math.cos(Math.PI * x));
      } else s = lfoShape(shape, phase);
      out[i] = s * depth[i];
      const before = Math.floor(phase);
      phase += rate[i] / sr;
      if (Math.floor(phase) !== before) {
        held = shape === 'smooth-random' ? next : rng.uniform(-1, 1);
        next = rng.uniform(-1, 1);
      }
    }
  }
  const delay = m.delay ?? 0;
  const fade = m.fade ?? 0;
  if (delay > 0 || fade > 0) {
    for (let i = 0; i < n; i++) {
      const t = t0 + i / sr - delay;
      out[i] *= t < 0 ? 0 : fade > 0 ? smoothstep(t / fade) : 1;
    }
  }
  return out;
}

function applyMod(base: Buf, wave: Buf, unit: ModUnit): void {
  const n = base.length;
  switch (unit) {
    case 'value':
      for (let i = 0; i < n; i++) base[i] += wave[i];
      break;
    case 'st':
      for (let i = 0; i < n; i++) base[i] *= Math.pow(2, wave[i] / 12);
      break;
    case 'cents':
      for (let i = 0; i < n; i++) base[i] *= Math.pow(2, wave[i] / 1200);
      break;
    case 'oct':
      for (let i = 0; i < n; i++) base[i] *= Math.pow(2, wave[i]);
      break;
    case 'pct':
      for (let i = 0; i < n; i++) base[i] *= 1 + wave[i] / 100;
      break;
    case 'db':
      for (let i = 0; i < n; i++) base[i] *= Math.pow(10, wave[i] / 20);
      break;
  }
}

export interface CompileOptions {
  sr: number;
  n: number;
  rng: Rng;
  /** Multiplies the result when the parameter is pitched. */
  pitchRatio?: Buf;
  /** Seconds at sample 0 (breakpoint times are measured from the event or buffer start). */
  t0?: number;
}

function fallbackOf(meta: ParamMeta): number {
  return typeof meta.default === 'number' ? meta.default : 0;
}

/** Compiles a parameter to a per-sample curve, applying its metadata: default, curve, pitch and hard limits. */
export function compileSignal(value: ParamValue | undefined, meta: ParamMeta, opts: CompileOptions): Buf {
  const { sr, n } = opts;
  const t0 = opts.t0 ?? 0;
  const sig = toSignalObject(value, fallbackOf(meta));
  const defaultCurve: Curve = sig.curve ?? (meta.scale === 'log' ? 'exp' : 'linear');
  const out = new Float64Array(n);
  if (sig.env && sig.env.length > 0) renderBreakpoints(sig.env, out, sr, defaultCurve, t0);
  else out.fill(typeof sig.value === 'number' && Number.isFinite(sig.value) ? sig.value : fallbackOf(meta));
  if (sig.mod) {
    sig.mod.forEach((m, k) => {
      const unit: ModUnit = m.unit ?? (meta.scale === 'log' ? 'st' : 'value');
      applyMod(out, modulatorWave(m, n, sr, opts.rng.fork('mod', k), t0), unit);
    });
  }
  if (meta.pitch && opts.pitchRatio) {
    const pr = opts.pitchRatio;
    for (let i = 0; i < n; i++) out[i] *= pr[i];
  }
  const lo = meta.hardMin ?? -Infinity;
  const hi = meta.hardMax ?? Infinity;
  for (let i = 0; i < n; i++) {
    const v = out[i];
    out[i] = Number.isFinite(v) ? clamp(v, lo, hi) : fallbackOf(meta);
  }
  return out;
}

/** A parameter's value at time t0 (default 0) as one number, with pitch applied when given. */
export function constantOf(value: ParamValue | undefined, meta: ParamMeta, pitchRatio = 1, t0 = 0): number {
  const sig = toSignalObject(value, fallbackOf(meta));
  const defaultCurve: Curve = sig.curve ?? (meta.scale === 'log' ? 'exp' : 'linear');
  let v = sig.env && sig.env.length > 0 ? breakpointsAt(sig.env, t0, defaultCurve) : sig.value ?? fallbackOf(meta);
  if (!Number.isFinite(v)) v = fallbackOf(meta);
  if (meta.pitch) v *= pitchRatio;
  return clamp(v, meta.hardMin ?? -Infinity, meta.hardMax ?? Infinity);
}

// ---- Envelopes -----------------------------------------------------------------------------

export function isPointsEnvelope(e: Envelope): e is PointsEnvelope {
  return Array.isArray((e as PointsEnvelope).points);
}

const LN1000 = Math.log(1000);

/** Fills the release-free part of an ADSR at time t. */
function adsrLevel(e: Required<Pick<AdsrEnvelope, 'attack' | 'hold' | 'sustain'>> & AdsrEnvelope, t: number): number {
  const a = e.attack;
  if (t < a) return a > 0 ? t / a : 1;
  const td = t - a - e.hold;
  if (td <= 0 || e.decay === undefined) return td <= 0 ? 1 : e.sustain;
  const s = e.sustain;
  if (e.curve === 'linear') return 1 - (1 - s) * Math.min(td / Math.max(e.decay, 1e-6), 1);
  return s + (1 - s) * Math.exp((-LN1000 * td) / Math.max(e.decay, 1e-6));
}

function adsrDefaults(e: AdsrEnvelope) {
  return {
    ...e,
    attack: Math.max(e.attack ?? 0.002, 0),
    hold: Math.max(e.hold ?? 0, 0),
    sustain: clamp(e.sustain ?? (e.decay !== undefined ? 0 : 1), 0, 1),
    release: Math.max(e.release ?? 0.01, 0),
  };
}

/**
 * Renders an amplitude envelope (0..1) over n samples. `gate` is the event's held time in seconds (Infinity when
 * the envelope has no gate of its own and the event gives no `dur`).
 */
export function renderEnvelope(env: Envelope, n: number, sr: number, gate: number): Buf {
  const out = new Float64Array(n);
  if (isPointsEnvelope(env)) {
    const curve = env.curve ?? 'linear';
    if (curve === 'exp') {
      // Interpolate in decibels so decays sound natural; 0 means silence (-100 dB floor).
      const db = env.points.map(([t, v, c]) => [t, v > 1e-5 ? 20 * Math.log10(v) : -100, c ?? 'linear'] as Breakpoint);
      renderBreakpoints(db, out, sr, 'linear');
      for (let i = 0; i < n; i++) out[i] = out[i] <= -99.9 ? 0 : Math.pow(10, out[i] / 20);
    } else {
      renderBreakpoints(env.points, out, sr, curve);
    }
    for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i]);
    return out;
  }
  const e = adsrDefaults(env);
  const g = env.gate ?? gate;
  const gateLevel = Number.isFinite(g) ? adsrLevel(e, g) : 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (!Number.isFinite(g) || t < g) {
      out[i] = adsrLevel(e, t);
      continue;
    }
    const tr = t - g;
    if (e.release <= 0) out[i] = 0;
    else if (e.curve === 'linear') out[i] = gateLevel * Math.max(1 - tr / e.release, 0);
    else out[i] = gateLevel * Math.exp((-LN1000 * tr) / e.release);
  }
  return out;
}

/** Seconds until the envelope has died away (60 dB down), or Infinity when it sustains with no gate. */
export function envelopeLength(env: Envelope, gate: number): number {
  if (isPointsEnvelope(env)) {
    const pts = sortedPoints(env.points);
    const last = pts[pts.length - 1];
    return last[1] <= 1e-4 ? last[0] : Infinity;
  }
  const e = adsrDefaults(env);
  const g = env.gate ?? gate;
  const decayed = e.decay !== undefined && e.sustain <= 1e-4 ? e.attack + e.hold + e.decay : Infinity;
  if (Number.isFinite(g)) return Math.min(g + e.release, decayed);
  return decayed;
}
