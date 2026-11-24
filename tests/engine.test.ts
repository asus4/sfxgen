import { describe, expect, it } from 'vitest';
import { render, validatePatch, applyControls, metaAt, encodeWav, decodeWav, type Patch } from '../src/core';

const base = (): Patch => ({
  format: 'sfxgen/1',
  name: 'test',
  duration: 'auto',
  seed: 3,
  tracks: [
    {
      id: 'zap',
      source: {
        type: 'osc',
        wave: 'saw',
        freq: [[0, 2400], [0.25, 180]],
        env: { attack: 0.001, decay: 0.3 },
        filter: { mode: 'lowpass', cutoff: [[0, 9000], [0.3, 800]], q: 3 },
      },
      fx: [{ type: 'drive', mode: 'fold', amount: 10 }],
    },
    { id: 'air', gain: -8, source: { type: 'noise', color: 'pink', env: { attack: 0.001, decay: 0.12 } } },
  ],
  controls: [{ id: 'pitch', label: 'Pitch', value: 1, targets: [{ path: 'tracks.zap.source.freq', mode: 'mul', from: 0.5, to: 2 }] }],
});

function peakOf(x: Float32Array) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

describe('render', () => {
  it('is deterministic and normalised', () => {
    const a = render(base());
    const b = render(base());
    expect(a.channels[0]).toEqual(b.channels[0]);
    expect(peakOf(a.channels[0])).toBeCloseTo(10 ** (-1 / 20), 3);
    expect(a.warnings).toEqual([]);
    expect(a.duration).toBeGreaterThan(0.25);
    expect(a.duration).toBeLessThan(0.4);
  });

  it('changes with the seed', () => {
    const p = base();
    const a = render(p);
    p.seed = 4;
    const b = render(p);
    expect(a.channels[0]).not.toEqual(b.channels[0]);
  });

  it('renders stereo with pan', () => {
    const p = base();
    p.output = { channels: 2 };
    p.tracks[0].pan = -1;
    const r = render(p);
    expect(r.channels.length).toBe(2);
  });

  it('wraps a loop to exactly its duration', () => {
    const p = base();
    p.duration = 0.2;
    p.loop = { mode: 'wrap' };
    const r = render(p, { sampleRate: 44100 });
    expect(r.channels[0].length).toBe(Math.round(0.2 * 44100));
  });
});

describe('controls', () => {
  it('multiplies breakpoint values', () => {
    const { patch } = applyControls(base(), metaAt);
    expect(patch.tracks[0].source.freq).toEqual([[0, 4800], [0.25, 360]]);
  });
});

describe('validation', () => {
  it('accepts the base patch', () => {
    const v = validatePatch(base());
    expect(v.errors).toEqual([]);
  });
  it('suggests close names', () => {
    const p = base() as unknown as { tracks: { source: Record<string, unknown> }[] };
    p.tracks[0].source.frq = 100;
    p.tracks[1].source.type = 'nosie';
    const v = validatePatch(p);
    expect(v.warnings.some((w) => w.message.includes('"freq"'))).toBe(true);
    expect(v.errors.some((e) => e.message.includes('"noise"'))).toBe(true);
  });
});

describe('wav', () => {
  it('round-trips 24-bit stereo', () => {
    const l = new Float32Array([0, 0.5, -0.5, 0.25]);
    const r = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    const back = decodeWav(encodeWav([l, r], 44100, 24));
    expect(back.sampleRate).toBe(44100);
    expect(back.channels[1][2]).toBeCloseTo(0.2, 5);
  });
});
