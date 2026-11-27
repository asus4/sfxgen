/**
 * The catalog is what agents learn from: every node's example must be valid as written and render cleanly, and the
 * checked-in JSON Schema must match the registry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUS_FIELDS,
  COMMON_EFFECT_PARAMS,
  COMMON_SOURCE_PARAMS,
  ENVELOPE_FIELDS,
  MASTER_FIELDS,
  PATCH_FIELDS,
  REPEAT_FIELDS,
  TRACK_FIELDS,
  formatIssues,
  listEffects,
  listSources,
  render,
  syncControlBases,
  validatePatch,
  type ParamMap,
  type ParamMeta,
  type Patch,
} from '../src/core';
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

/** Every parameter in a map, nested fields and array items included, by path. */
function* allParams(params: ParamMap, at: string): Generator<[string, ParamMeta]> {
  for (const [name, meta] of Object.entries(params)) {
    yield [`${at}.${name}`, meta];
    if (meta.fields) yield* allParams(meta.fields, `${at}.${name}`);
    if (meta.item) yield* allParams({ item: meta.item }, `${at}.${name}`);
  }
}

describe('hints for people', () => {
  // The editor shows `hint` as the tooltip; `doc` is the agents'. A hint is a few plain words, not a second doc.
  const maps: [string, ParamMap][] = [
    ['source', COMMON_SOURCE_PARAMS],
    ['effect', COMMON_EFFECT_PARAMS],
    ['env', ENVELOPE_FIELDS],
    ['track', TRACK_FIELDS],
    ['repeat', REPEAT_FIELDS],
    ['master', MASTER_FIELDS],
    ['bus', BUS_FIELDS],
    ['patch', PATCH_FIELDS],
    ...[...listSources(), ...listEffects()].map((def) => [def.type, def.params] as [string, ParamMap]),
  ];
  const short = (hint: string | undefined) => !!hint && hint.length <= 80 && !/[`.]$/.test(hint) && !hint.includes('`');

  it('every source and effect has one', () => {
    const missing = [...listSources(), ...listEffects()].filter((def) => !short(def.hint)).map((def) => def.type);
    expect(missing).toEqual([]);
  });

  it('every parameter has one', () => {
    const missing = maps.flatMap(([at, params]) => [...allParams(params, at)].filter(([, meta]) => !short(meta.hint)).map(([path]) => path));
    expect(missing).toEqual([]);
  });
});

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
