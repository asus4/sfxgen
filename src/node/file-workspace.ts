/**
 * A Workspace over patch files under a root directory. Refs are paths relative to the root (`sounds/zap.sfx.json`);
 * anything that would leave the root is rejected. The MCP server and `sfxgen serve` both use it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Patch } from '../core/format/types';
import { deepClone } from '../core/format/paths';
import { render } from '../core/render';
import { encodeWav } from '../core/wav';
import type { ChangeRecord, ProjectBuildRow, Workspace } from '../core/agent/workspace';
import { analyze } from '../core/analysis';
import { formatIssues, validatePatch } from '../core/format/validate';
import { PROJECT_FILE, newProject, renderProjectSound, soundExportPath, soundName, validateProject, type Project } from '../core/project/project';
import { diffValues } from '../core/agent/diff';

export const PATCH_EXT = '.sfx.json';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.cache']);
/** Where `sfxgen serve` listens unless told otherwise; the agent's play tool looks there for an editor. */
export const DEFAULT_SERVE_PORT = 5179;

/** What the file workspace needs from an editor server to make sound for the person. */
export interface EditorBridge {
  /** Open editor pages listening for events. */
  clientCount(): number;
  /** Asks every open editor to play this patch. */
  broadcastPlay(path: string): void;
}

export interface PatchFileInfo {
  path: string;
  name: string;
  mtime: number;
}

/** Every `*.sfx.json` under a directory, relative to it, sorted. */
export async function listPatchFiles(root: string): Promise<PatchFileInfo[]> {
  const out: PatchFileInfo[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && e.name.endsWith(PATCH_EXT)) {
        const s = await stat(full);
        out.push({ path: relative(root, full).split(sep).join('/'), name: e.name.slice(0, -PATCH_EXT.length), mtime: Math.round(s.mtimeMs) });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Nearest existing ancestor's real path, so a symlink can't smuggle a write out of the root. */
function realAncestor(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return realpathSync(cur);
}

export class FileWorkspace implements Workspace {
  readonly kind = 'files' as const;
  readonly root: string;
  private readonly realRoot: string;
  /** What the agent last wrote or first read, per file: the baseline for a person's changes. */
  private readonly baseline = new Map<string, Patch>();
  private current: string | undefined;
  private bridge: EditorBridge | undefined;
  /** Set by hosts that know how to tell the person to open an editor. */
  playHint = 'No editor is open. Run `sfxgen serve` in the project folder and open the URL it prints, then call play again.';

  /** The project file, relative to the root. */
  readonly projectFile: string;

  constructor(root: string, opts: { projectFile?: string } = {}) {
    this.projectFile = opts.projectFile ?? PROJECT_FILE;
    this.root = resolve(root);
    this.realRoot = existsSync(this.root) ? realpathSync(this.root) : this.root;
  }

  attachEditor(bridge: EditorBridge | undefined): void {
    this.bridge = bridge;
  }

  /** Maps a ref to a path relative to the root (forward slashes), or throws. */
  normalize(ref: string): string {
    let r = ref.trim();
    if (!r) throw new Error('Empty file path.');
    if (isAbsolute(r)) r = relative(this.root, r);
    if (!r.endsWith(PATCH_EXT)) {
      if (/\.json$/i.test(r)) throw new Error(`Patch files end in ${PATCH_EXT}, not ".json": try "${r.replace(/\.json$/i, PATCH_EXT)}".`);
      r += PATCH_EXT;
    }
    return this.confine(r);
  }

  /** The path relative to the root (forward slashes), or throws when it would leave the root. */
  confine(path: string): string {
    const full = resolve(this.root, isAbsolute(path) ? relative(this.root, path) : path);
    const rel = relative(this.root, full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`"${path}" is outside the project folder (${this.root}).`);
    const realParent = realAncestor(dirname(full));
    if (realParent !== this.realRoot && !realParent.startsWith(this.realRoot + sep)) {
      throw new Error(`"${path}" resolves outside the project folder.`);
    }
    return rel.split(sep).join('/');
  }

  /** Absolute path of a normalized ref. */
  absolute(rel: string): string {
    return join(this.root, ...rel.split('/'));
  }

  private pick(ref?: string): string {
    const r = ref ?? this.current;
    if (!r) throw new Error('Which patch? Pass `file` (for example "zap.sfx.json"), or create one first with new_from_template or set_patch. list_patches shows what exists.');
    return this.normalize(r);
  }

  async getPatch(ref?: string): Promise<Patch> {
    const rel = this.pick(ref);
    let text: string;
    try {
      text = await readFile(this.absolute(rel), 'utf8');
    } catch {
      const known = (await listPatchFiles(this.root)).map((f) => f.path);
      throw new Error(`No patch file "${rel}".${known.length ? ` Existing: ${known.slice(0, 20).join(', ')}.` : ' There are no patch files yet.'}`);
    }
    let patch: Patch;
    try {
      patch = JSON.parse(text) as Patch;
    } catch (err) {
      throw new Error(`${rel} is not valid JSON: ${(err as Error).message}`);
    }
    this.current = rel;
    if (!this.baseline.has(rel)) this.baseline.set(rel, deepClone(patch));
    return patch;
  }

  async setPatch(patch: Patch, opts: { ref?: string; origin?: 'agent' | 'human' } = {}): Promise<void> {
    const rel = this.pick(opts.ref);
    const abs = this.absolute(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(patch, null, 2)}\n`);
    this.current = rel;
    if ((opts.origin ?? 'agent') === 'agent') this.baseline.set(rel, deepClone(patch));
  }

  async render(patch: Patch) {
    return render(patch);
  }

  async play(ref?: string): Promise<{ played: boolean; note?: string }> {
    const rel = this.pick(ref);
    if (this.bridge) {
      const n = this.bridge.clientCount();
      if (n > 0) {
        this.bridge.broadcastPlay(rel);
        return { played: true, note: `Sent to ${n} open editor${n === 1 ? '' : 's'}; the person hears it if the page has had a click (browsers block sound before one).` };
      }
      return { played: false, note: 'The editor server is running but no browser has the editor open. Ask the person to open its URL.' };
    }
    // A `sfxgen serve` in another process for the same folder.
    const via = await this.playViaLocalServer(rel);
    if (via) return via;
    return { played: false, note: this.playHint };
  }

  private async playViaLocalServer(rel: string): Promise<{ played: boolean; note?: string } | undefined> {
    const base = `http://127.0.0.1:${DEFAULT_SERVE_PORT}`;
    try {
      const info = (await (await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(600) })).json()) as { root?: string };
      if (!info.root || resolve(info.root) !== this.root) return undefined;
      const res = (await (await fetch(`${base}/api/play?path=${encodeURIComponent(rel)}`, { method: 'POST', signal: AbortSignal.timeout(1000) })).json()) as { clients?: number };
      if (!res.clients) return { played: false, note: 'sfxgen serve is running but no browser has the editor open. Ask the person to open its URL.' };
      return { played: true, note: `Sent to ${res.clients} open editor(s).` };
    } catch {
      return undefined;
    }
  }

  async exportWav(patch: Patch, opts: { path?: string; bitDepth?: 16 | 24 | 32 } = {}): Promise<{ location: string; bytes: number }> {
    let rel: string;
    if (opts.path) {
      const p = opts.path.endsWith('.wav') ? opts.path : `${opts.path}.wav`;
      rel = this.confine(p);
    } else {
      if (!this.current) throw new Error('Nothing to name the WAV after: pass `path`.');
      rel = this.current.slice(0, -PATCH_EXT.length) + '.wav';
    }
    const result = render(patch);
    const data = encodeWav(result.channels, result.sampleRate, opts.bitDepth ?? patch.output?.bitDepth ?? 16);
    const abs = this.absolute(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return { location: rel, bytes: data.length };
  }

  async getHumanChanges(ref?: string): Promise<ChangeRecord[]> {
    const rel = this.pick(ref);
    const before = this.baseline.get(rel);
    if (!before) return [];
    const now = JSON.parse(await readFile(this.absolute(rel), 'utf8')) as Patch;
    return diffValues(before, now);
  }

  async list(): Promise<string[]> {
    return (await listPatchFiles(this.root)).map((f) => f.path);
  }

  // ---- Projects --------------------------------------------------------------------------------

  /** Absolute path of the project file. */
  get projectPath(): string {
    return join(this.root, ...this.projectFile.split('/'));
  }

  /** The root's project file, or (saved: false) its patch files as a project that is not on disk yet. */
  async getProject(): Promise<{ project: Project; path: string; saved: boolean } | null> {
    let text: string | undefined;
    try {
      text = await readFile(this.projectPath, 'utf8');
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      try {
        return { project: JSON.parse(text) as Project, path: this.projectFile, saved: true };
      } catch (err) {
        throw new Error(`${this.projectFile} is not valid JSON: ${(err as Error).message}`);
      }
    }
    const files = (await listPatchFiles(this.root)).map((f) => f.path);
    return { project: newProject(basename(this.root) || 'Project', files), path: this.projectFile, saved: false };
  }

  /** Where each sound's WAV would go, absolute. */
  private exportTargets(project: Project): string[] {
    const dir = dirname(this.projectPath);
    return (project.sounds ?? []).map((s) => resolve(dir, soundExportPath(project, s)));
  }

  private inRoot(abs: string): boolean {
    const rel = relative(this.root, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }

  /**
   * Validates and writes the project file (2-space JSON). An agent may not point exports outside the root: that
   * stays a person's decision (an edit with origin `human`, or by hand in the file).
   */
  async setProject(project: Project, opts: { origin?: 'agent' | 'human' } = {}): Promise<void> {
    const v = validateProject(project);
    if (!v.ok) throw new Error(`The project has errors:\n${formatIssues(v)}`);
    if ((opts.origin ?? 'agent') === 'agent') {
      const before = await this.getProject().catch(() => null);
      const allowed = new Set(before?.saved ? this.exportTargets(before.project).filter((t) => !this.inRoot(t)) : []);
      const outside = this.exportTargets(project).filter((t) => !this.inRoot(t) && !allowed.has(t));
      if (outside.length > 0) {
        throw new Error(`Export path ${outside[0]} is outside the project folder. Only a person may point exports elsewhere (for example into a game's Assets folder): ask them to set it in ${this.projectFile}.`);
      }
    }
    await mkdir(dirname(this.projectPath), { recursive: true });
    await writeFile(this.projectPath, `${JSON.stringify(project, null, 2)}\n`);
  }

  /**
   * Renders every sound that is not skipped (or only those named) in the project's context and writes each WAV to
   * its export path, relative to the project file. A sound that fails is reported in its row; the rest still build.
   * With `dryRun` nothing is written.
   */
  async buildProject(opts: { only?: string[]; dryRun?: boolean } = {}): Promise<ProjectBuildRow[]> {
    const got = await this.getProject();
    if (!got) return [];
    const { project } = got;
    const v = validateProject(project);
    if (!v.ok) throw new Error(`${this.projectFile} has errors:\n${formatIssues(v)}`);
    const dir = dirname(this.projectPath);
    const rows: ProjectBuildRow[] = [];
    for (const sound of project.sounds) {
      const name = soundName(sound);
      if (sound.skip || (opts.only && !opts.only.includes(name))) continue;
      const exportPath = soundExportPath(project, sound);
      const row: ProjectBuildRow = { name, file: sound.file, export: exportPath, duration: 0, peakDb: 0, lufs: 0, warnings: [] };
      rows.push(row);
      try {
        let patch = sound.patch;
        if (!patch) {
          const abs = resolve(dir, sound.file as string);
          if (!/\.json$/i.test(abs)) throw new Error(`${sound.file} is not a .sfx.json file.`);
          let text: string;
          try {
            text = await readFile(abs, 'utf8');
          } catch {
            throw new Error(`No patch file ${sound.file}.`);
          }
          patch = JSON.parse(text) as Patch;
        }
        const pv = validatePatch(patch);
        if (!pv.ok) throw new Error(`The patch has errors:\n${formatIssues({ ...pv, warnings: [] })}`);
        const r = renderProjectSound(project, sound, patch);
        const a = analyze(r.channels, r.sampleRate);
        const bits = project.output?.bitDepth ?? patch.output?.bitDepth ?? 16;
        Object.assign(row, { duration: r.duration, peakDb: a.peakDb, lufs: a.lufs, warnings: r.warnings });
        if (!opts.dryRun) {
          const abs = resolve(dir, exportPath);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, encodeWav(r.channels, r.sampleRate, bits));
        }
      } catch (err) {
        row.error = (err as Error).message;
      }
    }
    return rows;
  }
}
