/**
 * The catalog is what agents learn from: every node's example must be valid as written and render cleanly, and the
 * checked-in JSON Schema must match the registry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listEffects, listSources, render, syncControlBases, validatePatch, formatIssues, type Patch } from '../src/core';
import { buildGuide } from '../src/core/agent/guide';
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

// The guide's "Levels and balance" tells agents how loud each source comes out, so they can balance layers unheard.
describe('levels the guide promises', () => {
  const peakDb = (source: Record<string, unknown>) => {
    const p: Patch = { ...patchWithSource(source), master: { normalize: { mode: 'none' } } };
    const r = render(p, { sampleRate: 24000 });
    let peak = 0;
    for (const ch of r.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
    return 20 * Math.log10(peak);
  };
  for (const def of listSources().filter((d) => d.type !== 'noise')) {
    it(`${def.type} at its defaults peaks within a few dB of full scale`, () => {
      expect(Math.abs(peakDb({ type: def.type }))).toBeLessThan(4);
    });
  }
  it('unfiltered noise peaks over full scale', () => {
    for (const color of ['white', 'pink', 'velvet', 'crackle']) expect(peakDb({ type: 'noise', color })).toBeGreaterThan(3);
  });
});

describe("the guide's example patch", () => {
  const overview = buildGuide({ section: 'overview' });
  const example = JSON.parse(/## A patch\n\n```json\n([\s\S]*?)\n```/.exec(overview)![1]) as Patch;
  it('is valid, renders cleanly and says what it plays', () => {
    const v = validatePatch(example);
    expect([...v.errors, ...v.warnings], formatIssues(v)).toEqual([]);
    expect(render(example, { sampleRate: 24000 }).warnings).toEqual([]);
    expect(syncControlBases(example).changes).toEqual([]);
  });
  it('is the same patch as docs/FORMAT.md shows', () => {
    const format = readFileSync(new URL('../docs/FORMAT.md', import.meta.url), 'utf8');
    const shown = JSON.parse(/## A whole patch\n\n```json\n([\s\S]*?)\n```/.exec(format)![1]) as Patch & { output?: unknown };
    const { output: _output, ...rest } = shown;
    expect(rest).toEqual(example);
  });
});

describe('schema', () => {
  it('schema/sfxgen.schema.json is up to date (run `npm run sfxgen -- schema --write`)', () => {
    const onDisk = JSON.parse(readFileSync(new URL('../schema/sfxgen.schema.json', import.meta.url), 'utf8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildSchema())));
  });
});
