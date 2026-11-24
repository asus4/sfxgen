/**
 * Every source and effect type, and the metadata for the patch fields that aren't nodes (tracks, envelopes,
 * repeats, the master). `metaAt` finds the metadata for any parameter path.
 */
import type { Patch } from './format/types';
import { getPath, splitPath } from './format/paths';
import {
  COMMON_EFFECT_PARAMS,
  COMMON_SOURCE_PARAMS,
  type EffectDef,
  type ParamMap,
  type ParamMeta,
  type SourceDef,
} from './nodes';
import { SOURCES } from './sources';
import { EFFECTS } from './effects';

export function getSource(type: string): SourceDef | undefined {
  return Object.prototype.hasOwnProperty.call(SOURCES, type) ? SOURCES[type] : undefined;
}

export function getEffect(type: string): EffectDef | undefined {
  return Object.prototype.hasOwnProperty.call(EFFECTS, type) ? EFFECTS[type] : undefined;
}

export function listSources(): SourceDef[] {
  return Object.values(SOURCES);
}

export function listEffects(): EffectDef[] {
  return Object.values(EFFECTS);
}

export const ENVELOPE_FIELDS: ParamMap = {
  attack: { kind: 'number', doc: 'Seconds from silence to full level.', default: 0.002, min: 0, max: 2, unit: 's', scale: 'log' },
  hold: { kind: 'number', doc: 'Seconds held at full level.', default: 0, min: 0, max: 2, unit: 's' },
  decay: {
    kind: 'number',
    doc: 'Seconds to fall 60 dB toward the sustain level.',
    min: 0.005,
    max: 10,
    unit: 's',
    scale: 'log',
  },
  sustain: { kind: 'number', doc: 'Level after the decay, 0 to 1.', min: 0, max: 1 },
  release: { kind: 'number', doc: 'Seconds to fade out after the gate.', default: 0.01, min: 0.001, max: 10, unit: 's', scale: 'log' },
  gate: { kind: 'number', doc: 'Seconds after the start when the release begins.', min: 0, max: 10, unit: 's' },
  curve: { kind: 'enum', doc: 'Decay and release shape.', options: ['exp', 'linear'], default: 'exp' },
};

export const TRACK_FIELDS: ParamMap = {
  start: { kind: 'number', doc: 'Seconds from the start of the patch.', default: 0, min: 0, max: 5, unit: 's' },
  length: { kind: 'number', doc: 'Cut the track after this many seconds.', min: 0.01, max: 10, unit: 's' },
  gain: { kind: 'number', doc: 'Track level in dB.', default: 0, min: -48, max: 12, unit: 'dB' },
  pan: { kind: 'number', doc: 'Left -1 to right 1 (stereo output only).', default: 0, min: -1, max: 1 },
  mute: { kind: 'bool', doc: 'Silence this track.', default: false },
  solo: { kind: 'bool', doc: 'Hear only soloed tracks.', default: false },
};

export const REPEAT_FIELDS: ParamMap = {
  count: { kind: 'number', doc: 'How many events.', default: 1, min: 1, max: 64, step: 1 },
  interval: { kind: 'number', doc: 'Seconds between the first two events.', default: 0.1, min: 0.005, max: 2, unit: 's', scale: 'log' },
  accel: { kind: 'number', doc: 'Each gap is the last times this: below 1 speeds up.', default: 1, min: 0.5, max: 1.5 },
  jitter: { kind: 'number', doc: 'Random timing, ± seconds.', default: 0, min: 0, max: 0.1, unit: 's' },
  decay: { kind: 'number', doc: 'dB added per repeat.', default: 0, min: -24, max: 6, unit: 'dB' },
  pitchStep: { kind: 'number', doc: 'Semitones added per repeat.', default: 0, min: -12, max: 12, unit: 'st' },
  pitchJitter: { kind: 'number', doc: 'Random pitch, ± semitones.', default: 0, min: 0, max: 12, unit: 'st' },
  velJitter: { kind: 'number', doc: 'Random velocity, ±.', default: 0, min: 0, max: 1 },
  dur: { kind: 'number', doc: 'Held length of each event, seconds.', min: 0.001, max: 5, unit: 's' },
};

export const MASTER_FIELDS: ParamMap = {
  gain: { kind: 'number', doc: 'Master level in dB, after the effects.', default: 0, min: -24, max: 24, unit: 'dB' },
  fadeIn: { kind: 'number', doc: 'Fade-in seconds.', default: 0.0005, min: 0, max: 1, unit: 's' },
  fadeOut: { kind: 'number', doc: 'Fade-out seconds.', min: 0, max: 2, unit: 's' },
};

export const BUS_FIELDS: ParamMap = {
  gain: { kind: 'number', doc: 'Bus level in dB.', default: 0, min: -48, max: 12, unit: 'dB' },
};

export const PATCH_FIELDS: ParamMap = {
  duration: { kind: 'number', doc: 'Seconds, or "auto".', min: 0.01, max: 30, unit: 's' },
  seed: { kind: 'number', doc: 'Random seed.', default: 1, min: 0, max: 99999, step: 1 },
};

/** Metadata of a source parameter, including the common ones. */
export function sourceParamMeta(type: string, name: string): ParamMeta | undefined {
  const def = getSource(type);
  return def?.params[name] ?? COMMON_SOURCE_PARAMS[name];
}

export function effectParamMeta(type: string, name: string): ParamMeta | undefined {
  const def = getEffect(type);
  return def?.params[name] ?? COMMON_EFFECT_PARAMS[name];
}

/** Walks the rest of a path through nested `fields` / `item` metadata. */
function descend(meta: ParamMeta | undefined, rest: string[]): ParamMeta | undefined {
  let m = meta;
  for (const seg of rest) {
    if (!m) return undefined;
    if (m.kind === 'envelope') m = ENVELOPE_FIELDS[seg];
    else if (m.kind === 'object') m = m.fields?.[seg];
    // An array segment is a position (or an item's id); the item's metadata describes what is there.
    else if (m.kind === 'array') m = m.item;
    else if (m.kind === 'signal') return m; // `freq.value` and the like
    else return undefined;
  }
  return m;
}

/** Finds the metadata of the parameter at a path in a patch (used for controls, the editor and validation). */
export function metaAt(patch: Patch, path: string): ParamMeta | undefined {
  const segs = splitPath(path);
  if (segs.length === 0) return undefined;
  if (segs[0] === 'duration' || segs[0] === 'seed') return PATCH_FIELDS[segs[0]];
  const fxMeta = (fxList: unknown, fxSeg: string, rest: string[]): ParamMeta | undefined => {
    const fx = getPath({ fx: fxList }, `fx.${fxSeg}`) as { type?: string } | undefined;
    if (!fx?.type || rest.length === 0) return undefined;
    return descend(effectParamMeta(fx.type, rest[0]), rest.slice(1));
  };
  if (segs[0] === 'master') {
    if (segs[1] === 'fx') return fxMeta(patch.master?.fx ?? [], segs[2], segs.slice(3));
    return MASTER_FIELDS[segs[1]];
  }
  if (segs[0] === 'buses') {
    const bus = getPath(patch, `buses.${segs[1]}`) as { fx?: unknown } | undefined;
    if (!bus) return undefined;
    if (segs[2] === 'fx') return fxMeta(bus.fx ?? [], segs[3], segs.slice(4));
    return BUS_FIELDS[segs[2]];
  }
  if (segs[0] === 'tracks') {
    const track = getPath(patch, `tracks.${segs[1]}`) as { source?: { type?: string }; fx?: unknown } | undefined;
    if (!track) return undefined;
    const field = segs[2];
    if (field === 'source') {
      const type = track.source?.type;
      if (!type || segs.length < 4) return undefined;
      return descend(sourceParamMeta(type, segs[3]), segs.slice(4));
    }
    if (field === 'fx') return fxMeta(track.fx ?? [], segs[3], segs.slice(4));
    if (field === 'repeat') return REPEAT_FIELDS[segs[3]];
    if (field === 'sends') return BUS_FIELDS.gain;
    return TRACK_FIELDS[field];
  }
  return undefined;
}
