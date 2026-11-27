/**
 * Every template must validate, render cleanly, and have controls that change the sound at both ends of their range.
 *
 * That is about a thousand renders, too many for one test file: vitest runs a file's tests one after another in one
 * worker. So the tests are dealt round-robin to the shard files next to this one (`shard-<n>.test.ts`), which run in
 * parallel. The tests are dealt rather than the templates because a few templates cost ten times the others; dealt
 * one test at a time, their controls land in different shards. `tests/templates.test.ts` checks every shard has its
 * file.
 */
import { describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTemplates } from '../../src/core/templates';
import { render, validatePatch, formatIssues, deepClone, type Patch } from '../../src/core';

/** How many shard files there are. Changing it means adding or removing `shard-<n>.test.ts` files to match. */
export const SHARDS = 12;

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

interface Case {
  template: string;
  name: string;
  run: () => void;
}

/** Every template's tests, in library order. */
function cases(): Case[] {
  const out: Case[] = [];
  for (const { id: template, patch } of allTemplates()) {
    out.push({
      template,
      name: 'validates, with a story and controls',
      run: () => {
        const v = validatePatch(patch);
        expect(v.errors, formatIssues(v)).toEqual([]);
        expect(v.warnings, formatIssues(v)).toEqual([]);
        expect(patch.description && patch.description.length > 20, 'needs a description that tells the story').toBe(true);
        const n = patch.controls?.length ?? 0;
        expect(n >= 2 && n <= 8, 'needs 2 to 8 controls').toBe(true);
        for (const c of patch.controls ?? []) expect(c.hint, `control ${c.id} needs a hint`).toBeTruthy();
      },
    });

    out.push({
      template,
      name: 'renders cleanly',
      run: () => {
        const r = render(patch, { sampleRate: SR });
        expect(r.warnings).toEqual([]);
        const s = stats(r.channels[0]);
        expect(s.finite).toBe(true);
        expect(s.rms).toBeGreaterThan(1e-4);
        expect(r.duration).toBeGreaterThan(0.02);
        expect(r.duration).toBeLessThan(12.5);
      },
    });

    for (const c of patch.controls ?? []) {
      out.push({
        template,
        name: `control "${c.id}" changes the sound and never breaks it`,
        run: () => {
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
        },
      });
    }
  }
  return out;
}

/** Defines this shard's share of the tests; the shard number comes from the calling file's name. */
export function testTemplateShard(fileUrl: string): void {
  const file = basename(fileURLToPath(fileUrl));
  const shard = Number(/^shard-(\d+)\.test\.ts$/.exec(file)?.[1]);
  if (!(shard >= 1 && shard <= SHARDS)) throw new Error(`${file}: expected shard-<1..${SHARDS}>.test.ts`);

  // Grouped under each template's id, as `-t "<category>/"` expects.
  const byTemplate = new Map<string, Case[]>();
  cases().forEach((c, i) => {
    if (i % SHARDS !== shard - 1) return;
    byTemplate.set(c.template, [...(byTemplate.get(c.template) ?? []), c]);
  });
  for (const [template, list] of byTemplate) {
    describe(template, () => {
      for (const c of list) it(c.name, c.run);
    });
  }
}
