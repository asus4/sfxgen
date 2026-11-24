import { describe, expect, it } from 'vitest';
import { applyControls, getPath, metaAt, validatePatch, type Patch } from '../src/core';
import {
  addEffect,
  addTrack,
  anotherTake,
  changeSourceType,
  duplicateTrack,
  moveEffect,
  pinControl,
  pinnedControlFor,
  readSignal,
  removeControl,
  removeEffect,
  removeTrack,
  setAt,
  setControlValue,
  surprise,
  uniqueId,
  writeSignal,
} from '../src/ui/lib/patchOps';
import { canonPath, diffPatches, drivenPaths, summarize, touched } from '../src/ui/lib/paths';
import { computePeaks, lerpPeaks } from '../src/ui/lib/peaks';

const base = (): Patch => ({
  format: 'sfxgen/1',
  name: 'Zap',
  duration: 'auto',
  seed: 3,
  tracks: [
    {
      id: 'zap',
      source: { type: 'osc', wave: 'saw', freq: [[0, 2400], [0.25, 180]], env: { attack: 0.001, decay: 0.3 } },
      fx: [{ type: 'drive', id: 'bite', amount: 10 }, { type: 'gain' }],
    },
    { id: 'air', gain: -8, source: { type: 'noise' } },
  ],
  controls: [
    { id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.zap.source.freq', mode: 'mul', from: 0.4, to: 2.2 }] },
    { id: 'bite', label: 'Bite', value: 0.4, targets: [{ path: 'tracks.zap.fx.bite.amount', from: 0, to: 26 }] },
  ],
});

describe('patch edits', () => {
  it('never changes the patch it was given', () => {
    const p = base();
    const before = JSON.stringify(p);
    setAt(p, 'tracks.zap.gain', -3);
    setControlValue(p, 'pitch', 1);
    addEffect(p, 'master.fx', 'gain');
    removeTrack(p, 'air');
    surprise(p, () => 0.9);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('sets and removes values by path', () => {
    let p = setAt(base(), 'tracks.air.pan', 0.5);
    expect(p.tracks[1].pan).toBe(0.5);
    p = setAt(p, 'tracks.air.pan', undefined);
    expect('pan' in p.tracks[1]).toBe(false);
    p = setAt(p, 'tracks.air.repeat.count', 4);
    expect(p.tracks[1].repeat).toEqual({ count: 4 });
    p = setAt(p, 'tracks.air.repeat.count', undefined);
    expect(p.tracks[1].repeat).toBeUndefined();
  });

  it('makes unique ids', () => {
    expect(uniqueId('Osc', ['osc', 'osc-2'])).toBe('osc-3');
    expect(uniqueId('  ', [])).toBe('item');
  });

  it('edits effect chains, creating and removing the list', () => {
    let p = addEffect(base(), 'master.fx', 'gain');
    expect(p.master?.fx?.map((f) => f.type)).toEqual(['gain']);
    p = removeEffect(p, 'master.fx', 0);
    expect(p.master?.fx).toBeUndefined();
    p = moveEffect(base(), 'tracks.zap.fx', 0, 1);
    expect(p.tracks[0].fx?.map((f) => f.type)).toEqual(['gain', 'drive']);
    expect(moveEffect(p, 'tracks.zap.fx', 1, 1)).toBe(p);
  });

  it('adds, duplicates and removes tracks, never the last one', () => {
    const added = addTrack(base(), 'noise');
    expect(added.id).toBe('noise');
    expect(added.patch.tracks).toHaveLength(3);
    const dup = duplicateTrack(base(), 'zap')!;
    expect(dup.patch.tracks.map((t) => t.id)).toEqual(['zap', 'zap-2', 'air']);
    const removed = removeTrack(base(), 'zap');
    expect(removed.tracks.map((t) => t.id)).toEqual(['air']);
    expect(removed.controls).toBeUndefined();
    expect(removeTrack(removed, 'air')).toBe(removed);
  });

  it('keeps what sources share when the type changes', () => {
    const p = changeSourceType(setAt(base(), 'tracks.zap.source.gain', -3), 'zap', 'noise');
    expect(p.tracks[0].source.type).toBe('noise');
    expect(p.tracks[0].source.gain).toBe(-3);
    expect(p.tracks[0].source.wave).toBeUndefined();
  });

  it('rolls a different seed and scatters the controls inside their ranges', () => {
    expect(anotherTake(base(), () => 0.5).seed).not.toBe(3);
    const p = surprise(
      { ...base(), controls: [{ id: 'a', label: 'A', value: 5, min: 2, max: 8 }, { id: 'b', label: 'B', value: 0, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] }] },
      () => 0.999,
    );
    expect(p.controls![0].value).toBeGreaterThan(7.9);
    expect(p.controls![0].value).toBeLessThanOrEqual(8);
    expect(p.controls![1].value).toBe(2);
  });
});

describe('pinning a parameter into the controls', () => {
  it('pins a constant as a knob over the parameter range that sets it', () => {
    const pinned = pinControl(base(), 'tracks.air.gain')!;
    const c = pinned.patch.controls!.find((x) => x.id === pinned.id)!;
    expect(c.value).toBe(-8);
    expect(c.unit).toBe('dB');
    expect(c.targets).toEqual([{ path: 'tracks.air.gain', mode: 'set', from: c.min, to: c.max }]);
    expect(validatePatch(pinned.patch).ok).toBe(true);
    // The knob shows the real value: turning it to -20 sets the parameter to -20.
    const turned = applyControls(setControlValue(pinned.patch, pinned.id, -20), metaAt).patch;
    expect(getPath(turned, 'tracks.air.gain')).toBeCloseTo(-20);
    expect(pinnedControlFor(pinned.patch, 'tracks.1.gain')?.id).toBe(pinned.id);
    expect(removeControl(pinned.patch, pinned.id).controls).toHaveLength(2);
  });

  it('pins a log-scale parameter so the knob still reads in its unit', () => {
    const start = setAt(base(), 'tracks.air.source.filter', { cutoff: 3000 });
    const pinned = pinControl(start, 'tracks.air.source.filter.cutoff')!;
    const c = pinned.patch.controls!.find((x) => x.id === pinned.id)!;
    expect(c.scale).toBe('exp');
    const turned = applyControls(setControlValue(pinned.patch, pinned.id, 500), metaAt).patch;
    expect(getPath(turned, 'tracks.air.source.filter.cutoff')).toBeCloseTo(500, 3);
  });

  it('pins a moving parameter as a scale, an enum as a selector', () => {
    const scale = pinControl(base(), 'tracks.zap.source.freq')!;
    expect(scale.patch.controls!.at(-1)!.targets![0].mode).toBe('mul');
    const select = pinControl(base(), 'tracks.zap.source.wave')!;
    const c = select.patch.controls!.at(-1)!;
    expect(c.widget).toBe('select');
    expect(c.options![c.value].label).toBe('saw');
    expect(validatePatch(select.patch).ok).toBe(true);
    expect(pinControl(base(), 'tracks.zap.nothing')).toBeNull();
  });
});

describe('signals', () => {
  it('reads every form and writes back keeping modulators', () => {
    expect(readSignal(440)).toEqual({ constant: 440, mods: 0 });
    expect(readSignal([[0, 1], [1, 2]]).points).toHaveLength(2);
    const obj = { value: 3, mod: [{ type: 'lfo' as const, rate: 5, depth: 1 }] };
    expect(readSignal(obj)).toMatchObject({ constant: 3, mods: 1 });
    expect(writeSignal(obj, { points: [[0, 1], [1, 2]] })).toEqual({ env: [[0, 1], [1, 2]], mod: obj.mod });
    expect(writeSignal([[0, 1]], { constant: 9 })).toBe(9);
    expect(readSignal(undefined)).toEqual({ mods: 0 });
  });
});

describe('paths and diffs', () => {
  it('resolves ids to positions', () => {
    expect(canonPath(base(), 'tracks.zap.fx.bite.amount')).toBe('tracks.0.fx.0.amount');
    expect(canonPath(base(), 'tracks.1.gain')).toBe('tracks.1.gain');
    expect(canonPath(base(), 'master.gain')).toBe('master.gain');
  });

  it('knows what each control drives', () => {
    const d = drivenPaths(base());
    expect(d.get('tracks.0.source.freq')).toMatchObject([{ mode: 'mul' }]);
    expect(d.get('tracks.0.fx.0.amount')?.map((x) => x.control.id)).toEqual(['bite']);
    // Two controls may share a parameter.
    const shared = base();
    shared.controls!.push({ id: 'speed', label: 'Speed', value: 0.5, targets: [{ path: 'tracks.0.source.freq', mode: 'stretch' }] });
    expect(drivenPaths(shared).get('tracks.0.source.freq')?.map((x) => x.mode)).toEqual(['mul', 'stretch']);
  });

  it('diffs by id, at leaf level', () => {
    const a = base();
    const b = setAt(setControlValue(a, 'pitch', 0.8), 'tracks.air.gain', -3);
    expect(diffPatches(a, b)).toEqual([
      { path: 'tracks.air.gain', before: -8, after: -3 },
      { path: 'controls.pitch.value', before: 0.5, after: 0.8 },
    ]);
    expect(diffPatches(a, base())).toEqual([]);
    // Reordering tracks is not a rewrite of both.
    const swapped = { ...a, tracks: [a.tracks[1], a.tracks[0]] };
    expect(diffPatches(a, swapped)).toEqual([]);
    // Breakpoints are reported whole.
    const moved = setAt(a, 'tracks.zap.source.freq', [[0, 2000], [0.25, 180]]);
    expect(diffPatches(a, moved).map((c) => c.path)).toEqual(['tracks.zap.source.freq']);
  });

  it('finds the knobs to flash after an outside change', () => {
    const a = base();
    const viaControl = touched(a, setControlValue(a, 'bite', 0.9));
    expect(viaControl.controls).toEqual(['bite']);
    const viaParam = touched(a, setAt(a, 'tracks.zap.source.freq', [[0, 900], [0.2, 90]]));
    expect(viaParam.controls).toEqual(['pitch']);
    expect(viaParam.paths).toEqual(['tracks.0.source.freq']);
    const unrelated = touched(a, setAt(a, 'tracks.air.gain', -2));
    expect(unrelated.controls).toEqual([]);
    expect(unrelated.paths).toEqual(['tracks.1.gain']);
    expect(summarize(unrelated.changes)).toBe('air.gain -8 → -2');
    expect(summarize([])).toBe('no changes');
  });
});

describe('waveform peaks', () => {
  it('places a buffer on the timeline', () => {
    const sr = 1000;
    const buf = new Float32Array(500).fill(0.5);
    buf[10] = -1;
    const p = computePeaks(buf, sr, 0.5, 2, 4);
    expect([...p.data]).toEqual([0, 0, -1, 0.5, 0, 0, 0, 0]);
  });

  it('blends towards the new picture and snaps when sizes differ', () => {
    const a = { bins: 1, data: new Float32Array([-1, 1]) };
    const b = { bins: 1, data: new Float32Array([0, 0]) };
    expect([...lerpPeaks(a, b, 0.5).data]).toEqual([-0.5, 0.5]);
    expect(lerpPeaks(a, b, 1)).toBe(b);
    expect(lerpPeaks(undefined, b, 0.2)).toBe(b);
    expect(lerpPeaks({ bins: 2, data: new Float32Array(4) }, b, 0.2)).toBe(b);
  });
});
