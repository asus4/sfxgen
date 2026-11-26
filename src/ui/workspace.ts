/**
 * The browser Workspace: what WebMCP tools act on. It is the open project in the editor, rendered in the worker and
 * played through the page. An agent's writes show in the activity feed, flash the knobs they touched and light the
 * pads of the sounds they changed.
 */
import { validatePatch, formatIssues, reviewReport, soundName, type Patch, type Project, type RenderResult } from '../core';
import type { ChangeRecord, Workspace } from '../core/agent/workspace';
import { diffPatches } from './lib/paths';
import { takesOf } from './lib/review';
import { addSound, patchOf, soundKey, stripProject } from './lib/projectOps';
import { renderClient } from './renderClient';
import { editor, versionIn } from './store';
import * as serve from './serve';
import { downloadBytes, exportAll, openServeFile, playNow } from './controller';

function checked(input: unknown): Patch {
  const result = validatePatch(input);
  if (!result.ok) throw new Error(`invalid patch:\n${formatIssues(result)}`);
  return input as Patch;
}

/** The sound a ref names: its file, its name, or `current`. -1 when the project has no such sound. */
function indexOf(ref: string | undefined): number {
  const s = editor();
  if (!ref || ref === 'current') return s.current;
  const bare = ref.replace(/\.sfx\.json$/i, '').replace(/^.*\//, '');
  return s.project.sounds.findIndex((x) => x.file === ref || soundKey(x) === ref || soundName(x) === bare);
}

export function createBrowserWorkspace(): Workspace {
  return {
    kind: 'browser',

    async getPatch(ref) {
      const at = indexOf(ref);
      if (at >= 0) return patchOf(editor().project.sounds[at]);
      if (editor().serve.info && ref) return checked(await serve.readFile(ref));
      throw new Error(`no sound "${ref}" in this project; it has: ${editor().project.sounds.map(soundKey).join(', ')}`);
    },

    async setPatch(patch, opts) {
      const next = checked(patch);
      const origin = opts?.origin ?? 'agent';
      const s = editor();
      const at = indexOf(opts?.ref);
      if (at < 0) {
        // A new sound: a file on a served folder (the project picks it up), else a new pad.
        if (s.serve.info && opts?.ref) {
          await serve.writeFile(opts.ref, next, origin === 'human' ? 'human' : 'agent');
          await openServeFile(opts.ref);
          return;
        }
        const added = addSound(s.project, next);
        s.loadProject(added.project, { origin, select: added.index, note: `added a sound: “${next.name}”` });
        return;
      }
      if (origin === 'human' && at === s.current) s.edit(next);
      else s.load(next, { origin, index: at });
      // An agent's write is saved to the sound's file like anyone else's.
      const file = editor().project.sounds[at]?.file;
      if (origin !== 'human' && s.serve.info && file) await serve.writeFile(file, next, 'agent').catch(() => undefined);
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
      const at = indexOf(ref);
      if (at >= 0) editor().openSound(at);
      else if (ref && !(await openServeFile(ref))) return { played: false, note: `No sound "${ref}" in this project.` };
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
      const name = opts?.path ?? `${soundName({ patch: next })}.wav`;
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

    async getHumanChanges(ref): Promise<ChangeRecord[]> {
      const s = editor();
      const at = indexOf(ref);
      const sound = s.project.sounds[at];
      const before = versionIn(s.baseline, sound);
      if (!sound || !before) return [];
      return diffPatches(patchOf(before), patchOf(sound));
    },

    async list() {
      return editor().project.sounds.map(soundKey);
    },

    async getProject() {
      const s = editor();
      return { project: stripProject(s.project), ...(s.serve.projectPath ? { path: s.serve.projectPath } : {}), saved: s.serve.info ? s.serve.projectSaved : true };
    },

    async setProject(project: Project, opts) {
      const s = editor();
      const origin = opts?.origin ?? 'agent';
      // Sounds named by file keep the patch the editor has; new files are read from the server.
      const known = new Map(s.project.sounds.map((x) => [soundKey(x), x.patch]));
      const sounds = [];
      for (const sound of project.sounds) {
        if (sound.patch) sounds.push(sound);
        else if (known.get(soundKey(sound))) sounds.push({ ...sound, patch: known.get(soundKey(sound)) });
        else if (s.serve.info && sound.file) sounds.push({ ...sound, patch: checked(await serve.readFile(sound.file)) });
        else throw new Error(`sound "${soundKey(sound)}" has no patch here: give it an inline \`patch\``);
      }
      if (sounds.length === 0) throw new Error('a project in the editor needs at least one sound');
      const next = { ...project, sounds };
      if (origin === 'human') s.editProject(next);
      else s.loadProject(next, { origin: 'agent' });
      if (origin !== 'human' && s.serve.info) await serve.writeProject(stripProject(next), 'agent').catch(() => undefined);
    },

    async buildProject(opts) {
      return exportAll({ only: opts?.only, origin: 'agent' });
    },

    async getReview() {
      const s = editor();
      const report = reviewReport(s.project, s.review, (sound) => ({ patch: patchOf(sound), takes: takesOf(s, sound).map((t) => ({ label: t.label, patch: t.patch })) }));
      const byRow = new Map(report.rows.map((row, i) => [row, patchOf(s.project.sounds[i])]));
      return { report, patchOf: (row) => byRow.get(row) };
    },
  };
}
