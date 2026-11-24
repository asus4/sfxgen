/** Patch paths for the editor: canonical forms, diffs between two patches, and what a control drives. */
import type { Control, Patch } from '../../core';
import { splitPath } from '../../core';

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasIds(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const ids = arr.map((x) => (isObj(x) && typeof x.id === 'string' ? x.id : null));
  return ids.every((id) => id !== null) && new Set(ids).size === ids.length;
}

function equal(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Leaf-level differences between two JSON values, as dot paths. Arrays whose items all carry an `id` (tracks,
 * controls, named effects) are matched by id, so reordering is not reported as a rewrite; other arrays
 * (breakpoints, events) are reported whole.
 */
export function diffValues(before: unknown, after: unknown, base = ''): Change[] {
  if (equal(before, after)) return [];
  const at = (k: string) => (base ? `${base}.${k}` : k);
  if (isObj(before) && isObj(after)) {
    const out: Change[] = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) out.push(...diffValues(before[k], after[k], at(k)));
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after) && hasIds(before) && hasIds(after)) {
    const out: Change[] = [];
    const a = new Map(before.map((x) => [(x as { id: string }).id, x]));
    const b = new Map(after.map((x) => [(x as { id: string }).id, x]));
    for (const id of new Set([...a.keys(), ...b.keys()])) out.push(...diffValues(a.get(id), b.get(id), at(id)));
    return out;
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.every(isObj) &&
    after.every(isObj)
  ) {
    return before.flatMap((x, i) => diffValues(x, after[i], at(String(i))));
  }
  return [{ path: base, before, after }];
}

export function diffPatches(before: Patch, after: Patch): Change[] {
  return diffValues(before, after);
}

/** The same path with every array segment as a position, so two spellings of one parameter compare equal. */
export function canonPath(patch: Patch, path: string): string {
  const out: string[] = [];
  let node: unknown = patch;
  for (const seg of splitPath(path)) {
    if (Array.isArray(node)) {
      const byId = node.findIndex((x) => isObj(x) && x.id === seg);
      const i = byId >= 0 ? byId : /^\d+$/.test(seg) ? Number(seg) : -1;
      out.push(i >= 0 ? String(i) : seg);
      node = i >= 0 ? node[i] : undefined;
    } else {
      out.push(seg);
      node = isObj(node) ? node[seg] : undefined;
    }
  }
  return out.join('.');
}

export interface Driver {
  control: Control;
  mode: 'set' | 'mul' | 'add' | 'stretch' | 'option';
}

/** Every parameter the controls drive, keyed by canonical path. Several controls may share one parameter. */
export function drivenPaths(patch: Patch): Map<string, Driver[]> {
  const out = new Map<string, Driver[]>();
  const add = (path: string, d: Driver) => {
    const key = canonPath(patch, path);
    const list = out.get(key) ?? [];
    if (!list.some((x) => x.control.id === d.control.id && x.mode === d.mode)) list.push(d);
    out.set(key, list);
  };
  for (const control of patch.controls ?? []) {
    for (const t of control.targets ?? []) add(t.path, { control, mode: t.mode ?? 'set' });
    for (const o of control.options ?? []) for (const p of Object.keys(o.set ?? {})) add(p, { control, mode: 'option' });
  }
  return out;
}

/**
 * What to flash after a change from outside: the controls whose value changed or whose targets were touched, and
 * the canonical paths of the parameters that changed.
 */
export function touched(before: Patch, after: Patch): { controls: string[]; paths: string[]; changes: Change[] } {
  const changes = diffPatches(before, after);
  const controls = new Set<string>();
  const paths = new Set<string>();
  const drivers = drivenPaths(after);
  for (const c of changes) {
    const segs = splitPath(c.path);
    if (segs[0] === 'controls') {
      if (segs[1]) controls.add(segs[1]);
      continue;
    }
    const canon = canonPath(after, c.path);
    paths.add(canon);
    for (const [target, list] of drivers) {
      if (canon === target || canon.startsWith(target + '.')) list.forEach((d) => controls.add(d.control.id));
    }
  }
  const existing = new Set((after.controls ?? []).map((c) => c.id));
  return { controls: [...controls].filter((id) => existing.has(id)), paths: [...paths], changes };
}

/** A short sentence for the activity feed. */
export function summarize(changes: Change[], limit = 3): string {
  if (changes.length === 0) return 'no changes';
  const short = (v: unknown): string => {
    if (v === undefined) return '∅';
    if (typeof v === 'number') return String(Number(v.toPrecision(4)));
    if (typeof v === 'string') return v.length > 18 ? `${v.slice(0, 17)}…` : v;
    if (Array.isArray(v)) return `[${v.length}]`;
    return typeof v === 'object' && v !== null ? '{…}' : String(v);
  };
  const parts = changes.slice(0, limit).map((c) => {
    const p = c.path.replace(/^tracks\./, '').replace(/^controls\.([^.]+)\.value$/, '$1');
    return `${p} ${short(c.before)} → ${short(c.after)}`;
  });
  if (changes.length > limit) parts.push(`+${changes.length - limit} more`);
  return parts.join(' · ');
}

/** The tracks a control acts on: their ids, or `all` when it reaches the master, a bus or the patch itself. */
export function controlTracks(patch: Patch, control: Control): Set<string> | 'all' {
  const ids = new Set<string>();
  const paths = [...(control.targets ?? []).map((t) => t.path), ...(control.options ?? []).flatMap((o) => Object.keys(o.set ?? {}))];
  for (const path of paths) {
    const segs = splitPath(path);
    if (segs[0] !== 'tracks' || !segs[1]) return 'all';
    const byId = patch.tracks.find((t) => t.id === segs[1]);
    const track = byId ?? (/^\d+$/.test(segs[1]) ? patch.tracks[Number(segs[1])] : undefined);
    if (track) ids.add(track.id);
  }
  return ids;
}

/** What a control does, in a few words for the display: "zap · freq ×, env ↔". */
export function describeControl(patch: Patch, control: Control): string {
  const sign = { set: '', mul: ' ×', add: ' +', stretch: ' ↔' } as const;
  const parts = (control.targets ?? []).map((t) => {
    const segs = splitPath(t.path).filter((x) => !['tracks', 'source', 'fx'].includes(x));
    return `${segs.join('.')}${sign[t.mode ?? 'set']}`;
  });
  if (control.options?.length) parts.push(`${control.options.length} choices`);
  void patch;
  return parts.join('  ') || 'no targets';
}
