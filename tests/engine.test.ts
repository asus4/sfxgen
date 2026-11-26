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

  it('does not wrap a sustained sound onto itself in a wrap loop', () => {
    const p: Patch = {
      format: 'sfxgen/1',
      name: 'hum',
      duration: 0.5,
      loop: { mode: 'wrap' },
      master: { normalize: { mode: 'none' } },
      tracks: [{ id: 'hum', source: { type: 'osc', wave: 'sine', freq: 100, env: { attack: 0, sustain: 1 } } }],
    };
    const x = render(p, { sampleRate: 48000 }).channels[0];
    const rmsOf = (a: number, b: number) => Math.sqrt(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
    // Two whole cycles at the start against two in the middle: equal, not doubled.
    expect(rmsOf(0, 960) / rmsOf(12000, 12960)).toBeCloseTo(1, 1);
    // And seamless: the last sample runs into the first.
    expect(Math.abs(x[x.length - 1] - x[0])).toBeLessThan(0.02);
  });

  it('wraps a loop to exactly its duration', () => {
    const p = base();
    p.duration = 0.2;
    p.loop = { mode: 'wrap' };
    const r = render(p, { sampleRate: 44100 });
    expect(r.channels[0].length).toBe(Math.round(0.2 * 44100));
  });
});

describe('repeats', () => {
  const layer = (id: string, group?: string): Patch['tracks'][number] => ({
    id,
    source: { type: 'noise', env: { attack: 0.001, decay: 0.02 } },
    repeat: { count: 4, interval: 0.15, jitter: 0.02, velJitter: 0.3, accents: [0.6, 1, 0.8], ...(group ? { group } : {}) },
  });
  const onsets = (x: Float32Array) => {
    const out: number[] = [];
    // A hit starts where the level first passes a tenth of the peak after a quiet stretch.
    let top = 0;
    for (const v of x) top = Math.max(top, Math.abs(v));
    let last = -Infinity;
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) < 0.1 * top) continue;
      if (i - last > 0.05 * 48000) out.push(i);
      last = i;
    }
    return out;
  };
  const solo = (tracks: Patch['tracks'], id: string) =>
    render({ ...base(), controls: [], master: { normalize: { mode: 'none' }, fadeIn: 0, fadeOut: 0 }, tracks: tracks.map((t) => ({ ...t, solo: t.id === id })) }).channels[0];

  it('moves the layers of one event together when they share a group', () => {
    // The door has no pitch or level jitter of its own: it must still keep the knuckle's timing.
    const door = layer('door', 'rap');
    door.repeat = { ...door.repeat!, velJitter: 0, pitchJitter: 0 };
    const tracks = [layer('knuckle', 'rap'), door, layer('loose')];
    const [k, d, l] = ['knuckle', 'door', 'loose'].map((id) => onsets(solo(tracks, id)));
    // Within a millisecond (each noise burst crosses the threshold at its own sample); the ungrouped layer drifts.
    expect(d.length).toBe(k.length);
    k.forEach((t, i) => expect(Math.abs(t - d[i])).toBeLessThan(48));
    expect(Math.max(...k.map((t, i) => Math.abs(t - (l[i] ?? 0))))).toBeGreaterThan(96);
  });

  it('shifts each repeat by its offset, the same on every render', () => {
    const x = solo([{ ...layer('a'), repeat: { count: 4, interval: 0.2, offsets: [0, 0, 0.12, 0] } }], 'a');
    const t = onsets(x).map((i) => i / 48000);
    expect(t).toHaveLength(4);
    expect(t[1] - t[0]).toBeCloseTo(0.2, 2);
    expect(t[2] - t[1]).toBeCloseTo(0.32, 2);
    expect(t[3] - t[2]).toBeCloseTo(0.08, 2);
  });

  it('accents each repeat in turn', () => {
    const x = solo([{ ...layer('a'), repeat: { count: 3, interval: 0.15, accents: [0.5, 1, 0.25] } }], 'a');
    const level = (k: number) => Math.max(...Array.from(x.subarray(Math.round(k * 0.15 * 48000), Math.round((k * 0.15 + 0.05) * 48000))).map(Math.abs));
    expect(level(1)).toBeGreaterThan(1.5 * level(0));
    expect(level(0)).toBeGreaterThan(1.5 * level(2));
  });
});

describe('fixed-length patches', () => {
  it('warns when a loop\'s only voice has a one-shot default envelope and falls silent', () => {
    const loop = (env?: object): Patch => ({
      format: 'sfxgen/1',
      name: 'hum',
      duration: 4,
      loop: { mode: 'wrap' },
      tracks: [{ id: 'current', source: { type: 'chaos', mode: 'lorenz', rate: 240, ...(env ? { env } : {}) } }],
    });
    expect(render(loop()).warnings.join('\n')).toMatch(/track current: .*default one-shot envelope/);
    expect(render(loop({ attack: 0.01, sustain: 1 })).warnings).toEqual([]);
  });
});

describe('controls', () => {
  it('multiplies breakpoint values', () => {
    const { patch } = applyControls(base(), metaAt);
    expect(patch.tracks[0].source.freq).toEqual([[0, 4800], [0.25, 360]]);
  });
});

describe('control targets', () => {
  it('stretch scales event times and a repeat', () => {
    const p = base();
    p.tracks[0].events = [0, { t: 0.1, dur: 0.05, pitch: 7 }];
    p.tracks[1].repeat = { count: 3, interval: 0.1, jitter: 0.01 };
    p.controls = [
      {
        id: 'speed',
        label: 'Speed',
        value: 1,
        targets: [
          { path: 'tracks.zap.events', mode: 'stretch', from: 1, to: 2 },
          { path: 'tracks.air.repeat', mode: 'stretch', from: 1, to: 2 },
        ],
      },
    ];
    const { patch, warnings } = applyControls(p, metaAt);
    expect(warnings).toEqual([]);
    expect(patch.tracks[0].events).toEqual([0, { t: 0.2, dur: 0.1, pitch: 7 }]);
    expect(patch.tracks[1].repeat).toEqual({ count: 3, interval: 0.2, jitter: 0.02 });
  });

  it('via puts the default exactly on the mixed value', () => {
    const p = base();
    const at = (value: number) => {
      p.controls = [{ id: 'air', label: 'Air', value, default: 0.5, targets: [{ path: 'tracks.air.gain', from: -30, via: -8, to: 0 }] }];
      return applyControls(p, metaAt).patch.tracks[1].gain;
    };
    expect(at(0)).toBeCloseTo(-30);
    expect(at(0.5)).toBeCloseTo(-8);
    expect(at(0.75)).toBeCloseTo(-4);
    expect(at(1)).toBeCloseTo(0);
  });

  it('relative changes land on top of set values, whatever the order', () => {
    const p = base();
    p.controls = [
      { id: 'distance', label: 'Distance', value: 1, targets: [{ path: 'tracks.air.gain', mode: 'add', from: 0, to: -10 }] },
      { id: 'air', label: 'Air', value: 1, targets: [{ path: 'tracks.air.gain', from: -20, to: 0 }] },
    ];
    expect(applyControls(p, metaAt).patch.tracks[1].gain).toBeCloseTo(-10);
  });

  it('set reaches one breakpoint value by index', () => {
    const p = base();
    p.controls = [{ id: 'end', label: 'End pitch', value: 1, targets: [{ path: 'tracks.zap.source.freq.1.1', from: 100, to: 300 }] }];
    const { patch, warnings } = applyControls(p, metaAt);
    expect(warnings).toEqual([]);
    expect(patch.tracks[0].source.freq).toEqual([[0, 2400], [0.25, 300]]);
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
