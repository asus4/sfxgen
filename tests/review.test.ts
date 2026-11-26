import { describe, expect, it } from 'vitest';
import {
  emptyReview,
  formatReview,
  newProject,
  patchVersion,
  readReview,
  reviewReport,
  reviewStatus,
  soundVersion,
  takeFileFor,
  takeLabel,
  takeOwner,
  takesDirOf,
  validateReview,
  withVerdict,
  type Patch,
} from '../src/core';

const patch = (name: string, freq = 440): Patch => ({
  format: 'sfxgen/1',
  name,
  duration: 'auto',
  tracks: [{ id: 'a', source: { type: 'osc', wave: 'sine', freq, env: { decay: 0.1 } } }],
  controls: [{ id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.a.source.freq', mode: 'set', from: 220, to: 880 }] }],
});

describe('review versions', () => {
  it('hashes the same patch the same, whatever the key order', () => {
    const a = patch('beep');
    const b = JSON.parse(JSON.stringify({ tracks: a.tracks, controls: a.controls, duration: a.duration, name: a.name, format: a.format })) as Patch;
    expect(patchVersion(b)).toBe(patchVersion(a));
    expect(patchVersion(patch('beep', 441))).not.toBe(patchVersion(a));
    expect(patchVersion(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('counts the takes in a sound\'s version, in any order', () => {
    const a = patch('beep');
    const t1 = patch('beep', 300);
    const t2 = patch('beep', 600);
    expect(soundVersion(a)).toBe(patchVersion(a));
    expect(soundVersion(a, [t1, t2])).toBe(soundVersion(a, [t2, t1]));
    expect(soundVersion(a, [t1])).not.toBe(soundVersion(a, [t1, t2]));
  });

  it('holds a verdict only for the version it was given for', () => {
    const v = patchVersion(patch('beep'));
    const entry = { status: 'approved' as const, at: '2026-11-26T10:00:00Z', version: v };
    expect(reviewStatus(entry, v)).toBe('approved');
    expect(reviewStatus(entry, patchVersion(patch('beep', 500)))).toBe('unreviewed');
    expect(reviewStatus(undefined, v)).toBe('unreviewed');
  });
});

describe('takes', () => {
  it('lives in a folder next to the sound', () => {
    expect(takesDirOf('sounds/door.sfx.json')).toBe('sounds/door.takes');
    expect(takeOwner('sounds/door.takes/darker-throb.sfx.json')).toBe('sounds/door.sfx.json');
    expect(takeOwner('door.takes/a.sfx.json')).toBe('door.sfx.json');
    expect(takeOwner('sounds/door.sfx.json')).toBeNull();
    expect(takeLabel('sounds/door.takes/darker-throb.sfx.json')).toBe('darker throb');
  });

  it('names new takes without clashing', () => {
    expect(takeFileFor('door.sfx.json', 'Original', [])).toBe('door.takes/original.sfx.json');
    expect(takeFileFor('door.sfx.json', 'original', ['door.takes/original.sfx.json'])).toBe('door.takes/original-2.sfx.json');
  });
});

describe('the review file', () => {
  it('validates, and reads only the valid verdicts', () => {
    const good = withVerdict(emptyReview(), 'beep.sfx.json', { status: 'needs-work', at: '2026-11-26T10:00:00Z', version: 'abc' });
    expect(validateReview(good).ok).toBe(true);
    const bad = { ...good, sounds: { ...good.sounds, 'x.sfx.json': { status: 'maybe', at: 'soon' } } };
    const v = validateReview(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['sounds.x.sfx.json.status', 'sounds.x.sfx.json.at']));
    expect(Object.keys(readReview(bad).sounds)).toEqual(['beep.sfx.json']);
    expect(readReview('nonsense')).toEqual(emptyReview());
    expect(withVerdict(good, 'beep.sfx.json', null).sounds).toEqual({});
  });
});

describe('the review report', () => {
  const files: Record<string, Patch> = { 'a.sfx.json': patch('a'), 'b.sfx.json': patch('b'), 'c.sfx.json': patch('c') };
  const takes = { 'c.sfx.json': [{ label: 'low', patch: patch('c', 200) }, { label: 'same', patch: patch('c') }] };
  const project = newProject('Set', Object.keys(files));
  const look = (s: { file?: string }) => ({ patch: files[s.file!], takes: takes[s.file as keyof typeof takes] });

  it('counts the states and marks what the agent has not read', () => {
    let review = emptyReview();
    review = withVerdict(review, 'a.sfx.json', {
      status: 'approved',
      at: '2026-11-26T10:00:00Z',
      version: soundVersion(files['a.sfx.json']),
      changes: [{ path: 'controls.pitch.value', before: 0.5, after: 0.7 }],
    });
    review = withVerdict(review, 'b.sfx.json', { status: 'needs-work', at: '2026-11-26T09:00:00Z', version: 'stale' });
    review.read = '2026-11-26T09:30:00Z';
    const report = reviewReport(project, review, look);
    expect(report.counts).toEqual({ sounds: 3, unreviewed: 2, needsWork: 0, approved: 1 });
    const [a, b, c] = report.rows;
    expect(a).toMatchObject({ n: 1, name: 'a', status: 'approved', isNew: true });
    expect(b).toMatchObject({ n: 2, status: 'unreviewed', changedSince: true, isNew: false });
    expect(c).toMatchObject({ n: 3, status: 'unreviewed', takes: ['low', 'same'], takeInUse: 'same' });

    const text = formatReview(report, { patchOf: (r) => files[r.file!] }).join('\n');
    expect(text).toContain('Set: 3 sounds · 2 not reviewed · 0 need work · 1 approved');
    expect(text).toContain('#1 a: approved');
    expect(text).toContain('the person changed: Pitch 0.5 -> 0.7');
    expect(text).not.toContain('#2 b: needs work');
    expect(text).toContain('Not reviewed (2): #2 b, #3 c (2 takes)');
    expect(formatReview(report, { all: true }).join('\n')).toContain('#2 b: needs work (the sound has changed since: not reviewed now)');
  });
});
