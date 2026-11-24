/**
 * The editor's state: the patch with its undo history, what is selected and shown, the last render, and the
 * record of who changed what. Side effects (rendering, saving, audio) live in controller.ts and subscribe here.
 */
import { create } from 'zustand';
import type { Patch } from '../core';
import { createHistory, pushHistory, redoHistory, sealHistory, undoHistory, type History } from './lib/history';
import { summarize, touched } from './lib/paths';
import type { RenderView, SpectrogramGrid } from './renderProtocol';

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
  files: { path: string; name: string; mtime?: number }[];
  /** The file the editor is bound to. */
  path: string | null;
  save: 'idle' | 'saving' | 'saved' | 'error';
}

export interface Settings {
  theme: 'light' | 'dark';
  autoAudition: boolean;
  everything: boolean;
  stageView: 'wave' | 'spectro';
}

export const SELECT_MASTER = '@master';

export interface EditorState extends Settings {
  history: History<Patch>;
  patch: Patch;
  /** Who made the last change to the patch. Only a person's changes are saved back to the file. */
  lastOrigin: Origin;
  /** The version an agent last wrote (or the one first opened): what getHumanChanges compares against. */
  baseline: Patch;
  /** The version as loaded, for "reset to the value the patch was saved with". */
  saved: Patch;
  /** A track id, or SELECT_MASTER. */
  selected: string;
  galleryOpen: boolean;
  exportOpen: boolean;
  view: RenderView | null;
  spectro: SpectrogramGrid | null;
  rendering: boolean;
  renderError: string | null;
  playing: boolean;
  activity: Activity[];
  /** Highlighter flashes: `c:<control id>` or `p:<canonical path>` to a nonce that restarts the animation. */
  flash: Record<string, number>;
  focus: { control: string; nonce: number } | null;
  toasts: Toast[];
  stamp: { text: string; nonce: number } | null;
  serve: ServeState;
  webmcp: { api: string; count: number } | 'pending';

  edit(next: Patch | ((p: Patch) => Patch), tag?: string | null): void;
  /** Ends a gesture: the next edit with the same tag is a new undo step. */
  seal(): void;
  /** `fresh`: a different sound was opened (a template, a file), not an edit to this one. */
  load(patch: Patch, opts: { origin: Origin; note?: string; fresh?: boolean }): void;
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
}

let serial = 1;
const nextId = () => serial++;

const SETTINGS_KEY = 'sfxgen:settings';
/** False until the person picks a theme: until then the editor follows the system's light or dark setting. */
let themeChosen = false;
export const followsSystemTheme = () => !themeChosen;

export function loadSettings(): Settings {
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const base: Settings = { theme: prefersDark ? 'dark' : 'light', autoAudition: true, everything: false, stageView: 'wave' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<Settings>;
    themeChosen = s.theme === 'dark' || s.theme === 'light';
    return {
      theme: s.theme === 'dark' || s.theme === 'light' ? s.theme : base.theme,
      autoAudition: typeof s.autoAudition === 'boolean' ? s.autoAudition : base.autoAudition,
      everything: typeof s.everything === 'boolean' ? s.everything : base.everything,
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

const EMPTY: Patch = { format: 'sfxgen/1', name: 'Untitled', duration: 'auto', tracks: [{ id: 'tone', source: { type: 'osc' } }] };

export const useEditor = create<EditorState>()((set, get) => ({
  ...loadSettings(),
  history: createHistory(EMPTY),
  patch: EMPTY,
  lastOrigin: 'system',
  baseline: EMPTY,
  saved: EMPTY,
  selected: 'tone',
  galleryOpen: false,
  exportOpen: false,
  view: null,
  spectro: null,
  rendering: false,
  renderError: null,
  playing: false,
  activity: [],
  flash: {},
  focus: null,
  toasts: [],
  stamp: null,
  serve: { info: null, files: [], path: null, save: 'idle' },
  webmcp: 'pending',

  edit(next, tag = null) {
    const s = get();
    const patch = typeof next === 'function' ? next(s.patch) : next;
    if (patch === s.patch) return;
    const history = pushHistory(s.history, patch, tag, Date.now());
    set({ history, patch, lastOrigin: 'human', selected: keepSelection(patch, s.selected) });
  },

  seal() {
    set((s) => ({ history: sealHistory(s.history) }));
  },

  load(patch, { origin, note, fresh }) {
    const s = get();
    const outside = origin === 'agent' || origin === 'file';
    const t = outside && !fresh ? touched(s.patch, patch) : null;
    // Opening another sound is undoable too: a template clicked by mistake must not cost the work before it.
    const history = s.patch === EMPTY ? createHistory(patch) : pushHistory(sealHistory(s.history), patch, null, Date.now());
    const flash = { ...s.flash };
    if (t) {
      const nonce = nextId();
      for (const id of t.controls) flash[`c:${id}`] = nonce;
      for (const p of t.paths) flash[`p:${p}`] = nonce;
    }
    // A wholly different sound is one event, not a list of every field that differs.
    const kept = patch.tracks.some((x) => s.patch.tracks.some((y) => y.id === x.id));
    const text = note ?? (t ? (kept ? summarize(t.changes) : `wrote a new patch: “${patch.name}”`) : `opened “${patch.name}”`);
    set({
      history,
      patch,
      lastOrigin: origin,
      baseline: origin === 'human' ? s.baseline : patch,
      saved: fresh ? patch : s.saved,
      selected: keepSelection(patch, fresh ? '' : s.selected),
      flash,
      activity: [{ id: nextId(), at: Date.now(), origin, text }, ...s.activity].slice(0, 60),
    });
  },

  undo() {
    const s = get();
    const history = undoHistory(s.history);
    if (history !== s.history) set({ history, patch: history.present, lastOrigin: 'human', selected: keepSelection(history.present, s.selected) });
  },

  redo() {
    const s = get();
    const history = redoHistory(s.history);
    if (history !== s.history) set({ history, patch: history.present, lastOrigin: 'human', selected: keepSelection(history.present, s.selected) });
  },

  select(id) {
    set({ selected: id });
  },

  log(origin, text) {
    set((s) => ({ activity: [{ id: nextId(), at: Date.now(), origin, text }, ...s.activity].slice(0, 60) }));
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
    set((s) => ({ focus: { control: id, nonce: nextId() }, flash: { ...s.flash, [`c:${id}`]: nextId() } }));
  },

  showStamp(text) {
    set({ stamp: { text, nonce: nextId() } });
  },

  setSettings(partial) {
    if (partial.theme) themeChosen = true;
    set(partial);
    const { theme, autoAudition, everything, stageView } = get();
    saveSettings({ theme, autoAudition, everything, stageView });
  },
}));

export const editor = () => useEditor.getState();
