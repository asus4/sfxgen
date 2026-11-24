/**
 * Checks a patch against the format and the node catalog, with messages written for agents: each names the path,
 * what was expected and, for misspellings, the closest valid name.
 */
import { FORMAT_ID, type Patch } from './types';
import { COMMON_EFFECT_PARAMS, COMMON_SOURCE_PARAMS, type ParamMap, type ParamMeta } from '../nodes';
import { ENVELOPE_FIELDS, REPEAT_FIELDS, getEffect, getSource, listEffects, listSources, metaAt } from '../registry';
import { getPath } from './paths';

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** " (did you mean "x"?)" when a name is close to a valid one. */
export function suggest(name: string, options: Iterable<string>): string {
  let best = '';
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(name.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(name.length / 3)) ? ` (did you mean "${best}"?)` : '';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Checker {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  error(path: string, message: string) {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string) {
    this.warnings.push({ path, message });
  }

  breakpoints(path: string, v: unknown[], meta: ParamMeta) {
    let lastT = -Infinity;
    v.forEach((bp, i) => {
      const p = `${path}[${i}]`;
      if (!Array.isArray(bp) || bp.length < 2 || !isNum(bp[0]) || !isNum(bp[1])) {
        this.error(p, 'a breakpoint is [seconds, value] or [seconds, value, curve]');
        return;
      }
      if (bp[0] < lastT) this.warn(p, 'breakpoint times should rise; they will be sorted');
      lastT = bp[0];
      this.range(p, bp[1], meta);
      const c = bp[2];
      if (c !== undefined && !(isNum(c) || ['linear', 'exp', 'smooth', 'hold'].includes(c as string))) {
        this.error(p, `curve must be linear, exp, smooth, hold or a number from -1 to 1, not ${JSON.stringify(c)}`);
      }
    });
  }

  range(path: string, v: number, meta: ParamMeta) {
    if (meta.hardMin !== undefined && v < meta.hardMin) this.error(path, `${v} is below the limit ${meta.hardMin}${meta.unit ? ' ' + meta.unit : ''}`);
    if (meta.hardMax !== undefined && v > meta.hardMax) this.error(path, `${v} is above the limit ${meta.hardMax}${meta.unit ? ' ' + meta.unit : ''}`);
  }

  value(path: string, v: unknown, meta: ParamMeta) {
    switch (meta.kind) {
      case 'number':
        if (!isNum(v)) this.error(path, `expected a number${meta.unit ? ' in ' + meta.unit : ''}`);
        else this.range(path, v, meta);
        break;
      case 'signal':
        if (isNum(v)) this.range(path, v, meta);
        else if (Array.isArray(v)) {
          if (v.length === 0) this.error(path, 'an empty breakpoint list');
          else this.breakpoints(path, v, meta);
        } else if (isObj(v)) {
          for (const key of Object.keys(v)) {
            if (!['value', 'env', 'curve', 'mod'].includes(key)) this.warn(`${path}.${key}`, `unknown signal field${suggest(key, ['value', 'env', 'curve', 'mod'])}`);
          }
          if (v.value !== undefined) {
            if (!isNum(v.value)) this.error(`${path}.value`, 'expected a number');
            else this.range(`${path}.value`, v.value, meta);
          }
          if (v.env !== undefined) {
            if (!Array.isArray(v.env)) this.error(`${path}.env`, 'expected a breakpoint list');
            else this.breakpoints(`${path}.env`, v.env, meta);
          }
          if (v.mod !== undefined) {
            if (!Array.isArray(v.mod)) this.error(`${path}.mod`, 'expected a list of modulators');
            else
              v.mod.forEach((m, i) => {
                const p = `${path}.mod[${i}]`;
                if (!isObj(m)) return this.error(p, 'expected a modulator object');
                if (m.type !== 'lfo' && m.type !== 'wander') this.error(`${p}.type`, 'modulator type is "lfo" or "wander"');
                if (!(isNum(m.rate) || Array.isArray(m.rate))) this.error(`${p}.rate`, 'rate is Hz: a number or breakpoints');
                if (!(isNum(m.depth) || Array.isArray(m.depth))) this.error(`${p}.depth`, 'depth is a number or breakpoints');
                if (m.unit !== undefined && !['value', 'st', 'cents', 'oct', 'pct', 'db'].includes(m.unit as string)) {
                  this.error(`${p}.unit`, 'unit is value, st, cents, oct, pct or db');
                }
              });
          }
          if (v.value === undefined && v.env === undefined) this.warn(path, 'a signal object without value or env uses the default');
        } else this.error(path, `expected a number, a breakpoint list or { value, env, mod }${meta.unit ? ' (' + meta.unit + ')' : ''}`);
        break;
      case 'enum':
        if (!meta.options?.includes(String(v))) {
          this.error(path, `must be one of ${meta.options?.join(', ')}${suggest(String(v), meta.options ?? [])}`);
        }
        break;
      case 'bool':
        if (typeof v !== 'boolean') this.error(path, 'expected true or false');
        break;
      case 'string':
        if (typeof v !== 'string') this.error(path, 'expected a string');
        break;
      case 'envelope':
        this.envelope(path, v);
        break;
      case 'object':
        if (!isObj(v)) this.error(path, 'expected an object');
        else this.params(path, v, meta.fields ?? {}, []);
        break;
      case 'array':
        if (!Array.isArray(v)) this.error(path, 'expected a list');
        else if (meta.item) v.forEach((item, i) => this.value(`${path}[${i}]`, item, meta.item!));
        break;
    }
  }

  envelope(path: string, v: unknown) {
    if (!isObj(v)) return this.error(path, 'an envelope is { attack, decay, sustain, release, ... } or { points: [[t, level], ...] }');
    if (Array.isArray(v.points)) {
      this.breakpoints(`${path}.points`, v.points, { kind: 'number', doc: '', hardMin: 0 });
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      const meta = ENVELOPE_FIELDS[k];
      if (!meta) this.warn(`${path}.${k}`, `unknown envelope field${suggest(k, Object.keys(ENVELOPE_FIELDS))}`);
      else if (k === 'curve') {
        if (val !== 'exp' && val !== 'linear') this.error(`${path}.curve`, 'envelope curve is "exp" or "linear"');
      } else if (!isNum(val) || val < 0) this.error(`${path}.${k}`, 'expected a number of seconds (or a level) of 0 or more');
    }
  }

  params(path: string, obj: Record<string, unknown>, map: ParamMap, skip: string[]) {
    for (const [k, v] of Object.entries(obj)) {
      if (skip.includes(k)) continue;
      const meta = map[k];
      if (!meta) {
        this.warn(`${path}.${k}`, `unknown parameter, ignored${suggest(k, Object.keys(map))}`);
        continue;
      }
      if (v === undefined || v === null) continue;
      this.value(`${path}.${k}`, v, meta);
    }
  }

  fxChain(path: string, chain: unknown) {
    if (chain === undefined) return;
    if (!Array.isArray(chain)) return this.error(path, 'expected a list of effects');
    const ids = new Set<string>();
    chain.forEach((fx, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(fx)) return this.error(p, 'expected an effect object');
      const def = typeof fx.type === 'string' ? getEffect(fx.type) : undefined;
      if (!def) {
        return this.error(`${p}.type`, `unknown effect "${String(fx.type)}"${suggest(String(fx.type), listEffects().map((e) => e.type))}`);
      }
      if (typeof fx.id === 'string') {
        if (ids.has(fx.id)) this.error(`${p}.id`, `effect id "${fx.id}" is used twice in this chain`);
        ids.add(fx.id);
      }
      this.params(p, fx, { ...COMMON_EFFECT_PARAMS, ...def.params }, ['type']);
    });
  }
}

/** Validates a patch. `ok` is true when there are no errors (warnings are advice). */
export function validatePatch(input: unknown): ValidationResult {
  const c = new Checker();
  if (!isObj(input)) {
    c.error('', 'a patch is a JSON object');
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }
  const patch = input as unknown as Patch;
  if (input.format === undefined) c.warn('format', `missing; assuming "${FORMAT_ID}"`);
  else if (input.format !== FORMAT_ID) c.error('format', `this version reads "${FORMAT_ID}", not ${JSON.stringify(input.format)}`);
  if (typeof input.name !== 'string' || !input.name) c.warn('name', 'give the patch a name');
  if (!(input.duration === 'auto' || (isNum(input.duration) && input.duration > 0 && input.duration <= 60))) {
    c.error('duration', 'seconds (0 to 60) or "auto"');
  }
  if (input.seed !== undefined && !isNum(input.seed)) c.error('seed', 'expected a number');
  if (input.output !== undefined) {
    const o = input.output as Record<string, unknown>;
    if (o.sampleRate !== undefined && !(isNum(o.sampleRate) && o.sampleRate >= 8000 && o.sampleRate <= 192000)) c.error('output.sampleRate', '8000 to 192000');
    if (o.channels !== undefined && o.channels !== 1 && o.channels !== 2) c.error('output.channels', '1 or 2');
    if (o.bitDepth !== undefined && ![16, 24, 32].includes(o.bitDepth as number)) c.error('output.bitDepth', '16, 24 or 32');
  }
  if (input.loop !== undefined) {
    const l = input.loop as Record<string, unknown>;
    if (l.mode !== 'wrap' && l.mode !== 'crossfade') c.error('loop.mode', '"wrap" or "crossfade"');
    if (!isNum(input.duration)) c.error('duration', 'a loop needs a fixed duration in seconds');
  }

  const busIds = new Set<string>();
  if (input.buses !== undefined) {
    if (!Array.isArray(input.buses)) c.error('buses', 'expected a list');
    else
      input.buses.forEach((b, i) => {
        if (!isObj(b) || typeof b.id !== 'string') return c.error(`buses[${i}]`, 'a bus needs an id');
        if (busIds.has(b.id)) c.error(`buses[${i}].id`, `bus id "${b.id}" is used twice`);
        busIds.add(b.id);
        c.fxChain(`buses[${i}].fx`, b.fx);
      });
  }

  if (!Array.isArray(input.tracks)) c.error('tracks', 'expected a list of tracks');
  else {
    if (input.tracks.length === 0) c.warn('tracks', 'no tracks: the patch is silent');
    const ids = new Set<string>();
    input.tracks.forEach((t, i) => {
      const p = `tracks[${i}]`;
      if (!isObj(t)) return c.error(p, 'expected a track object');
      if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t.id)) c.error(`${p}.id`, 'letters, digits, _ and - only');
      else if (ids.has(t.id)) c.error(`${p}.id`, `track id "${t.id}" is used twice`);
      else ids.add(t.id);
      for (const k of ['start', 'length', 'gain', 'pan']) if (t[k] !== undefined && !isNum(t[k])) c.error(`${p}.${k}`, 'expected a number');
      const known = ['id', 'name', 'color', 'note', 'start', 'length', 'gain', 'pan', 'mute', 'solo', 'source', 'events', 'repeat', 'fx', 'sends'];
      for (const k of Object.keys(t)) if (!known.includes(k)) c.warn(`${p}.${k}`, `unknown track field, ignored${suggest(k, known)}`);
      if (!isObj(t.source)) c.error(`${p}.source`, 'a track needs a source: { "type": "osc", ... }');
      else {
        const def = typeof t.source.type === 'string' ? getSource(t.source.type) : undefined;
        if (!def) {
          c.error(`${p}.source.type`, `unknown source "${String(t.source.type)}"${suggest(String(t.source.type), listSources().map((s) => s.type))}`);
        } else {
          c.params(`${p}.source`, t.source, { ...COMMON_SOURCE_PARAMS, ...def.params }, ['type']);
        }
      }
      if (t.events !== undefined) {
        if (!Array.isArray(t.events)) c.error(`${p}.events`, 'a list of seconds or { t, pitch, vel, dur }');
        else
          t.events.forEach((e, k) => {
            if (isNum(e)) return;
            if (!isObj(e) || !isNum(e.t)) c.error(`${p}.events[${k}]`, 'seconds, or { t, pitch, vel, dur }');
          });
      }
      if (t.repeat !== undefined) {
        if (!isObj(t.repeat)) c.error(`${p}.repeat`, 'expected { count, interval, ... }');
        else {
          if (!isNum(t.repeat.count) || !isNum(t.repeat.interval)) c.error(`${p}.repeat`, 'needs count and interval');
          c.params(`${p}.repeat`, t.repeat, REPEAT_FIELDS, []);
        }
      }
      c.fxChain(`${p}.fx`, t.fx);
      if (t.sends !== undefined) {
        if (!isObj(t.sends)) c.error(`${p}.sends`, 'expected { busId: dB }');
        else
          for (const [bus, db] of Object.entries(t.sends)) {
            if (!busIds.has(bus)) c.error(`${p}.sends.${bus}`, `no bus "${bus}"${suggest(bus, busIds)}`);
            if (!isNum(db)) c.error(`${p}.sends.${bus}`, 'send level in dB');
          }
      }
    });
  }

  if (input.master !== undefined) {
    const m = input.master as Record<string, unknown>;
    c.fxChain('master.fx', m.fx);
    if (m.normalize !== undefined) {
      const nm = m.normalize as Record<string, unknown>;
      if (!['peak', 'loudness', 'none'].includes(nm.mode as string)) c.error('master.normalize.mode', 'peak, loudness or none');
    }
  }

  if (input.controls !== undefined) {
    if (!Array.isArray(input.controls)) c.error('controls', 'expected a list of controls');
    else {
      const ids = new Set<string>();
      input.controls.forEach((ctl, i) => {
        const p = `controls[${i}]`;
        if (!isObj(ctl)) return c.error(p, 'expected a control object');
        if (typeof ctl.id !== 'string' || !ctl.id) c.error(`${p}.id`, 'a control needs an id');
        else if (ids.has(ctl.id)) c.error(`${p}.id`, `control id "${ctl.id}" is used twice`);
        else ids.add(ctl.id);
        if (typeof ctl.label !== 'string') c.warn(`${p}.label`, 'give the control a label a person will understand');
        if (!isNum(ctl.value)) c.error(`${p}.value`, 'expected a number');
        if (ctl.min !== undefined && !isNum(ctl.min)) c.error(`${p}.min`, 'expected a number');
        if (ctl.max !== undefined && !isNum(ctl.max)) c.error(`${p}.max`, 'expected a number');
        const targets = (ctl.targets ?? []) as unknown[];
        if (!Array.isArray(targets)) c.error(`${p}.targets`, 'expected a list of { path, mode, from, to }');
        else
          targets.forEach((t, k) => {
            const tp = `${p}.targets[${k}]`;
            if (!isObj(t) || typeof t.path !== 'string') return c.error(tp, 'a target needs a path');
            if (t.mode !== undefined && !['set', 'mul', 'add', 'stretch'].includes(t.mode as string)) c.error(`${tp}.mode`, 'set, mul, add or stretch');
            if (getPath(patch, t.path) === undefined && metaAt(patch, t.path) === undefined) {
              c.warn(`${tp}.path`, `nothing at "${t.path}"`);
            }
          });
        if (Array.isArray(ctl.options)) {
          ctl.options.forEach((o, k) => {
            if (!isObj(o) || typeof o.label !== 'string') c.error(`${p}.options[${k}]`, 'an option needs a label');
          });
        }
        if (!Array.isArray(ctl.options) && targets.length === 0) c.warn(p, 'this control has no targets or options, so it does nothing');
      });
    }
  }
  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings };
}

/** Formats issues for a terminal or a tool result. */
export function formatIssues(result: ValidationResult): string {
  const lines: string[] = [];
  for (const e of result.errors) lines.push(`error   ${e.path || '(patch)'}: ${e.message}`);
  for (const w of result.warnings) lines.push(`warning ${w.path || '(patch)'}: ${w.message}`);
  return lines.join('\n');
}
