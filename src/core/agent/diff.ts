/**
 * A small recursive diff between two JSON values, reported path by path in the patch's dot-path style (array items
 * with an `id` are addressed by it, others by position).
 */
import type { ChangeRecord } from './workspace';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function itemKey(item: unknown, index: number): string {
  return isObj(item) && typeof item.id === 'string' ? item.id : String(index);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What changed from `before` to `after`: one record per leaf (or per added or removed subtree). */
export function diffValues(before: unknown, after: unknown, path = '', out: ChangeRecord[] = []): ChangeRecord[] {
  if (same(before, after)) return out;
  if (isObj(before) && isObj(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffValues(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after) && keyed(before) && keyed(after)) {
    // Arrays of objects with ids (tracks, effects, controls) are compared item by item, by id.
    const b = new Map(before.map((item, i) => [itemKey(item, i), item]));
    const a = new Map(after.map((item, i) => [itemKey(item, i), item]));
    for (const key of new Set([...b.keys(), ...a.keys()])) {
      diffValues(b.get(key), a.get(key), path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  out.push({ path, before, after });
  return out;
}

function keyed(arr: unknown[]): boolean {
  return arr.length > 0 && arr.every((x) => isObj(x) && typeof x.id === 'string');
}
