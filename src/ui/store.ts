/**
 * The editor's state. The editor always edits a project (a lone patch is a project of one): the project with its
 * undo history, which sound is open, what is shown, the last render, and the record of who changed what.
 * Side effects (rendering, saving, audio) live in controller.ts and subscribe here.
 */
import { create } from 'zustand';
import { emptyReview, soundName, type Patch, type Project, type ProjectSound, type Review } from '../core';
import { createHistory, pushHistory, redoHistory, sealHistory, undoHistory, type History } from './lib/history';
import { diffValues, summarize, touched } from './lib/paths';
import { EMPTY_PATCH, patchOf, projectOfOne, setSoundPatch, soundKey, type Measured } from './lib/projectOps';
import type { RenderView, SpectrogramGrid } from './renderProtocol';
import type { ProjectBuildRow } from '../core/agent/workspace';

export type Origin = 'human' | 'agent' | 'file' | 'system';

export interface Activity {
  id: number;
  at: number;
  origin: Origin;
  text: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface ServeState {
  /** null: not checked yet or no server. */
  info: { version?: string; root?: string } | null;
  /** The project file, when the server has one. */
  projectPath: string | null;
  /** False: the folder's patches shown as a project that has no file yet. */
  projectSaved: boolean;
  save: 'idle' | 'saving' | 'saved' | 'error';
}

/** Projects kept in this browser. */
export interface Library {
  current: string;
  items: { id: string; name: string }[];
}

export interface Settings {
  theme: 'light' | 'dark';
  /** Full control is open. It starts closed: the display and the easy controls are enough to begin with. */
  fullOpen: boolean;
  stageView: 'wave' | 'spectro';
}

export type Surface = 'sound' | 'mixer' | 'project' | 'notes';

/** Another version of a sound, kept in `<name>.takes/` next to its file (served folders only). */
export interface Take {
  /** The take's file, relative to the served folder. */
  path: string;
  label: string;
  patch: Patch;
}

export const SELECT_MASTER = '@master';

export interface EditorState extends Settings {
  history: History<Project>;
  /** The open project, every sound carrying its patch. */
  project: Project;
  /** Index of the open sound. */
  current: number;
  /** The open sound's patch (`project.sounds[current].patch`). */
  patch: Patch;
  /** Who made the last change. Only a person's changes are saved back to files. */
  lastOrigin: Origin;
  /** The versions an agent last wrote (or the ones first opened): what getHumanChanges compares against. */
  baseline: Project;
  /** The project as loaded, for "reset to the saved value" and the pads' edited LEDs. */
  saved: Project;
  /** A track id, or SELECT_MASTER. */
  selected: string;
  surface: Surface;
  gallery: { open: boolean; mode: 'replace' | 'add' };
  exportOpen: boolean;
  projectsOpen: boolean;
  /** The WebMCP key's panel: status and how to turn it on. */
  webmcpOpen: boolean;
  buildRows: ProjectBuildRow[] | null;
  view: RenderView | null;
  spectro: SpectrogramGrid | null;
  rendering: boolean;
  renderError: string | null;
  playing: boolean;
  /** The sound that is sounding now (a pad's playing LED). */
  playingKey: string | null;
  /** Loudness, peak and a small waveform per sound key, measured in project context. */
  measured: Record<string, Measured>;
  /** Sounds an agent or a file change touched since the person last opened them. */
  padTouched: Record<string, number>;
  /** The control under the pointer or being turned: the display shows where it acts. */
  activeControl: string | null;
  activity: Activity[];
  /** Highlights: `c:<control id>` or `p:<canonical path>` to a nonce that restarts the animation. */
  flash: Record<string, number>;
  focus: { control: string; nonce: number } | null;
  toasts: Toast[];
  stamp: { text: string; nonce: number } | null;
  serve: ServeState;
  library: Library;
  webmcp: { api: string; count: number } | 'pending';
  /** Who approved what (src/core/project/review.ts): the served folder's sfxgen.review.json, or the browser's copy. */
  review: Review;
  /** Each sound's takes, by its file. */
  takes: Record<string, Take[]>;
  /** Sounds whose takes are shown under their pad, by sound key. */
  takesOpen: Record<string, boolean>;

  /** A person's edit to the open sound's patch. */
  edit(next: Patch | ((p: Patch) => Patch), tag?: string | null): void;
  /** A person's edit to the project (levels, groups, settings, the list of sounds). */
  editProject(next: Project | ((p: Project) => Project), tag?: string | null, select?: number): void;
  /** Ends a gesture: the next edit with the same tag is a new undo step. */
  seal(): void;
  /**
   * Replaces one sound's patch from outside the knobs. `fresh`: a different sound took its place (a template), not
   * an edit to it. `rebase`: the person's changes count from this version on (a take they picked). `index` defaults
   * to the open sound.
   */
  load(patch: Patch, opts: { origin: Origin; note?: string; fresh?: boolean; index?: number; rebase?: boolean }): void;
  /** Replaces the project. `fresh`: another project was opened (history starts over). */
  loadProject(project: Project, opts: { origin: Origin; note?: string; fresh?: boolean; select?: number }): void;
  openSound(index: number): void;
  undo(): void;
  redo(): void;
  select(id: string): void;
  log(origin: Origin, text: string): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  flashKeys(keys: string[]): void;
  focusControl(id: string): void;
  showStamp(text: string): void;
  setSettings(s: Partial<Settings>): void;
  /** Opens full control on the sound, the mixer, the project or the notes. */
  showSurface(surface: Surface): void;
}

let serial = 1;
const nextId = () => serial++;

const SETTINGS_KEY = 'sfxgen:settings';
/** False until the person picks a theme: until then the editor follows the system's light or dark setting. */
let themeChosen = false;
export const followsSystemTheme = () => !themeChosen;

export function loadSettings(): Settings {
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const base: Settings = { theme: prefersDark ? 'dark' : 'light', fullOpen: false, stageView: 'wave' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<Settings>;
    themeChosen = s.theme === 'dark' || s.theme === 'light';
    return {
      theme: s.theme === 'dark' || s.theme === 'light' ? s.theme : base.theme,
      fullOpen: typeof s.fullOpen === 'boolean' ? s.fullOpen : base.fullOpen,
      stageView: s.stageView === 'spectro' ? 'spectro' : 'wave',
    };
  } catch {
    return base;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(themeChosen ? s : { ...s, theme: undefined }));
  } catch {
    // Private mode or a full disk: settings just don't persist.
  }
}

function keepSelection(patch: Patch, selected: string): string {
  if (selected === SELECT_MASTER || patch.tracks.some((t) => t.id === selected)) return selected;
  return patch.tracks[0]?.id ?? SELECT_MASTER;
}

const EMPTY: Project = projectOfOne(EMPTY_PATCH);

/** `base` with this sound's version recorded under its key (sounds are matched by key, not by position). */
function remember(base: Project, sound: ProjectSound): Project {
  const key = soundKey(sound);
  const at = base.sounds.findIndex((x) => soundKey(x) === key);
  return { ...base, sounds: at < 0 ? [...base.sounds, sound] : base.sounds.map((x, i) => (i === at ? sound : x)) };
}

/** The version of a sound in `base` (the baseline or the saved project), by key. */
export function versionIn(base: Project, sound: ProjectSound | undefined): ProjectSound | undefined {
  if (!sound) return undefined;
  const key = soundKey(sound);
  return base.sounds.find((x) => soundKey(x) === key);
}

/** The project without its patches, sounds named, so a diff reads "sounds.thud.gain 0 → -3". */
function shell(project: Project): unknown {
  return { ...project, sounds: project.sounds.map(({ patch: _patch, file: _file, ...rest }) => ({ id: soundName({ patch: _patch, file: _file }), ...rest })) };
}

function describeProjectChange(before: Project, after: Project): string {
  const changes = diffValues(shell(before), shell(after));
  if (changes.length > 0) return `project: ${summarize(changes)}`;
  const changed = after.sounds.filter((x, i) => x.patch !== before.sounds[i]?.patch).length;
  return changed ? `changed ${changed} sound${changed === 1 ? '' : 's'}` : 'rewrote the project (nothing differs)';
}

/** After undo or redo: the sound whose patch changed, so the person sees what came back. */
function changedSound(before: Project, after: Project, current: number): number {
  if (after.sounds[current] && before.sounds[current]?.patch === after.sounds[current].patch && before.sounds.length === after.sounds.length) {
    const other = after.sounds.findIndex((s, i) => s.patch !== before.sounds[i]?.patch);
    return other >= 0 ? other : current;
  }
  return Math.min(current, after.sounds.length - 1);
}

export const useEditor = create<EditorState>()((set, get) => {
  /** The fields that follow from a project and the open sound. */
  const opened = (project: Project, index: number, selected: string) => {
    const current = Math.max(0, Math.min(index, project.sounds.length - 1));
    const patch = patchOf(project.sounds[current]);
    return { project, current, patch, selected: keepSelection(patch, selected) };
  };
  const logged = (origin: Origin, text: string) => [{ id: nextId(), at: Date.now(), origin, text }, ...get().activity].slice(0, 60);

  return {
    ...loadSettings(),
    history: createHistory(EMPTY),
    project: EMPTY,
    current: 0,
    patch: EMPTY_PATCH,
    lastOrigin: 'system',
    baseline: EMPTY,
    saved: EMPTY,
    selected: 'tone',
    surface: 'sound',
    gallery: { open: false, mode: 'replace' },
    exportOpen: false,
    projectsOpen: false,
    webmcpOpen: false,
    buildRows: null,
    view: null,
    spectro: null,
    rendering: false,
    renderError: null,
    playing: false,
    playingKey: null,
    measured: {},
    padTouched: {},
    activeControl: null,
    activity: [],
    flash: {},
    focus: null,
    toasts: [],
    stamp: null,
    serve: { info: null, projectPath: null, projectSaved: false, save: 'idle' },
    library: { current: '', items: [] },
    webmcp: 'pending',
    review: emptyReview(),
    takes: {},
    takesOpen: {},

    edit(next, tag = null) {
      const s = get();
      const patch = typeof next === 'function' ? next(s.patch) : next;
      if (patch === s.patch) return;
      const project = setSoundPatch(s.project, s.current, patch);
      const history = pushHistory(s.history, project, tag === null ? null : `${s.current}:${tag}`, Date.now());
      set({ history, lastOrigin: 'human', ...opened(project, s.current, s.selected) });
    },

    editProject(next, tag = null, select) {
      const s = get();
      const project = typeof next === 'function' ? next(s.project) : next;
      if (project === s.project) return;
      const history = pushHistory(s.history, project, tag === null ? null : `project:${tag}`, Date.now());
      set({ history, lastOrigin: 'human', ...opened(project, select ?? s.current, select === undefined ? s.selected : '') });
    },

    seal() {
      set((s) => ({ history: sealHistory(s.history) }));
    },

    load(patch, { origin, note, fresh, index, rebase }) {
      const s = get();
      const at = index ?? s.current;
      const sound = s.project.sounds[at];
      if (!sound) return;
      const isOpen = at === s.current;
      const outside = origin === 'agent' || origin === 'file';
      const before = patchOf(sound);
      const t = outside && !fresh ? touched(before, patch) : null;
      const project = setSoundPatch(s.project, at, patch);
      // The placeholder the editor starts with is not a version worth keeping.
      const first = s.project === EMPTY;
      // Opening another sound is undoable too: a template clicked by mistake must not cost the work before it.
      const history = first ? createHistory(project) : pushHistory(sealHistory(s.history), project, null, Date.now());
      const flash = { ...s.flash };
      if (t && isOpen) {
        const nonce = nextId();
        for (const id of t.controls) flash[`c:${id}`] = nonce;
        for (const p of t.paths) flash[`p:${p}`] = nonce;
      }
      // A wholly different sound is one event, not a list of every field that differs.
      const kept = patch.tracks.some((x) => before.tracks.some((y) => y.id === x.id));
      const where = isOpen ? '' : `${soundKey(project.sounds[at])}: `;
      const text = note ?? (t ? where + (kept ? summarize(t.changes) : `wrote a new patch: “${patch.name}”`) : `opened “${patch.name}”`);
      set({
        history,
        lastOrigin: origin,
        baseline: first ? project : origin === 'human' && !rebase ? s.baseline : remember(s.baseline, project.sounds[at]),
        saved: first ? project : fresh ? remember(s.saved, project.sounds[at]) : s.saved,
        ...opened(project, s.current, fresh && isOpen ? '' : s.selected),
        flash,
        padTouched: outside && !isOpen ? { ...s.padTouched, [soundKey(project.sounds[at])]: nextId() } : s.padTouched,
        activity: logged(origin, text),
      });
    },

    loadProject(project, { origin, note, fresh, select }) {
      const s = get();
      const first = fresh || s.project === EMPTY;
      const history = first ? createHistory(project) : pushHistory(sealHistory(s.history), project, null, Date.now());
      // Keep the same sound open when it is still there.
      const openKey = s.project.sounds[s.current] ? soundKey(s.project.sounds[s.current]) : '';
      const same = project.sounds.findIndex((x) => soundKey(x) === openKey);
      const index = select ?? (first || same < 0 ? 0 : same);
      const outside = origin === 'agent' || origin === 'file';
      const padTouched = { ...(first ? {} : s.padTouched) };
      if (outside && !first) {
        const before = new Map(s.project.sounds.map((x) => [soundKey(x), x]));
        project.sounds.forEach((x, i) => {
          const old = before.get(soundKey(x));
          if (i !== index && (!old || old.patch !== x.patch || (old.gain ?? 0) !== (x.gain ?? 0))) padTouched[soundKey(x)] = nextId();
        });
      }
      set({
        history,
        lastOrigin: origin,
        baseline: origin === 'human' ? s.baseline : project,
        saved: first ? project : s.saved,
        ...opened(project, index, first ? '' : s.selected),
        padTouched,
        measured: first ? {} : s.measured,
        activity: logged(origin, note ?? (first ? `opened project “${project.name}”` : describeProjectChange(s.project, project))),
      });
    },

    openSound(index) {
      const s = get();
      if (!s.project.sounds[index]) return;
      const key = soundKey(s.project.sounds[index]);
      const { [key]: _seen, ...padTouched } = s.padTouched;
      if (index === s.current) {
        if (key in s.padTouched) set({ padTouched });
        return;
      }
      set({ history: sealHistory(s.history), padTouched, activeControl: null, ...opened(s.project, index, '') });
    },

    undo() {
      const s = get();
      const history = undoHistory(s.history);
      if (history === s.history) return;
      set({ history, lastOrigin: 'human', ...opened(history.present, changedSound(s.project, history.present, s.current), s.selected) });
    },

    redo() {
      const s = get();
      const history = redoHistory(s.history);
      if (history === s.history) return;
      set({ history, lastOrigin: 'human', ...opened(history.present, changedSound(s.project, history.present, s.current), s.selected) });
    },

    select(id) {
      set({ selected: id });
    },

    log(origin, text) {
      set({ activity: logged(origin, text) });
    },

    toast(text, tone = 'info') {
      const id = nextId();
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
      setTimeout(() => get().dismissToast(id), tone === 'error' ? 7000 : 3200);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    flashKeys(keys) {
      const nonce = nextId();
      set((s) => ({ flash: { ...s.flash, ...Object.fromEntries(keys.map((k) => [k, nonce])) } }));
    },

    focusControl(id) {
      set((s) => ({ surface: 'sound', focus: { control: id, nonce: nextId() }, flash: { ...s.flash, [`c:${id}`]: nextId() } }));
    },

    showStamp(text) {
      set({ stamp: { text, nonce: nextId() } });
    },

    setSettings(partial) {
      if (partial.theme) themeChosen = true;
      set(partial);
      const { theme, fullOpen, stageView } = get();
      saveSettings({ theme, fullOpen, stageView });
    },

    showSurface(surface) {
      set({ surface });
      if (!get().fullOpen) get().setSettings({ fullOpen: true });
    },
  };
});

export const editor = () => useEditor.getState();
