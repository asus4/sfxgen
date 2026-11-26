/** Edits to a patch. Every function returns a new patch and leaves its argument alone. */
import {
  applyControls,
  deepClone,
  getEffect,
  getPath,
  getSource,
  metaAt,
  setPath,
  splitPath,
  COMMON_SOURCE_PARAMS,
  type Breakpoint,
  type Control,
  type EffectSpec,
  type ParamMeta,
  type ParamValue,
  type Patch,
  type SignalObject,
  type Track,
} from '../../core';
import { canonPath } from './paths';
import { positionToValue } from './knob';

export function mutate<T>(patch: T, fn: (draft: T) => void): T {
  const draft = deepClone(patch);
  fn(draft);
  return draft;
}

/** Sets (or, with `undefined`, removes) the value at a path. Works on a patch or on a project. */
export function setAt<T>(patch: T, path: string, value: unknown): T {
  return mutate(patch, (d) => {
    setPath(d, path, value);
    // Removing the last key of an optional group leaves `{}` behind; drop it so the file stays tidy.
    if (value === undefined) {
      const segs = splitPath(path);
      const parent = segs.slice(0, -1).join('.');
      const last = segs[segs.length - 2];
      const node = getPath(d, parent);
      if ((last === 'repeat' || last === 'sends') && node && typeof node === 'object' && Object.keys(node).length === 0) {
        setPath(d, parent, undefined);
      }
    }
  });
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) if (!used.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

// ---- Controls ---------------------------------------------------------------------------------

export function setControlValue(patch: Patch, id: string, value: number): Patch {
  return mutate(patch, (d) => {
    const c = d.controls?.find((x) => x.id === id);
    if (c) c.value = value;
  });
}

/** The value a control goes back to on a double-click. */
export function controlDefault(c: Control, saved?: Control): number {
  return c.default ?? saved?.value ?? c.value;
}

function niceLabel(path: string): string {
  const segs = splitPath(path).filter((s) => !['tracks', 'source', 'fx', 'master', 'buses'].includes(s));
  const last = segs[segs.length - 1] ?? path;
  const owner = segs.length > 1 ? segs[0] : '';
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return owner ? `${owner} ${label.toLowerCase()}`.replace(/^./, (c) => c.toUpperCase()) : label;
}

/** Can this parameter become a control, and as what? */
export function pinKind(meta: ParamMeta | undefined, value: unknown): 'range' | 'scale' | 'options' | 'toggle' | null {
  if (!meta) return null;
  if (meta.kind === 'enum' && meta.options?.length) return 'options';
  if (meta.kind === 'bool') return 'toggle';
  if (meta.kind === 'number' || meta.kind === 'signal') {
    if (value !== undefined && typeof value !== 'number') return 'scale';
    return meta.min !== undefined && meta.max !== undefined ? 'range' : null;
  }
  return null;
}

/**
 * Pins a parameter into the controls. A constant becomes a knob over the parameter's own range that sets it; a
 * moving parameter becomes a 0.5x to 2x knob that scales its whole curve; an enum becomes a selector.
 */
export function pinControl(patch: Patch, path: string): { patch: Patch; id: string } | null {
  const meta = metaAt(patch, path);
  const current = getPath(patch, path);
  const kind = pinKind(meta, current);
  if (!meta || !kind) return null;
  const id = uniqueId(splitPath(path).slice(-2).join('-'), (patch.controls ?? []).map((c) => c.id));
  const label = meta.label ?? niceLabel(path);
  let control: Control;
  if (kind === 'options') {
    const options = meta.options!.map((o) => ({ label: o, set: { [path]: o } }));
    const now = meta.options!.indexOf(String(current ?? meta.default));
    control = { id, label, hint: meta.doc, value: Math.max(0, now), widget: 'select', options };
  } else if (kind === 'toggle') {
    const on = Boolean(current ?? meta.default);
    control = {
      id,
      label,
      hint: meta.doc,
      value: on ? 1 : 0,
      widget: 'toggle',
      options: [
        { label: 'Off', set: { [path]: false } },
        { label: 'On', set: { [path]: true } },
      ],
    };
  } else if (kind === 'scale') {
    control = {
      id,
      label,
      hint: `Scales the whole curve. ${meta.doc}`,
      value: 1,
      min: 0.5,
      max: 2,
      default: 1,
      unit: 'x',
      scale: 'exp',
      targets: [{ path, mode: 'mul', from: 0.5, to: 2 }],
    };
  } else {
    const min = meta.min!;
    const max = meta.max!;
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const fallback = typeof meta.default === 'number' ? meta.default : positionToValue(0.5, { min, max, scale: meta.scale });
    const value = Math.min(hi, Math.max(lo, typeof current === 'number' ? current : fallback));
    const log = meta.scale === 'log' && min > 0 && max > 0;
    control = {
      id,
      label,
      hint: meta.doc,
      value,
      min,
      max,
      default: value,
      ...(meta.unit ? { unit: meta.unit } : {}),
      ...(meta.step ? { step: meta.step } : {}),
      ...(log ? { scale: 'exp' as const } : {}),
      targets: [{ path, mode: 'set', from: min, to: max }],
    };
  }
  return { patch: mutate(patch, (d) => void (d.controls = [...(d.controls ?? []), control])), id };
}

export function removeControl(patch: Patch, id: string): Patch {
  return mutate(patch, (d) => {
    d.controls = (d.controls ?? []).filter((c) => c.id !== id);
    if (d.controls.length === 0) delete d.controls;
  });
}

/** The control that was made by pinning exactly this parameter, if any. */
export function pinnedControlFor(patch: Patch, path: string): Control | undefined {
  const canon = canonPath(patch, path);
  return (patch.controls ?? []).find((c) => {
    const paths = [...(c.targets ?? []).map((t) => t.path), ...(c.options ?? []).flatMap((o) => Object.keys(o.set ?? {}))];
    return paths.length > 0 && paths.every((p) => canonPath(patch, p) === canon);
  });
}

/** The controls that set this parameter outright (a `set` target or an option), so its own value is not what renders. */
export function settersOf(patch: Patch, path: string): Control[] {
  const canon = canonPath(patch, path);
  return (patch.controls ?? []).filter(
    (c) =>
      (c.targets ?? []).some((t) => (t.mode ?? 'set') === 'set' && canonPath(patch, t.path) === canon) ||
      (c.options ?? []).some((o) => Object.keys(o.set ?? {}).some((p) => canonPath(patch, p) === canon)),
  );
}

/** A parameter's value as it renders: with every control applied. */
export function heardAt(patch: Patch, path: string): unknown {
  return getPath(patch.controls?.length ? applyControls(patch, metaAt).patch : patch, path);
}

/**
 * Moves a number parameter that a control sets, so that it renders at `value`. Writing the parameter itself would do
 * nothing (the control puts its own value back), so the control's range for it moves instead: shifted by the
 * difference (scaled by the ratio, on an exponential mapping) and every option's value with it. The knob keeps
 * working, around the new value. Null when no control sets the parameter: write it directly.
 */
export function moveSetValue(patch: Patch, path: string, value: number): Patch | null {
  if (settersOf(patch, path).length === 0) return null;
  const now = heardAt(patch, path);
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  const canon = canonPath(patch, path);
  const meta = metaAt(patch, path);
  const lo = meta?.hardMin ?? meta?.min ?? -Infinity;
  const hi = meta?.hardMax ?? Infinity;
  const tidy = (x: number) => Math.min(hi, Math.max(lo, Number(x.toPrecision(6))));
  // The patch with every setting of the parameter moved by `by`, and what is then heard.
  const shifted = (by: number): [Patch, number] => {
    const ratio = now > 0 && now + by > 0 ? (now + by) / now : null;
    const out = mutate(patch, (d) => {
      for (const c of d.controls ?? []) {
        for (const t of c.targets ?? []) {
          if ((t.mode ?? 'set') !== 'set' || canonPath(d, t.path) !== canon) continue;
          const from = t.from ?? meta?.min ?? 0;
          const to = t.to ?? meta?.max ?? 1;
          const exp = ratio !== null && (t.curve ?? (meta?.scale === 'log' && from > 0 && to > 0 ? 'exp' : 'linear')) === 'exp';
          const move = (x: number) => tidy(exp ? x * ratio! : x + by);
          t.from = move(from);
          t.to = move(to);
          if (typeof t.via === 'number') t.via = move(t.via);
        }
        for (const o of c.options ?? []) {
          for (const [p, v] of Object.entries(o.set ?? {})) {
            if (typeof v === 'number' && canonPath(d, p) === canon) o.set![p] = tidy(v + by);
          }
        }
      }
    });
    const heard = heardAt(out, path);
    return [out, typeof heard === 'number' ? heard : NaN];
  };
  // Usually exact at once; a relative control on top (`mul`, `add`) scales the move, and a secant step corrects it.
  let [prevBy, prevHeard] = [0, now];
  let by = value - now;
  let [out, heard] = shifted(by);
  for (let i = 0; i < 6 && Number.isFinite(heard) && Math.abs(heard - value) > 1e-9 && heard !== prevHeard; i++) {
    const next = by - ((heard - value) * (by - prevBy)) / (heard - prevHeard);
    [prevBy, prevHeard] = [by, heard];
    by = next;
    [out, heard] = shifted(by);
  }
  return out;
}

/**
 * Moves a number parameter that a relative control scales or offsets (`mul`, `add`, `stretch`), so that it renders at
 * `value`: the file's own value is the base the control works from, so writing the heard value there would apply the
 * control twice (a start a Height knob doubles would land at twice the time). Solves for the base instead. Null
 * when no relative control acts on the parameter.
 */
export function moveBaseValue(patch: Patch, path: string, value: number): Patch | null {
  const canon = canonPath(patch, path);
  const relative = (patch.controls ?? []).some((c) => (c.targets ?? []).some((t) => (t.mode ?? 'set') !== 'set' && canonPath(patch, t.path) === canon));
  if (!relative) return null;
  const meta = metaAt(patch, path);
  const lo = meta?.hardMin ?? meta?.min ?? -Infinity;
  const hi = meta?.hardMax ?? Infinity;
  const base = getPath(patch, path);
  const b0 = typeof base === 'number' ? base : typeof meta?.default === 'number' ? meta.default : 0;
  const at = (b: number): [Patch, number] => {
    const p = setAt(patch, path, Number(Math.min(hi, Math.max(lo, b)).toPrecision(6)));
    const h = heardAt(p, path);
    return [p, typeof h === 'number' ? h : NaN];
  };
  const h0 = heardAt(patch, path);
  if (typeof h0 !== 'number' || !Number.isFinite(h0)) return null;
  // A scaling control is undone by the ratio, an offset by the difference; a secant step tidies up the rest.
  let [prevB, prevH] = [b0, h0];
  let b = h0 !== 0 && b0 !== 0 && value / h0 > 0 ? b0 * (value / h0) : b0 + (value - h0);
  let [out, heard] = at(b);
  for (let i = 0; i < 6 && Number.isFinite(heard) && Math.abs(heard - value) > 1e-9 && heard !== prevH; i++) {
    const next = b - ((heard - value) * (b - prevB)) / (heard - prevH);
    [prevB, prevH] = [b, heard];
    b = next;
    [out, heard] = at(b);
  }
  return out;
}

// ---- Takes -------------------------------------------------------------------------------------

export function anotherTake(patch: Patch, random: () => number = Math.random): Patch {
  return mutate(patch, (d) => {
    let seed = d.seed ?? 1;
    while (seed === (d.seed ?? 1)) seed = 1 + Math.floor(random() * 99998);
    d.seed = seed;
  });
}

/** Every control to a random place in its range (selectors to a random option), and a new seed. */
export function surprise(patch: Patch, random: () => number = Math.random): Patch {
  const next = anotherTake(patch, random);
  for (const c of next.controls ?? []) {
    if (c.options?.length) c.value = Math.min(c.options.length - 1, Math.floor(random() * c.options.length));
    else c.value = positionToValue(random(), { min: c.min ?? 0, max: c.max ?? 1, scale: c.scale === 'exp' ? 'log' : 'linear', step: c.step });
  }
  return next;
}

// ---- Signals -----------------------------------------------------------------------------------

export interface SignalParts {
  /** Set when the value is one number. */
  constant?: number;
  /** Set when the value moves along breakpoints. */
  points?: Breakpoint[];
  /** Number of modulators riding on it. */
  mods: number;
  curve?: SignalObject['curve'];
}

function isPoints(v: unknown): v is Breakpoint[] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

export function readSignal(v: unknown): SignalParts {
  if (typeof v === 'number') return { constant: v, mods: 0 };
  if (isPoints(v)) return { points: v, mods: 0 };
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const s = v as SignalObject;
    const mods = s.mod?.length ?? 0;
    if (s.env && s.env.length > 0) return { points: s.env, mods, curve: s.curve };
    return { constant: s.value, mods, curve: s.curve };
  }
  return { mods: 0 };
}

/** Writes a constant or breakpoints back, keeping the modulators and curve of a signal object. */
export function writeSignal(original: unknown, next: { constant: number } | { points: Breakpoint[] }): ParamValue {
  const isObject = typeof original === 'object' && original !== null && !Array.isArray(original);
  if (!isObject) return 'constant' in next ? next.constant : next.points;
  const s = { ...(original as SignalObject) };
  if ('constant' in next) {
    delete s.env;
    s.value = next.constant;
  } else {
    delete s.value;
    s.env = next.points;
  }
  return s;
}

export function sortPoints(points: Breakpoint[]): Breakpoint[] {
  return [...points].sort((a, b) => a[0] - b[0]);
}

// ---- Tracks and effects -----------------------------------------------------------------------

export function defaultEffect(type: string): EffectSpec {
  const def = getEffect(type);
  const example = def?.example as EffectSpec | undefined;
  return example ? { ...deepClone(example), type } : { type };
}

export function getChain(patch: unknown, chainPath: string): EffectSpec[] {
  const v = getPath(patch, chainPath);
  return Array.isArray(v) ? (v as EffectSpec[]) : [];
}

export function setChain<T>(patch: T, chainPath: string, chain: EffectSpec[]): T {
  return setAt(patch, chainPath, chain.length > 0 ? chain : undefined);
}

export function addEffect<T>(patch: T, chainPath: string, type: string): T {
  return setChain(patch, chainPath, [...getChain(patch, chainPath), defaultEffect(type)]);
}

export function removeEffect<T>(patch: T, chainPath: string, index: number): T {
  return setChain(patch, chainPath, getChain(patch, chainPath).filter((_, i) => i !== index));
}

export function moveEffect<T>(patch: T, chainPath: string, index: number, by: number): T {
  const chain = [...getChain(patch, chainPath)];
  const to = index + by;
  if (to < 0 || to >= chain.length) return patch;
  [chain[index], chain[to]] = [chain[to], chain[index]];
  return setChain(patch, chainPath, chain);
}

/** A segment that addresses an effect: its id when it has one, else its position. */
export function effectSegment(fx: EffectSpec, index: number): string {
  return typeof fx.id === 'string' && fx.id && !/^\d+$/.test(fx.id) ? fx.id : String(index);
}

export function defaultSource(type: string): Track['source'] {
  const def = getSource(type);
  const example = def?.example as Track['source'] | undefined;
  return example ? { ...deepClone(example), type } : { type };
}

/** Swaps a track's source type, keeping what every source shares (level, envelope, pitch, voice filter). */
export function changeSourceType(patch: Patch, trackId: string, type: string): Patch {
  return mutate(patch, (d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const next: Track['source'] = { type };
    for (const k of Object.keys(COMMON_SOURCE_PARAMS)) if (t.source[k] !== undefined && k !== 'env') next[k] = t.source[k];
    const fresh = defaultSource(type);
    t.source = { ...fresh, ...next };
  });
}

export function addTrack(patch: Patch, type = 'osc'): { patch: Patch; id: string } {
  const id = uniqueId(type, patch.tracks.map((t) => t.id));
  return { patch: mutate(patch, (d) => void d.tracks.push({ id, source: defaultSource(type) })), id };
}

export function duplicateTrack(patch: Patch, trackId: string): { patch: Patch; id: string } | null {
  const i = patch.tracks.findIndex((t) => t.id === trackId);
  if (i < 0) return null;
  const id = uniqueId(trackId, patch.tracks.map((t) => t.id));
  return {
    patch: mutate(patch, (d) => {
      const copy = deepClone(d.tracks[i]);
      copy.id = id;
      delete copy.color;
      d.tracks.splice(i + 1, 0, copy);
    }),
    id,
  };
}

export function removeTrack(patch: Patch, trackId: string): Patch {
  if (patch.tracks.length <= 1) return patch;
  return mutate(patch, (d) => {
    d.tracks = d.tracks.filter((t) => t.id !== trackId);
    // Controls that only drove the removed track would warn on every render.
    const prefix = `tracks.${trackId}.`;
    if (d.controls) {
      d.controls = d.controls
        .map((c) => ({ ...c, targets: c.targets?.filter((t) => !t.path.startsWith(prefix)) }))
        .filter((c) => (c.targets?.length ?? 0) > 0 || (c.options?.length ?? 0) > 0);
      if (d.controls.length === 0) delete d.controls;
    }
  });
}

export function fileNameFor(patch: Patch): string {
  return (patch.name || 'sound').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sound';
}
