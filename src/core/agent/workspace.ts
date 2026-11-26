/**
 * What an agent tool acts on. The same tool definitions (src/core/agent/tools.ts) run in three places, each with
 * its own Workspace:
 *
 * - the editor in a browser, for WebMCP (src/web/webmcp.ts): the open patch, with audio playback;
 * - the CLI (src/node/file-workspace.ts): patch files on disk, headless;
 * - tests: an in-memory workspace.
 *
 * Keep it small. Anything a tool can compute from the patch with the core belongs in the tool, not here.
 */
import type { Patch } from '../format/types';
import type { RenderResult } from '../render';
import type { Project } from '../project/project';
import type { ReviewReport, ReviewRow } from '../project/review';

/** One row of a project build: what was written and how it measures. */
export interface ProjectBuildRow {
  /** The sound's name (its file name without .sfx.json). */
  name: string;
  /** Patch file, relative to the project, when the sound is a file. */
  file?: string;
  /** Where the WAV went (a path, or a download name in the browser). */
  export: string;
  duration: number;
  peakDb: number;
  lufs: number;
  warnings: string[];
  /** Set when the sound could not be built (its patch is missing or invalid); the other fields are then 0. */
  error?: string;
}

export interface WorkspacePatchRef {
  /** A file path (Node), or an id the editor understands (browser). Omitted: the current patch. */
  ref?: string;
}

export interface ChangeRecord {
  path: string;
  before: unknown;
  after: unknown;
}

export interface Workspace {
  /** `browser` (WebMCP in the editor) or `files` (the CLI). */
  readonly kind: 'browser' | 'files';
  /** The patch being worked on. */
  getPatch(ref?: string): Promise<Patch>;
  /**
   * Replaces the patch. `origin` says who changed it, so the editor can show the agent's edits and the workspace can
   * report a person's edits back (getHumanChanges).
   */
  setPatch(patch: Patch, opts?: { ref?: string; origin?: 'agent' | 'human' }): Promise<void>;
  /** Renders the current patch (with its controls applied). Browsers render in a worker. */
  render(patch: Patch): Promise<RenderResult>;
  /** Plays a sound for the person, if this workspace can (the editor can; the file workspace asks the editor). */
  play?(ref?: string): Promise<{ played: boolean; note?: string }>;
  /** Writes a WAV (file workspace: next to the patch or at `path`; browser: a download). Returns where it went. */
  exportWav?(patch: Patch, opts?: { path?: string; bitDepth?: 16 | 24 | 32 }): Promise<{ location: string; bytes: number }>;
  /** What a person changed since the agent last wrote this patch. */
  getHumanChanges?(ref?: string): Promise<ChangeRecord[]>;
  /** Patch files the workspace can see (file workspace), or open documents (browser). */
  list?(): Promise<string[]>;
  /**
   * The project being worked on, if any: a file workspace reads `sfxgen.project.json` in its root (or describes the
   * folder's patches as an unsaved project); the editor returns the open project. `path` is the project file.
   */
  getProject?(): Promise<{ project: Project; path?: string; saved: boolean } | null>;
  /** Replaces the project (validated by the caller). Sound files are not touched. */
  setProject?(project: Project, opts?: { origin?: 'agent' | 'human' }): Promise<void>;
  /** Renders every sound (or `only` those names) in project context to its export path. */
  buildProject?(opts?: { only?: string[] }): Promise<ProjectBuildRow[]>;
  /**
   * Which sounds a person approved or flagged as needing work, what they changed before deciding, and each sound's
   * takes (src/core/project/review.ts). `patchOf` gives a row's patch, to name its controls.
   */
  getReview?(): Promise<{ report: ReviewReport; patchOf(row: ReviewRow): Patch | undefined }>;
}
