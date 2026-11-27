/**
 * A JSON Schema (2020-12) for `*.sfx.json`, generated from the registry so editors autocomplete every source and
 * effect parameter, show its doc on hover and flag values outside its hard limits. Sources and effects are each an
 * `anyOf` of per-type schemas told apart by a `type` constant. Written to schema/sfxgen.schema.json by
 * `sfxgen schema --write`; a patch points at it with `"$schema"`.
 *
 * The validator (format/validate.ts) remains the authority: it also checks paths, ids and cross-references, and
 * reports unknown parameters as warnings where the schema, for the editor's sake, flags them.
 */
import type { NodeDef, ParamMap, ParamMeta } from '../nodes';
import { COMMON_EFFECT_PARAMS, COMMON_SOURCE_PARAMS } from '../nodes';
import { ENVELOPE_FIELDS, MASTER_FIELDS, REPEAT_FIELDS, TRACK_FIELDS, listEffects, listSources } from '../registry';
import { FORMAT_ID } from '../format/types';

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });

function describeMeta(m: ParamMeta): string {
  const bits: string[] = [];
  if (m.min !== undefined || m.max !== undefined) bits.push(`${m.min ?? ''} to ${m.max ?? ''}${m.unit && m.unit !== 'x' ? ' ' + m.unit : m.unit === 'x' ? 'x' : ''}`);
  else if (m.unit) bits.push(m.unit);
  if (m.scale === 'log') bits.push('log scale');
  if (m.pitch) bits.push('follows pitch');
  return bits.length ? `${m.doc} (${bits.join(', ')})` : m.doc;
}

function numberSchema(m: ParamMeta): Schema {
  const s: Schema = { type: 'number' };
  if (m.hardMin !== undefined) s.minimum = m.hardMin;
  if (m.hardMax !== undefined) s.maximum = m.hardMax;
  return s;
}

function paramSchema(m: ParamMeta): Schema {
  const base: Schema = { description: describeMeta(m) };
  if (m.default !== undefined) base.default = m.default;
  switch (m.kind) {
    case 'number':
      return { ...base, ...numberSchema(m) };
    case 'signal': {
      const value = numberSchema(m);
      const limited = m.hardMin !== undefined || m.hardMax !== undefined;
      return {
        ...base,
        anyOf: [
          value,
          limited
            ? {
                type: 'array',
                minItems: 1,
                items: { type: 'array', prefixItems: [{ type: 'number', minimum: 0 }, value, ref('curve')], minItems: 2, maxItems: 3 },
              }
            : ref('breakpoints'),
          ref('signalObject'),
        ],
      };
    }
    case 'enum': {
      // Numeric options ("12", "24") are accepted as numbers too, as the validator does.
      const options: (string | number)[] = [...(m.options ?? [])];
      for (const o of m.options ?? []) if (/^-?\d+(\.\d+)?$/.test(o)) options.push(Number(o));
      return { ...base, enum: options };
    }
    case 'bool':
      return { ...base, type: 'boolean' };
    case 'string':
      return { ...base, type: 'string' };
    case 'envelope':
      return { ...base, ...ref('envelope') };
    case 'object':
      return { ...base, ...objectSchema(m.fields ?? {}) };
    case 'array':
      return { ...base, type: 'array', ...(m.item ? { items: paramSchema(m.item) } : {}) };
  }
}

function objectSchema(fields: ParamMap, extra: Record<string, Schema> = {}, required: string[] = []): Schema {
  const properties: Record<string, Schema> = { ...extra };
  for (const [k, m] of Object.entries(fields)) properties[k] = paramSchema(m);
  const s: Schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) s.required = required;
  return s;
}

function nodeSchema(def: NodeDef, common: ParamMap): Schema {
  return {
    title: `${def.type}: ${def.label}`,
    description: def.doc,
    ...objectSchema({ ...common, ...def.params }, { type: { const: def.type, description: `${def.label} (${def.category}).` } }, ['type']),
    ...(def.example ? { examples: [def.example] } : {}),
  };
}

export function buildSchema(): Schema {
  const defs: Record<string, Schema> = {};

  defs.curve = {
    description: 'Shape of the segment that ends at this point: linear, exp (constant ratio), smooth, hold, or a bend from -1 (fast first) to 1 (slow first).',
    anyOf: [{ enum: ['linear', 'exp', 'smooth', 'hold'] }, { type: 'number', minimum: -1, maximum: 1 }],
  };
  defs.breakpoint = {
    description: '[seconds, value] or [seconds, value, curve].',
    type: 'array',
    prefixItems: [{ type: 'number', minimum: 0, description: 'Seconds.' }, { type: 'number', description: 'Value.' }, ref('curve')],
    minItems: 2,
    maxItems: 3,
  };
  defs.breakpoints = { description: 'Breakpoints over time: [[seconds, value], ...].', type: 'array', minItems: 1, items: ref('breakpoint') };
  const numberOrBreakpoints = { anyOf: [{ type: 'number' }, ref('breakpoints')] };
  defs.modulator = {
    description: 'A wobble added on top of a parameter.',
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Names it for paths: tracks.x.source.freq.mod.<id>.depth.' },
      type: { enum: ['lfo', 'wander'], description: 'lfo repeats a shape; wander is smooth random drift.' },
      rate: { ...numberOrBreakpoints, description: 'Hz; breakpoints make the rate move.' },
      depth: { ...numberOrBreakpoints, description: 'Peak deviation in `unit`; breakpoints fade it in or out.' },
      unit: { enum: ['value', 'st', 'cents', 'oct', 'pct', 'db'], description: 'Default: st on log-scale parameters, else value.' },
      shape: { enum: ['sine', 'triangle', 'square', 'saw', 'ramp', 'random', 'smooth-random'] },
      phase: { type: 'number', minimum: 0, maximum: 1, description: 'Start phase, 0 to 1.' },
      delay: { type: 'number', minimum: 0, description: 'Seconds before the modulator starts.' },
      fade: { type: 'number', minimum: 0, description: 'Seconds to reach full depth after the delay.' },
    },
    required: ['type', 'rate', 'depth'],
    additionalProperties: false,
  };
  defs.signalObject = {
    description: '{ value or env, curve, mod }: a parameter with modulators.',
    type: 'object',
    properties: {
      value: { type: 'number', description: 'Constant base value, used when there is no env.' },
      env: ref('breakpoints'),
      curve: ref('curve'),
      mod: { type: 'array', items: ref('modulator') },
    },
    additionalProperties: false,
  };
  defs.envelope = {
    description: 'Amplitude envelope: ADSR in seconds ({ attack, decay, ... }) or { points: [[seconds, level], ...] }.',
    anyOf: [
      { title: 'ADSR', ...objectSchema(ENVELOPE_FIELDS) },
      {
        title: 'Points',
        type: 'object',
        properties: { points: ref('breakpoints'), curve: ref('curve') },
        required: ['points'],
        additionalProperties: false,
      },
    ],
  };

  const sources = listSources();
  const effects = listEffects();
  for (const def of sources) defs[`source-${def.type}`] = nodeSchema(def, COMMON_SOURCE_PARAMS);
  for (const def of effects) defs[`effect-${def.type}`] = nodeSchema(def, COMMON_EFFECT_PARAMS);
  defs.source = {
    description: `A sound source: ${sources.map((d) => d.type).join(', ')}.`,
    type: 'object',
    required: ['type'],
    properties: { type: { enum: sources.map((d) => d.type) } },
    anyOf: sources.map((d) => ref(`source-${d.type}`)),
  };
  defs.effect = {
    description: `An effect: ${effects.map((d) => d.type).join(', ')}.`,
    type: 'object',
    required: ['type'],
    properties: { type: { enum: effects.map((d) => d.type) } },
    anyOf: effects.map((d) => ref(`effect-${d.type}`)),
  };
  defs.fxChain = { description: 'Effects, in order.', type: 'array', items: ref('effect') };

  defs.event = {
    description: 'One trigger of the source: seconds, or { t, pitch, vel, dur }.',
    anyOf: [
      { type: 'number', minimum: 0 },
      {
        type: 'object',
        properties: {
          t: { type: 'number', minimum: 0, description: 'Seconds from the track start.' },
          pitch: { type: 'number', description: 'Semitones of transposition.' },
          vel: { type: 'number', minimum: 0, maximum: 4, description: 'Velocity: scales the level. Default 1.' },
          dur: { type: 'number', minimum: 0, description: 'Seconds held: the envelope gate.' },
        },
        required: ['t'],
        additionalProperties: false,
      },
    ],
  };
  defs.repeat = {
    description: 'A run of events: ratchets, bounces, rolls. accel below 1 speeds up.',
    ...objectSchema(REPEAT_FIELDS, {}, ['count', 'interval']),
  };
  defs.track = {
    description: 'One layer: a source played by events, then its effects.',
    ...objectSchema(
      TRACK_FIELDS,
      {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'Unique; paths use it: tracks.<id>.source.freq.' },
        name: { type: 'string' },
        color: { type: 'string', description: 'Ink colour in the editor (CSS).' },
        note: { type: 'string', description: 'Why this layer exists, for the person tweaking it.' },
        source: ref('source'),
        events: { type: 'array', items: ref('event'), description: 'When the source plays. Default: once at 0. Ignored when repeat is set.' },
        repeat: ref('repeat'),
        fx: ref('fxChain'),
        sends: { type: 'object', additionalProperties: { type: 'number' }, description: '{ busId: send level in dB }.' },
      },
      ['id', 'source'],
    ),
  };
  defs.bus = {
    description: 'A shared effect chain that tracks send to.',
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      fx: ref('fxChain'),
      gain: { type: 'number', description: 'Bus level, dB.' },
    },
    required: ['id'],
    additionalProperties: false,
  };
  defs.master = {
    description: 'The master: effects, gain, normalisation, fades.',
    ...objectSchema(MASTER_FIELDS, {
      fx: ref('fxChain'),
      normalize: {
        type: 'object',
        properties: {
          mode: { enum: ['peak', 'loudness', 'none'], description: 'peak sets the highest sample, loudness the integrated loudness (LUFS).' },
          target: { type: 'number', description: 'dBFS for peak (default -1), LUFS for loudness (default -16).' },
          ceiling: { type: 'number', description: 'For loudness: the highest peak allowed, dBFS (default -0.3).' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      dcBlock: { type: 'boolean', description: 'Remove DC offset. Default true.' },
    }),
  };
  defs.controlTarget = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Dot path to a parameter: tracks.body.source.freq, tracks.body.fx.space.mix, master.gain.' },
      mode: { enum: ['set', 'mul', 'add', 'stretch'], description: 'set (default), mul (multiplies, breakpoints and all), add, stretch (breakpoint, envelope, event and repeat times).' },
      from: { type: 'number', description: 'Value (or factor) at the control minimum.' },
      to: { type: 'number', description: 'Value (or factor) at the control maximum.' },
      via: { type: 'number', description: "Value at the control's default (or middle): from -> via -> to." },
      curve: { anyOf: [{ enum: ['linear', 'exp', 'smooth'] }, { type: 'number', minimum: -1, maximum: 1 }] },
    },
    required: ['path'],
    additionalProperties: false,
  };
  defs.control = {
    description: 'A knob a person sees first: a perceptual move named in the listener\'s words.',
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string', description: 'What the person sees: Size, Weight, Grit, Distance.' },
      hint: { type: 'string', description: 'What the listener hears across its range.' },
      group: { type: 'string' },
      value: { type: 'number', description: 'Current value between min and max; for select and toggle, the option index.' },
      min: { type: 'number', default: 0 },
      max: { type: 'number', default: 1 },
      step: { type: 'number' },
      unit: { type: 'string' },
      default: { type: 'number' },
      scale: { enum: ['linear', 'exp'] },
      widget: { enum: ['knob', 'slider', 'toggle', 'select'] },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, set: { type: 'object', description: '{ path: value } applied when chosen.' } },
          required: ['label'],
          additionalProperties: false,
        },
      },
      targets: { type: 'array', items: ref('controlTarget') },
      vary: { type: 'number', minimum: 0, description: 'How far variations may move it, in its own units.' },
    },
    required: ['id', 'value'],
    additionalProperties: false,
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://sfxgen.dev/schema/sfxgen.schema.json',
    title: `sfxgen patch (${FORMAT_ID})`,
    description: 'One sound effect: layered tracks, each a source played by events through effects, mixed through optional buses into the master. See docs/FORMAT.md or `sfxgen guide`.',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      format: { const: FORMAT_ID },
      name: { type: 'string' },
      description: { type: 'string', description: 'The story: what it is, made of what, what happens, where.' },
      tags: { type: 'array', items: { type: 'string' } },
      author: { type: 'string' },
      license: { type: 'string' },
      duration: {
        description: 'Seconds, or "auto": until every layer has rung out (capped by maxDuration).',
        anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 60 }, { const: 'auto' }],
      },
      maxDuration: { type: 'number', exclusiveMinimum: 0, maximum: 60, description: 'Cap for "auto", seconds. Default 10.' },
      seed: { type: 'number', description: 'Every random choice comes from it. Default 1.' },
      output: {
        type: 'object',
        properties: {
          sampleRate: { type: 'number', minimum: 8000, maximum: 192000, default: 48000 },
          channels: { enum: [1, 2], default: 1 },
          bitDepth: { enum: [16, 24, 32], default: 16 },
        },
        additionalProperties: false,
      },
      loop: {
        type: 'object',
        properties: {
          mode: { enum: ['wrap', 'crossfade'] },
          crossfade: { type: 'number', minimum: 0, description: 'Seconds, for crossfade. Default 0.05.' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      tracks: { type: 'array', items: ref('track') },
      buses: { type: 'array', items: ref('bus') },
      master: ref('master'),
      controls: { type: 'array', items: ref('control') },
      meta: { type: 'object', description: 'Anything else; the renderer ignores it.' },
    },
    required: ['format', 'name', 'duration', 'tracks'],
    additionalProperties: false,
    $defs: defs,
  };
}
