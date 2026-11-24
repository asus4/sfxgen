/**
 * Dot paths into a patch: `tracks.body.source.freq`, `tracks.body.fx.space.mix`, `master.fx.0.ceiling`.
 * In an array, a segment picks the item whose `id` matches, else the item at that position.
 */

export function splitPath(path: string): string[] {
  return path.split('.').filter((s) => s.length > 0);
}

function pickInArray(arr: unknown[], seg: string): number {
  const byId = arr.findIndex((item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === seg);
  if (byId >= 0) return byId;
  if (/^\d+$/.test(seg)) {
    const i = Number(seg);
    return i < arr.length ? i : -1;
  }
  return -1;
}

/** Reads the value at a path, or undefined. */
export function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const seg of splitPath(path)) {
    if (Array.isArray(node)) {
      const i = pickInArray(node, seg);
      if (i < 0) return undefined;
      node = node[i];
    } else if (typeof node === 'object' && node !== null) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Writes a value at a path, creating plain objects for missing keys (never array items). Returns false when the
 * path runs through something that isn't there.
 */
export function setPath(root: unknown, path: string, value: unknown): boolean {
  const segs = splitPath(path);
  if (segs.length === 0) return false;
  let node: unknown = root;
  for (let k = 0; k < segs.length - 1; k++) {
    const seg = segs[k];
    if (Array.isArray(node)) {
      const i = pickInArray(node, seg);
      if (i < 0) return false;
      node = node[i];
    } else if (typeof node === 'object' && node !== null) {
      const obj = node as Record<string, unknown>;
      if (obj[seg] === undefined || obj[seg] === null) obj[seg] = {};
      node = obj[seg];
    } else {
      return false;
    }
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(node)) {
    const i = pickInArray(node, last);
    if (i < 0) return false;
    node[i] = value;
    return true;
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    if (value === undefined) delete obj[last];
    else obj[last] = value;
    return true;
  }
  return false;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
