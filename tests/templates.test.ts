/**
 * Every template must validate, render cleanly, and have controls that change the sound at both ends of their range.
 * Run after adding templates: `npm run templates && npx vitest run tests/templates.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { allTemplates } from '../src/core/templates';
import { render, validatePatch, formatIssues, deepClone, type Patch } from '../src/core';

const SR = 24000;

function stats(x: Float32Array) {
  let peak = 0;
  let sum = 0;
  let finite = true;
  for (const v of x) {
    if (!Number.isFinite(v)) finite = false;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(x.length, 1)), finite };
}

/** 0 when identical, around 1 or more when clearly different. */
function difference(a: Float32Array, b: Float32Array): number {
  const n = Math.max(a.length, b.length);
  let d = 0;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : 0;
    const y = i < b.length ? b[i] : 0;
    d += (x - y) * (x - y);
    e += x * x + y * y;
  }
  return e > 0 ? (2 * d) / e : 0;
}

function withControl(p: Patch, id: string, value: number): Patch {
  const q = deepClone(p);
  const c = q.controls!.find((k) => k.id === id)!;
  c.value = value;
  return q;
}

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
});

describe.each(templates.map((t) => [t.id, t] as const))('%s', (_id, entry) => {
  const patch = entry.patch;

  it('validates, with a story and controls', () => {
    const v = validatePatch(patch);
    expect(v.errors, formatIssues(v)).toEqual([]);
    expect(v.warnings, formatIssues(v)).toEqual([]);
    expect(patch.description && patch.description.length > 20, 'needs a description that tells the story').toBe(true);
    const n = patch.controls?.length ?? 0;
    expect(n >= 2 && n <= 8, 'needs 2 to 8 controls').toBe(true);
    for (const c of patch.controls ?? []) expect(c.hint, `control ${c.id} needs a hint`).toBeTruthy();
  });

  it('renders cleanly', () => {
    const r = render(patch, { sampleRate: SR });
    expect(r.warnings).toEqual([]);
    const s = stats(r.channels[0]);
    expect(s.finite).toBe(true);
    expect(s.rms).toBeGreaterThan(1e-4);
    expect(r.duration).toBeGreaterThan(0.02);
    expect(r.duration).toBeLessThan(12.5);
  });

  for (const c of patch.controls ?? []) {
    it(`control "${c.id}" changes the sound and never breaks it`, () => {
      const lo = c.options ? 0 : (c.min ?? 0);
      const hi = c.options ? c.options.length - 1 : (c.max ?? 1);
      const a = render(withControl(patch, c.id, lo), { sampleRate: SR });
      const b = render(withControl(patch, c.id, hi), { sampleRate: SR });
      for (const r of [a, b]) {
        expect(r.warnings).toEqual([]);
        const s = stats(r.channels[0]);
        expect(s.finite).toBe(true);
        expect(s.rms).toBeGreaterThan(1e-4);
      }
      expect(difference(a.channels[0], b.channels[0])).toBeGreaterThan(0.02);
    });
  }
});
