/**
 * What an agent tool acts on. The same tool definitions (src/core/agent/tools.ts) run in three places, each with
 * its own Workspace:
 *
 * - the editor in a browser, for WebMCP (src/web/webmcp.ts): the open patch, with audio playback;
 * - the MCP server (src/node/mcp.ts): patch files on disk, headless;
 * - tests: an in-memory workspace.
 *
 * Keep it small. Anything a tool can compute from the patch with the core belongs in the tool, not here.
 */
import type { Patch } from '../format/types';
import type { RenderResult } from '../render';

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
  /** `browser` (WebMCP in the editor) or `files` (MCP server, CLI). */
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
}
