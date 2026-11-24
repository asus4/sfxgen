/**
 * Sync: make the patch file say what renders. A control's `set` targets and options override the base value at their
 * path every time the patch renders, so the file's own value there is dead text. `syncControlBases` writes the value
 * the controls currently apply into the base, leaving the controls as they are. Relative targets (`mul`, `add`,
 * `stretch`) are left alone: baking them in would apply them twice.
 */
import type { Patch } from './types';
import { applyControl } from './controls';
import { deepClone, getPath, setPath } from './paths';
import { metaAt } from '../registry';

export interface SyncChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Equal, allowing the last digits of a float to differ (so syncing twice changes nothing). */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 2e-5 * Math.max(Math.abs(a), Math.abs(b)) + 1e-12;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Six significant digits: enough to render the same, short enough to read in a file. */
function tidy(v: unknown): unknown {
  return typeof v === 'number' ? Number(v.toPrecision(6)) : v;
}

/** Path -> id of the control that sets it (its last one, as the renderer does), for `set` targets and the chosen option. */
export function controlsSetting(patch: Patch): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of patch.controls ?? []) {
    const idx = c.options && c.options.length > 0 ? Math.max(0, Math.min(c.options.length - 1, Math.round(c.value))) : -1;
    if (idx >= 0) for (const path of Object.keys(c.options?.[idx].set ?? {})) map.set(path, c.id);
    for (const t of c.targets ?? []) if ((t.mode ?? 'set') === 'set') map.set(t.path, c.id);
  }
  return map;
}

export function setPaths(patch: Patch): string[] {
  return [...controlsSetting(patch).keys()];
}

/** A copy of the patch with every `set` target and chosen option written into the base value at its path. */
export function syncControlBases(patch: Patch): { patch: Patch; changes: SyncChange[] } {
  const applied = deepClone(patch);
  const warnings: string[] = [];
  for (const c of patch.controls ?? []) applyControl(applied, c, metaAt, warnings, 'absolute');
  const out = deepClone(patch);
  const changes: SyncChange[] = [];
  for (const path of setPaths(patch)) {
    const after = getPath(applied, path);
    if (after === undefined) continue;
    const before = getPath(patch, path);
    if (same(before, after)) continue;
    const value = tidy(deepClone(after));
    if (!setPath(out, path, value)) continue;
    changes.push({ path, before, after: value });
  }
  return { patch: out, changes };
}
