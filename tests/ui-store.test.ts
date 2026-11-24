import { beforeEach, describe, expect, it } from 'vitest';
import type { Patch } from '../src/core';
import { setAt, setControlValue } from '../src/ui/lib/patchOps';
import { SELECT_MASTER, useEditor } from '../src/ui/store';

const patch = (): Patch => ({
  format: 'sfxgen/1',
  name: 'Zap',
  duration: 'auto',
  tracks: [
    { id: 'zap', source: { type: 'osc', freq: [[0, 2400], [0.25, 180]] } },
    { id: 'air', gain: -8, source: { type: 'noise' } },
  ],
  controls: [{ id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.zap.source.freq', mode: 'mul', from: 0.4, to: 2.2 }] }],
});

const s = () => useEditor.getState();

describe('editor store', () => {
  beforeEach(() => {
    s().load(patch(), { origin: 'system', fresh: true });
    useEditor.setState({ flash: {}, activity: [] });
  });

  it('opens a sound: selects its first track and remembers it as saved', () => {
    expect(s().patch.name).toBe('Zap');
    expect(s().selected).toBe('zap');
    expect(s().saved).toBe(s().patch);
    expect(s().baseline).toBe(s().patch);
  });

  it('coalesces a gesture into one undo step and seals it', () => {
    const before = s().history.past.length;
    for (const v of [0.6, 0.7, 0.8]) s().edit((p) => setControlValue(p, 'pitch', v), 'control:pitch');
    expect(s().history.past.length).toBe(before + 1);
    s().seal();
    s().edit((p) => setControlValue(p, 'pitch', 0.1), 'control:pitch');
    expect(s().history.past.length).toBe(before + 2);
    s().undo();
    expect(s().patch.controls![0].value).toBe(0.8);
    s().undo();
    expect(s().patch.controls![0].value).toBe(0.5);
    s().redo();
    expect(s().patch.controls![0].value).toBe(0.8);
    expect(s().lastOrigin).toBe('human');
  });

  it("flashes what an agent touched, logs it, and keeps the agent's version as the baseline", () => {
    s().edit((p) => setControlValue(p, 'pitch', 0.9));
    const agent = setAt(setControlValue(s().patch, 'pitch', 0.3), 'tracks.air.gain', -3);
    s().load(agent, { origin: 'agent' });
    expect(Object.keys(s().flash).sort()).toEqual(['c:pitch', 'p:tracks.1.gain']);
    expect(s().activity[0]).toMatchObject({ origin: 'agent', text: 'air.gain -8 → -3 · pitch 0.9 → 0.3' });
    expect(s().baseline).toBe(agent);
    expect(s().lastOrigin).toBe('agent');
    // A person can undo the agent.
    s().undo();
    expect(s().patch.controls![0].value).toBe(0.9);
    // Touching a parameter a control drives flashes that control.
    s().load(setAt(s().patch, 'tracks.zap.source.freq', [[0, 900], [0.1, 90]]), { origin: 'file' });
    expect(s().flash['c:pitch']).toBeGreaterThan(0);
  });

  it('reports a wholly different patch as one event, and opening another sound can be undone', () => {
    const other: Patch = { format: 'sfxgen/1', name: 'Thud', duration: 'auto', tracks: [{ id: 'body', source: { type: 'osc' } }] };
    s().load(other, { origin: 'agent' });
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
