/**
 * Everything the editor does besides holding state: rendering on every change, playback, autosave, files, share
 * links, the local server and WebMCP. Components call these functions; the store stays plain data.
 */
import { takeFileName, validatePatch, variationTakes, type Patch } from '../core';
import { getTemplate, listTemplates } from '../core/templates';
import { player } from './audio';
import { anotherTake, fileNameFor, surprise } from './lib/patchOps';
import { decodePatchHash, encodePatchHash } from './lib/share';
import { renderClient } from './renderClient';
import * as serve from './serve';
import { editor, followsSystemTheme, useEditor, type Origin } from './store';
import { createBrowserWorkspace } from './workspace';

const AUTOSAVE_KEY = 'sfxgen:autosave';
const SPECTRO_W = 360;
const SPECTRO_H = 128;

// ---- Playback ---------------------------------------------------------------------------------

/** Plays the open patch once its render is up to date. Returns false when the browser refused audio. */
export async function playNow(from = 0): Promise<boolean> {
  // Unlock inside the gesture, before waiting for anything.
  const unlocked = player.unlock();
  await renderClient.idle();
  const { view, patch } = editor();
  if (!view || !(await unlocked)) return false;
  return player.play(view, from, !!patch.loop);
}

export function stop(): void {
  player.stop();
}

export function togglePlay(): void {
  if (player.playing) stop();
  else void playNow();
}

/** After a knob is released: play, when the person wants that. */
export function audition(): void {
  if (editor().autoAudition) void playNow();
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

export function loadTemplate(id: string): void {
  const patch = getTemplate(id);
  if (!patch) return;
  unbindFile();
  editor().load(patch, { origin: 'system', note: `loaded template “${patch.name}”`, fresh: true });
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

export async function importFile(file: File): Promise<void> {
  try {
    const patch = accept(JSON.parse(await file.text()), file.name);
    if (!patch) return;
    unbindFile();
    editor().load(patch, { origin: 'system', note: `opened ${file.name}`, fresh: true });
    void playNow();
  } catch {
    editor().toast(`${file.name} is not valid JSON`, 'error');
  }
}

export function exportJson(): void {
  const { patch } = editor();
  downloadBytes(`${JSON.stringify(patch, null, 2)}\n`, `${fileNameFor(patch)}.sfx.json`, 'application/json');
  editor().showStamp('Saved');
}

export interface ExportOptions {
  bitDepth: 16 | 24 | 32;
  channels: 1 | 2;
  sampleRate: number;
  /** 1 exports the patch as it is; more adds varied takes. */
  takes: number;
  /** Serve mode: write beside the patch instead of downloading. */
  toFolder: boolean;
}

export async function exportWav(opts: ExportOptions): Promise<void> {
  const s = editor();
  const { patch } = s;
  const base = fileNameFor(patch);
  const takes = variationTakes(patch, opts.takes);
  const folder = opts.toFolder && s.serve.info && s.serve.path ? s.serve.path.replace(/[^/]*$/, '') : null;
  const stem = folder !== null && s.serve.path ? s.serve.path.replace(/^.*\//, '').replace(/\.sfx\.json$|\.json$/, '') : base;
  try {
    for (let take = 0; take < opts.takes; take++) {
      const p = takes[take];
      const { bytes } = await renderClient.wav(p, { sampleRate: opts.sampleRate, channels: opts.channels }, opts.bitDepth);
      const name = takeFileName(stem, take, opts.takes);
      if (folder !== null) await serve.writeWav(`${folder}${name}`, bytes);
      else downloadBytes(bytes, name, 'audio/wav');
    }
    s.showStamp('Exported');
    s.log('human', opts.takes > 1 ? `exported ${opts.takes} takes as WAV` : `exported ${stem}.wav`);
  } catch (err) {
    s.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

export async function copyShareLink(): Promise<void> {
  const s = editor();
  try {
    const hash = await encodePatchHash(s.patch);
    const url = `${location.origin}${location.pathname}#${hash}`;
    history.replaceState(null, '', `#${hash}`);
    try {
      await navigator.clipboard.writeText(url);
      s.toast(`Link copied (${url.length.toLocaleString()} characters)`);
    } catch {
      s.toast('The link is in the address bar: copy it from there');
    }
  } catch {
    s.toast('This browser cannot make share links', 'error');
  }
}

// ---- Local server -----------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** JSON of what the editor last read from or wrote to the bound file, so its own saves don't echo back. */
let onDisk = '';

function unbindFile(): void {
  const s = editor();
  if (!s.serve.path) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  useEditor.setState({ serve: { ...s.serve, path: null, save: 'idle' } });
  const url = new URL(location.href);
  url.searchParams.delete('file');
  history.replaceState(null, '', url);
}

export async function openServeFile(path: string, origin: Origin = 'system'): Promise<boolean> {
  const s = editor();
  try {
    const patch = accept(await serve.readFile(path), path);
    if (!patch) return false;
    const same = s.serve.path === path;
    onDisk = JSON.stringify(patch);
    useEditor.setState({ serve: { ...editor().serve, path, save: 'saved' } });
    editor().load(patch, same ? { origin } : { origin, note: `opened ${path}`, fresh: true });
    const url = new URL(location.href);
    url.searchParams.set('file', path);
    url.hash = '';
    history.replaceState(null, '', url);
    return true;
  } catch (err) {
    s.toast(err instanceof Error ? err.message : `could not open ${path}`, 'error');
    return false;
  }
}

export async function refreshFiles(): Promise<void> {
  try {
    const files = await serve.listFiles();
    useEditor.setState({ serve: { ...editor().serve, files } });
  } catch {
    // The list is a convenience; the open file still works.
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const s = editor();
    const path = s.serve.path;
    if (!path) return;
    const json = JSON.stringify(s.patch);
    if (json === onDisk) return;
    useEditor.setState({ serve: { ...s.serve, save: 'saving' } });
    try {
      onDisk = json;
      await serve.writeFile(path, s.patch, 'human');
      if (editor().serve.path === path) useEditor.setState({ serve: { ...editor().serve, save: 'saved' } });
    } catch (err) {
      onDisk = '';
      useEditor.setState({ serve: { ...editor().serve, save: 'error' } });
      s.toast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  }, 350);
}

async function onFileEvent(e: { path: string; origin?: string; deleted?: boolean }): Promise<void> {
  const s = editor();
  if (e.path !== s.serve.path) {
    void refreshFiles();
    return;
  }
  if (e.deleted) {
    s.toast(`${e.path} was deleted on disk; your next edit saves it again`);
    onDisk = '';
    return;
  }
  try {
    const incoming = await serve.readFile(e.path);
    const json = JSON.stringify(incoming);
    // Our own save coming back, or nothing new.
    if (json === onDisk || json === JSON.stringify(editor().patch)) {
      onDisk = json;
      return;
    }
    const patch = accept(incoming, e.path);
    if (!patch) return;
    onDisk = json;
    // `agent` is an agent's PUT; anything else is the file changing on disk (an agent's editor, git, another tab).
    editor().load(patch, { origin: e.origin === 'agent' ? 'agent' : 'file' });
    audition();
  } catch {
    // Caught mid-write; the next event brings the finished file.
  }
}

async function startServeMode(): Promise<boolean> {
  const info = await serve.detectServer();
  if (!info) return false;
  useEditor.setState({ serve: { ...editor().serve, info } });
  await refreshFiles();
  serve.followEvents({
    file: (e) => void onFileEvent(e),
    play: async (e) => {
      if (e.path && e.path !== editor().serve.path) await openServeFile(e.path, 'agent');
      const played = await playNow();
      editor().log('agent', played ? 'played the sound' : 'asked to play: click anywhere to let audio start');
      if (!played) editor().toast('The agent wants you to hear this: press play');
    },
    focus: async (e) => {
      if (e.path && e.path !== editor().serve.path) await openServeFile(e.path, 'agent');
      if (e.control) editor().focusControl(e.control);
    },
  });
  return true;
}

// ---- Start-up ---------------------------------------------------------------------------------

function readAutosave(): Patch | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const patch = JSON.parse(raw) as unknown;
    return validatePatch(patch).ok ? (patch as Patch) : null;
  } catch {
    return null;
  }
}

function firstPatch(): Patch {
  const preferred = getTemplate('scifi/laser-zap') ?? getTemplate(listTemplates()[0]?.id ?? '');
  return preferred ?? editor().patch;
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0b0d' : '#f1f2f4');
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
      if (editor().stageView === 'spectro') void requestSpectrogram();
    },
    onError: (message) => useEditor.setState({ rendering: false, renderError: message }),
  });
  player.subscribe((playing) => useEditor.setState({ playing }));

  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  useEditor.subscribe((s, prev) => {
    if (s.theme !== prev.theme) applyTheme(s.theme);
    if (s.stageView !== prev.stageView && s.stageView === 'spectro') void requestSpectrogram();
    if (s.patch === prev.patch) return;
    renderClient.live(s.patch);
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(editor().patch));
      } catch {
        // Storage is full or blocked; the patch is still in memory and can be exported.
      }
    }, 400);
    if (s.lastOrigin === 'human' && s.serve.path) scheduleSave();
  });

  // What to open: a shared link, then the server's file, then what was open last, then a starter sound.
  const params = new URLSearchParams(location.search);
  let opened = false;
  try {
    const shared = await decodePatchHash(location.hash);
    if (shared) {
      const patch = accept(shared, 'Shared link');
      if (patch) {
        editor().load(patch, { origin: 'system', note: `opened a shared link: “${patch.name}”`, fresh: true });
        opened = true;
        // The link has done its job; left in place it would undo the next edits on reload.
        history.replaceState(null, '', location.pathname + location.search);
      }
    }
  } catch {
    editor().toast('That share link is damaged', 'error');
  }
  // Show a sound at once; the server check must not hold up the first paint.
  if (!opened) {
    const local = params.get('file') ? null : readAutosave();
    const patch = local ?? firstPatch();
    editor().load(patch, { origin: 'system', note: local ? `picked up where you left off: “${patch.name}”` : `opened “${patch.name}”`, fresh: true });
  }

  // The agent tools (with the guide and analysis they carry) load after the first paint, in their own chunk.
  const workspace = createBrowserWorkspace();
  // For debugging and browser tests in development: the store and the workspace the tools act on.
  if (import.meta.env.DEV) Object.assign(window, { __sfxgen: { store: useEditor, workspace } });
  void import('../web/webmcp')
    .then(({ installWebMcpShim, registerWebMcp }) => {
      if (params.get('webmcp') === 'shim') installWebMcpShim();
      return registerWebMcp(workspace);
    })
    .then((h) => useEditor.setState({ webmcp: { api: h.api, count: h.count } }))
    .catch(() => useEditor.setState({ webmcp: { api: 'none', count: 0 } }));

  if (await startServeMode()) {
    const file = params.get('file');
    if (file && !opened) await openServeFile(file);
  }
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
    if (s.galleryOpen || s.exportOpen) useEditor.setState({ galleryOpen: false, exportOpen: false });
    return;
  }
  if (mod || e.altKey || isTyping(e.target)) return;
  if (e.key === ' ' || e.code === 'Space') {
    // Space always plays, even with a button focused (Enter still presses the button).
    e.preventDefault();
    togglePlay();
  } else if (e.key.toLowerCase() === 'g') {
    useEditor.setState({ galleryOpen: !s.galleryOpen });
  } else if (e.key.toLowerCase() === 'e') {
    s.setSettings({ everything: !s.everything });
  }
}
