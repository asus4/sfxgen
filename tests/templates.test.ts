/**
 * The template library as a whole. Each template's own tests (validates, renders, every control at both ends) are in
 * tests/templates/, dealt across shard files so they run in parallel.
 * Run after adding templates: `npm run templates && npx vitest run tests/templates`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allTemplates } from '../src/core/templates';
import { SHARDS } from './templates/suite';

const templates = allTemplates();

describe('template library', () => {
  it('has templates with unique ids', () => {
    expect(templates.length).toBeGreaterThan(0);
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length);
  });

  // Serving templates/ opens the whole library as one project, and a project's sounds are named by file name.
  it('has unique file names, so the whole library opens as one project', () => {
    const byName = new Map<string, string[]>();
    for (const t of templates) {
      const name = t.id.replace(/^.*\//, '');
      byName.set(name, [...(byName.get(name) ?? []), t.id]);
    }
    expect([...byName.values()].filter((ids) => ids.length > 1)).toEqual([]);
  });

  // A missing shard file would leave every SHARDS-th template untested without anything failing.
  it('has a test file for every shard', () => {
    const dir = fileURLToPath(new URL('./templates/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
    const want = Array.from({ length: SHARDS }, (_, i) => `shard-${i + 1}.test.ts`).sort();
    expect(files).toEqual(want);
  });
});
