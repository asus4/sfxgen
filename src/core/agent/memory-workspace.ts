/**
 * An in-memory Workspace: patches live in a Map. For tests and simple hosts (a script that wants the tools without
 * files). Rendering is the core's, run on the calling thread.
 */
import type { Patch } from '../format/types';
import { deepClone } from '../format/paths';
import { render } from '../render';
import { encodeWav } from '../wav';
import { analyze } from '../analysis';
import { PROJECT_FILE, newProject, renderProjectSound, soundExportPath, soundName, validateProject, type Project } from '../project/project';
import { validatePatch, formatIssues } from '../format/validate';
import type { ChangeRecord, ProjectBuildRow, Workspace } from './workspace';
import { diffValues } from './diff';

export interface MemoryWorkspaceOptions {
  /** Starting patches by ref. */
  patches?: Record<string, Patch>;
  /** A saved project to start with. Without one, getProject describes the patches as an unsaved project. */
  project?: Project;
  /** Ref used when a tool names none. Default: the first patch, or the last one written. */
  current?: string;
}

export class MemoryWorkspace implements Workspace {
  readonly kind = 'files' as const;
  /** The current content of each patch. */
  readonly patches = new Map<string, Patch>();
  /** What the agent last wrote, to find a person's changes. */
  private readonly agentCopy = new Map<string, Patch>();
  /** Files "exported" by exportWav, by location. */
  readonly exports = new Map<string, Uint8Array>();
  /** Calls to play(), for tests. */
  readonly played: string[] = [];
  project: Project | null = null;
  private current: string | undefined;

  constructor(opts: MemoryWorkspaceOptions = {}) {
    if (opts.project) this.project = deepClone(opts.project);
    for (const [ref, p] of Object.entries(opts.patches ?? {})) {
      this.patches.set(ref, deepClone(p));
      this.agentCopy.set(ref, deepClone(p));
    }
    this.current = opts.current ?? Object.keys(opts.patches ?? {})[0];
  }

  private resolve(ref?: string): string {
    const r = ref ?? this.current;
    if (!r) throw new Error('No patch is open: name one with `file`, or create one first (new_from_template, set_patch).');
    return r;
  }

  async getPatch(ref?: string): Promise<Patch> {
    const r = this.resolve(ref);
    const p = this.patches.get(r);
    if (!p) throw new Error(`No patch "${r}". Known: ${[...this.patches.keys()].join(', ') || 'none'}.`);
    this.current = r;
    return deepClone(p);
  }

  async setPatch(patch: Patch, opts: { ref?: string; origin?: 'agent' | 'human' } = {}): Promise<void> {
    const r = this.resolve(opts.ref);
    this.patches.set(r, deepClone(patch));
    if ((opts.origin ?? 'agent') === 'agent') this.agentCopy.set(r, deepClone(patch));
    this.current = r;
  }

  async render(patch: Patch) {
    return render(patch);
  }

  async play(ref?: string) {
    this.played.push(this.resolve(ref));
    return { played: true, note: 'in memory' };
  }

  async exportWav(patch: Patch, opts: { path?: string; bitDepth?: 16 | 24 | 32 } = {}) {
    const result = render(patch);
    const bytes = encodeWav(result.channels, result.sampleRate, opts.bitDepth ?? patch.output?.bitDepth ?? 16);
    const location = opts.path ?? `${this.resolve()}.wav`;
    this.exports.set(location, bytes);
    return { location, bytes: bytes.length };
  }

  async getHumanChanges(ref?: string): Promise<ChangeRecord[]> {
    const r = this.resolve(ref);
    const mine = this.agentCopy.get(r);
    const now = this.patches.get(r);
    if (!mine || !now) return [];
    return diffValues(mine, now);
  }

  async list(): Promise<string[]> {
    return [...this.patches.keys()].sort();
  }

  async getProject() {
    if (this.project) return { project: deepClone(this.project), path: PROJECT_FILE, saved: true };
    if (this.patches.size === 0) return null;
    return { project: newProject('Project', [...this.patches.keys()].sort()), path: PROJECT_FILE, saved: false };
  }

  async setProject(project: Project): Promise<void> {
    const v = validateProject(project);
    if (!v.ok) throw new Error(`The project has errors:\n${formatIssues(v)}`);
    this.project = deepClone(project);
  }

  async buildProject(opts: { only?: string[] } = {}): Promise<ProjectBuildRow[]> {
    const got = await this.getProject();
    if (!got) return [];
    const { project } = got;
    const rows: ProjectBuildRow[] = [];
    for (const sound of project.sounds) {
      const name = soundName(sound);
      if (sound.skip || (opts.only && !opts.only.includes(name))) continue;
      const row: ProjectBuildRow = { name, file: sound.file, export: soundExportPath(project, sound), duration: 0, peakDb: 0, lufs: 0, warnings: [] };
      rows.push(row);
      try {
        const patch = sound.patch ?? this.patches.get(sound.file ?? '');
        if (!patch) throw new Error(`No patch "${sound.file}".`);
        const v = validatePatch(patch);
        if (!v.ok) throw new Error(`The patch has errors:\n${formatIssues(v)}`);
        const r = renderProjectSound(project, sound, patch);
        const a = analyze(r.channels, r.sampleRate);
        const bits = project.output?.bitDepth ?? patch.output?.bitDepth ?? 16;
        this.exports.set(row.export, encodeWav(r.channels, r.sampleRate, bits));
        Object.assign(row, { duration: r.duration, peakDb: a.peakDb, lufs: a.lufs, warnings: r.warnings });
      } catch (e) {
        row.error = (e as Error).message;
      }
    }
    return rows;
  }
}
