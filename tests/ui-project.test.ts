import { describe, expect, it } from 'vitest';
import { validateProject, type Patch, type Project } from '../src/core';
import {
  addGroup,
  addSound,
  bundleProject,
  groupInk,
  levelOf,
  matchGroup,
  moveSound,
  projectOfOne,
  removeGroup,
  removeSound,
  renderHash,
  setSoundPatch,
  shellKey,
  soundKey,
  stripProject,
  suggestTarget,
  uniquePatchName,
  updateGroup,
  updateSound,
  zipPath,
  type Measured,
} from '../src/ui/lib/projectOps';

const patch = (name: string): Patch => ({ format: 'sfxgen/1', name, duration: 'auto', tracks: [{ id: 'a', source: { type: 'osc' } }] });

const project = (): Project => ({
  format: 'sfxgen-project/1',
  name: 'Cave crawler',
  groups: [{ id: 'ui', label: 'Interface' }, { id: 'hits' }],
  sounds: [
    { file: 'Sword_Hit.sfx.json', patch: patch('Sword hit'), group: 'hits' },
    { file: 'ui/Click.sfx.json', patch: patch('Click'), group: 'ui', gain: -2 },
    { patch: patch('Laser zap') },
  ],
});

const measured = (lufs: number, peakDb: number): Measured => ({ hash: '', lufs, peakDb, duration: 1, peaks: new Float32Array(0), warnings: [] });

describe('projects in the editor', () => {
  it('keys sounds by file, else by name', () => {
    expect(project().sounds.map(soundKey)).toEqual(['Sword_Hit.sfx.json', 'ui/Click.sfx.json', 'Laser-zap']);
  });

  it('a lone patch is a valid project of one', () => {
    const p = projectOfOne(patch('Solo'));
    expect(p.name).toBe('Solo');
    expect(validateProject(p).ok).toBe(true);
  });

  it('strips file sounds for the project file and inlines everything for a bundle', () => {
    const stripped = stripProject(project());
    expect(stripped.sounds[0]).toEqual({ file: 'Sword_Hit.sfx.json', group: 'hits' });
    expect(stripped.sounds[2].patch?.name).toBe('Laser zap');
    const bundle = bundleProject(project());
    expect(bundle.sounds.every((s) => s.patch && !s.file)).toBe(true);
    expect(validateProject(bundle).ok).toBe(true);
    expect(validateProject(stripped).ok).toBe(true);
  });

  it('knows when the project file would change, and when only a patch did', () => {
    const p = project();
    const editedFile = setSoundPatch(p, 0, patch('Punch harder'));
    expect(shellKey(editedFile)).toBe(shellKey(p));
    expect(shellKey(setSoundPatch(p, 2, patch('Laser zap II')))).not.toBe(shellKey(p));
    expect(shellKey(updateSound(p, 0, { gain: -3 }))).not.toBe(shellKey(p));
  });

  it('edits one sound and leaves the others by reference', () => {
    const p = project();
    const next = updateSound(p, 1, { gain: 0, note: 'Every menu move.' });
    expect(next.sounds[1]).toEqual({ file: 'ui/Click.sfx.json', patch: p.sounds[1].patch, group: 'ui', note: 'Every menu move.' });
    expect(next.sounds[0]).toBe(p.sounds[0]);
    expect(updateSound(next, 1, { group: undefined }).sounds[1].group).toBeUndefined();
    expect(setSoundPatch(p, 0, p.sounds[0].patch!)).toBe(p);
  });

  it('adds sounds under unique names, removes and reorders them', () => {
    const p = project();
    expect(uniquePatchName(p, 'Laser zap')).toBe('Laser zap 2');
    expect(uniquePatchName(p, 'Laser zap', 2)).toBe('Laser zap');
    const added = addSound(p, patch('Laser zap'));
    expect(added.index).toBe(3);
    expect(added.project.sounds[3].patch?.name).toBe('Laser zap 2');
    expect(validateProject(added.project).ok).toBe(true);
    expect(addSound(added.project, patch('Laser zap')).project.sounds[4].patch?.name).toBe('Laser zap 3');
    expect(removeSound(p, 0).sounds.map(soundKey)).toEqual(['ui/Click.sfx.json', 'Laser-zap']);
    expect(removeSound(projectOfOne(patch('x')), 0).sounds).toHaveLength(1);
    expect(moveSound(p, 0, 1).sounds.map(soundKey)).toEqual(['ui/Click.sfx.json', 'Sword_Hit.sfx.json', 'Laser-zap']);
    expect(moveSound(p, 0, -1)).toBe(p);
  });

  it('manages groups and their inks', () => {
    const p = project();
    const { project: withGroup, id } = addGroup(p, 'Loops');
    expect(id).toBe('loops');
    expect(groupInk(withGroup, 'loops')).toMatch(/^#/);
    expect(groupInk(p, 'ui')).toMatch(/^#/);
    expect(groupInk(p, undefined)).toBeUndefined();
    const levelled = updateGroup(p, 'ui', { normalize: { mode: 'loudness', target: -24 } });
    expect(levelled.groups![0].normalize).toEqual({ mode: 'loudness', target: -24 });
    expect(updateGroup(levelled, 'ui', { normalize: undefined }).groups![0].normalize).toBeUndefined();
    const removed = removeGroup(p, 'ui');
    expect(removed.groups!.map((g) => g.id)).toEqual(['hits']);
    expect(removed.sounds[1].group).toBeUndefined();
    expect(removeGroup(removed, 'hits').groups).toBeUndefined();
    expect(validateProject(removed).ok).toBe(true);
  });

  it('re-renders a sound when its context changes, not when its gain does', () => {
    const p = project();
    const base = renderHash(p, p.sounds[0]);
    expect(renderHash(updateSound(p, 0, { gain: -6 }), updateSound(p, 0, { gain: -6 }).sounds[0])).toBe(base);
    const louder = { ...p, normalize: { mode: 'loudness' as const, target: -20 } };
    expect(renderHash(louder, louder.sounds[0])).not.toBe(base);
    const grouped = updateGroup(p, 'hits', { normalize: { mode: 'peak', target: -6 } });
    expect(renderHash(grouped, grouped.sounds[0])).not.toBe(base);
    expect(renderHash(grouped, grouped.sounds[1])).toBe(renderHash(p, p.sounds[1]));
  });

  it('reports levels after gain and matches a group to one loudness under a ceiling', () => {
    const p = project();
    const m = { 'Sword_Hit.sfx.json': measured(-12, -1), 'ui/Click.sfx.json': measured(-20, -6), 'Laser-zap': measured(-16, -1) };
    expect(levelOf(p.sounds[1], m['ui/Click.sfx.json'])).toEqual({ name: 'ui/Click.sfx.json', lufs: -22, peakDb: -8, gain: -2 });
    expect(levelOf(p.sounds[0], undefined)).toBeNull();
    const all = matchGroup(p, m, '*', -18, -1);
    expect(all.sounds.map((s) => s.gain ?? 0)).toEqual([-6, 2, -2]);
    // The ceiling holds a quiet, peaky sound back.
    expect(matchGroup(p, m, '*', -10, -1).sounds.map((s) => s.gain ?? 0)).toEqual([0, 5, 0]);
    // One group only; the ungrouped sound is `null`.
    const hits = matchGroup(p, m, 'hits', -18, -1);
    expect(hits.sounds.map((s) => s.gain ?? 0)).toEqual([-6, -2, 0]);
    expect(hits.sounds[1]).toBe(p.sounds[1]);
    expect(matchGroup(p, m, null, -18, -1).sounds.map((s) => s.gain ?? 0)).toEqual([0, -2, -2]);
    // Unmeasured sounds keep their gain.
    expect(matchGroup(p, {}, '*', -18, -1)).toEqual(p);
    expect(suggestTarget([{ name: 'a', lufs: -12, peakDb: 0, gain: 0 }, { name: 'b', lufs: -20.4, peakDb: 0, gain: 0 }, { name: 'c', lufs: -Infinity, peakDb: 0, gain: 0 }])).toBe(-12);
    expect(suggestTarget([])).toBe(-18);
  });

  it('gives every sound a path inside the zip', () => {
    const p: Project = { ...project(), outDir: 'build' };
    expect(zipPath(p, p.sounds[0])).toBe('build/Sword_Hit.wav');
    expect(zipPath(p, { ...p.sounds[0], export: '../Assets/Audio/Sword_Hit.wav' })).toBe('build/Sword_Hit.wav');
    expect(zipPath(p, { ...p.sounds[1], export: 'sfx/ui/click.wav' })).toBe('sfx/ui/click.wav');
  });
});
