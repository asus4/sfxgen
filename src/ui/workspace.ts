/**
 * The browser Workspace: what WebMCP tools act on. It is the open patch in the editor, rendered in the worker and
 * played through the page. An agent's writes show in the activity feed and flash the knobs they touched.
 */
import { validatePatch, formatIssues, type Patch, type RenderResult } from '../core';
import type { ChangeRecord, Workspace } from '../core/agent/workspace';
import { diffPatches } from './lib/paths';
import { fileNameFor } from './lib/patchOps';
import { renderClient } from './renderClient';
import { editor } from './store';
import * as serve from './serve';
import { downloadBytes, openServeFile, playNow } from './controller';

function checked(input: unknown): Patch {
  const result = validatePatch(input);
  if (!result.ok) throw new Error(`invalid patch:\n${formatIssues(result)}`);
  return input as Patch;
}

export function createBrowserWorkspace(): Workspace {
  const isOther = (ref?: string) => {
    const s = editor();
    return !!ref && !!s.serve.info && ref !== s.serve.path && ref !== 'current';
  };
  return {
    kind: 'browser',

    async getPatch(ref) {
      if (isOther(ref)) return checked(await serve.readFile(ref!));
      return editor().patch;
    },

    async setPatch(patch, opts) {
      const next = checked(patch);
      const origin = opts?.origin ?? 'agent';
      if (isOther(opts?.ref)) {
        await serve.writeFile(opts!.ref!, next, origin === 'human' ? 'human' : 'agent');
        await openServeFile(opts!.ref!, origin === 'human' ? 'file' : 'agent');
        return;
      }
      const s = editor();
      if (origin === 'human') s.edit(next);
      else s.load(next, { origin: 'agent' });
      // An agent's write is saved to the bound file like anyone else's.
      if (origin !== 'human' && s.serve.info && s.serve.path) await serve.writeFile(s.serve.path, next, 'agent').catch(() => undefined);
    },

    async render(patch): Promise<RenderResult> {
      const view = await renderClient.render(patch, { keepTracks: true });
      return {
        sampleRate: view.sampleRate,
        channels: view.channels,
        duration: view.duration,
        tracks: view.tracks,
        warnings: view.warnings,
        normalizeGainDb: view.normalizeGainDb,
        timeMs: view.timeMs,
      };
    },

    async play(ref) {
      if (isOther(ref)) await openServeFile(ref!, 'agent');
      const played = await playNow();
      editor().log('agent', played ? 'played the sound' : 'asked to play (audio is waiting for a click)');
      return played ? { played } : { played, note: 'The browser blocks audio until the person clicks the page once.' };
    },

    async exportWav(patch, opts) {
      const next = checked(patch);
      const bitDepth = opts?.bitDepth ?? next.output?.bitDepth ?? 16;
      const { bytes } = await renderClient.wav(next, {}, bitDepth);
      const size = bytes.byteLength;
      const s = editor();
      const name = opts?.path ?? `${fileNameFor(next)}.wav`;
      if (s.serve.info && opts?.path) {
        await serve.writeWav(opts.path, bytes);
        s.log('agent', `exported ${opts.path}`);
        return { location: opts.path, bytes: size };
      }
      downloadBytes(bytes, name.split('/').pop() ?? name, 'audio/wav');
      s.log('agent', `exported ${name}`);
      s.showStamp('Exported');
      return { location: `download:${name}`, bytes: size };
    },

    async getHumanChanges(): Promise<ChangeRecord[]> {
      const s = editor();
      return diffPatches(s.baseline, s.patch);
    },

    async list() {
      const s = editor();
      if (s.serve.info) return s.serve.files.map((f) => f.path);
      return ['current'];
    },
  };
}
