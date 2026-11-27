/**
 * Controls: the knobs a person sees first. Each control maps its value onto one or more parameters. Controls are
 * applied to a copy of the patch just before rendering, so the patch keeps both the base values and the knobs.
 */
import type { AdsrEnvelope, Breakpoint, Control, ControlTarget, MapCurve, Patch, SignalObject } from './types';
import type { ParamMeta } from '../nodes';
import { deepClone, getPath, setPath } from './paths';
import { bendPosition, clamp, smoothstep } from '../dsp/math';
import { isBreakpoints, isPointsEnvelope } from '../params';
import { Rng, hashString } from '../dsp/rng';

export type MetaLookup = (patch: Patch, path: string) => ParamMeta | undefined;

/** The control's position 0..1, on its own scale. */
export function controlPosition(c: Control): number {
  const min = c.min ?? 0;
  const max = c.max ?? 1;
  if (max === min) return 0;
  if (c.scale === 'exp' && min > 0 && max > 0) {
    return clamp(Math.log(Math.max(c.value, 1e-12) / min) / Math.log(max / min), 0, 1);
  }
  return clamp((c.value - min) / (max - min), 0, 1);
}

/** The control's value at a position 0..1. */
export function controlValueAt(c: Control, position: number): number {
  const min = c.min ?? 0;
  const max = c.max ?? 1;
  const p = clamp(position, 0, 1);
  const raw = c.scale === 'exp' && min > 0 && max > 0 ? min * Math.pow(max / min, p) : min + (max - min) * p;
  return c.step ? Math.round(raw / c.step) * c.step : raw;
}

export function mapValue(position: number, from: number, to: number, curve: MapCurve): number {
  const x = clamp(position, 0, 1);
  switch (curve) {
    case 'exp':
      if ((from > 0 && to > 0) || (from < 0 && to < 0)) return from * Math.pow(to / from, x);
      return from + (to - from) * x;
    case 'smooth':
      return from + (to - from) * smoothstep(x);
    case 'linear':
      return from + (to - from) * x;
    default:
      return from + (to - from) * bendPosition(x, curve);
  }
}

function defaultsFor(t: ControlTarget, meta: ParamMeta | undefined): { from: number; to: number; curve: MapCurve } {
  const mode = t.mode ?? 'set';
  let from = t.from;
  let to = t.to;
  if (from === undefined || to === undefined) {
    if (mode === 'set') {
      from ??= meta?.min ?? 0;
      to ??= meta?.max ?? 1;
    } else if (mode === 'add') {
      from ??= -1;
      to ??= 1;
    } else {
      from ??= 0.5;
      to ??= 2;
    }
  }
  const logish = mode === 'mul' || mode === 'stretch' || meta?.scale === 'log';
  const curve: MapCurve = t.curve ?? (logish && from > 0 && to > 0 ? 'exp' : 'linear');
  return { from, to, curve };
}

function transformValues(current: unknown, fn: (v: number) => number): unknown {
  if (typeof current === 'number') return fn(current);
  if (isBreakpoints(current)) return current.map(([t, v, c]) => (c === undefined ? [t, fn(v)] : [t, fn(v), c]) as Breakpoint);
  if (typeof current === 'object' && current !== null) {
    const s = { ...(current as SignalObject) };
    if (typeof s.value === 'number') s.value = fn(s.value);
    if (s.env) s.env = s.env.map(([t, v, c]) => (c === undefined ? [t, fn(v)] : [t, fn(v), c]) as Breakpoint);
    if (s.value === undefined && !s.env) return current;
    return s;
  }
  return current;
}

function stretchTimes(current: unknown, k: number): unknown {
  const scalePoints = (pts: Breakpoint[]) => pts.map(([t, v, c]) => (c === undefined ? [t * k, v] : [t * k, v, c]) as Breakpoint);
  if (isBreakpoints(current)) return scalePoints(current);
  // A track's events (seconds, or { t, dur }): the whole pattern speeds up or slows down.
  if (Array.isArray(current)) {
    return current.map((e) => {
      if (typeof e === 'number') return e * k;
      if (typeof e !== 'object' || e === null) return e;
      const ev = { ...(e as Record<string, unknown>) };
      if (typeof ev.t === 'number') ev.t = ev.t * k;
      if (typeof ev.dur === 'number') ev.dur = ev.dur * k;
      return ev;
    });
  }
  if (typeof current === 'object' && current !== null) {
    const obj = current as Record<string, unknown>;
    if (isPointsEnvelope(obj as never)) return { ...obj, points: scalePoints(obj.points as Breakpoint[]) };
    const out: Record<string, unknown> = { ...obj };
    if (Array.isArray(obj.env)) out.env = scalePoints(obj.env as Breakpoint[]);
    // An ADSR envelope (every duration) or a repeat (its timing) scales.
    for (const key of ['attack', 'hold', 'decay', 'release', 'gate', 'interval', 'jitter', 'dur'] as (keyof AdsrEnvelope)[]) {
      if (typeof obj[key] === 'number') out[key] = (obj[key] as number) * k;
    }
    return out;
  }
  if (typeof current === 'number') return current * k;
  return current;
}

/**
 * What a control's target maps to at the control's current value: the value it sets (`set`), the factor (`mul`,
 * `stretch`) or the amount (`add`).
 */
export function targetValue(c: Control, t: ControlTarget, meta: ParamMeta | undefined): number {
  const pos = controlPosition(c);
  // Where `via` sits: the control's default, else its middle.
  const anchor = c.default !== undefined ? controlPosition({ ...c, value: c.default }) : 0.5;
  const { from, to, curve } = defaultsFor(t, meta);
  if (typeof t.via === 'number' && anchor > 0 && anchor < 1) {
    return pos <= anchor ? mapValue(pos / anchor, from, t.via, curve) : mapValue((pos - anchor) / (1 - anchor), t.via, to, curve);
  }
  return mapValue(pos, from, to, curve);
}

/**
 * Applies one control to a patch in place. `phase` limits it to its absolute changes (options and `set` targets) or
 * its relative ones (`mul`, `add`, `stretch`).
 */
export function applyControl(
  patch: Patch,
  c: Control,
  metaAt: MetaLookup,
  warnings: string[],
  phase: 'all' | 'absolute' | 'relative' = 'all',
): void {
  if (phase !== 'relative' && c.options && c.options.length > 0) {
    const idx = clamp(Math.round(c.value), 0, c.options.length - 1);
    for (const [path, value] of Object.entries(c.options[idx].set ?? {})) {
      if (!setPath(patch, path, deepClone(value))) warnings.push(`control "${c.id}": option path not found: ${path}`);
    }
  }
  for (const t of c.targets ?? []) {
    const meta = metaAt(patch, t.path);
    const mapped = targetValue(c, t, meta);
    const mode = t.mode ?? 'set';
    if ((phase === 'absolute' && mode !== 'set') || (phase === 'relative' && mode === 'set')) continue;
    const current = getPath(patch, t.path);
    const base = current === undefined ? (typeof meta?.default === 'number' ? meta.default : undefined) : current;
    let next: unknown;
    if (mode === 'set') next = mapped;
    else if (mode === 'mul') next = base === undefined ? undefined : transformValues(base, (v) => v * mapped);
    else if (mode === 'add') next = base === undefined ? undefined : transformValues(base, (v) => v + mapped);
    else next = base === undefined ? undefined : stretchTimes(base, mapped);
    if (next === undefined) {
      warnings.push(`control "${c.id}": nothing to ${mode} at ${t.path}`);
      continue;
    }
    if (!setPath(patch, t.path, next)) warnings.push(`control "${c.id}": path not found: ${t.path}`);
  }
}

/** A copy of the patch with every control applied. */
export function applyControls(patch: Patch, metaAt: MetaLookup): { patch: Patch; warnings: string[] } {
  const out = deepClone(patch);
  const warnings: string[] = [];
  const controls = patch.controls ?? [];
  // Absolute values first (options, `set`), then relative changes on top, so the order of controls doesn't matter.
  for (const c of controls) applyControl(out, c, metaAt, warnings, 'absolute');
  for (const c of controls) applyControl(out, c, metaAt, warnings, 'relative');
  const setBy = new Map<string, string>();
  for (const c of controls) {
    const paths = [...(c.targets ?? []).filter((t) => (t.mode ?? 'set') === 'set').map((t) => t.path), ...(c.options ?? []).flatMap((o) => Object.keys(o.set ?? {}))];
    for (const path of new Set(paths)) {
      const other = setBy.get(path);
      if (other && other !== c.id) warnings.push(`controls "${other}" and "${c.id}" both set ${path}; "${c.id}" wins`);
      setBy.set(path, c.id);
    }
  }
  return { patch: out, warnings };
}

/**
 * A variation: each control with `vary` moves by up to ± that amount, and the seed changes, so the take differs
 * the way the author allowed. Returns a new patch (controls still unapplied).
 */
export function varyPatch(patch: Patch, rng: Rng, take: number): Patch {
  const out = deepClone(patch);
  out.seed = ((patch.seed ?? 1) + take * 7919) % 1000003;
  for (const c of out.controls ?? []) {
    if (!c.vary || c.options) continue;
    const min = c.min ?? 0;
    const max = c.max ?? 1;
    c.value = clamp(c.value + rng.uniform(-c.vary, c.vary), Math.min(min, max), Math.max(min, max));
  }
  return out;
}

/**
 * Round-robin takes: the patch itself, then `count - 1` variations. The editor, the CLI and the agent tools all use
 * this, so the same patch gives the same takes everywhere.
 */
export function variationTakes(patch: Patch, count: number): Patch[] {
  const rng = new Rng(hashString('variations', patch.seed ?? 1));
  const takes: Patch[] = [];
  for (let take = 0; take < Math.max(1, Math.floor(count)); take++) takes.push(take === 0 ? patch : varyPatch(patch, rng, take));
  return takes;
}

/** File name of a take: `stem-01.wav` when there are several, `stem.wav` for one. */
export function takeFileName(stem: string, take: number, count: number, ext = '.wav'): string {
  return count > 1 ? `${stem}-${String(take + 1).padStart(2, '0')}${ext}` : `${stem}${ext}`;
}
