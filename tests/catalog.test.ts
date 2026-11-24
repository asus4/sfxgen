/**
 * The catalog is what agents learn from: every node's example must be valid as written and render cleanly, and the
 * checked-in JSON Schema must match the registry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listEffects, listSources, render, validatePatch, formatIssues, type Patch } from '../src/core';
import { buildSchema } from '../src/core/agent/schema';

function patchWithSource(source: Record<string, unknown>): Patch {
  return { format: 'sfxgen/1', name: 'example', duration: 'auto', maxDuration: 4, tracks: [{ id: 'a', source: source as never }] };
}

function patchWithEffect(effect: Record<string, unknown>): Patch {
  return {
    format: 'sfxgen/1',
    name: 'example',
    duration: 1.5,
    tracks: [{ id: 'a', source: { type: 'noise', color: 'pink', env: { attack: 0.002, decay: 0.6 } }, fx: [effect as never] }],
  };
}

describe('node examples', () => {
  for (const def of listSources()) {
    it(`source ${def.type}`, () => {
      expect(def.example, `${def.type} needs an example`).toBeTruthy();
      const p = patchWithSource(def.example!);
      const v = validatePatch(p);
      expect([...v.errors, ...v.warnings], formatIssues(v)).toEqual([]);
      const r = render(p, { sampleRate: 24000 });
      expect(r.warnings).toEqual([]);
    });
  }
  for (const def of listEffects()) {
    it(`effect ${def.type}`, () => {
      expect(def.example, `${def.type} needs an example`).toBeTruthy();
      const p = patchWithEffect(def.example!);
      const v = validatePatch(p);
      expect([...v.errors, ...v.warnings], formatIssues(v)).toEqual([]);
      const r = render(p, { sampleRate: 24000 });
      expect(r.warnings).toEqual([]);
    });
  }
});

describe('schema', () => {
  it('schema/sfxgen.schema.json is up to date (run `npm run sfxgen -- schema --write`)', () => {
    const onDisk = JSON.parse(readFileSync(new URL('../schema/sfxgen.schema.json', import.meta.url), 'utf8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildSchema())));
  });
});
