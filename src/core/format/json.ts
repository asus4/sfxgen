/**
 * How sfxgen writes patches and projects: two-space JSON, one key per line, and short arrays of plain values on one
 * line, so a breakpoint list like `[[0, 150], [0.09, 96]]` stays readable and a one-value change is a one-line diff.
 * Every writer uses this, so a file keeps its shape whoever touched it last.
 */

/** Columns an inline array may reach, indentation and key included. */
const WIDTH = 100;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isPlain = (v: unknown): boolean => v === null || v === undefined || typeof v !== 'object';

/** A plain value, or a list of plain values (one breakpoint): what may sit inside an inline array. */
const isFlat = (v: unknown): boolean => isPlain(v) || (Array.isArray(v) && v.every(isPlain));

function plain(v: unknown): string {
  // As JSON.stringify writes them inside an array: undefined and non-finite numbers become null.
  return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? 'null' : JSON.stringify(v);
}

function inline(items: unknown[]): string {
  return `[${items.map((x) => (Array.isArray(x) ? `[${x.map(plain).join(', ')}]` : plain(x))).join(', ')}]`;
}

function write(v: unknown, indent: number, lead: number): string {
  if (isPlain(v)) return plain(v);
  if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return write((v as { toJSON: () => unknown }).toJSON(), indent, lead);
  const pad = ' '.repeat(indent + 2);
  const end = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every(isFlat)) {
      const one = inline(v);
      if (indent + lead + one.length <= WIDTH) return one;
    }
    return `[\n${v.map((x) => pad + write(x, indent + 2, 0)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && typeof x !== 'function');
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return pad + key + write(x, indent + 2, key.length);
    })
    .join(',\n')}\n${end}}`;
}

/** The text of a patch or project file, ending in a newline. Parses back to the same value as JSON.stringify's. */
export function formatJson(value: unknown): string {
  return `${write(value as Json, 0, 0)}\n`;
}
