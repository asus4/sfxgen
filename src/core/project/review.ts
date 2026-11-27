/**
 * Review: which sounds a person has listened to and approved, which need work, and the takes a sound can choose
 * between. It is kept beside the project in `sfxgen.review.json` (or in the browser, for a project kept there), so
 * the editor, the CLI and agents read the same state. What to change is said in the chat with the agent; this file
 * only says which sounds, and what the person changed before deciding.
 *
 * A verdict is for one version of a sound: the patch and its takes, hashed. When either changes (an agent's edit,
 * a file saved on disk, a person's own knob turn, another take picked, a new take), the sound is unreviewed again.
 * A value that a control sets is left out of the hash: every render overrides it, so writing the controls' values
 * into the file (`sync`, or the editor saving a knob turn) changes nothing that was heard and keeps the verdict.
 *
 * Takes are other versions of a sound, kept as patch files in a folder next to it: `door.sfx.json` is the take in
 * use (what builds and exports read) and `door.takes/*.sfx.json` are the takes to choose from. Picking a take copies
 * it into the sound's file. These are not the round-robin variations a WAV export writes (`variationTakes`).
 */
import type { Patch } from '../format/types';
import type { ChangeRecord } from '../agent/workspace';
import { hashString } from '../dsp/rng';
import { deepClone, setPath } from '../format/paths';
import { setPaths } from '../format/sync';
import type { Issue, ValidationResult } from '../format/validate';
import { soundName, type Project, type ProjectSound } from './project';

export const REVIEW_FORMAT_ID = 'sfxgen-review/1' as const;
/** Where the review is kept: next to the project file. */
export const REVIEW_FILE = 'sfxgen.review.json';
/** A sound's takes live in `<name>.takes/` next to its patch file. */
export const TAKES_SUFFIX = '.takes';

export type ReviewVerdict = 'approved' | 'needs-work';
/** `unreviewed`: no verdict, or the sound changed after it. */
export type ReviewStatus = ReviewVerdict | 'unreviewed';

export interface ReviewEntry {
  status: ReviewVerdict;
  /** When the verdict was given (ISO 8601). */
  at: string;
  /** The version it was given for (soundVersion). */
  version: string;
  /** The take in use when it was given, by label. */
  take?: string;
  /** What the person changed before deciding, since the sound was last written by someone else. */
  changes?: ChangeRecord[];
}

export interface Review {
  format: typeof REVIEW_FORMAT_ID;
  /** When an agent last read the verdicts (`sfxgen review`): later verdicts are new to it. */
  read?: string;
  /** Verdicts by sound: its file relative to the project, or its name for a sound kept inline. */
  sounds: Record<string, ReviewEntry>;
}

export function emptyReview(): Review {
  return { format: REVIEW_FORMAT_ID, sounds: {} };
}

/** The key a sound's verdict is kept under. */
export function reviewKey(sound: ProjectSound): string {
  return sound.file ?? soundName(sound);
}

// ---- Versions ---------------------------------------------------------------------------------------

/** JSON with every object's keys sorted, so the same patch hashes the same however it was built or read. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  });
}

function hash64(text: string): string {
  return hashString(text, 0x9e3779b9).toString(16).padStart(8, '0') + hashString(text, 0x85ebca6b).toString(16).padStart(8, '0');
}

/** The patch with every value a control sets blanked: what a render can hear, whether or not the file is synced. */
function heardForm(patch: Patch): unknown {
  const paths = setPaths(patch);
  if (paths.length === 0) return patch;
  const out = deepClone(patch);
  for (const path of paths) setPath(out, path, null);
  return out;
}

/** A short fingerprint of a patch's content, leaving out the values its controls override. */
export function patchVersion(patch: Patch): string {
  return hash64(canonicalJson(heardForm(patch)));
}

/** The version a verdict is for: the sound's patch, and its takes when it has some (in any order). */
export function soundVersion(patch: Patch, takes: readonly Patch[] = []): string {
  return combineVersions(patchVersion(patch), takes.map(patchVersion));
}

/** soundVersion from versions already worked out (the editor keeps them per patch). */
export function combineVersions(own: string, takeVersions: readonly string[]): string {
  return takeVersions.length === 0 ? own : hash64([own, ...[...takeVersions].sort()].join('|'));
}

export function reviewStatus(entry: ReviewEntry | undefined, version: string): ReviewStatus {
  return entry && entry.version === version ? entry.status : 'unreviewed';
}

// ---- Takes ------------------------------------------------------------------------------------------

const stem = (file: string) => file.replace(/\.sfx\.json$/i, '').replace(/\.json$/i, '');

/** The folder holding a sound's takes: `sounds/door.sfx.json` -> `sounds/door.takes`. */
export function takesDirOf(file: string): string {
  return `${stem(file)}${TAKES_SUFFIX}`;
}

/** The sound a take belongs to (`sounds/door.takes/b.sfx.json` -> `sounds/door.sfx.json`), or null for a sound. */
export function takeOwner(path: string): string | null {
  const m = /^(.*?)\.takes\/[^/]+\.sfx\.json$/i.exec(path);
  return m ? `${m[1]}.sfx.json` : null;
}

/** A take's label, from its file name: `darker-throb.sfx.json` -> `darker throb`. */
export function takeLabel(path: string): string {
  return stem(path.replace(/^.*\//, '')).replace(/[-_]+/g, ' ').trim() || 'take';
}

/** A file for a new take of `soundFile`, named from `label` and not one of `taken`. */
export function takeFileFor(soundFile: string, label: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'take';
  for (let i = 1; ; i++) {
    const path = `${takesDirOf(soundFile)}/${i === 1 ? slug : `${slug}-${i}`}.sfx.json`;
    if (!used.has(path.toLowerCase())) return path;
  }
}

// ---- Validation -------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateReviewEntry(input: unknown, path = ''): Issue[] {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (!isObj(input)) return [{ path, message: 'expected { status, at, version }' }];
  const errors: Issue[] = [];
  if (input.status !== 'approved' && input.status !== 'needs-work') errors.push({ path: at('status'), message: 'approved or needs-work' });
  if (typeof input.at !== 'string' || Number.isNaN(Date.parse(input.at))) errors.push({ path: at('at'), message: 'expected an ISO date' });
  if (typeof input.version !== 'string' || !input.version) errors.push({ path: at('version'), message: 'expected the version the verdict is for' });
  if (input.take !== undefined && typeof input.take !== 'string') errors.push({ path: at('take'), message: 'expected a take label' });
  if (input.changes !== undefined && (!Array.isArray(input.changes) || input.changes.some((c) => !isObj(c) || typeof c.path !== 'string'))) {
    errors.push({ path: at('changes'), message: 'expected a list of { path, before, after }' });
  }
  return errors;
}

export function validateReview(input: unknown): ValidationResult {
  const warnings: Issue[] = [];
  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'a review file is a JSON object' }], warnings };
  const errors: Issue[] = [];
  if (input.format !== REVIEW_FORMAT_ID) errors.push({ path: 'format', message: `this version reads "${REVIEW_FORMAT_ID}", not ${JSON.stringify(input.format)}` });
  if (input.read !== undefined && (typeof input.read !== 'string' || Number.isNaN(Date.parse(input.read)))) errors.push({ path: 'read', message: 'expected an ISO date' });
  if (!isObj(input.sounds)) errors.push({ path: 'sounds', message: 'expected an object of verdicts by sound' });
  else for (const [key, entry] of Object.entries(input.sounds)) errors.push(...validateReviewEntry(entry, `sounds.${key}`));
  return { ok: errors.length === 0, errors, warnings };
}

/** A review read from disk or storage: the valid part of it, never a throw. */
export function readReview(input: unknown): Review {
  if (!isObj(input) || !isObj(input.sounds)) return emptyReview();
  const sounds: Record<string, ReviewEntry> = {};
  for (const [key, entry] of Object.entries(input.sounds)) if (validateReviewEntry(entry).length === 0) sounds[key] = entry as unknown as ReviewEntry;
  return { format: REVIEW_FORMAT_ID, ...(typeof input.read === 'string' ? { read: input.read } : {}), sounds };
}

/** The review with one sound's verdict set, or cleared with null. */
export function withVerdict(review: Review, key: string, entry: ReviewEntry | null): Review {
  const sounds = { ...review.sounds };
  if (entry) sounds[key] = entry;
  else delete sounds[key];
  return { ...review, sounds };
}

// ---- The report agents read -------------------------------------------------------------------------

export interface ReviewTake {
  label: string;
  patch: Patch;
}

export interface ReviewRow {
  /** The pad number in the editor: position in the project, from 1. */
  n: number;
  name: string;
  file?: string;
  status: ReviewStatus;
  /** The last verdict, also when the sound has changed since (status is then `unreviewed`). */
  verdict?: ReviewEntry;
  /** The sound changed after its last verdict. */
  changedSince?: boolean;
  /** The verdict is newer than the agent's last read. */
  isNew: boolean;
  /** Labels of the sound's takes, and the one whose content is in use now. */
  takes?: string[];
  takeInUse?: string;
}

export interface ReviewReport {
  project: string;
  read?: string;
  counts: { sounds: number; unreviewed: number; needsWork: number; approved: number };
  rows: ReviewRow[];
}

/** Each sound's state: `look` gives a sound's patch (undefined when it can't be read) and its takes. */
export function reviewReport(project: Project, review: Review, look: (sound: ProjectSound) => { patch?: Patch; takes?: ReviewTake[] }): ReviewReport {
  const rows: ReviewRow[] = project.sounds.map((sound, i) => {
    const { patch, takes = [] } = look(sound);
    const verdict = review.sounds[reviewKey(sound)];
    const version = patch ? soundVersion(patch, takes.map((t) => t.patch)) : '';
    const status = patch ? reviewStatus(verdict, version) : 'unreviewed';
    const own = patch ? patchVersion(patch) : '';
    const inUse = takes.find((t) => patchVersion(t.patch) === own);
    return {
      n: i + 1,
      name: soundName(sound),
      ...(sound.file ? { file: sound.file } : {}),
      status,
      ...(verdict ? { verdict, changedSince: status === 'unreviewed' } : {}),
      isNew: !!verdict && (!review.read || verdict.at > review.read),
      ...(takes.length ? { takes: takes.map((t) => t.label), ...(inUse ? { takeInUse: inUse.label } : {}) } : {}),
    };
  });
  const count = (s: ReviewStatus) => rows.filter((r) => r.status === s).length;
  return {
    project: project.name,
    ...(review.read ? { read: review.read } : {}),
    counts: { sounds: rows.length, unreviewed: count('unreviewed'), needsWork: count('needs-work'), approved: count('approved') },
    rows,
  };
}

function short(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  const s = JSON.stringify(v);
  return s === undefined ? '(none)' : s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** A change in a person's words where it can be: a control by its label, else the parameter's path. */
export function describeChange(change: ChangeRecord, patch?: Patch): string {
  const m = /^controls\.([^.]+)\.value$/.exec(change.path);
  const label = m && patch?.controls?.find((c) => c.id === m[1])?.label;
  return `${label ?? change.path} ${short(change.before)} -> ${short(change.after)}`;
}

const VERDICT_TEXT: Record<ReviewStatus, string> = { approved: 'approved', 'needs-work': 'needs work', unreviewed: 'not reviewed' };

/**
 * The report as text for an agent: the counts, then the verdicts new since its last read (all of them with `all`),
 * then the sounds not reviewed yet.
 */
export function formatReview(report: ReviewReport, opts: { all?: boolean; patchOf?: (row: ReviewRow) => Patch | undefined } = {}): string[] {
  const c = report.counts;
  const lines = [`${report.project}: ${c.sounds} sound${c.sounds === 1 ? '' : 's'} · ${c.unreviewed} not reviewed · ${c.needsWork} need${c.needsWork === 1 ? 's' : ''} work · ${c.approved} approved`];
  const shown = report.rows.filter((r) => r.verdict && (opts.all || r.isNew));
  lines.push('');
  if (shown.length === 0) lines.push(opts.all ? 'No verdicts yet.' : `No new verdicts${report.read ? ` since ${report.read}` : ''}.`);
  else lines.push(opts.all ? `Verdicts (${shown.length}):` : `New verdicts${report.read ? ` since the last read (${report.read})` : ''} (${shown.length}):`);
  for (const r of shown) {
    const v = r.verdict!;
    const take = v.take ? `, take "${v.take}"${r.takes ? ` (of ${r.takes.length})` : ''}` : '';
    lines.push(`  #${r.n} ${r.name}: ${VERDICT_TEXT[v.status]}${take}${r.changedSince ? ' (the sound has changed since: not reviewed now)' : ''}`);
    if (v.changes?.length) lines.push(`      the person changed: ${v.changes.map((ch) => describeChange(ch, opts.patchOf?.(r))).join('; ')}`);
  }
  const waiting = report.rows.filter((r) => r.status === 'unreviewed');
  if (waiting.length) {
    lines.push('');
    const list = waiting.slice(0, 40).map((r) => `#${r.n} ${r.name}${r.takes ? ` (${r.takes.length} takes)` : ''}`);
    lines.push(`Not reviewed (${waiting.length}): ${list.join(', ')}${waiting.length > 40 ? `, and ${waiting.length - 40} more` : ''}`);
  }
  if (shown.some((r) => r.verdict?.changes?.length)) {
    lines.push('');
    lines.push('The changes are already in the files: build on them. What still needs work, the person says in the chat.');
  }
  return lines;
}
