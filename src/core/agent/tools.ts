/**
 * The agent tools, defined once. The editor's WebMCP registration (src/web/webmcp.ts) exposes exactly these on the
 * editor's Workspace (src/core/agent/workspace.ts); the CLI runs some of them on a FileWorkspace.
 *
 * Hosts call `callTool(ws, name, args)`: it checks the arguments against the tool's JSON Schema, runs the tool and
 * turns a failure into an `isError` result, so every host reports mistakes the same way.
 */
import type { Control, Patch, Track } from '../format/types';
import { validatePatch, formatIssues, suggest, type ValidationResult } from '../format/validate';
import { deepClone, getPath, setPath, splitPath } from '../format/paths';
import { controlsSetting, syncControlBases } from '../format/sync';
import { takeFileName, variationTakes } from '../format/controls';
import { metaAt, getSource } from '../registry';
import { getTemplate, listTemplates, templateCategories } from '../templates';
import { analyze, describe, encodePng, spectrogram } from '../analysis';
import type { RenderResult } from '../render';
import { buildGuide, catalogIndex, type GuideSection } from './guide';
import { PROJECT_FILE, matchLoudness, newProject, projectPatch, soundExportPath, soundName, validateProject, type Project, type ProjectSound, type SoundLevel } from '../project/project';
import type { ChangeRecord, ProjectBuildRow, Workspace } from './workspace';

// ---- Types -----------------------------------------------------------------------------------

export interface ToolAnnotations {
  /** The tool changes nothing. */
  readOnlyHint?: boolean;
  /** The tool may overwrite or remove something the person cares about. */
  destructiveHint?: boolean;
  /** Calling it twice with the same arguments leaves the same state. */
  idempotentHint?: boolean;
  /** The tool has effects outside the patch (writes files, makes sound): WebMCP clients may ask first. */
  consequentialHint?: boolean;
}

export interface ToolResult {
  /** What the agent reads. */
  text: string;
  /** The same result as structured data, where there is some. */
  data?: unknown;
  image?: { data: Uint8Array; mimeType: 'image/png' };
  /** The call failed in a way the agent can fix; `text` says how. */
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset), always `type: "object"` with `additionalProperties: false`. */
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  run(ws: Workspace, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  default?: unknown;
}

// ---- Argument checking -----------------------------------------------------------------------

/**
 * Checks a value against the schema subset the tools use. Returns the value (a JSON string given for an object or
 * array is parsed, since models often stringify) or throws a message naming the first problems.
 */
export function checkArgs(schema: JsonSchema, value: unknown): unknown {
  const problems: string[] = [];
  const out = check(schema, value, 'arguments', problems);
  if (problems.length > 0) throw new ToolError(`Invalid arguments:\n- ${problems.slice(0, 8).join('\n- ')}`);
  return out;
}

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

function check(schema: JsonSchema, value: unknown, path: string, problems: string[]): unknown {
  let v = value;
  if ((schema.type === 'object' || schema.type === 'array') && typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        v = JSON.parse(s);
      } catch {
        /* reported below as a type mismatch */
      }
    }
  }
  if (schema.enum && !schema.enum.includes(v as string | number)) {
    const hint = typeof v === 'string' ? suggest(v, schema.enum.map(String)) : '';
    problems.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}${hint}`);
    return v;
  }
  switch (schema.type) {
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        problems.push(`${path}: expected an object, got ${typeOf(v)}`);
        return v;
      }
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) if (obj[key] === undefined) problems.push(`${path}.${key}: required`);
      for (const [key, val] of Object.entries(obj)) {
        if (val === undefined) continue;
        const sub = schema.properties?.[key];
        if (sub) out[key] = check(sub, val, `${path}.${key}`, problems);
        else if (schema.additionalProperties === false) {
          problems.push(`${path}.${key}: unknown argument${suggest(key, Object.keys(schema.properties ?? {}))}`);
        } else if (typeof schema.additionalProperties === 'object') {
          out[key] = check(schema.additionalProperties, val, `${path}.${key}`, problems);
        } else out[key] = val;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(v)) {
        problems.push(`${path}: expected an array, got ${typeOf(v)}`);
        return v;
      }
      if (schema.minItems !== undefined && v.length < schema.minItems) problems.push(`${path}: at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && v.length > schema.maxItems) problems.push(`${path}: at most ${schema.maxItems} item(s)`);
      return schema.items ? v.map((item, i) => check(schema.items as JsonSchema, item, `${path}[${i}]`, problems)) : v;
    }
    case 'string':
      if (typeof v !== 'string') problems.push(`${path}: expected a string, got ${typeOf(v)}`);
      else if (schema.minLength !== undefined && v.length < schema.minLength) problems.push(`${path}: must not be empty`);
      return v;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${path}: expected a number, got ${typeOf(v)}`);
      else {
        if (schema.type === 'integer' && !Number.isInteger(v)) problems.push(`${path}: expected a whole number`);
        if (schema.minimum !== undefined && v < schema.minimum) problems.push(`${path}: at least ${schema.minimum}`);
        if (schema.maximum !== undefined && v > schema.maximum) problems.push(`${path}: at most ${schema.maximum}`);
      }
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') problems.push(`${path}: expected true or false, got ${typeOf(v)}`);
      return v;
    default:
      return v;
  }
}

/** A mistake the agent can correct: the message goes back as the tool's result. */
export class ToolError extends Error {}

// ---- Helpers ---------------------------------------------------------------------------------

const FILE_PROP: JsonSchema = {
  type: 'string',
  description:
    'Which patch: its file path relative to the workspace (such as "sounds/laser.sfx.json"). Optional when you work on one patch: it defaults to the one used last, or the open patch in the editor.',
};

function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required: required.length ? required : undefined, additionalProperties: false };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function fail(text: string): ToolResult {
  return { text, isError: true };
}

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function round(n: number, digits = 3): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sound';
}

/** Validates, and describes the problems when there are errors. */
function validationText(result: ValidationResult): string {
  return formatIssues(result);
}

/** Controls whose targets or option paths point at nothing (renders would warn and skip them). */
export function brokenControlTargets(patch: Patch): string[] {
  const out: string[] = [];
  const resolves = (path: string) => getPath(patch, path) !== undefined || metaAt(patch, path) !== undefined;
  for (const c of patch.controls ?? []) {
    (c.targets ?? []).forEach((t, i) => {
      if (!t || typeof t.path !== 'string' || !resolves(t.path)) {
        const p = typeof t?.path === 'string' ? t.path : String(t?.path);
        out.push(`controls ${c.id} targets[${i}]: path "${p}" does not point at a parameter${pathHint(patch, p)}`);
      }
    });
    (c.options ?? []).forEach((o, i) => {
      for (const p of Object.keys(o.set ?? {})) {
        if (!resolves(p)) out.push(`controls ${c.id} options[${i}] "${o.label}": path "${p}" does not point at a parameter${pathHint(patch, p)}`);
      }
    });
  }
  return out;
}

/** Says where a bad path went wrong: the first segment that isn't there, with what is. */
function pathHint(patch: Patch, path: string): string {
  const segs = splitPath(path);
  if (segs[0] === 'tracks' && segs[1]) {
    const ids = patch.tracks.map((t) => t.id);
    if (!ids.includes(segs[1])) return ` (no track "${segs[1]}"; tracks: ${ids.join(', ') || 'none'}${suggest(segs[1], ids)})`;
    const track = patch.tracks.find((t) => t.id === segs[1]);
    if (segs[2] === 'source' && segs[3] && track) {
      const def = getSource(String(track.source.type));
      const names = [...Object.keys(def?.params ?? {}), 'gain', 'env', 'pitch', 'filter'];
      return ` (source "${track.source.type}" has: ${names.join(', ')}${suggest(segs[3], names)})`;
    }
  }
  return '';
}

async function humanChangeNote(ws: Workspace, ref: string | undefined): Promise<string> {
  if (!ws.getHumanChanges) return '';
  try {
    const changes = await ws.getHumanChanges(ref);
    if (changes.length === 0) return '';
    return `\nNote: a person changed ${changes.length} value(s) since you last wrote this patch, and this edit keeps them. Call get_human_changes to see what they chose.`;
  } catch {
    return '';
  }
}

function summarize(patch: Patch): string {
  const tracks = patch.tracks.map((t) => `${t.id} (${t.source.type})`).join(', ');
  const controls = (patch.controls ?? []).map((c) => c.id).join(', ');
  return `"${patch.name}": duration ${patch.duration}, tracks: ${tracks || 'none'}${controls ? `; controls: ${controls}` : '; no controls yet (add some with set_controls)'}`;
}

/** Validates a finished patch: returns an error result, or the warnings text to append. */
function gate(patch: Patch): { error: ToolResult } | { warnings: string } {
  const v = validatePatch(patch);
  if (!v.ok) return { error: fail(`Not saved: the patch has errors.\n${validationText(v)}`) };
  return { warnings: v.warnings.length ? `\nWarnings:\n${formatIssues({ ...v, errors: [] })}` : '' };
}

async function save(ws: Workspace, patch: Patch, ref: string | undefined): Promise<void> {
  await ws.setPatch(patch, { ref, origin: 'agent' });
}

// ---- describe_format -------------------------------------------------------------------------

const describeFormat: ToolDef = {
  name: 'describe_format',
  title: 'Describe the patch format',
  description:
    'Returns the sfxgen patch format as markdown: by default the format overview and a one-line index of every source and effect. Pass `node` (such as "modal" or "reverb") for one node with all its parameters, units, ranges and an example, or `section` for the full catalog of sources, effects or templates. Call it before writing your first patch.',
  inputSchema: obj({
    node: { type: 'string', description: 'A source or effect type, such as "noise" or "drive": its parameters in detail.' },
    section: {
      type: 'string',
      enum: ['overview', 'index', 'sources', 'effects', 'templates', 'all'],
      description: 'A part of the guide. Default: the overview plus the index. "all" is long (about 90k characters).',
    },
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(_ws, args) {
    const node = str(args, 'node');
    const section = str(args, 'section') as GuideSection | undefined;
    try {
      if (node) return { text: buildGuide({ type: node }) };
      if (section) return { text: buildGuide({ section }) };
      return { text: `${buildGuide({ section: 'overview' })}\n${catalogIndex()}\n\nNext: describe_format with \`node\` for the nodes you will use.\n` };
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  },
};

// ---- templates -------------------------------------------------------------------------------

const listTemplatesTool: ToolDef = {
  name: 'list_templates',
  title: 'List templates',
  description:
    'Searches the template library by category and/or words, returning each template id, description and its controls. Starting from the closest template with new_from_template and editing it beats writing a patch from nothing.',
  inputSchema: obj({
    category: { type: 'string', description: 'Only templates in this category (such as "impacts", "scifi", "ui").' },
    query: { type: 'string', description: 'Words matched against name, description, tags and id; every word must match.' },
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(_ws, args) {
    const category = str(args, 'category');
    const query = str(args, 'query');
    const categories = templateCategories();
    if (category && !categories.includes(category)) {
      return fail(`No category "${category}"${suggest(category, categories)}. Categories: ${categories.join(', ')}.`);
    }
    const found = listTemplates({ category, query });
    if (found.length === 0) return { text: `No templates match. Categories: ${categories.join(', ')}. Try fewer words.`, data: { templates: [] } };
    const lines = found.map((t) => `- ${t.id}: ${t.description || t.name}${t.controls.length ? ` [controls: ${t.controls.map((c) => c.id).join(', ')}]` : ''}`);
    return { text: `${found.length} template(s):\n${lines.join('\n')}`, data: { templates: found } };
  },
};

const newFromTemplate: ToolDef = {
  name: 'new_from_template',
  title: 'New patch from a template',
  description:
    'Creates a patch from a template, optionally setting some of its controls (by control id, to a value inside the control\'s range) and the seed, and saves it. The file defaults to <template name>.sfx.json; an existing file is only replaced when overwrite is true.',
  inputSchema: obj(
    {
      template: { type: 'string', description: 'Template id from list_templates, such as "impacts/thud".', minLength: 1 },
      file: FILE_PROP,
      name: { type: 'string', description: 'A name for the new patch (default: the template\'s).' },
      controls: { type: 'object', description: 'Control values by control id, for example { "weight": 0.8 }.', additionalProperties: { type: 'number' } },
      seed: { type: 'integer', description: 'Seed for every random choice; a new seed is a new take.' },
      overwrite: { type: 'boolean', description: 'Replace the file if it already exists. Default false.' },
    },
    ['template'],
  ),
  annotations: { destructiveHint: true },
  async run(ws, args) {
    const id = str(args, 'template') as string;
    const patch = getTemplate(id);
    if (!patch) {
      const ids = listTemplates().map((t) => t.id);
      return fail(`No template "${id}"${suggest(id, ids)}. Call list_templates to see them.`);
    }
    if (typeof args.name === 'string') patch.name = args.name;
    if (typeof args.seed === 'number') patch.seed = args.seed;
    const values = (args.controls ?? {}) as Record<string, number>;
    for (const [cid, value] of Object.entries(values)) {
      const c = patch.controls?.find((k) => k.id === cid);
      if (!c) return fail(`Template "${id}" has no control "${cid}"${suggest(cid, (patch.controls ?? []).map((k) => k.id))}. Controls: ${(patch.controls ?? []).map((k) => k.id).join(', ') || 'none'}.`);
      const lo = Math.min(c.min ?? 0, c.max ?? 1);
      const hi = Math.max(c.min ?? 0, c.max ?? 1);
      c.value = Math.min(hi, Math.max(lo, value));
    }
    let ref = str(args, 'file');
    if (!ref && ws.kind === 'files') ref = `${slug(id.split('/').pop() ?? id)}.sfx.json`;
    if (ref && ws.kind === 'files' && args.overwrite !== true && ws.list) {
      const existing = await ws.list();
      if (existing.includes(ref)) return fail(`${ref} already exists. Pass overwrite: true to replace it, or choose another file.`);
    }
    await save(ws, patch, ref);
    return {
      text: `Created ${ref ?? 'the patch'} from template ${id}: ${summarize(patch)}.\nNext: render_and_analyze to hear it in numbers, then edit_patch.`,
      data: { file: ref, patch },
    };
  },
};

// ---- reading and writing patches ---------------------------------------------------------------

const getPatchTool: ToolDef = {
  name: 'get_patch',
  title: 'Get the patch',
  description:
    'Returns the current patch JSON. Read it before editing so you work from what is there now, since a person may have changed it in the editor.',
  inputSchema: obj({ file: FILE_PROP }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(ws, args) {
    const patch = await ws.getPatch(str(args, 'file'));
    return { text: pretty(patch), data: patch };
  },
};

const setPatchTool: ToolDef = {
  name: 'set_patch',
  title: 'Replace the patch',
  description:
    'Replaces the whole patch with the JSON you give (see describe_format for the structure). It is validated first: if there are errors, nothing is saved and each error names its path and the closest valid name. For small changes use edit_patch.',
  inputSchema: obj(
    {
      patch: { type: 'object', description: 'The complete patch: { "format": "sfxgen/1", "name", "duration", "tracks": [...], ... }.' },
      file: FILE_PROP,
    },
    ['patch'],
  ),
  annotations: { destructiveHint: true, idempotentHint: true },
  async run(ws, args) {
    const patch = args.patch as Patch;
    const ref = str(args, 'file');
    const g = gate(patch);
    if ('error' in g) return g.error;
    const note = await humanChangeNote(ws, ref);
    await save(ws, patch, ref);
    return { text: `Saved ${summarize(patch)}.${g.warnings}${note}`, data: { warnings: validatePatch(patch).warnings } };
  },
};

const trackSchema: JsonSchema = {
  type: 'object',
  description: 'A track: { "id": "click", "source": { "type": "noise", ... }, "events": [...], "fx": [...] }. The id must be new.',
  properties: { id: { type: 'string', minLength: 1 }, source: { type: 'object' } },
  required: ['id', 'source'],
  additionalProperties: true,
};

function unsetPath(root: unknown, path: string): boolean {
  const segs = splitPath(path);
  if (segs.length === 0) return false;
  const parent = segs.length === 1 ? root : getPath(root, segs.slice(0, -1).join('.'));
  const last = segs[segs.length - 1];
  if (Array.isArray(parent)) {
    let i = parent.findIndex((item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === last);
    if (i < 0 && /^\d+$/.test(last) && Number(last) < parent.length) i = Number(last);
    if (i < 0) return false;
    parent.splice(i, 1);
    return true;
  }
  if (typeof parent === 'object' && parent !== null && last in (parent as object)) {
    delete (parent as Record<string, unknown>)[last];
    return true;
  }
  return false;
}

const editPatch: ToolDef = {
  name: 'edit_patch',
  title: 'Edit the patch',
  description:
    'Changes parts of the patch by dot path: `set` writes values ({"tracks.body.source.freq": [[0,200],[0.1,60]], "master.gain": -3}), `unset` removes paths, `add_track` appends a track and `remove_track` deletes one by id. Order: remove_track, add_track, set, unset; the result is validated and nothing is saved if it has errors.',
  inputSchema: obj({
    file: FILE_PROP,
    set: { type: 'object', description: 'Path to new value. Paths: tracks.<trackId>.source.<param>, tracks.<trackId>.fx.<effectId or index>.<param>, master.gain, duration, seed. Arrays pick an item by id, else by position.', additionalProperties: true },
    unset: { type: 'array', items: { type: 'string' }, description: 'Paths to remove (an optional parameter goes back to its default; an array item is deleted).' },
    add_track: trackSchema,
    remove_track: { type: 'string', description: 'Id of the track to delete.' },
  }),
  annotations: { destructiveHint: true },
  async run(ws, args) {
    const ref = str(args, 'file');
    const patch = deepClone(await ws.getPatch(ref));
    const set = (args.set ?? {}) as Record<string, unknown>;
    const unset = (args.unset ?? []) as string[];
    const done: string[] = [];
    if (Object.keys(set).length === 0 && unset.length === 0 && args.add_track === undefined && args.remove_track === undefined) {
      return fail('Nothing to do: give set, unset, add_track or remove_track.');
    }
    if (typeof args.remove_track === 'string') {
      const i = patch.tracks.findIndex((t) => t.id === args.remove_track);
      if (i < 0) return fail(`No track "${args.remove_track}"${suggest(args.remove_track, patch.tracks.map((t) => t.id))}. Tracks: ${patch.tracks.map((t) => t.id).join(', ')}.`);
      patch.tracks.splice(i, 1);
      done.push(`removed track ${args.remove_track}`);
    }
    if (args.add_track !== undefined) {
      const track = args.add_track as Track;
      if (patch.tracks.some((t) => t.id === track.id)) return fail(`A track "${track.id}" already exists; choose another id or edit it with set.`);
      patch.tracks.push(track);
      done.push(`added track ${track.id}`);
    }
    for (const [path, value] of Object.entries(set)) {
      if (!setPath(patch, path, deepClone(value))) {
        return fail(`Cannot set "${path}": it runs through something that doesn't exist${pathHint(patch, path)}. Nothing was changed.`);
      }
      done.push(`set ${path}`);
    }
    for (const path of unset) {
      if (!unsetPath(patch, path)) return fail(`Cannot unset "${path}": nothing is there${pathHint(patch, path)}. Nothing was changed.`);
      done.push(`unset ${path}`);
    }
    const g = gate(patch);
    if ('error' in g) return fail(`Not saved: the edit leaves the patch with errors.\n${validationText(validatePatch(patch))}`);
    const broken = brokenControlTargets(patch);
    const note = await humanChangeNote(ws, ref);
    const owners = controlsSetting(patch);
    const overridden = Object.keys(set)
      .filter((p) => owners.has(p))
      .map((p) => `\nWarning: ${p} is set by control "${owners.get(p)}", which overrides this value when rendering. Change the control's value instead, or call sync_controls after editing.`)
      .join('');
    await save(ws, patch, ref);
    const brokenText = broken.length ? `\nControls now broken (fix with set_controls):\n- ${broken.join('\n- ')}` : '';
    return { text: `Saved. ${done.join('; ')}.${g.warnings}${overridden}${brokenText}${note}`, data: { applied: done, patch } };
  },
};

const controlSchema: JsonSchema = {
  type: 'object',
  description:
    'A control: { "id": "weight", "label": "Weight", "hint": "what the listener hears", "value": 0.5, "min": 0, "max": 1, "vary": 0.1, "targets": [{ "path": "tracks.body.source.freq", "mode": "mul", "from": 1.6, "to": 0.6 }] }.',
  properties: {
    id: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    value: { type: 'number' },
  },
  required: ['id', 'label', 'value'],
  additionalProperties: true,
};


const syncControls: ToolDef = {
  name: 'sync_controls',
  title: 'Sync the patch with its controls',
  description:
    'Writes the value each control currently applies into the base value at its `set` targets and options, so the patch file says what renders (a control overrides the base value there on every render, which makes a hand-edited value at that path look dead). Relative targets (mul, add, stretch) are left alone. Call it after changing a control\'s value or a controlled parameter, and before reading the patch back to a person.',
  inputSchema: obj({ file: FILE_PROP }),
  annotations: { destructiveHint: true, idempotentHint: true },
  async run(ws, args) {
    const ref = str(args, 'file');
    const patch = await ws.getPatch(ref);
    const { patch: synced, changes } = syncControlBases(patch);
    if (changes.length === 0) return { text: 'Already in sync: no control sets a value that differs from the patch.', data: { changes } };
    await save(ws, synced, ref);
    const lines = changes.map((c) => `- ${c.path}: ${formatValue(c.before)} -> ${formatValue(c.after)}`);
    return { text: `Wrote ${changes.length} base value(s) from the controls:\n${lines.join('\n')}`, data: { changes } };
  },
};

const setControls: ToolDef = {
  name: 'set_controls',
  title: 'Set the controls',
  description:
    'Replaces the patch\'s controls: the three to seven knobs a person sees first, each a perceptual move (Size, Weight, Grit, Distance) that drives one or more parameters through its targets. Every target path must point at a real parameter; the call is rejected, with the bad paths, if one does not.',
  inputSchema: obj(
    {
      controls: { type: 'array', items: controlSchema, maxItems: 24, description: 'The full list of controls. An empty list removes them all.' },
      file: FILE_PROP,
    },
    ['controls'],
  ),
  annotations: { destructiveHint: true, idempotentHint: true },
  async run(ws, args) {
    const ref = str(args, 'file');
    const controls = args.controls as Control[];
    const patch = deepClone(await ws.getPatch(ref));
    const ids = new Set<string>();
    for (const c of controls) {
      if (ids.has(c.id)) return fail(`Control id "${c.id}" appears twice; ids must be unique.`);
      ids.add(c.id);
    }
    patch.controls = controls;
    if (controls.length === 0) delete patch.controls;
    const broken = brokenControlTargets(patch);
    if (broken.length > 0) return fail(`Not saved: some control targets do not resolve.\n- ${broken.join('\n- ')}`);
    const g = gate(patch);
    if ('error' in g) return g.error;
    await save(ws, patch, ref);
    return { text: `Saved ${controls.length} control(s): ${controls.map((c) => c.id).join(', ') || 'none'}.${g.warnings}`, data: { controls } };
  },
};

// ---- render_and_analyze ----------------------------------------------------------------------


// ---- Per-track levels ----------------------------------------------------------------------------------

export interface TrackLevel {
  id: string;
  type: string;
  muted: boolean;
  /** Peak and loudness of the track on its own, at the level it has in the finished mix, dB. */
  peakDb: number;
  lufs: number;
  /** Share of the mix's energy, percent (layers that overlap or cancel make the shares not add up to 100). */
  sharePct: number;
  /** 30 dB or more under the loudest track: it contributes nothing you can hear. */
  inaudible: boolean;
}

const INAUDIBLE_DB = 30;

function energyOf(channels: Float32Array[]): number {
  let e = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
  return e;
}

/**
 * Renders every track on its own (same seed, controls and master chain, normalisation off) and measures it at the
 * level it has in the finished mix: `mix` is the normal render of `patch`, whose `normalizeGainDb` is the gain the
 * mix got, and each solo is brought up by the same amount. `renderPatch` renders a patch as the caller does (project
 * context, controls applied); pass the patch as it renders (project settings already in it).
 */
export async function measureTracks(
  patch: Patch,
  mix: RenderResult,
  renderPatch: (p: Patch) => RenderResult | Promise<RenderResult>,
): Promise<TrackLevel[]> {
  const withoutNormalize = (p: Patch): Patch => {
    const q = deepClone(p);
    q.master = { ...(q.master ?? {}), normalize: { mode: 'none' } };
    return q;
  };
  const rawMix = await renderPatch(withoutNormalize(patch));
  const mixEnergy = energyOf(rawMix.channels);
  const gain = mix.normalizeGainDb;
  const rows: TrackLevel[] = [];
  for (const track of patch.tracks) {
    const base = { id: track.id, type: String(track.source.type) };
    if (track.mute) {
      rows.push({ ...base, muted: true, peakDb: -Infinity, lufs: -Infinity, sharePct: 0, inaudible: false });
      continue;
    }
    const solo = withoutNormalize(patch);
    for (const t of solo.tracks) t.solo = t.id === track.id;
    const r = await renderPatch(solo);
    const a = analyze(r.channels, r.sampleRate);
    const silent = a.peakDb <= -100;
    rows.push({
      ...base,
      muted: false,
      peakDb: silent ? -Infinity : a.peakDb + gain,
      lufs: silent ? -Infinity : a.lufs + gain,
      sharePct: mixEnergy > 0 ? (100 * energyOf(r.channels)) / mixEnergy : 0,
      inaudible: false,
    });
  }
  const loudest = Math.max(...rows.filter((r) => !r.muted).map((r) => r.peakDb));
  for (const r of rows) if (!r.muted && r.peakDb <= loudest - INAUDIBLE_DB) r.inaudible = true;
  return rows;
}

/** The track table as text lines (one row per track). */
export function trackTable(rows: TrackLevel[]): string[] {
  const db = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-inf');
  return formatTable(
    ['track', 'source', 'peak dBFS', 'LUFS', 'energy %', ''],
    rows.map((r) => [r.id, r.type, r.muted ? '-' : db(r.peakDb), r.muted ? '-' : db(r.lufs), r.muted ? '-' : r.sharePct < 0.1 ? '<0.1' : r.sharePct.toFixed(1), r.muted ? 'muted' : r.inaudible ? 'inaudible' : '']),
    [2, 3, 4],
  );
}

const renderAndAnalyze: ToolDef = {
  name: 'render_and_analyze',
  title: 'Render and analyze',
  description:
    'Renders the patch (controls applied) and measures it: a plain-language description, then numbers for level, loudness, envelope, pitch and spectrum. Use it after every change instead of guessing; set `spectrogram` to also get an image of the sound over time (frequency up, time right), which shows sweeps, noise and tails at a glance.',
  inputSchema: obj({
    file: FILE_PROP,
    describe: { type: 'boolean', description: 'Include the plain-language description. Default true.' },
    analyze: { type: 'boolean', description: 'Include every measurement as structured data. Default true.' },
    spectrogram: { type: 'boolean', description: 'Also return a spectrogram image with the waveform above it. Default false.' },
    tracks: { type: 'boolean', description: 'Also render each track on its own and list its peak, loudness and share of the mix\'s energy, marking tracks 30 dB or more under the loudest as inaudible. Use it when a layer seems to do nothing. Default false.' },
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(ws, args) {
    const patch = await ws.getPatch(str(args, 'file'));
    const v = validatePatch(patch);
    if (!v.ok) return fail(`The patch has errors, so it cannot render yet.\n${validationText(v)}`);
    const result = await ws.render(patch);
    const analysis = analyze(result.channels, result.sampleRate);
    const lines = [`Rendered "${patch.name}": ${round(result.duration)} s, ${result.sampleRate} Hz, ${result.channels.length === 2 ? 'stereo' : 'mono'}, in ${Math.round(result.timeMs)} ms.`];
    if (args.describe !== false) lines.push(describe(analysis, { loop: !!patch.loop }));
    const tracks = args.tracks === true ? await measureTracks(patch, result, (p) => ws.render(p)) : undefined;
    if (tracks) lines.push('Tracks on their own, at their level in the mix:', ...trackTable(tracks));
    if (result.warnings.length) lines.push(`Render warnings:\n- ${result.warnings.join('\n- ')}`);
    if (v.warnings.length) lines.push(`Validation warnings:\n${formatIssues({ ...v, errors: [] })}`);
    const out: ToolResult = {
      text: lines.join('\n'),
      data: {
        name: patch.name,
        duration: result.duration,
        sampleRate: result.sampleRate,
        channels: result.channels.length,
        renderMs: result.timeMs,
        warnings: result.warnings,
        ...(args.analyze !== false ? { analysis } : {}),
        ...(tracks ? { tracks } : {}),
      },
    };
    if (args.spectrogram === true) {
      const img = spectrogram(result.channels, result.sampleRate, {});
      out.image = { data: await encodePng(img.width, img.height, img.rgba), mimeType: 'image/png' };
      out.text += '\nSpectrogram attached: time runs left to right, frequency bottom to top on a log scale, louder is brighter; the waveform is the strip above.';
    }
    return out;
  },
};

// ---- play and export ---------------------------------------------------------------------------

const play: ToolDef = {
  name: 'play',
  title: 'Play the sound',
  description:
    'Plays the sound for the person through the open editor, so they can judge it by ear. Call it when a version is worth hearing, not after every tweak; if no editor is open it says how to open one.',
  inputSchema: obj({ file: FILE_PROP }),
  annotations: { readOnlyHint: true, consequentialHint: true },
  async run(ws, args) {
    if (!ws.play) return { text: 'This workspace cannot play audio.', data: { played: false } };
    const r = await ws.play(str(args, 'file'));
    return { text: r.played ? `Playing.${r.note ? ` ${r.note}` : ''}` : `Not played. ${r.note ?? ''}`.trim(), data: r };
  },
};

function stripExt(p: string): string {
  return p.replace(/\.sfx\.json$/i, '').replace(/\.(json|wav)$/i, '');
}

const exportWav: ToolDef = {
  name: 'export_wav',
  title: 'Export WAV',
  description:
    'Writes the sound as a WAV file, next to the patch unless `path` is given. With `variations` above 1 it writes that many takes (the patch itself, then versions where each control with a `vary` range moves a little and the seed changes), named name-01.wav, name-02.wav and so on (the same takes the editor and the CLI write): the usual set for game round-robin.',
  inputSchema: obj({
    file: FILE_PROP,
    path: { type: 'string', description: 'Where to write the WAV (relative to the workspace). Default: next to the patch, same name.' },
    bit_depth: { type: 'integer', enum: [16, 24, 32], description: '16 or 24-bit integer PCM, or 32 for float. Default: the patch\'s output.bitDepth, else 16.' },
    variations: { type: 'integer', minimum: 1, maximum: 16, description: 'How many takes to write. Default 1.' },
  }),
  annotations: { consequentialHint: true, destructiveHint: true },
  async run(ws, args) {
    if (!ws.exportWav) return fail('This workspace cannot export WAV files.');
    const ref = str(args, 'file');
    const patch = await ws.getPatch(ref);
    const v = validatePatch(patch);
    if (!v.ok) return fail(`The patch has errors, so it cannot be exported.\n${validationText(v)}`);
    const bitDepth = args.bit_depth as 16 | 24 | 32 | undefined;
    const count = typeof args.variations === 'number' ? args.variations : 1;
    const path = str(args, 'path');
    const written: { location: string; bytes: number }[] = [];
    if (count === 1) {
      written.push(await ws.exportWav(patch, { path, bitDepth }));
    } else {
      const base = path ? stripExt(path) : ref ? stripExt(ref) : slug(patch.name);
      const takes = variationTakes(patch, count);
      for (let take = 0; take < takes.length; take++) {
        written.push(await ws.exportWav(takes[take], { path: takeFileName(base, take, count), bitDepth }));
      }
    }
    return {
      text: `Wrote ${written.length} WAV file(s):\n${written.map((w) => `- ${w.location} (${w.bytes} bytes)`).join('\n')}`,
      data: { files: written },
    };
  },
};

// ---- human changes and listing ---------------------------------------------------------------------

function formatValue(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? '(absent)' : s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

const getHumanChanges: ToolDef = {
  name: 'get_human_changes',
  title: 'Get changes made by a person',
  description:
    'Lists what a person changed in the patch (in the editor or by hand in the file) since you last wrote it, as path, before and after. Call it when they say they tweaked something: their values show what they want, so keep them and build on them.',
  inputSchema: obj({ file: FILE_PROP }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(ws, args) {
    if (!ws.getHumanChanges) return { text: 'This workspace does not track changes made by a person.', data: { changes: [] } };
    const changes: ChangeRecord[] = await ws.getHumanChanges(str(args, 'file'));
    if (changes.length === 0) return { text: 'No changes by a person since you last wrote this patch.', data: { changes } };
    const lines = changes.map((c) => `- ${c.path}: ${formatValue(c.before)} -> ${formatValue(c.after)}`);
    return { text: `${changes.length} change(s) by a person:\n${lines.join('\n')}`, data: { changes } };
  },
};

const listPatches: ToolDef = {
  name: 'list_patches',
  title: 'List patches',
  description: 'Lists the patch files the workspace can see (every *.sfx.json under the project folder), or the open documents in the editor.',
  inputSchema: obj({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(ws) {
    if (!ws.list) return { text: 'This workspace cannot list patches.', data: { patches: [] } };
    const patches = await ws.list();
    return { text: patches.length ? `${patches.length} patch(es):\n${patches.map((p) => `- ${p}`).join('\n')}` : 'No patches yet. Create one with new_from_template or set_patch.', data: { patches } };
  },
};


// ---- Projects --------------------------------------------------------------------------------------

const PROJECT_HINT = 'This workspace has no projects.';

/** A column-aligned text table: header row, then rows. Columns in `right` are right-aligned (numbers). */
export function formatTable(header: string[], rows: string[][], right: number[] = []): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (right.includes(i) ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

const num1 = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(1));

export interface MeasuredSound {
  name: string;
  file?: string;
  group?: string;
  /** The sound's gain in the project, dB. */
  gain: number;
  skip: boolean;
  export: string;
  duration?: number;
  /** Peak and loudness as the project renders it, gain included. */
  peakDb?: number;
  lufs?: number;
  warnings: string[];
  /** The sound could not be rendered. */
  error?: string;
}

/**
 * Renders every sound (skipped ones are only listed) in its project's context and measures it. Gain is applied
 * analytically: it moves peak and loudness by exactly that many dB.
 */
export async function measureProject(ws: Workspace, project: Project, only?: string[]): Promise<MeasuredSound[]> {
  const rows: MeasuredSound[] = [];
  for (const sound of project.sounds) {
    const name = soundName(sound);
    const row: MeasuredSound = { name, file: sound.file, group: sound.group, gain: sound.gain ?? 0, skip: sound.skip === true, export: soundExportPath(project, sound), warnings: [] };
    rows.push(row);
    if (row.skip || (only && !only.includes(name))) continue;
    try {
      const patch = sound.patch ?? (await ws.getPatch(sound.file));
      const v = validatePatch(patch);
      if (!v.ok) throw new ToolError(`the patch has errors:\n${formatIssues({ ...v, warnings: [] })}`);
      const r = await ws.render(projectPatch(project, sound, patch));
      const a = analyze(r.channels, r.sampleRate);
      row.duration = r.duration;
      row.peakDb = a.peakDb + row.gain;
      row.lufs = a.lufs + row.gain;
      row.warnings = r.warnings;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
  }
  return rows;
}

/** Loads the workspace's project or throws a message for the agent. */
async function requireProject(ws: Workspace): Promise<{ project: Project; path?: string; saved: boolean }> {
  if (!ws.getProject) throw new ToolError(PROJECT_HINT);
  const got = await ws.getProject();
  if (!got) throw new ToolError('There is no project yet. Add sounds with edit_project (add_sound) to start one, or create patches first.');
  return { ...got, project: deepClone(got.project) };
}

function describeProject(project: Project, path: string | undefined, saved: boolean): string {
  const bits = [
    project.output ? `output ${JSON.stringify(project.output)}` : '',
    project.normalize ? `normalize ${project.normalize.mode}${project.normalize.target !== undefined ? ` ${project.normalize.target}` : ''}` : '',
    project.master?.fx?.length ? `master fx ${project.master.fx.map((f) => f.type).join(', ')}` : '',
    project.outDir ? `outDir ${project.outDir}` : '',
  ].filter(Boolean);
  const groups = (project.groups ?? []).map((g) => `${g.id}${g.normalize ? ` (${g.normalize.mode}${g.normalize.target !== undefined ? ` ${g.normalize.target}` : ''})` : ''}`);
  return `Project "${project.name}" (${saved ? path ?? PROJECT_FILE : `not saved yet: it will be written to ${path ?? PROJECT_FILE} on the first edit`}): ${project.sounds.length} sound(s)${groups.length ? `; groups: ${groups.join(', ')}` : ''}${bits.length ? `\nShared settings: ${bits.join('; ')}` : ''}`;
}

const getProjectTool: ToolDef = {
  name: 'get_project',
  title: 'Get the project',
  description:
    'Returns the project: the set of sounds made to be heard together, with its shared output and levelling, groups and each sound\'s group, gain and export path. Pass `measure: true` to render every sound in the project\'s context and add its loudness (LUFS) and peak, which is how you find a sound that is too loud or quiet for the set.',
  inputSchema: obj({ measure: { type: 'boolean', description: 'Also render each sound and report duration, peak (dBFS) and loudness (LUFS). Default false.' } }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(ws, args) {
    const { project, path, saved } = await requireProject(ws);
    const measured = args.measure === true ? await measureProject(ws, project) : undefined;
    const header = ['name', 'group', 'gain', 'export', ...(measured ? ['dur s', 'peak', 'LUFS'] : []), 'note'];
    const rows = project.sounds.map((s, i) => {
      const m = measured?.[i];
      return [
        soundName(s) + (s.skip ? ' (skip)' : ''),
        s.group ?? '',
        num1(s.gain ?? 0),
        soundExportPath(project, s),
        ...(measured ? [m?.duration !== undefined ? m.duration.toFixed(2) : '-', num1(m?.peakDb), m?.error ? 'error' : num1(m?.lufs)] : []),
        s.note ?? '',
      ];
    });
    const lines = [describeProject(project, path, saved), '', ...formatTable(header, rows, measured ? [2, 4, 5, 6] : [2])];
    for (const m of measured ?? []) if (m.error) lines.push(`${m.name}: ${m.error}`);
    const data = {
      path,
      saved,
      project,
      sounds: project.sounds.map((s, i) => ({ name: soundName(s), file: s.file, group: s.group, gain: s.gain ?? 0, export: soundExportPath(project, s), skip: s.skip === true, ...(measured?.[i] ? { duration: measured[i].duration, peakDb: measured[i].peakDb, lufs: measured[i].lufs, error: measured[i].error } : {}) })),
    };
    return { text: lines.join('\n'), data };
  },
};

/** `sounds.<name>.gain` -> `sounds.<index>.gain`: sounds have no id, so tools address them by name. */
function resolveProjectPath(project: Project, path: string): string {
  const segs = splitPath(path);
  if (segs[0] === 'sounds' && segs[1] !== undefined && !/^\d+$/.test(segs[1])) {
    const i = project.sounds.findIndex((s) => soundName(s) === segs[1]);
    if (i < 0) {
      throw new ToolError(`No sound "${segs[1]}" in the project${suggest(segs[1], project.sounds.map(soundName))}. Sounds: ${project.sounds.map(soundName).join(', ') || 'none'}.`);
    }
    segs[1] = String(i);
  }
  return segs.join('.');
}

const addSoundSchema: JsonSchema = {
  type: 'object',
  description: 'A sound to add: `file` (a patch path relative to the project, such as "hits/punch.sfx.json") or an inline `patch`, plus optional group, gain (dB), export (a .wav path), note and skip.',
  properties: {
    file: { type: 'string', description: 'Patch file, relative to the project folder.' },
    patch: { type: 'object', description: 'An inline patch instead of a file.' },
    group: { type: 'string', description: 'A group id from the project\'s groups.' },
    gain: { type: 'number', description: 'dB added after levelling: the sound\'s place in the set.' },
    export: { type: 'string', description: 'WAV path for builds, relative to the project file. Default: <outDir>/<name>.wav.' },
    note: { type: 'string', description: 'What the sound is for in the game.' },
    skip: { type: 'boolean', description: 'Leave it out of builds.' },
  },
  additionalProperties: false,
};

const editProject: ToolDef = {
  name: 'edit_project',
  title: 'Edit the project',
  description:
    'Changes the project file by dot path: `set` writes values ({"normalize": {"mode":"peak","target":-3}, "sounds.punch.gain": -2, "groups.ui.normalize": {...}}; sounds are addressed by name), `unset` removes paths, `add_sound` appends a sound and `remove_sound` removes one by name. Order: remove_sound, add_sound, set, unset; it is validated first and nothing is saved if it has errors. Patch files are never touched: use edit_patch for the sounds themselves.',
  inputSchema: obj({
    set: { type: 'object', description: 'Path to new value. Paths: name, output.sampleRate, normalize, master.fx, outDir, groups.<id>.normalize, sounds.<name>.gain|group|export|note|skip.', additionalProperties: true },
    unset: { type: 'array', items: { type: 'string' }, description: 'Paths to remove.' },
    add_sound: addSoundSchema,
    remove_sound: { type: 'string', description: 'Name of the sound to remove (its file name without .sfx.json). The patch file stays on disk.' },
  }),
  annotations: { destructiveHint: true },
  async run(ws, args) {
    if (!ws.setProject) return fail(PROJECT_HINT);
    const { project, saved } = await requireProjectOrNew(ws);
    const set = (args.set ?? {}) as Record<string, unknown>;
    const unset = (args.unset ?? []) as string[];
    if (Object.keys(set).length === 0 && unset.length === 0 && args.add_sound === undefined && args.remove_sound === undefined) {
      return fail('Nothing to do: give set, unset, add_sound or remove_sound.');
    }
    const done: string[] = [];
    if (typeof args.remove_sound === 'string') {
      const i = project.sounds.findIndex((s) => soundName(s) === args.remove_sound);
      if (i < 0) return fail(`No sound "${args.remove_sound}"${suggest(args.remove_sound, project.sounds.map(soundName))}. Sounds: ${project.sounds.map(soundName).join(', ')}.`);
      project.sounds.splice(i, 1);
      done.push(`removed sound ${args.remove_sound}`);
    }
    if (args.add_sound !== undefined) {
      const sound = args.add_sound as ProjectSound;
      if (!sound.file && !sound.patch) return fail('add_sound needs a `file` or an inline `patch`.');
      if (sound.file && ws.list) {
        const known = await ws.list();
        if (!known.includes(sound.file)) return fail(`No patch file "${sound.file}"${suggest(sound.file, known)}. Patches: ${known.slice(0, 20).join(', ') || 'none'}. Create it first (new_from_template, set_patch).`);
      }
      project.sounds.push(sound);
      done.push(`added sound ${soundName(sound)}`);
    }
    try {
      for (const [path, value] of Object.entries(set)) {
        if (!setPath(project, resolveProjectPath(project, path), deepClone(value))) return fail(`Cannot set "${path}": it runs through something that doesn't exist. Nothing was changed.`);
        done.push(`set ${path}`);
      }
      for (const path of unset) {
        if (!unsetPath(project, resolveProjectPath(project, path))) return fail(`Cannot unset "${path}": nothing is there. Nothing was changed.`);
        done.push(`unset ${path}`);
      }
    } catch (e) {
      if (e instanceof ToolError) return fail(`${e.message} Nothing was changed.`);
      throw e;
    }
    const v = validateProject(project);
    if (!v.ok) return fail(`Not saved: the edit leaves the project with errors.\n${formatIssues(v)}`);
    await ws.setProject(project, { origin: 'agent' });
    const warn = v.warnings.length ? `\nWarnings:\n${formatIssues({ ...v, errors: [] })}` : '';
    return { text: `${saved ? 'Saved' : 'Created the project file'}. ${done.join('; ')}.${warn}`, data: { applied: done, project } };
  },
};

/** The workspace's project, or a new empty one for a first edit. */
async function requireProjectOrNew(ws: Workspace): Promise<{ project: Project; saved: boolean }> {
  const got = ws.getProject ? await ws.getProject() : null;
  if (got) return { project: deepClone(got.project), saved: got.saved };
  return { project: newProject('Project'), saved: false };
}

function buildRowsText(rows: ProjectBuildRow[]): string[] {
  return formatTable(
    ['name', 'dur s', 'peak', 'LUFS', 'export', 'warnings'],
    rows.map((r) => [r.name, r.error ? '-' : r.duration.toFixed(2), r.error ? '-' : num1(r.peakDb), r.error ? '-' : num1(r.lufs), r.export, r.error ? `ERROR ${r.error.split('\n')[0]}` : r.warnings.join('; ')]),
    [1, 2, 3],
  );
}

const buildProjectTool: ToolDef = {
  name: 'build_project',
  title: 'Build the project',
  description:
    'Renders every sound of the project (or only the named ones) in the project\'s context, with its output, levelling and shared master chain, and writes each WAV to its export path. Use it when the set is ready to go into the game; it overwrites the previous build and reports each sound\'s duration, peak and loudness so you can check the set is level.',
  inputSchema: obj({ only: { type: 'array', items: { type: 'string' }, description: 'Build only these sounds, by name. Default: all that are not skipped.' } }),
  annotations: { consequentialHint: true, destructiveHint: true },
  async run(ws, args) {
    if (!ws.buildProject) return fail('This workspace cannot build projects.');
    const only = args.only as string[] | undefined;
    if (only && ws.getProject) {
      const got = await ws.getProject();
      const names = (got?.project.sounds ?? []).map(soundName);
      const missing = only.filter((n) => !names.includes(n));
      if (missing.length) return fail(`No sound named ${missing.map((m) => `"${m}"${suggest(m, names)}`).join(', ')}. Sounds: ${names.join(', ')}.`);
    }
    const rows = await ws.buildProject({ only });
    const failed = rows.filter((r) => r.error).length;
    const text = [`Built ${rows.length - failed} of ${rows.length} sound(s):`, ...buildRowsText(rows)].join('\n');
    return { text: failed ? `${text}\n${failed} failed; see the ERROR rows.` : text, data: { rows }, isError: failed > 0 ? true : undefined };
  },
};

const balanceProject: ToolDef = {
  name: 'balance_project',
  title: 'Balance the project levels',
  description:
    'Measures every sound as the project renders it and works out the gains that bring each to a target loudness (LUFS), never letting a peak pass the ceiling. By default it only reports the suggestion; with `apply: true` it writes the new gains into the project. Use `group` or `group_targets` when families should sit at different levels (interface quieter than impacts); typical game targets are -24 to -16 LUFS.',
  inputSchema: obj(
    {
      target_lufs: { type: 'number', minimum: -60, maximum: 0, description: 'Integrated loudness to match, LUFS. Used for every sound without a group target.' },
      group: { type: 'string', description: 'Only balance the sounds of this group.' },
      group_targets: { type: 'object', additionalProperties: { type: 'number' }, description: 'Target LUFS by group id, overriding target_lufs for that group: {"ui": -26, "hits": -16}.' },
      ceiling_db: { type: 'number', minimum: -20, maximum: 0, description: 'Highest peak allowed after the new gain, dBFS. Default -1.' },
      apply: { type: 'boolean', description: 'Write the gains into the project. Default false (suggest only).' },
    },
    ['target_lufs'],
  ),
  annotations: { destructiveHint: true },
  async run(ws, args) {
    const { project } = await requireProject(ws);
    if (args.apply === true && !ws.setProject) return fail(PROJECT_HINT);
    const groupFilter = str(args, 'group');
    if (groupFilter && !(project.groups ?? []).some((g) => g.id === groupFilter)) {
      return fail(`No group "${groupFilter}"${suggest(groupFilter, (project.groups ?? []).map((g) => g.id))}. Groups: ${(project.groups ?? []).map((g) => g.id).join(', ') || 'none'}.`);
    }
    const targets = (args.group_targets ?? {}) as Record<string, number>;
    const ceiling = typeof args.ceiling_db === 'number' ? args.ceiling_db : -1;
    const measured = (await measureProject(ws, project)).filter((m) => !m.skip && (!groupFilter || m.group === groupFilter));
    const levels: SoundLevel[] = [];
    const bad: MeasuredSound[] = [];
    for (const m of measured) {
      if (m.error || m.lufs === undefined || !Number.isFinite(m.lufs) || m.peakDb === undefined) bad.push(m);
      else levels.push({ name: m.name, lufs: m.lufs, peakDb: m.peakDb, gain: m.gain });
    }
    const byTarget = new Map<number, SoundLevel[]>();
    for (const l of levels) {
      const g = measured.find((m) => m.name === l.name)?.group;
      const t = (g !== undefined ? targets[g] : undefined) ?? (args.target_lufs as number);
      byTarget.set(t, [...(byTarget.get(t) ?? []), l]);
    }
    const gains: Record<string, number> = {};
    for (const [t, ls] of byTarget) Object.assign(gains, matchLoudness(ls, t, ceiling));
    const rows = levels.map((l) => {
      const m = measured.find((x) => x.name === l.name) as MeasuredSound;
      const g = gains[l.name];
      const target = (m.group !== undefined ? targets[m.group] : undefined) ?? (args.target_lufs as number);
      const limited = g < target - (l.lufs - l.gain) - 0.05;
      return [l.name, m.group ?? '', num1(l.lufs), num1(l.gain), num1(g), num1(l.lufs - l.gain + g), num1(l.peakDb - l.gain + g), limited ? 'ceiling' : ''];
    });
    const lines = [
      `${args.apply === true ? 'Applied' : 'Suggested'} gains for ${levels.length} sound(s) (peak ceiling ${ceiling} dBFS):`,
      ...formatTable(['name', 'group', 'LUFS now', 'gain now', 'gain new', 'LUFS new', 'peak new', 'held by'], rows, [2, 3, 4, 5, 6]),
    ];
    for (const m of bad) lines.push(`${m.name}: left alone (${m.error ? m.error.split('\n')[0] : 'silent'})`);
    const changed = levels.filter((l) => Math.abs(gains[l.name] - l.gain) >= 0.05);
    if (args.apply === true) {
      if (changed.length === 0) lines.push('Nothing to change: the gains already match.');
      else {
        for (const s of project.sounds) {
          const g = gains[soundName(s)];
          if (g !== undefined) {
            if (g === 0) delete s.gain;
            else s.gain = g;
          }
        }
        await (ws.setProject as NonNullable<Workspace['setProject']>)(project, { origin: 'agent' });
        lines.push(`Wrote ${changed.length} new gain(s) to the project. Run build_project to write the WAVs.`);
      }
    } else if (changed.length) lines.push('Call again with apply: true to write these gains.');
    return { text: lines.join('\n'), data: { gains, applied: args.apply === true && changed.length > 0, levels } };
  },
};

// ---- The list ----------------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  describeFormat,
  listTemplatesTool,
  newFromTemplate,
  getPatchTool,
  setPatchTool,
  editPatch,
  setControls,
  syncControls,
  renderAndAnalyze,
  play,
  exportWav,
  getHumanChanges,
  listPatches,
  getProjectTool,
  editProject,
  buildProjectTool,
  balanceProject,
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Runs a tool the way every host should: arguments checked against the schema, an unknown tool or a failure
 * returned as an `isError` result rather than thrown.
 */
export async function callTool(ws: Workspace, name: string, args: unknown, tools: ToolDef[] = TOOLS): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail(`Unknown tool "${name}"${suggest(name, tools.map((t) => t.name))}.`);
  try {
    const checked = checkArgs(tool.inputSchema, args ?? {}) as Record<string, unknown>;
    return await tool.run(ws, checked);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
