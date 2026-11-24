/**
 * Project edits. In the editor a project is always "hydrated": every sound carries its patch in memory, whether it
 * lives in a file (serve mode) or inline (browser). `stripProject` gives the form that goes into a project file.
 * Every function returns a new project and keeps the patches it did not touch by reference, so the editor can tell
 * which sounds changed.
 */
import {
  PROJECT_FORMAT_ID,
  groupOf,
  matchLoudness,
  projectPatch,
  soundExportPath,
  soundName,
  type Normalize,
  type Patch,
  type Project,
  type ProjectGroup,
  type ProjectSound,
  type SoundLevel,
} from '../../core';
import { INKS } from './inks';
import { uniqueId } from './patchOps';

export const EMPTY_PATCH: Patch = { format: 'sfxgen/1', name: 'Untitled', duration: 'auto', tracks: [{ id: 'tone', source: { type: 'osc' } }] };

/** A sound's identity in the editor: its file, or its (unique) name. */
export function soundKey(sound: ProjectSound): string {
  return sound.file ?? soundName(sound);
}

export function patchOf(sound: ProjectSound | undefined): Patch {
  return sound?.patch ?? EMPTY_PATCH;
}

/** A lone patch is a project of one. */
export function projectOfOne(patch: Patch, name = patch.name): Project {
  return { format: PROJECT_FORMAT_ID, name, sounds: [{ patch }] };
}

/** The project as it is written to `sfxgen.project.json`: sounds in files lose their in-memory patch. */
export function stripProject(project: Project): Project {
  return { ...project, sounds: project.sounds.map((s) => (s.file ? (({ patch: _patch, ...rest }) => rest)(s) : s)) };
}

/** One self-contained file: every patch inline, no file references. */
export function bundleProject(project: Project): Project {
  return { ...project, sounds: project.sounds.map(({ file: _file, ...rest }) => rest) };
}

/** Everything about the project except the patches' contents, as a string: changes when the project file would. */
export function shellKey(project: Project): string {
  return JSON.stringify({ ...project, sounds: project.sounds.map((s) => (s.file ? { ...s, patch: undefined } : s)) });
}

function withSounds(project: Project, sounds: ProjectSound[]): Project {
  return { ...project, sounds };
}

export function setSoundPatch(project: Project, index: number, patch: Patch): Project {
  if (!project.sounds[index] || project.sounds[index].patch === patch) return project;
  return withSounds(project, project.sounds.map((s, i) => (i === index ? { ...s, patch } : s)));
}

export function updateSound(project: Project, index: number, change: Partial<ProjectSound>): Project {
  if (!project.sounds[index]) return project;
  return withSounds(
    project,
    project.sounds.map((s, i) => {
      if (i !== index) return s;
      const next: ProjectSound = { ...s, ...change };
      for (const k of Object.keys(change) as (keyof ProjectSound)[]) if (change[k] === undefined) delete next[k];
      if (next.gain === 0) delete next.gain;
      return next;
    }),
  );
}

/** A name no other sound in the project has: "Laser zap", "Laser zap 2", ... */
export function uniquePatchName(project: Project, name: string, except = -1): string {
  const taken = new Set(project.sounds.filter((_, i) => i !== except).map((s) => soundName(s).toLowerCase()));
  const free = (n: string) => !taken.has(soundName({ patch: { ...EMPTY_PATCH, name: n } }).toLowerCase());
  if (free(name)) return name;
  const base = name.replace(/\s+\d+$/, '');
  for (let i = 2; ; i++) if (free(`${base} ${i}`)) return `${base} ${i}`;
}

/** Adds an inline sound (renamed if its name is taken). Returns the project and the new sound's index. */
export function addSound(project: Project, patch: Patch, extra: Partial<ProjectSound> = {}): { project: Project; index: number } {
  const name = extra.file ? patch.name : uniquePatchName(project, patch.name || 'Sound');
  const sound: ProjectSound = { ...extra, patch: name === patch.name ? patch : { ...patch, name } };
  return { project: withSounds(project, [...project.sounds, sound]), index: project.sounds.length };
}

export function removeSound(project: Project, index: number): Project {
  if (project.sounds.length <= 1) return project;
  return withSounds(project, project.sounds.filter((_, i) => i !== index));
}

export function moveSound(project: Project, index: number, by: number): Project {
  const to = index + by;
  if (to < 0 || to >= project.sounds.length) return project;
  const sounds = [...project.sounds];
  [sounds[index], sounds[to]] = [sounds[to], sounds[index]];
  return withSounds(project, sounds);
}

// ---- Groups -----------------------------------------------------------------------------------

export function groupInk(project: Project, groupId: string | undefined): string | undefined {
  if (!groupId) return undefined;
  const i = (project.groups ?? []).findIndex((g) => g.id === groupId);
  if (i < 0) return undefined;
  return project.groups![i].color || INKS[i % INKS.length].hex;
}

export function addGroup(project: Project, label = 'Group'): { project: Project; id: string } {
  const groups = project.groups ?? [];
  const id = uniqueId(label, groups.map((g) => g.id));
  return { project: { ...project, groups: [...groups, { id, label, color: INKS[groups.length % INKS.length].hex }] }, id };
}

export function updateGroup(project: Project, id: string, change: Partial<ProjectGroup>): Project {
  return {
    ...project,
    groups: (project.groups ?? []).map((g) => {
      if (g.id !== id) return g;
      const next = { ...g, ...change };
      for (const k of Object.keys(change) as (keyof ProjectGroup)[]) if (change[k] === undefined) delete next[k];
      return next;
    }),
  };
}

export function removeGroup(project: Project, id: string): Project {
  const groups = (project.groups ?? []).filter((g) => g.id !== id);
  const next: Project = { ...project, sounds: project.sounds.map((s) => (s.group === id ? (({ group: _group, ...rest }) => rest)(s) : s)) };
  if (groups.length > 0) next.groups = groups;
  else delete next.groups;
  return next;
}

/** The levelling a sound gets: its group's, else the project's, else (null) its own patch's. */
export function levellingOf(project: Project, sound: ProjectSound): Normalize | null {
  return groupOf(project, sound)?.normalize ?? project.normalize ?? null;
}

// ---- Levels -----------------------------------------------------------------------------------

/** What the editor measured for a sound, before the sound's project gain. */
export interface Measured {
  /** Identifies the render it came from (the patch in project context). */
  hash: string;
  lufs: number;
  peakDb: number;
  duration: number;
  /** A small waveform for the pad. */
  peaks: Float32Array;
  warnings: string[];
}

/** The string that changes exactly when a sound has to be rendered again (its gain is applied afterwards). */
export function renderHash(project: Project, sound: ProjectSound): string {
  return JSON.stringify(projectPatch(project, sound, patchOf(sound)));
}

export function levelOf(sound: ProjectSound, m: Measured | undefined): SoundLevel | null {
  if (!m) return null;
  const gain = sound.gain ?? 0;
  return { name: soundKey(sound), lufs: m.lufs + gain, peakDb: m.peakDb + gain, gain };
}

/**
 * New gains that bring the sounds of one group (`null`: the ungrouped ones, `'*'`: every sound) to the target
 * loudness without passing the ceiling. Sounds that have not been measured keep their gain.
 */
export function matchGroup(project: Project, measured: Record<string, Measured>, group: string | null, targetLufs: number, ceilingDb: number): Project {
  const inGroup = (s: ProjectSound) => group === '*' || (s.group ?? null) === group;
  const levels = project.sounds.filter(inGroup).map((s) => levelOf(s, measured[soundKey(s)])).filter((l): l is SoundLevel => l !== null);
  const gains = matchLoudness(levels, targetLufs, ceilingDb);
  return withSounds(
    project,
    project.sounds.map((s) => {
      const g = gains[soundKey(s)];
      if (!inGroup(s) || g === undefined || g === (s.gain ?? 0)) return s;
      const next: ProjectSound = { ...s, gain: g };
      if (g === 0) delete next.gain;
      return next;
    }),
  );
}

/** The loudness to suggest as a target: the median of what the group measures now, rounded. */
export function suggestTarget(levels: SoundLevel[]): number {
  const v = levels.map((l) => l.lufs).filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return -18;
  return Math.round(v[Math.floor(v.length / 2)]);
}

/** Where each sound's WAV goes in a zip of the whole project (paths that climb out of the folder are flattened). */
export function zipPath(project: Project, sound: ProjectSound): string {
  const path = soundExportPath(project, sound);
  return path.includes('..') ? `${(project.outDir ?? 'out').replace(/\/+$/, '').replace(/^.*\.\.\/?/, '') || 'out'}/${path.replace(/^.*\//, '')}` : path;
}

export function dbText(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}
