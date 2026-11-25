import { beforeEach, describe, expect, it } from 'vitest';
import { emptyReview, withVerdict, type Patch, type Project } from '../src/core';
import { setControlValue } from '../src/ui/lib/patchOps';
import { changesOf, nextUnreviewed, reviewCounts, reviewVersion, statusOf, takeInUse } from '../src/ui/lib/review';
import { useEditor } from '../src/ui/store';

const beep = (freq = 440): Patch => ({
  format: 'sfxgen/1',
  name: 'Beep',
  duration: 'auto',
  tracks: [{ id: 'a', source: { type: 'osc', freq, env: { decay: 0.1 } } }],
  controls: [{ id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.a.source.freq', mode: 'mul', from: 0.5, to: 2 }] }],
});
const set = (): Project => ({
  format: 'sfxgen-project/1',
  name: 'Set',
  sounds: [{ file: 'a.sfx.json', patch: beep() }, { file: 'b.sfx.json', patch: beep(300) }, { file: 'c.sfx.json', patch: beep(600) }],
});

const s = () => useEditor.getState();
const approve = (i: number) => {
  const sound = s().project.sounds[i];
  useEditor.setState({ review: withVerdict(s().review, sound.file!, { status: 'approved', at: new Date().toISOString(), version: reviewVersion(s(), sound) }) });
};

describe('review in the editor', () => {
  beforeEach(() => {
    useEditor.setState({ review: emptyReview(), takes: {} });
    s().loadProject(set(), { origin: 'system', fresh: true });
  });

  it('starts with every sound to review, and approving one moves on to the next', () => {
    expect(reviewCounts(s())).toEqual({ unreviewed: 3, approved: 0, 'needs-work': 0 });
    approve(0);
    expect(statusOf(s(), s().project.sounds[0])).toBe('approved');
    expect(nextUnreviewed(s(), 0)).toBe(1);
    approve(1);
    approve(2);
    expect(nextUnreviewed(s(), 2)).toBe(-1);
  });

  it('takes the approval back when the person turns a knob, and lists what they changed', () => {
    approve(0);
    s().edit((p) => setControlValue(p, 'pitch', 0.8), 'control:pitch');
    const sound = s().project.sounds[0];
    expect(statusOf(s(), sound)).toBe('unreviewed');
    expect(changesOf(s(), sound)).toEqual([{ path: 'controls.pitch.value', before: 0.5, after: 0.8 }]);
  });

  it('knows the take in use, also once the person has changed it, and a new take needs a new listen', () => {
    const low = beep(200);
    useEditor.setState({ takes: { 'a.sfx.json': [{ path: 'a.takes/low.sfx.json', label: 'low', patch: low }, { path: 'a.takes/original.sfx.json', label: 'original', patch: beep() }] } });
    expect(takeInUse(s(), s().project.sounds[0])).toMatchObject({ take: { label: 'original' }, changed: false });
    approve(0);
    s().load(low, { origin: 'human', index: 0, rebase: true });
    expect(statusOf(s(), s().project.sounds[0])).toBe('unreviewed');
    expect(takeInUse(s(), s().project.sounds[0])).toMatchObject({ take: { label: 'low' }, changed: false });
    s().edit((p) => setControlValue(p, 'pitch', 0.3), 'control:pitch');
    expect(takeInUse(s(), s().project.sounds[0])).toMatchObject({ take: { label: 'low' }, changed: true });
    // Changes count from the take picked, not from the version before it.
    expect(changesOf(s(), s().project.sounds[0])).toEqual([{ path: 'controls.pitch.value', before: 0.5, after: 0.3 }]);

    approve(0);
    useEditor.setState({ takes: { 'a.sfx.json': [...s().takes['a.sfx.json'], { path: 'a.takes/high.sfx.json', label: 'high', patch: beep(900) }] } });
    expect(statusOf(s(), s().project.sounds[0])).toBe('unreviewed');
  });
});
