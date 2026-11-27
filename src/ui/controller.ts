/**
 * Everything the editor does besides holding state: rendering on every change, measuring the set, playback,
 * projects kept in the browser, files, share links, the local server and WebMCP. Components call these functions;
 * the store stays plain data.
 */
import {
  PROJECT_FORMAT_ID,
  deepClone,
  newProject,
  readReview,
  reviewKey,
  takeFileFor,
  takeLabel,
  takeOwner,
  withVerdict,
  projectPatch,
  soundExportPath,
  soundName,
  syncControlBases,
  takeFileName,
  validatePatch,
  validateProject,
  variationTakes,
  type Patch,
  type Project,
  type ProjectSound,
  type ReviewEntry,
  type ReviewVerdict,
} from '../core';
import type { ProjectBuildRow } from '../core/agent/workspace';
import { formatJson } from '../core/format/json';
import { getTemplate } from '../core/templates';
import { player } from './audio';
import { anotherTake, fileNameFor, surprise } from './lib/patchOps';
import {
  EMPTY_PATCH,
  addSound,
  bundleProject,
  matchGroup,
  patchOf,
  projectOfOne,
  removeSound,
  renderHash,
  shellKey,
  soundKey,
  starterProject,
  stripProject,
  uniquePatchName,
  zipPath,
} from './lib/projectOps';
import { decodePatchHash, encodePatchHash, jsonIn } from './lib/share';
import { makeZip } from './lib/zip';
import { renderClient } from './renderClient';
import type { RenderView } from './renderProtocol';
import * as serve from './serve';
import { editor, followsSystemTheme, useEditor, type Library, type Origin, type Take } from './store';
import { changesOf, nextUnreviewed, reviewVersion, statusOf, takeInUse, takesOf, versionOf } from './lib/review';
import { createBrowserWorkspace } from './workspace';

const SPECTRO_W = 360;
const SPECTRO_H = 128;
const PAD_BINS = 40;

// ---- Playback ---------------------------------------------------------------------------------

/** Audio of every sound as the project hears it (before its project gain), for pads and "play the set". */
const audio = new Map<string, { hash: string; view: RenderView }>();
let setToken = 0;
/**
 * What the player holds: the open sound's live render (its project gain baked in), or a sound from the cache
 * above (its gain applied on the way out). Edits made while it plays are swapped in accordingly.
 */
let voice: 'live' | 'cached' = 'live';

function currentKey(): string {
  const s = editor();
  return s.project.sounds[s.current] ? soundKey(s.project.sounds[s.current]) : '';
}

/** Plays the open sound once its render is up to date. Returns false when the browser refused audio. */
export async function playNow(from = 0): Promise<boolean> {
  setToken++;
  // Unlock inside the gesture, before waiting for anything.
  const unlocked = player.unlock();
  await renderClient.idle();
  const { view, patch } = editor();
  if (!view || !(await unlocked)) return false;
  const ok = await player.play(view, from, !!patch.loop);
  if (ok) {
    voice = 'live';
    useEditor.setState({ playingKey: currentKey() });
  }
  return ok;
}

export function stop(): void {
  setToken++;
  player.stop();
}

export function togglePlay(): void {
  if (player.playing) stop();
  else void playNow();
}

/** A knob was released: hear what it did. A loop already playing is not restarted; the change is swapped into it. */
export function audition(): void {
  if (player.playing && player.looping && voice === 'live' && editor().playingKey === currentKey()) return;
  void playNow();
}

export function pressPad(index: number): void {
  editor().openSound(index);
  void playNow();
}

/** Plays one sound without opening it (the mixer's play keys), at its level in the set. */
export async function playSound(index: number): Promise<boolean> {
  const s = editor();
  if (index === s.current) return playNow();
  setToken++;
  const unlocked = player.unlock();
  const sound = s.project.sounds[index];
  const view = sound && (await ensureAudio(sound));
  if (!sound || !view || !(await unlocked)) return false;
  const ok = await player.play(view, 0, false, sound.gain ?? 0);
  if (ok) {
    voice = 'cached';
    useEditor.setState({ playingKey: soundKey(sound) });
  }
  return ok;
}

/** Plays the whole set in turn (or one group of it), so levels can be judged side by side. */
export async function playSet(group?: string | null): Promise<void> {
  const token = ++setToken;
  const unlocked = player.unlock();
  const sounds = editor().project.sounds.filter((x) => !x.skip && (group === undefined || (x.group ?? null) === group));
  if (!(await unlocked)) return;
  for (const sound of sounds) {
    const view = await ensureAudio(sound);
    if (token !== setToken) return;
    if (!view) continue;
    // The fader may have moved while the set plays: read the gain now.
    const now = editor().project.sounds.find((x) => soundKey(x) === soundKey(sound)) ?? sound;
    if (!(await player.play(view, 0, false, now.gain ?? 0))) return;
    voice = 'cached';
    useEditor.setState({ playingKey: soundKey(sound) });
    await player.whenEnded();
    if (token !== setToken) return;
    await new Promise((r) => setTimeout(r, 140));
    if (token !== setToken) return;
  }
}

// ---- Measuring the set --------------------------------------------------------------------------

async function measure(sound: ProjectSound): Promise<RenderView | null> {
  const project = editor().project;
  const key = soundKey(sound);
  const hash = renderHash(project, sound);
  const have = audio.get(key);
  if (have?.hash === hash && editor().measured[key]?.hash === hash) return have.view;
  try {
    const r = await renderClient.sound(projectPatch(project, sound, patchOf(sound)), PAD_BINS);
    audio.set(key, { hash, view: r.view });
    // The sound changed while it was playing from the cache (an undo, an agent's edit): let that be heard.
    if (have && voice === 'cached' && player.playing && editor().playingKey === key) player.swap(r.view, false, sound.gain ?? 0);
    useEditor.setState((s) => ({
      measured: { ...s.measured, [key]: { hash, lufs: r.lufs, peakDb: r.peakDb, duration: r.view.duration, peaks: r.peaks, warnings: r.view.warnings } },
    }));
    return r.view;
  } catch {
    return null;
  }
}

async function ensureAudio(sound: ProjectSound): Promise<RenderView | null> {
  const now = editor().project.sounds.find((x) => soundKey(x) === soundKey(sound));
  return now ? measure(now) : null;
}

let measuring = false;
let measureAgain = false;
let measureTimer: ReturnType<typeof setTimeout> | null = null;

async function measureAll(): Promise<void> {
  if (measuring) {
    measureAgain = true;
    return;
  }
  measuring = true;
  try {
    do {
      measureAgain = false;
      for (const sound of editor().project.sounds) await ensureAudio(sound);
      // Forget sounds that left the project.
      const keys = new Set(editor().project.sounds.map(soundKey));
      for (const k of [...audio.keys()]) if (!keys.has(k)) audio.delete(k);
      const stale = Object.keys(editor().measured).filter((k) => !keys.has(k));
      if (stale.length) useEditor.setState((s) => ({ measured: Object.fromEntries(Object.entries(s.measured).filter(([k]) => keys.has(k))) }));
    } while (measureAgain);
  } finally {
    measuring = false;
  }
}

function scheduleMeasure(): void {
  if (measureTimer) clearTimeout(measureTimer);
  measureTimer = setTimeout(() => void measureAll(), 260);
}

/** Resolves when every sound's loudness and peak are up to date. */
export async function levelsReady(): Promise<void> {
  if (measureTimer) clearTimeout(measureTimer);
  await measureAll();
}

export async function matchLoudnessOf(group: string | null, targetLufs: number, ceilingDb: number): Promise<void> {
  await levelsReady();
  const s = editor();
  s.editProject((p) => matchGroup(p, editor().measured, group, targetLufs, ceilingDb));
  s.log('human', `matched ${group === '*' ? 'the set' : group === null ? 'ungrouped sounds' : `group ${group}`} to ${targetLufs} LUFS (ceiling ${ceilingDb} dB)`);
}

// ---- Patch actions ----------------------------------------------------------------------------

export function rollTake(): void {
  editor().edit((p) => anotherTake(p));
  void playNow();
}

export function surpriseMe(): void {
  editor().edit((p) => surprise(p));
  const ids = (editor().patch.controls ?? []).map((c) => `c:${c.id}`);
  editor().flashKeys(ids);
  void playNow();
}

function accept(input: unknown, source: string): Patch | null {
  const result = validatePatch(input);
  if (!result.ok) {
    const first = result.errors[0];
    editor().toast(`${source}: ${first ? `${first.path || 'patch'}: ${first.message}` : 'not a patch'}`, 'error');
    return null;
  }
  return input as Patch;
}

function uniqueFile(project: Project, stem: string): string {
  const taken = new Set(project.sounds.map((x) => (x.file ?? '').toLowerCase()));
  const clean = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'sound';
  for (let i = 1; ; i++) {
    const file = `${i === 1 ? clean : `${clean}-${i}`}.sfx.json`;
    if (!taken.has(file.toLowerCase())) return file;
  }
}

/** Adds a sound to the project as a new pad, opens it and plays it. In serve mode it becomes a file. */
export async function addSoundToProject(patch: Patch, note: string): Promise<void> {
  const s = editor();
  try {
    let extra: Partial<ProjectSound> = {};
    if (s.serve.info) {
      const file = uniqueFile(s.project, soundName({ patch }));
      const written = forDisk(patch);
      await serve.writeFile(file, written, 'human');
      onDisk.set(file, JSON.stringify(written));
      extra = { file };
    }
    const added = addSound(editor().project, patch, extra);
    editor().editProject(added.project, null, added.index);
    editor().log('human', note);
    void playNow();
  } catch (err) {
    s.toast(err instanceof Error ? err.message : 'Could not add the sound', 'error');
  }
}

/** A gallery card was clicked: the template replaces the open sound, or becomes a new pad. */
export function pickTemplate(id: string): void {
  const patch = getTemplate(id);
  if (!patch) return;
  const s = editor();
  if (s.gallery.mode === 'add') {
    void addSoundToProject(patch, `added “${patch.name}” from the gallery`);
    return;
  }
  const sound = s.project.sounds[s.current];
  // An inline sound is named by its patch: keep names unique in the set.
  const named = sound?.file ? patch : { ...patch, name: uniquePatchName(s.project, patch.name, s.current) };
  s.load(named, { origin: 'human', note: `loaded template “${patch.name}”`, fresh: true });
  void playNow();
}

export function addBlankSound(): void {
  void addSoundToProject({ ...EMPTY_PATCH, name: 'New sound' }, 'added a blank sound');
}

export function deleteSound(index: number): void {
  const s = editor();
  const sound = s.project.sounds[index];
  if (!sound || s.project.sounds.length <= 1) return;
  s.editProject((p) => removeSound(p, index));
  s.log('human', `removed ${soundKey(sound)} from the project${sound.file ? ' (its file stays on disk)' : ''}`);
}

// ---- Files ------------------------------------------------------------------------------------

export function downloadBytes(bytes: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function acceptProject(input: unknown, source: string): Project | null {
  const result = validateProject(input);
  if (!result.ok) {
    const first = result.errors[0];
    editor().toast(`${source}: ${first ? `${first.path || 'project'}: ${first.message}` : 'not a project'}`, 'error');
    return null;
  }
  return input as Project;
}

/** Opens a dropped or chosen file: a patch becomes a new pad, a project bundle becomes a project. */
export async function importFile(file: File): Promise<void> {
  await importJson(await file.text(), file.name);
}

/** A patch joins the set (or a bundle opens) from JSON text: a file's contents, or a paste. */
async function importJson(text: string, name: string, pasted = false): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    editor().toast(`${name} is not valid JSON`, 'error');
    return;
  }
  if ((json as { format?: unknown } | null)?.format === PROJECT_FORMAT_ID) {
    const project = acceptProject(json, name);
    if (!project) return;
    const inline = project.sounds.filter((x) => x.patch);
    if (inline.length === 0) {
      editor().toast(`${name} lists files, not sounds: import a bundle (.sfxproj.json) or open the folder with sfxgen serve`, 'error');
      return;
    }
    if (editor().serve.info) {
      // On a served folder the bundle's sounds join the folder's project.
      for (const x of inline) await addSoundToProject(x.patch!, `imported “${x.patch!.name}” from ${name}`);
      return;
    }
    openBrowserProject(createLibraryEntry(project.name), { ...project, sounds: inline }, `imported project “${project.name}”`);
    return;
  }
  const patch = accept(json, name);
  if (patch) await addSoundToProject(patch, pasted ? `pasted “${patch.name}”` : `imported ${name}`);
}

/** A paste outside a text field: .sfx.json files copied in the file manager, or a patch copied as text. */
export function onPaste(e: ClipboardEvent): void {
  if (isTyping(e.target) || !e.clipboardData) return;
  const files = [...e.clipboardData.files].filter((f) => f.name.endsWith('.json'));
  if (files.length > 0) {
    e.preventDefault();
    // One after another, so each new pad gets its own unique name.
    void (async () => {
      for (const f of files) await importFile(f);
    })();
    return;
  }
  const json = jsonIn(e.clipboardData.getData('text/plain'));
  if (json === null) return;
  e.preventDefault();
  void importJson(json, 'The pasted patch', true);
}

export function exportJson(): void {
  const { patch } = editor();
  downloadBytes(formatJson(forDisk(patch)), `${fileNameFor(patch)}.sfx.json`, 'application/json');
  editor().showStamp('Saved');
}

/** The whole project as one file, every patch inline. */
export function exportBundle(): void {
  const { project } = editor();
  const stem = project.name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const bundle = bundleProject(project);
  const synced = { ...bundle, sounds: bundle.sounds.map((s) => (s.patch ? { ...s, patch: forDisk(s.patch) } : s)) };
  downloadBytes(formatJson(synced), `${stem}.sfxproj.json`, 'application/json');
  editor().showStamp('Saved');
}

export interface ExportOptions {
  bitDepth: 16 | 24 | 32;
  channels: 1 | 2;
  sampleRate: number;
  /** 1 exports the patch as it is; more adds varied takes. */
  takes: number;
  /** Serve mode: write to the sound's export path instead of downloading. */
  toFolder: boolean;
}

/** Exports the open sound as the project hears it. */
export async function exportWav(opts: ExportOptions): Promise<void> {
  const s = editor();
  const sound = s.project.sounds[s.current];
  if (!sound) return;
  const toFolder = opts.toFolder && !!s.serve.info;
  const target = soundExportPath(s.project, sound);
  const stem = toFolder ? target.replace(/\.wav$/i, '') : soundName(sound);
  try {
    const takes = variationTakes(s.patch, opts.takes);
    for (let take = 0; take < takes.length; take++) {
      const p = projectPatch(s.project, sound, takes[take]);
      const { bytes } = await renderClient.wav(p, { sampleRate: opts.sampleRate, channels: opts.channels }, opts.bitDepth, sound.gain ?? 0);
      const name = takeFileName(stem, take, takes.length);
      if (toFolder) await serve.writeWav(name, bytes);
      else downloadBytes(bytes, name, 'audio/wav');
    }
    s.showStamp('Exported');
    s.log('human', opts.takes > 1 ? `exported ${opts.takes} takes of ${soundName(sound)}` : `exported ${stem}.wav`);
  } catch (err) {
    s.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

/**
 * Exports every sound of the project in project context: the server builds to the export paths when it can,
 * otherwise the browser renders them and downloads one zip.
 */
export async function exportAll(opts: { only?: string[]; origin?: Origin } = {}): Promise<ProjectBuildRow[]> {
  const s = editor();
  const origin = opts.origin ?? 'human';
  if (s.serve.info) {
    await flushSaves();
    if (!editor().serve.projectSaved) await saveProjectFile();
    if (editor().serve.projectSaved) {
      const rows = await serve.build(opts.only);
      if (rows) {
        // A person gets the report; an agent's build must not put a dialog in their way.
        if (origin === 'human') useEditor.setState({ buildRows: rows });
        s.showStamp('Built');
        s.log(origin, `built ${rows.length} sound${rows.length === 1 ? '' : 's'} to their export paths`);
        return rows;
      }
    }
  }
  const project = editor().project;
  const rows: ProjectBuildRow[] = [];
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const sound of project.sounds) {
    const name = soundName(sound);
    if (sound.skip || (opts.only && !opts.only.includes(name))) continue;
    const patch = projectPatch(project, sound, patchOf(sound));
    const r = await renderClient.wav(patch, {}, patch.output?.bitDepth ?? 16, sound.gain ?? 0);
    const path = zipPath(project, sound);
    entries.push({ name: path, data: r.bytes });
    rows.push({ name, ...(sound.file ? { file: sound.file } : {}), export: path, duration: r.duration, peakDb: r.peakDb, lufs: r.lufs, warnings: r.warnings });
  }
  if (entries.length === 0) {
    s.toast('Nothing to export: every sound is skipped', 'error');
    return rows;
  }
  const stem = project.name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  downloadBytes(makeZip(entries), `${stem}.zip`, 'application/zip');
  if (origin === 'human') useEditor.setState({ buildRows: rows });
  s.showStamp('Exported');
  s.log(origin, `exported ${rows.length} sound${rows.length === 1 ? '' : 's'} as ${stem}.zip`);
  return rows;
}

/** "Export set" as pressed by a person: failures become a message, not an exception. */
export async function exportSet(): Promise<void> {
  try {
    await exportAll();
  } catch (err) {
    editor().toast(err instanceof Error ? err.message : 'The export failed', 'error');
  }
}

export async function copyShareLink(): Promise<void> {
  const s = editor();
  try {
    const hash = await encodePatchHash(s.patch);
    const url = `${location.origin}${location.pathname}#${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      s.toast(`Link to this sound copied (${url.length.toLocaleString()} characters)`);
    } catch {
      history.replaceState(null, '', `#${hash}`);
      s.toast('The link is in the address bar: copy it from there');
    }
  } catch {
    s.toast('This browser cannot make share links', 'error');
  }
}

// ---- Projects kept in the browser ---------------------------------------------------------------

const LIBRARY_KEY = 'sfxgen:library';
const projectKey = (id: string) => `sfxgen:project:${id}`;
const LEGACY_AUTOSAVE_KEY = 'sfxgen:autosave';

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage is full or blocked; the project is still in memory and can be exported.
    return false;
  }
}

function readLibrary(): Library {
  const lib = readJson(LIBRARY_KEY) as Partial<Library> | null;
  const items = Array.isArray(lib?.items) ? lib.items.filter((i) => i && typeof i.id === 'string' && typeof i.name === 'string') : [];
  return { current: typeof lib?.current === 'string' ? lib.current : '', items };
}

function readStoredProject(id: string): Project | null {
  const project = readJson(projectKey(id));
  return project && validateProject(project).ok && (project as Project).sounds.every((x) => x.patch) && (project as Project).sounds.length > 0 ? (project as Project) : null;
}

function createLibraryEntry(name: string): string {
  const id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const lib = editor().library;
  useEditor.setState({ library: { current: lib.current, items: [...lib.items, { id, name }] } });
  return id;
}

function openBrowserProject(id: string, project: Project, note?: string): void {
  setToken++;
  player.stop();
  audio.clear();
  useEditor.setState((s) => ({ library: { ...s.library, current: id } }));
  loadBrowserReview();
  editor().loadProject(project, { origin: 'system', fresh: true, note });
  persistBrowserProject();
}

function persistBrowserProject(): void {
  const s = editor();
  if (s.serve.info || !s.library.current) return;
  const items = s.library.items.map((i) => (i.id === s.library.current ? { ...i, name: s.project.name } : i));
  const library = { current: s.library.current, items };
  if (JSON.stringify(items) !== JSON.stringify(s.library.items)) useEditor.setState({ library });
  writeJson(projectKey(s.library.current), s.project);
  writeJson(LIBRARY_KEY, library);
}

export function createProject(name = 'New set'): void {
  if (editor().serve.info) return;
  const taken = new Set(editor().library.items.map((i) => i.name));
  let unique = name;
  for (let i = 2; taken.has(unique); i++) unique = `${name} ${i}`;
  openBrowserProject(createLibraryEntry(unique), projectOfOne({ ...EMPTY_PATCH, name: 'New sound' }, unique), `started project “${unique}”`);
}

export function switchProject(id: string): void {
  const s = editor();
  if (s.serve.info || id === s.library.current) return;
  persistBrowserProject();
  const project = readStoredProject(id);
  if (!project) {
    s.toast('That project could not be read from this browser', 'error');
    return;
  }
  openBrowserProject(id, project);
}

export function deleteProject(id: string): void {
  const s = editor();
  if (s.serve.info) return;
  const items = s.library.items.filter((i) => i.id !== id);
  try {
    localStorage.removeItem(projectKey(id));
    localStorage.removeItem(reviewStorageKey(id));
  } catch {
    // Nothing to remove.
  }
  useEditor.setState({ library: { current: s.library.current, items } });
  if (id !== s.library.current) {
    writeJson(LIBRARY_KEY, { current: s.library.current, items });
    return;
  }
  const next = items.map((i) => ({ id: i.id, project: readStoredProject(i.id) })).find((x) => x.project);
  if (next?.project) openBrowserProject(next.id, next.project);
  else openBrowserProject(createLibraryEntry('First set'), starterProject());
}

function bootBrowserProject(shared: Patch | null): void {
  const library = readLibrary();
  useEditor.setState({ library });
  if (shared) {
    openBrowserProject(createLibraryEntry(shared.name), projectOfOne(shared), `opened a shared link: “${shared.name}”`);
    return;
  }
  const stored = library.current ? readStoredProject(library.current) : null;
  if (stored) {
    loadBrowserReview();
    editor().loadProject(stored, { origin: 'system', fresh: true, note: `picked up where you left off: “${stored.name}”` });
    return;
  }
  // A patch autosaved by the first version of the editor becomes a project of one.
  const legacy = readJson(LEGACY_AUTOSAVE_KEY);
  if (legacy && validatePatch(legacy).ok) {
    const patch = legacy as Patch;
    openBrowserProject(createLibraryEntry(patch.name), projectOfOne(patch));
    try {
      localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
    } catch {
      // Leave it.
    }
    return;
  }
  openBrowserProject(createLibraryEntry('First set'), starterProject());
}

// ---- Local server -----------------------------------------------------------------------------

/** JSON of each patch file as the editor last read or wrote it, so its own saves don't echo back. */
const onDisk = new Map<string, string>();

/**
 * A patch as the editor writes it: the values its controls set written into the file (`sfxgen sync`), so a knob
 * turned in the editor leaves a file that says what renders. The sound is the same, and so is its review version.
 */
function forDisk(patch: Patch): Patch {
  return syncControlBases(patch).patch;
}
/** The project file's content (see shellKey) as last read or written. */
let projectOnDisk = '';
const fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
let projectTimer: ReturnType<typeof setTimeout> | null = null;

function setServe(change: Partial<ReturnType<typeof editor>['serve']>): void {
  useEditor.setState((s) => ({ serve: { ...s.serve, ...change } }));
}

/** `leaving`: the page is going away (a reload); the request is sent so that it outlives the page. */
async function saveFile(file: string, leaving = false): Promise<void> {
  fileTimers.delete(file);
  const sound = editor().project.sounds.find((x) => x.file === file);
  if (!sound?.patch) return;
  const patch = forDisk(sound.patch);
  const json = JSON.stringify(patch);
  if (json === onDisk.get(file)) return;
  setServe({ save: 'saving' });
  try {
    onDisk.set(file, json);
    await serve.writeFile(file, patch, 'human', { keepalive: leaving });
    setServe({ save: 'saved' });
  } catch (err) {
    onDisk.delete(file);
    setServe({ save: 'error' });
    editor().toast(err instanceof Error ? err.message : 'Save failed', 'error');
  }
}

async function saveProjectNow(leaving = false): Promise<boolean> {
  projectTimer = null;
  const project = editor().project;
  const key = shellKey(project);
  if (key === projectOnDisk) return true;
  setServe({ save: 'saving' });
  try {
    projectOnDisk = key;
    const res = await serve.writeProject(stripProject(project), 'human', { keepalive: leaving });
    setServe({ save: 'saved', projectSaved: true, projectPath: res.path ?? editor().serve.projectPath ?? 'sfxgen.project.json' });
    return true;
  } catch (err) {
    projectOnDisk = '';
    setServe({ save: 'error' });
    editor().toast(err instanceof Error ? err.message : 'Could not save the project', 'error');
    return false;
  }
}

/** Writes the project file for a folder that has none yet. */
export async function saveProjectFile(): Promise<void> {
  if (!editor().serve.info) return;
  if (await saveProjectNow()) editor().log('human', 'saved the project file');
}

/** The page is going away (a reload, or closing the tab): send the saves still waiting on their timers now. */
function saveBeforeLeaving(): void {
  for (const [file, timer] of fileTimers) {
    clearTimeout(timer);
    void saveFile(file, true);
  }
  if (projectTimer) {
    clearTimeout(projectTimer);
    void saveProjectNow(true);
  }
}

/** In a served folder the address names the open sound, so a reload reopens it. */
function rememberOpenSound(): void {
  const s = editor();
  const file = s.project.sounds[s.current]?.file;
  const url = new URL(location.href);
  if (!file || url.searchParams.get('file') === file) return;
  url.searchParams.set('file', file);
  history.replaceState(history.state, '', url);
}

async function flushSaves(): Promise<void> {
  const files = [...fileTimers.keys()];
  for (const t of fileTimers.values()) clearTimeout(t);
  await Promise.all(files.map((f) => saveFile(f)));
  if (projectTimer) {
    clearTimeout(projectTimer);
    await saveProjectNow();
  }
}

function scheduleServeSaves(prev: Project, next: Project): void {
  const before = new Map(prev.sounds.filter((x) => x.file).map((x) => [x.file!, x.patch]));
  for (const sound of next.sounds) {
    if (!sound.file || !before.has(sound.file) || before.get(sound.file) === sound.patch) continue;
    const old = fileTimers.get(sound.file);
    if (old) clearTimeout(old);
    const file = sound.file;
    fileTimers.set(file, setTimeout(() => void saveFile(file), 350));
  }
  if (editor().serve.projectSaved && shellKey(next) !== projectOnDisk) {
    if (projectTimer) clearTimeout(projectTimer);
    projectTimer = setTimeout(() => void saveProjectNow(), 450);
  }
}

/** Gives every file sound its patch: the one already in memory, else the file from the server. */
async function hydrate(project: Project, reuse: Project | null): Promise<Project> {
  const known = new Map((reuse?.sounds ?? []).filter((x) => x.file && x.patch).map((x) => [x.file!, x.patch!]));
  const sounds: ProjectSound[] = [];
  const failed: string[] = [];
  await Promise.all(
    project.sounds.map(async (sound, i) => {
      if (sound.patch || !sound.file) {
        sounds[i] = sound;
        return;
      }
      const have = known.get(sound.file);
      if (have) {
        sounds[i] = { ...sound, patch: have };
        return;
      }
      try {
        const raw = await serve.readFile(sound.file);
        if (!validatePatch(raw).ok) throw new Error('invalid');
        onDisk.set(sound.file, JSON.stringify(raw));
        sounds[i] = { ...sound, patch: raw as Patch };
      } catch {
        failed.push(sound.file);
      }
    }),
  );
  if (failed.length) editor().toast(`Could not open ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}`, 'error');
  return { ...project, sounds: sounds.filter(Boolean) };
}

async function fetchServedProject(): Promise<serve.ServedProject> {
  const served = await serve.readProject().catch(() => null);
  if (served) return served;
  // A server without project routes: the folder's patches, as an unsaved project.
  const files = await serve.listFiles();
  const root = editor().serve.info?.root ?? '';
  return { path: null, saved: false, project: newProject(root.replace(/\/+$/, '').replace(/^.*\//, '') || 'Folder', files.map((f) => f.path)) };
}

async function loadServedProject(origin: Origin, fresh: boolean, select?: string): Promise<boolean> {
  try {
    const served = await fetchServedProject();
    if (!validateProject(served.project).ok) throw new Error('the project file is not valid');
    const project = await hydrate(served.project, fresh ? null : editor().project);
    if (project.sounds.length === 0) {
      setServe({ projectPath: served.path, projectSaved: served.saved });
      return false;
    }
    projectOnDisk = shellKey(project);
    setServe({ projectPath: served.path, projectSaved: served.saved, save: 'saved' });
    // The verdicts and takes first, so the pads open showing what is reviewed.
    if (fresh) await Promise.all([refreshTakes(), loadServedReview()]);
    const at = select ? project.sounds.findIndex((x) => x.file === select) : -1;
    editor().loadProject(project, { origin, fresh, ...(at >= 0 ? { select: at } : {}), ...(fresh ? { note: `opened ${served.saved ? 'project' : 'folder'} “${project.name}”` } : {}) });
    return true;
  } catch (err) {
    editor().toast(err instanceof Error ? err.message : 'Could not open the project', 'error');
    return false;
  }
}

function indexOfFile(path: string | undefined): number {
  return path ? editor().project.sounds.findIndex((x) => x.file === path) : -1;
}

/** Opens a sound of the served project by its file, re-reading the project when the file is new to it. */
export async function openServeFile(path: string): Promise<boolean> {
  let at = indexOfFile(path);
  if (at < 0) {
    await loadServedProject('file', false);
    at = indexOfFile(path);
  }
  if (at < 0) return false;
  editor().openSound(at);
  return true;
}

async function onFileEvent(e: { path: string; origin?: string; deleted?: boolean }): Promise<void> {
  // A take is not a sound: its sound's list of takes changes.
  if (takeOwner(e.path)) {
    if (e.deleted) takeCache.delete(e.path);
    scheduleTakesRefresh();
    return;
  }
  const at = indexOfFile(e.path);
  if (at < 0 || e.deleted) {
    // A folder without a project file is its own list of sounds.
    if (!editor().serve.projectSaved) await loadServedProject('file', false);
    else if (e.deleted && at >= 0) editor().toast(`${e.path} was deleted on disk; your next edit saves it again`);
    if (e.deleted) onDisk.delete(e.path);
    return;
  }
  try {
    const incoming = await serve.readFile(e.path);
    const json = JSON.stringify(incoming);
    const now = indexOfFile(e.path);
    // Our own save coming back, or nothing new.
    if (now < 0 || json === onDisk.get(e.path) || json === JSON.stringify(editor().project.sounds[now].patch)) {
      onDisk.set(e.path, json);
      return;
    }
    const patch = accept(incoming, e.path);
    if (!patch) return;
    onDisk.set(e.path, json);
    // `agent` is an agent's PUT; anything else is the file changing on disk (an agent's editor, git, another tab).
    editor().load(patch, { origin: e.origin === 'agent' ? 'agent' : 'file', index: now });
    if (now === editor().current) audition();
  } catch {
    // Caught mid-write; the next event brings the finished file.
  }
}

async function onProjectEvent(e: { origin?: string }): Promise<void> {
  try {
    const served = await fetchServedProject();
    const project = await hydrate(served.project, editor().project);
    setServe({ projectPath: served.path, projectSaved: served.saved });
    const key = shellKey(project);
    if (key === projectOnDisk || key === shellKey(editor().project) || project.sounds.length === 0) {
      projectOnDisk = key;
      return;
    }
    projectOnDisk = key;
    editor().loadProject(project, { origin: e.origin === 'agent' ? 'agent' : 'file', note: 'changed the project file' });
  } catch {
    // The next event brings the finished file.
  }
}

async function startServeMode(select?: string): Promise<boolean> {
  const info = await serve.detectServer();
  if (!info) return false;
  setServe({ info });
  const ok = await loadServedProject('system', true, select);
  serve.followEvents({
    file: (e) => void onFileEvent(e),
    project: (e) => void onProjectEvent(e),
    review: () => void loadServedReview(),
    play: async (e) => {
      if (e.path && !(await openServeFile(e.path))) return;
      const played = await playNow();
      editor().log('agent', played ? 'played the sound' : 'asked to play: click anywhere to let audio start');
      if (!played) editor().toast('The agent wants you to hear this: press play');
    },
    focus: async (e) => {
      if (e.path && !(await openServeFile(e.path))) return;
      if (e.control) editor().focusControl(e.control);
    },
  });
  return ok;
}

// ---- Review and takes -------------------------------------------------------------------------

const reviewStorageKey = (id: string) => `sfxgen:review:${id}`;

/** The review kept in the browser for the open browser project. */
function loadBrowserReview(): void {
  const id = editor().library.current;
  useEditor.setState({ review: readReview(id ? readJson(reviewStorageKey(id)) : null), takes: {} });
}

/** Verdicts sent to the server and not answered yet: until they are, the server's copy is behind the editor's. */
let verdictsPending = 0;
let verdictQueue: Promise<void> = Promise.resolve();

async function loadServedReview(): Promise<void> {
  const review = await serve.readReview().catch(() => null);
  if (review && verdictsPending === 0) useEditor.setState({ review });
}

function setVerdict(key: string, entry: ReviewEntry | null): void {
  useEditor.setState((s) => ({ review: withVerdict(s.review, key, entry) }));
  const s = editor();
  if (!s.serve.info) {
    if (s.library.current) writeJson(reviewStorageKey(s.library.current), s.review);
    return;
  }
  verdictsPending++;
  verdictQueue = verdictQueue.then(async () => {
    try {
      const review = await serve.writeVerdict(key, entry);
      if (verdictsPending === 1) useEditor.setState({ review });
    } catch (err) {
      editor().toast(err instanceof Error ? err.message : 'Could not save the verdict', 'error');
    } finally {
      verdictsPending--;
    }
  });
}

/**
 * Approves the open sound, or flags it as needing work, with whatever the person changed before deciding; the lit
 * verdict pressed again clears it. Then the next sound nobody has reviewed opens and plays.
 */
export function giveVerdict(kind: ReviewVerdict): void {
  const s = editor();
  const sound = s.project.sounds[s.current];
  if (!sound) return;
  const name = patchOf(sound).name || soundName(sound);
  if (statusOf(s, sound) === kind) {
    setVerdict(reviewKey(sound), null);
    s.log('human', `took back the verdict on “${name}”`);
    return;
  }
  const changes = changesOf(s, sound);
  const take = takeInUse(s, sound);
  setVerdict(reviewKey(sound), {
    status: kind,
    at: new Date().toISOString(),
    version: reviewVersion(s, sound),
    ...(take ? { take: take.take.label } : {}),
    ...(changes.length ? { changes } : {}),
  });
  const n = changes.length ? ` with ${changes.length} change${changes.length === 1 ? '' : 's'}` : '';
  s.log('human', kind === 'approved' ? `approved “${name}”${n}` : `flagged “${name}” as needing work${n}`);
  const next = nextUnreviewed(editor(), editor().current);
  if (next >= 0) pressPad(next);
  else s.toast('Every sound has a verdict');
}

export function openNextUnreviewed(): void {
  const s = editor();
  const next = nextUnreviewed(s, s.current);
  if (next >= 0) pressPad(next);
  else s.toast('Every sound has a verdict');
}

/** Take files as last read, by path, so an unchanged take keeps its patch object (and its cached version). */
const takeCache = new Map<string, { mtime?: number; patch: Patch }>();
let takesTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshTakes(): Promise<void> {
  const listing = await serve.listTakes().catch(() => null);
  if (!listing) return;
  const takes: Record<string, Take[]> = {};
  await Promise.all(
    Object.entries(listing).flatMap(([owner, files]) =>
      files.map(async (f) => {
        let cached = takeCache.get(f.path);
        if (!cached || cached.mtime !== f.mtime) {
          try {
            const raw = await serve.readFile(f.path);
            if (!validatePatch(raw).ok) return;
            cached = { mtime: f.mtime, patch: raw as Patch };
            takeCache.set(f.path, cached);
            onDisk.set(f.path, JSON.stringify(raw));
          } catch {
            return;
          }
        }
        (takes[owner] ??= []).push({ path: f.path, label: takeLabel(f.path), patch: cached.patch });
      }),
    ),
  );
  for (const list of Object.values(takes)) list.sort((a, b) => a.path.localeCompare(b.path));
  useEditor.setState({ takes });
}

function scheduleTakesRefresh(): void {
  if (takesTimer) clearTimeout(takesTimer);
  takesTimer = setTimeout(() => void refreshTakes(), 150);
}

/**
 * Puts a take into its sound's file, opens the sound and plays it. Nothing is lost: when the sound holds a version
 * none of its takes has (the person's changes to a take, or an agent's write), that version goes back into the
 * take it came from, or becomes a take of its own.
 */
export async function pickTake(index: number, path: string): Promise<void> {
  const s = editor();
  const sound = s.project.sounds[index];
  const takes = takesOf(s, sound);
  const take = takes.find((t) => t.path === path);
  if (!sound?.file || !take) return;
  const current = patchOf(sound);
  if (!takes.some((t) => versionOf(t.patch) === versionOf(current))) {
    const target = takeInUse(s, sound)?.take.path ?? takeFileFor(sound.file, 'original', takes.map((t) => t.path));
    try {
      const written = forDisk(current);
      onDisk.set(target, JSON.stringify(written));
      await serve.writeFile(target, written, 'human');
    } catch (err) {
      s.toast(err instanceof Error ? err.message : 'Could not keep the current version as a take', 'error');
      return;
    }
  }
  if (index !== editor().current) editor().openSound(index);
  if (versionOf(take.patch) !== versionOf(current)) editor().load(deepClone(take.patch), { origin: 'human', index, note: `took “${take.label}”`, rebase: true });
  void playNow();
  await refreshTakes();
}

export function stepTake(dir: 1 | -1): void {
  const s = editor();
  const sound = s.project.sounds[s.current];
  const takes = takesOf(s, sound);
  if (!sound || takes.length === 0) return;
  const inUse = takeInUse(s, sound);
  const at = inUse ? takes.indexOf(inUse.take) : -1;
  const next = at < 0 ? (dir > 0 ? 0 : takes.length - 1) : (at + dir + takes.length) % takes.length;
  if (inUse && next === at && !inUse.changed) return;
  useEditor.setState({ takesOpen: { ...s.takesOpen, [soundKey(sound)]: true } });
  void pickTake(s.current, takes[next].path);
}

export function toggleTakes(index: number): void {
  const s = editor();
  const sound = s.project.sounds[index];
  if (!sound) return;
  const key = soundKey(sound);
  useEditor.setState({ takesOpen: { ...s.takesOpen, [key]: !s.takesOpen[key] } });
}

// ---- Start-up ---------------------------------------------------------------------------------

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17181b' : '#e4e5e7');
}

async function requestSpectrogram(): Promise<void> {
  const grid = await renderClient.spectrogram(SPECTRO_W, SPECTRO_H).catch(() => null);
  if (grid) useEditor.setState({ spectro: grid });
}

let started = false;

export async function start(): Promise<void> {
  if (started) return;
  started = true;
  applyTheme(editor().theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (followsSystemTheme()) useEditor.setState({ theme: e.matches ? 'dark' : 'light' });
  });

  renderClient.listen({
    onStart: () => useEditor.setState({ rendering: true }),
    onResult: (view) => {
      useEditor.setState({ view, rendering: false, renderError: null });
      // Whatever changed while the open sound plays (a knob, mute, undo) reaches the ears at the same position.
      if (voice === 'live' && player.playing && editor().playingKey === currentKey()) player.swap(view, !!editor().patch.loop);
      if (editor().stageView === 'spectro') void requestSpectrogram();
    },
    onError: (message) => useEditor.setState({ rendering: false, renderError: message }),
  });
  player.subscribe((playing) => useEditor.setState(playing ? { playing } : { playing, playingKey: null }));
  addEventListener('pagehide', saveBeforeLeaving);

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let liveKey = '';
  useEditor.subscribe((s, prev) => {
    if (s.theme !== prev.theme) applyTheme(s.theme);
    if (s.stageView !== prev.stageView && s.stageView === 'spectro') void requestSpectrogram();
    if (s.project === prev.project && s.current === prev.current) return;
    if (s.serve.info) rememberOpenSound();
    const sound = s.project.sounds[s.current];
    if (sound) {
      // The open sound renders as the project hears it: its output, levelling, shared chain and gain.
      const patch = projectPatch(s.project, sound, s.patch);
      const key = `${sound.gain ?? 0}|${JSON.stringify(patch)}`;
      if (key !== liveKey) {
        liveKey = key;
        renderClient.live(patch, sound.gain ?? 0);
      }
    }
    if (s.project === prev.project) return;
    // A fader moved under a sound playing from the cache: its level follows at once.
    if (voice === 'cached' && s.playingKey) {
      const playing = s.project.sounds.find((x) => soundKey(x) === s.playingKey);
      const before = prev.project.sounds.find((x) => soundKey(x) === s.playingKey);
      if (playing && (playing.gain ?? 0) !== (before?.gain ?? 0)) player.setGain(playing.gain ?? 0);
    }
    scheduleMeasure();
    if (s.serve.info) {
      if (s.lastOrigin === 'human') scheduleServeSaves(prev.project, s.project);
    } else {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(persistBrowserProject, 400);
    }
  });

  // What to open: the server's project when there is one; else a shared link, then what was open last, then a
  // starter set. The server check is quick and local, so the first paint waits for it rather than flashing a
  // browser project that the folder then replaces.
  const params = new URLSearchParams(location.search);
  let shared: Patch | null = null;
  try {
    const decoded = await decodePatchHash(location.hash);
    if (decoded) shared = accept(decoded, 'Shared link');
    // The link has done its job; left in place it would reopen on every reload.
    if (decoded) history.replaceState(null, '', location.pathname + location.search);
  } catch {
    editor().toast('That share link is damaged', 'error');
  }

  const served = await startServeMode(params.get('file') ?? undefined);
  if (served && shared) void addSoundToProject(shared, `opened a shared link: “${shared.name}”`);
  if (!served) {
    // With a server but an empty folder the starter set is only a place to begin: nothing is written until a sound
    // is added.
    if (editor().serve.info) editor().toast('This folder has no sounds yet: add one from the gallery');
    bootBrowserProject(shared);
  }

  // The agent tools (with the guide and analysis they carry) load after the first paint, in their own chunk.
  const workspace = createBrowserWorkspace();
  // For debugging and browser tests in development: the store and the workspace the tools act on.
  if (import.meta.env.DEV) Object.assign(window, { __sfxgen: { store: useEditor, workspace, player, play: { playSound, audition, stop } } });
  void import('../web/webmcp')
    .then(({ installWebMcpShim, registerWebMcp }) => {
      if (params.get('webmcp') === 'shim') installWebMcpShim();
      return registerWebMcp(workspace);
    })
    .then((h) => useEditor.setState({ webmcp: { api: h.api, count: h.count } }))
    .catch(() => useEditor.setState({ webmcp: { api: 'none', count: 0 } }));
}

// ---- Keyboard ---------------------------------------------------------------------------------

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button'].includes(target.type);
}

export function onGlobalKey(e: KeyboardEvent): void {
  const s = editor();
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    if (isTyping(e.target)) return;
    e.preventDefault();
    if (e.shiftKey) s.redo();
    else s.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !isTyping(e.target)) {
    e.preventDefault();
    s.redo();
    return;
  }
  if (e.key === 'Escape') {
    if (s.gallery.open || s.exportOpen || s.projectsOpen || s.webmcpOpen || s.buildRows) {
      useEditor.setState({ gallery: { ...s.gallery, open: false }, exportOpen: false, projectsOpen: false, webmcpOpen: false, buildRows: null });
    }
    return;
  }
  if (mod || e.altKey || isTyping(e.target)) return;
  const key = e.key.toLowerCase();
  if (e.key === ' ' || e.code === 'Space') {
    // Space always plays, even with a button focused (Enter still presses the button).
    e.preventDefault();
    togglePlay();
  } else if (/^[0-9]$/.test(e.key)) {
    // Number keys are the pads: 1 to 9, then 0 for the tenth.
    const index = e.key === '0' ? 9 : Number(e.key) - 1;
    if (s.project.sounds[index]) pressPad(index);
  } else if (key === 'g') {
    useEditor.setState({ gallery: { open: !s.gallery.open, mode: 'replace' } });
  } else if (key === 'e') {
    s.showSurface('sound');
  } else if (key === 'm') {
    s.showSurface(s.fullOpen && s.surface === 'mixer' ? 'sound' : 'mixer');
  } else if (key === 'a') {
    giveVerdict('approved');
  } else if (key === 'n') {
    giveVerdict('needs-work');
  } else if (e.key === '[' || e.key === ']') {
    stepTake(e.key === ']' ? 1 : -1);
  }
}

// See the end of store.ts: a hot update to the controller reloads the page rather than starting a second editor.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
