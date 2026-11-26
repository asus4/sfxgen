import { describe, expect, it } from 'vitest';
import { syncControlBases, controlsSetting, relativeOffsets, applyControls, metaAt, render, type Patch } from '../src/core';
import { analyze, describe as describeAnalysis } from '../src/core/analysis';

const patch = (): Patch => ({
  format: 'sfxgen/1',
  name: 'sync',
  duration: 'auto',
  seed: 2,
  tracks: [
    { id: 'tone', gain: 0, source: { type: 'osc', wave: 'sine', freq: 300, env: { attack: 0.001, decay: 0.2 } } },
    { id: 'air', gain: -6, source: { type: 'noise', color: 'pink', env: { attack: 0.001, decay: 0.1 } } },
  ],
  controls: [
    { id: 'punch', label: 'Punch', value: 0.5, targets: [{ path: 'tracks.air.gain', mode: 'set', from: -20, to: 0 }] },
    { id: 'pitch', label: 'Pitch', value: 1, targets: [{ path: 'tracks.tone.source.freq', mode: 'mul', from: 0.5, to: 2 }] },
    { id: 'kind', label: 'Kind', value: 1, widget: 'select', options: [{ label: 'a', set: { 'tracks.tone.source.wave': 'sine' } }, { label: 'b', set: { 'tracks.tone.source.wave': 'triangle' } }] },
  ],
});

describe('syncControlBases', () => {
  it('writes set targets and chosen options into the base, and leaves relative targets alone', () => {
    const p = patch();
    const { patch: synced, changes } = syncControlBases(p);
    expect(changes.map((c) => c.path).sort()).toEqual(['tracks.air.gain', 'tracks.tone.source.wave']);
    expect(synced.tracks[1].gain).toBe(-10);
    expect(synced.tracks[0].source.wave).toBe('triangle');
    expect(synced.tracks[0].source.freq).toBe(300);
    // The input is untouched, and the controls stay.
    expect(p.tracks[1].gain).toBe(-6);
    expect(synced.controls).toEqual(p.controls);
  });

  it('is idempotent and does not change what renders', () => {
    const { patch: once } = syncControlBases(patch());
    const again = syncControlBases(once);
    expect(again.changes).toEqual([]);
    expect(JSON.stringify(again.patch)).toBe(JSON.stringify(once));
    const a = render(patch());
    const b = render(once);
    expect(Buffer.from(b.channels[0].buffer).equals(Buffer.from(a.channels[0].buffer))).toBe(true);
  });

  it('rounds long floats and still reports in sync afterwards', () => {
    const p = patch();
    p.controls![0].value = 1 / 3;
    const { patch: synced, changes } = syncControlBases(p);
    expect(String(changes[0].after).length).toBeLessThan(12);
    expect(syncControlBases(synced).changes).toEqual([]);
  });

  it('knows which control owns a path', () => {
    expect(controlsSetting(patch()).get('tracks.air.gain')).toBe('punch');
    expect(applyControls(patch(), metaAt).patch.tracks[1].gain).toBe(-10);
  });
});

describe('relativeOffsets', () => {
  it('names the relative targets that move a value away from the file, and not the ones that keep it', () => {
    // Pitch at 1 doubles the frequency: the file says 300, 600 plays.
    expect(relativeOffsets(patch())).toEqual([{ path: 'tracks.tone.source.freq', control: 'pitch', mode: 'mul', by: 2 }]);
    const p = patch();
    p.controls![1].value = 0.5; // 0.5 to 2 is x1 in the middle (exponential), so nothing to say
    expect(relativeOffsets(p)).toEqual([]);
    // Ends that do not multiply to 1 drift at the middle, unless `via` pins it.
    p.controls![1].targets![0] = { path: 'tracks.tone.source.freq', mode: 'mul', from: 1.5, to: 0.84 };
    expect(relativeOffsets(p)[0].by).toBeCloseTo(1.122, 3);
    p.controls![1].targets![0].via = 1;
    expect(relativeOffsets(p)).toEqual([]);
    // add: an amount, against its range.
    p.controls![1].targets![0] = { path: 'tracks.tone.gain', mode: 'add', from: -2, to: 10 };
    expect(relativeOffsets(p)[0]).toMatchObject({ mode: 'add', by: 4 });
  });
});

describe('loop-aware describe', () => {
  const sr = 48000;
  const tone = (phase: number, wave: 'sine' | 'saw'): Float32Array[] => {
    const x = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      const t = (i / sr) * 100 + phase;
      x[i] = 0.5 * (wave === 'sine' ? Math.sin(2 * Math.PI * t) : 2 * (t - Math.floor(t)) - 1);
    }
    return [x];
  };

  it('drops the start and end warnings for a loop, and reports a clean seam', () => {
    const a = analyze(tone(0.2, 'sine'), sr);
    expect(describeAnalysis(a)).toContain('starts at');
    const loop = describeAnalysis(a, { loop: true });
    expect(loop).not.toContain('starts at');
    expect(loop).not.toContain('still sounding');
    expect(loop).toContain('seamless');
  });

  it('warns about a seam that jumps more than the sound does inside', () => {
    const x = tone(0.0, 'sine')[0];
    // A sine that does not close its last cycle: the end is far from the start.
    const cut = new Float32Array(x.subarray(0, Math.floor(sr * 0.9975)));
    const a = analyze([cut], sr);
    const text = describeAnalysis(a, { loop: true });
    expect(text).toContain('loop seam');
    expect(a.seamDb).toBeGreaterThan(a.maxStepDb);
  });
});
