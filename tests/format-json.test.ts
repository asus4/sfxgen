import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatJson } from '../src/core';

describe('formatJson', () => {
  it('keeps short lists of plain values on one line and objects one key per line', () => {
    const text = formatJson({ name: 'x', tags: ['a', 'b'], freq: [[0, 150], [0.09, 96]], source: { type: 'modal', exciter: { kind: 'mallet' } }, empty: [], none: {} });
    expect(text).toBe(
      [
        '{',
        '  "name": "x",',
        '  "tags": ["a", "b"],',
        '  "freq": [[0, 150], [0.09, 96]],',
        '  "source": {',
        '    "type": "modal",',
        '    "exciter": {',
        '      "kind": "mallet"',
        '    }',
        '  },',
        '  "empty": [],',
        '  "none": {}',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('breaks a list that would run past 100 columns, and lists of objects, one item per line', () => {
    const long = Array.from({ length: 30 }, (_, i) => [i / 10, 100 + i]);
    const lines = formatJson({ points: long, events: [{ t: 0 }, { t: 1 }] }).split('\n');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    expect(lines).toContain('    [0.1, 101],');
    expect(lines).toContain('    {');
  });

  it('writes every template so it parses back to the same patch', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : n.endsWith('.sfx.json') ? [p] : [];
      });
    for (const file of walk('templates')) {
      const text = readFileSync(file, 'utf8');
      const patch = JSON.parse(text);
      expect(JSON.parse(formatJson(patch))).toEqual(patch);
      // Every template is already written this way, so saving one changes only what changed.
      expect(formatJson(patch), file).toBe(text);
    }
  });
});
