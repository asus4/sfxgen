/**
 * The review as the editor sees it: each sound's status, the take in use, what the person changed before deciding,
 * and which sound to review next. Pure functions of the editor's state; controller.ts saves verdicts and takes.
 */
import { combineVersions, patchVersion, reviewKey, reviewStatus, type Patch, type ProjectSound, type ReviewStatus } from '../../core';
import type { ChangeRecord } from '../../core/agent/workspace';
import { versionIn, type EditorState, type Take } from '../store';
import { diffPatches } from './paths';
import { patchOf } from './projectOps';

type ReviewState = Pick<EditorState, 'project' | 'review' | 'takes' | 'baseline'>;

const versions = new WeakMap<Patch, string>();

/** A patch's version, worked out once per patch object (patches are never changed in place). */
export function versionOf(patch: Patch): string {
  let v = versions.get(patch);
  if (!v) {
    v = patchVersion(patch);
    versions.set(patch, v);
  }
  return v;
}

export function takesOf(state: Pick<EditorState, 'takes'>, sound: ProjectSound | undefined): Take[] {
  return sound?.file ? (state.takes[sound.file] ?? []) : [];
}

/** The version a verdict on this sound is for: its patch and its takes. */
export function reviewVersion(state: ReviewState, sound: ProjectSound): string {
  return combineVersions(versionOf(patchOf(sound)), takesOf(state, sound).map((t) => versionOf(t.patch)));
}

export function statusOf(state: ReviewState, sound: ProjectSound | undefined): ReviewStatus {
  return sound ? reviewStatus(state.review.sounds[reviewKey(sound)], reviewVersion(state, sound)) : 'unreviewed';
}

/**
 * The take whose content is in the sound now; or, when the person has changed it since picking it (or since an
 * agent wrote it), the take it started from, with `changed`. Null when the sound matches none of its takes.
 */
export function takeInUse(state: ReviewState, sound: ProjectSound | undefined): { take: Take; changed: boolean } | null {
  const takes = takesOf(state, sound);
  if (!sound || takes.length === 0) return null;
  const now = versionOf(patchOf(sound));
  const exact = takes.find((t) => versionOf(t.patch) === now);
  if (exact) return { take: exact, changed: false };
  const base = versionIn(state.baseline, sound);
  const was = base ? versionOf(patchOf(base)) : '';
  const from = takes.find((t) => versionOf(t.patch) === was);
  return from ? { take: from, changed: true } : null;
}

/** What the person changed since the sound was last written by someone else, or since they picked its take. */
export function changesOf(state: ReviewState, sound: ProjectSound | undefined): ChangeRecord[] {
  const base = versionIn(state.baseline, sound);
  return sound && base && base.patch !== sound.patch ? diffPatches(patchOf(base), patchOf(sound)) : [];
}

/** The next sound nobody has approved or flagged, after `from` and wrapping round; -1 when there is none. */
export function nextUnreviewed(state: ReviewState, from: number): number {
  const sounds = state.project.sounds;
  for (let k = 1; k <= sounds.length; k++) {
    const i = (from + k) % sounds.length;
    if (statusOf(state, sounds[i]) === 'unreviewed') return i;
  }
  return -1;
}

export function reviewCounts(state: ReviewState): Record<ReviewStatus, number> {
  const counts: Record<ReviewStatus, number> = { unreviewed: 0, approved: 0, 'needs-work': 0 };
  for (const sound of state.project.sounds) counts[statusOf(state, sound)]++;
  return counts;
}
