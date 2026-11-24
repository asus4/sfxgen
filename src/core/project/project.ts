/**
 * Projects: a set of sounds made to be heard together, such as one game's sound effects.
 *
 * A project file (`sfxgen.project.json`) lists its sounds (patch files next to it, or patches inline), and gives the
 * set what has to be the same across it: the output format, how each sound is normalised (per group), and a shared
 * master chain (the set's common character: a speaker, a medium, a glue compressor). Each sound keeps its own
 * patch and design; the project adds its level in the set (`gain`) and where it is exported.
 *
 * Rendering a sound in its project = rendering `projectPatch(project, sound, patch)`, then adding the sound's gain.
 */
import type { EffectSpec, Normalize, OutputSettings, Patch } from '../format/types';
import { deepClone } from '../format/paths';
import { validatePatch, suggest, type Issue, type ValidationResult } from '../format/validate';
import { render, type RenderOptions, type RenderResult } from '../render';
import { dbToGain } from '../dsp/math';

export const PROJECT_FORMAT_ID = 'sfxgen-project/1' as const;
/** The file name `sfxgen serve` and `sfxgen build` look for. */
export const PROJECT_FILE = 'sfxgen.project.json';

export interface ProjectGroup {
  /** Letters, digits, `_` and `-`. */
  id: string;
  label?: string;
  /** Ink for the editor, a CSS colour. */
  color?: string;
  /** How the group's sounds are levelled; overrides the project's `normalize`. */
  normalize?: Normalize;
}

export interface ProjectSound {
  /** Patch file, relative to the project file. */
  file?: string;
  /** Or the patch itself, for projects kept in the browser or shared as one file. */
  patch?: Patch;
  /** dB added after normalisation: the sound's level in the set. Default 0. */
  gain?: number;
  group?: string;
  /** WAV path for `sfxgen build`, relative to the project file. Default `<outDir>/<name>.wav`. */
  export?: string;
  /** Leave it out of builds (it still opens in the editor). */
  skip?: boolean;
  /** Why the sound exists or what it's for in the game, for people and agents. */
  note?: string;
}

export interface Project {
  format: typeof PROJECT_FORMAT_ID;
  name: string;
  description?: string;
  /** Every sound renders with these, whatever its patch says. */
  output?: OutputSettings;
  /** Default levelling for every sound (a group's `normalize` overrides it). Default: each patch's own. */
  normalize?: Normalize;
  /** Effects after each sound's own master chain: the set's shared character. `gain` in dB. */
  master?: { fx?: EffectSpec[]; gain?: number };
  /** Where builds go, relative to the project file. Default `out`. */
  outDir?: string;
  groups?: ProjectGroup[];
  sounds: ProjectSound[];
  meta?: Record<string, unknown>;
}

/** The sound's name: its file name without `.sfx.json`, or the inline patch's name made file-safe. */
export function soundName(sound: ProjectSound): string {
  if (sound.file) return sound.file.replace(/^.*\//, '').replace(/\.sfx\.json$/i, '').replace(/\.json$/i, '');
  const name = sound.patch?.name ?? 'sound';
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'sound';
}

/** Where a build writes the sound, relative to the project file. */
export function soundExportPath(project: Project, sound: ProjectSound): string {
  if (sound.export) return sound.export;
  const dir = (project.outDir ?? 'out').replace(/\/+$/, '');
  return `${dir}/${soundName(sound)}.wav`;
}

export function groupOf(project: Project, sound: ProjectSound): ProjectGroup | undefined {
  return sound.group ? project.groups?.find((g) => g.id === sound.group) : undefined;
}

/**
 * The patch as the project renders it: the project's output settings, its normalisation (the group's, else the
 * project's, else the patch's own) and its master chain appended after the patch's. The original is untouched.
 */
export function projectPatch(project: Project, sound: ProjectSound, patch: Patch): Patch {
  const p = deepClone(patch);
  if (project.output) p.output = { ...(p.output ?? {}), ...project.output };
  const normalize = groupOf(project, sound)?.normalize ?? project.normalize;
  const extraFx = project.master?.fx ?? [];
  if (normalize || extraFx.length || project.master?.gain) {
    p.master = { ...(p.master ?? {}) };
    if (normalize) p.master.normalize = deepClone(normalize);
    if (extraFx.length) p.master.fx = [...(p.master.fx ?? []), ...deepClone(extraFx)];
    if (project.master?.gain) p.master.gain = (p.master.gain ?? 0) + project.master.gain;
  }
  return p;
}

/** Renders one sound as the project hears it: in project context, then at its level in the set. */
export function renderProjectSound(project: Project, sound: ProjectSound, patch: Patch, opts: RenderOptions = {}): RenderResult {
  const r = render(projectPatch(project, sound, patch), opts);
  const gainDb = sound.gain ?? 0;
  if (gainDb !== 0) {
    const g = dbToGain(gainDb);
    let peak = 0;
    for (const ch of r.channels) {
      for (let i = 0; i < ch.length; i++) {
        ch[i] *= g;
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > 1) r.warnings.push(`its project gain of ${gainDb} dB makes it peak at ${(20 * Math.log10(peak)).toFixed(1)} dBFS: it will clip`);
    r.normalizeGainDb += gainDb;
  }
  return r;
}

export interface SoundLevel {
  name: string;
  /** Integrated loudness after normalisation and gain, LUFS. */
  lufs: number;
  /** Peak after normalisation and gain, dBFS. */
  peakDb: number;
  gain: number;
}

/**
 * Gains that bring every sound to `targetLufs` (each sound's loudness as rendered, minus its current gain, is its
 * starting point), held back so no peak goes above `ceilingDb`. Returns the new gain per sound name.
 */
export function matchLoudness(levels: SoundLevel[], targetLufs: number, ceilingDb = -1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of levels) {
    if (!Number.isFinite(l.lufs)) {
      out[l.name] = l.gain;
      continue;
    }
    const baseLufs = l.lufs - l.gain;
    const basePeak = l.peakDb - l.gain;
    let gain = targetLufs - baseLufs;
    if (basePeak + gain > ceilingDb) gain = ceilingDb - basePeak;
    out[l.name] = Math.round(gain * 10) / 10;
  }
  return out;
}

/** An empty project, or one listing the given patch files. */
export function newProject(name: string, files: string[] = []): Project {
  return { format: PROJECT_FORMAT_ID, name, sounds: files.map((file) => ({ file })) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks a project file; inline patches are validated too (their issues are prefixed with the sound). */
export function validateProject(input: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'a project is a JSON object' }], warnings };
  if (input.format !== PROJECT_FORMAT_ID) errors.push({ path: 'format', message: `this version reads "${PROJECT_FORMAT_ID}", not ${JSON.stringify(input.format)}` });
  if (typeof input.name !== 'string' || !input.name) warnings.push({ path: 'name', message: 'give the project a name' });
  const known = ['format', 'name', 'description', 'output', 'normalize', 'master', 'outDir', 'groups', 'sounds', 'meta'];
  for (const k of Object.keys(input)) if (!known.includes(k)) warnings.push({ path: k, message: `unknown project field, ignored${suggest(k, known)}` });
  // Output, normalisation and the shared chain are checked by the patch validator on a stand-in patch.
  const standIn = { format: 'sfxgen/1', name: 'project', duration: 1, tracks: [], output: input.output, master: { fx: (input.master as { fx?: unknown } | undefined)?.fx, normalize: input.normalize } };
  const shared = validatePatch(standIn);
  for (const e of shared.errors) errors.push({ path: e.path.replace(/^master\.normalize/, 'normalize'), message: e.message });
  for (const w of shared.warnings) if (w.path !== 'tracks') warnings.push(w);
  if (input.master !== undefined && !isObj(input.master)) errors.push({ path: 'master', message: 'expected { fx, gain }' });
  else if (input.master && (input.master as Record<string, unknown>).gain !== undefined && !isNum((input.master as Record<string, unknown>).gain)) {
    errors.push({ path: 'master.gain', message: 'expected dB' });
  }
  const groupIds = new Set<string>();
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) errors.push({ path: 'groups', message: 'expected a list' });
    else
      input.groups.forEach((g, i) => {
        if (!isObj(g) || typeof g.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(g.id)) return errors.push({ path: `groups[${i}].id`, message: 'letters, digits, _ and - only' });
        if (groupIds.has(g.id)) errors.push({ path: `groups[${i}].id`, message: `group "${g.id}" is listed twice` });
        groupIds.add(g.id);
        if (g.normalize !== undefined) {
          const n = g.normalize as Record<string, unknown>;
          if (!isObj(n) || !['peak', 'loudness', 'none'].includes(n.mode as string)) errors.push({ path: `groups[${i}].normalize.mode`, message: 'peak, loudness or none' });
        }
      });
  }
  if (!Array.isArray(input.sounds)) errors.push({ path: 'sounds', message: 'expected a list of { file } or { patch }' });
  else {
    const names = new Set<string>();
    input.sounds.forEach((s, i) => {
      const p = `sounds[${i}]`;
      if (!isObj(s)) return errors.push({ path: p, message: 'expected { file } or { patch }' });
      if (typeof s.file !== 'string' && !isObj(s.patch)) errors.push({ path: p, message: 'needs a `file` (path to a .sfx.json) or an inline `patch`' });
      if (typeof s.file === 'string' && !/\.sfx\.json$/i.test(s.file)) warnings.push({ path: `${p}.file`, message: 'patch files end in .sfx.json' });
      if (s.gain !== undefined && !isNum(s.gain)) errors.push({ path: `${p}.gain`, message: 'expected dB' });
      if (s.group !== undefined && !groupIds.has(String(s.group))) errors.push({ path: `${p}.group`, message: `no group "${String(s.group)}"${suggest(String(s.group), groupIds)}` });
      if (s.export !== undefined && (typeof s.export !== 'string' || !s.export.toLowerCase().endsWith('.wav'))) errors.push({ path: `${p}.export`, message: 'a .wav path' });
      const name = soundName(s as ProjectSound);
      if (names.has(name)) errors.push({ path: p, message: `two sounds are named "${name}"; their exports would collide` });
      names.add(name);
      if (isObj(s.patch)) {
        const v = validatePatch(s.patch);
        for (const e of v.errors) errors.push({ path: `${p}.patch.${e.path}`, message: e.message });
        for (const w of v.warnings) warnings.push({ path: `${p}.patch.${w.path}`, message: w.message });
      }
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}
