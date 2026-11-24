import { beforeEach, describe, expect, it } from 'vitest';
import type { Patch, Project } from '../src/core';
import { setAt, setControlValue } from '../src/ui/lib/patchOps';
import { addSound, updateSound } from '../src/ui/lib/projectOps';
import { SELECT_MASTER, useEditor, versionIn } from '../src/ui/store';

const zap = (): Patch => ({
  format: 'sfxgen/1',
  name: 'Zap',
  duration: 'auto',
  tracks: [
    { id: 'zap', source: { type: 'osc', freq: [[0, 2400], [0.25, 180]] } },
    { id: 'air', gain: -8, source: { type: 'noise' } },
  ],
  controls: [{ id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.zap.source.freq', mode: 'mul', from: 0.4, to: 2.2 }] }],
});
const thud = (): Patch => ({ format: 'sfxgen/1', name: 'Thud', duration: 'auto', tracks: [{ id: 'body', source: { type: 'osc' } }] });
const set = (): Project => ({ format: 'sfxgen-project/1', name: 'Set', sounds: [{ patch: zap() }, { patch: thud() }] });

const s = () => useEditor.getState();

describe('editor store', () => {
  beforeEach(() => {
    s().loadProject(set(), { origin: 'system', fresh: true });
    useEditor.setState({ flash: {}, activity: [], padTouched: {} });
  });

  it('opens a project on its first sound and remembers it as saved', () => {
    expect(s().project.name).toBe('Set');
    expect(s().patch.name).toBe('Zap');
    expect(s().selected).toBe('zap');
    expect(s().saved).toBe(s().project);
    expect(s().baseline).toBe(s().project);
    expect(s().history.past).toHaveLength(0);
  });

  it('edits the open sound only, as one undo step per gesture', () => {
    const other = s().project.sounds[1];
    for (const v of [0.6, 0.7, 0.8]) s().edit((p) => setControlValue(p, 'pitch', v), 'control:pitch');
    expect(s().history.past).toHaveLength(1);
    expect(s().project.sounds[1]).toBe(other);
    expect(s().project.sounds[0].patch).toBe(s().patch);
    s().seal();
    s().edit((p) => setControlValue(p, 'pitch', 0.1), 'control:pitch');
    expect(s().history.past).toHaveLength(2);
    s().undo();
    expect(s().patch.controls![0].value).toBe(0.8);
    s().undo();
    expect(s().patch.controls![0].value).toBe(0.5);
    s().redo();
    expect(s().patch.controls![0].value).toBe(0.8);
    expect(s().lastOrigin).toBe('human');
  });

  it('opens another sound, and undo brings the person back to the sound that changed', () => {
    s().edit((p) => setControlValue(p, 'pitch', 0.9));
    s().openSound(1);
    expect(s().current).toBe(1);
    expect(s().patch.name).toBe('Thud');
    expect(s().selected).toBe('body');
    // The same tag on another sound is another gesture.
    s().edit((p) => setAt(p, 'tracks.body.gain', -3), 'control:pitch');
    expect(s().history.past).toHaveLength(2);
    s().undo();
    s().undo();
    expect(s().current).toBe(0);
    expect(s().patch.controls![0].value).toBe(0.5);
  });

  it('edits the project (a level in the mixer) without touching the patches', () => {
    const patches = s().project.sounds.map((x) => x.patch);
    for (const g of [-1, -2, -3]) s().editProject((p) => updateSound(p, 1, { gain: g }), 'gain:Thud');
    expect(s().project.sounds[1].gain).toBe(-3);
    expect(s().project.sounds.map((x) => x.patch)).toEqual(patches);
    expect(s().history.past).toHaveLength(1);
    s().undo();
    expect(s().project.sounds[1].gain).toBeUndefined();
  });

  it("flashes what an agent touched in the open sound and keeps the agent's version as the baseline", () => {
    s().edit((p) => setControlValue(p, 'pitch', 0.9));
    const agent = setAt(setControlValue(s().patch, 'pitch', 0.3), 'tracks.air.gain', -3);
    s().load(agent, { origin: 'agent' });
    expect(Object.keys(s().flash).sort()).toEqual(['c:pitch', 'p:tracks.1.gain']);
    expect(s().activity[0]).toMatchObject({ origin: 'agent', text: 'air.gain -8 → -3 · pitch 0.9 → 0.3' });
    expect(versionIn(s().baseline, s().project.sounds[0])?.patch).toBe(agent);
    expect(s().lastOrigin).toBe('agent');
    // A person can undo the agent.
    s().undo();
    expect(s().patch.controls![0].value).toBe(0.9);
    // Touching a parameter a control drives flashes that control.
    s().load(setAt(s().patch, 'tracks.zap.source.freq', [[0, 900], [0.1, 90]]), { origin: 'file' });
    expect(s().flash['c:pitch']).toBeGreaterThan(0);
  });

  it("lights the pad of a sound an agent changed elsewhere, until the person opens it", () => {
    s().load(setAt(thud(), 'tracks.body.gain', -4), { origin: 'agent', index: 1 });
    expect(s().current).toBe(0);
    expect(Object.keys(s().flash)).toEqual([]);
    expect(Object.keys(s().padTouched)).toEqual(['Thud']);
    expect(s().activity[0].text).toBe('Thud: body.gain ∅ → -4');
    s().openSound(1);
    expect(s().padTouched).toEqual({});
  });

  it('takes a project written from outside: describes it, keeps the open sound, lights what changed', () => {
    s().openSound(1);
    const next = updateSound(addSound(s().project, { ...thud(), name: 'Click' }).project, 0, { gain: -6 });
    s().loadProject(next, { origin: 'agent' });
    expect(s().current).toBe(1);
    expect(s().patch.name).toBe('Thud');
    expect(Object.keys(s().padTouched).sort()).toEqual(['Click', 'Zap']);
    expect(s().activity[0].text).toContain('sounds.Zap.gain ∅ → -6');
    expect(s().baseline).toBe(next);
    s().undo();
    expect(s().project.sounds).toHaveLength(2);
  });

  it('replacing a sound with a template is one event and can be undone', () => {
    s().load(thud(), { origin: 'agent' });
    expect(s().activity[0].text).toBe('wrote a new patch: “Thud”');
    expect(s().selected).toBe('body');
    s().undo();
    expect(s().patch.name).toBe('Zap');
    expect(s().selected).toBe('zap');
  });

  it('keeps the selection valid when its track goes away', () => {
    s().select('air');
    s().edit((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== 'air') }));
    expect(s().selected).toBe('zap');
    s().select(SELECT_MASTER);
    s().edit((p) => setAt(p, 'master.gain', -3));
    expect(s().selected).toBe(SELECT_MASTER);
  });
});
