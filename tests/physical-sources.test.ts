import { describe, expect, it } from 'vitest';
import { render, validatePatch, getSource, type Patch, type ParamMap, type ParamMeta } from '../src/core';
import { magnitudeSpectrum } from '../src/core/dsp/fft';
import { buildModes, besselJ, MODAL_SHAPES } from '../src/core/dsp/modes';
import { Rng } from '../src/core/dsp/rng';

const TYPES = ['modal', 'pluck', 'particles'] as const;

/** One track of one source, with nothing after the source: no normalising, DC blocker or fades. */
function patchOf(source: Record<string, unknown>, extra: Record<string, unknown> = {}, track: Record<string, unknown> = {}): Patch {
  return {
    format: 'sfxgen/1',
    name: 'test',
    duration: 'auto',
    seed: 3,
    tracks: [{ id: 'a', source, ...track }],
    master: { normalize: { mode: 'none' }, dcBlock: false, fadeIn: 0, fadeOut: 0 },
    ...extra,
  } as unknown as Patch;
}

function play(source: Record<string, unknown>, extra: Record<string, unknown> = {}, track: Record<string, unknown> = {}) {
  const r = render(patchOf(source, extra, track));
  return { r, x: r.channels[0], sr: r.sampleRate };
}

function peakOf(x: ArrayLike<number>, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < Math.min(to, x.length); i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

function rmsOf(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  const end = Math.min(to, x.length);
  for (let i = from; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - from));
}

function spectrum(x: ArrayLike<number>, from = 0, size = 65536): Float64Array {
  const frame = new Float64Array(size);
  for (let i = 0; i < size && from + i < x.length; i++) frame[i] = x[from + i];
  return magnitudeSpectrum(frame);
}

/** Frequency of the strongest spectral peak within `tol` (a ratio) of `near`. */
function peakNear(mag: Float64Array, sr: number, near: number, tol = 0.04): number {
  const size = (mag.length - 1) * 2;
  const lo = Math.max(2, Math.floor((near * (1 - tol) * size) / sr));
  const hi = Math.min(mag.length - 2, Math.ceil((near * (1 + tol) * size) / sr));
  let best = lo;
  for (let b = lo; b <= hi; b++) if (mag[b] > mag[best]) best = b;
  const a = Math.log(mag[best - 1] + 1e-300);
  const b = Math.log(mag[best] + 1e-300);
  const c = Math.log(mag[best + 1] + 1e-300);
  return ((best + (0.5 * (a - c)) / (a - 2 * b + c)) * sr) / size;
}

function centroid(x: ArrayLike<number>, sr: number, from = 0, size = 16384): number {
  const mag = spectrum(x, from, size);
  let a = 0;
  let b = 0;
  for (let i = 1; i < mag.length; i++) {
    a += i * mag[i] * mag[i];
    b += mag[i] * mag[i];
  }
  return ((a / b) * sr) / size;
}

/** Seconds until the 10 ms peak envelope has fallen 60 dB below its maximum for good. */
function t60Of(x: ArrayLike<number>, sr: number): number {
  const w = Math.round(0.01 * sr);
  const env: number[] = [];
  for (let i = 0; i < x.length; i += w) env.push(peakOf(x, i, i + w));
  const top = Math.max(...env);
  for (let i = env.length - 1; i >= 0; i--) if (env[i] > top * 1e-3) return ((i + 1) * w) / sr;
  return 0;
}

/** Samples where the signal jumps above `level` after at least `gap` samples below it. */
function onsets(x: ArrayLike<number>, level: number, gap: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < level) continue;
    if (i - last > gap) out.push(i);
    last = i;
  }
  return out;
}

function eachParam(params: ParamMap, visit: (path: string, meta: ParamMeta) => void, prefix = ''): void {
  for (const [name, meta] of Object.entries(params)) {
    visit(prefix + name, meta);
    if (meta.fields) eachParam(meta.fields, visit, `${prefix}${name}.`);
  }
}

describe('catalog', () => {
  it('lists the three sources with usable metadata', () => {
    for (const type of TYPES) {
      const def = getSource(type)!;
      expect(def, type).toBeDefined();
      expect(def.doc.length).toBeGreaterThan(80);
      expect(def.example?.type).toBe(type);
      expect(validatePatch(patchOf(def.example!)).errors).toEqual([]);
      eachParam(def.params, (path, meta) => {
        const where = `${type}.${path}`;
        expect(meta.doc.length, where).toBeGreaterThan(20);
        if (meta.kind === 'enum') expect(meta.options!.length, where).toBeGreaterThan(1);
        if (meta.kind === 'number' || meta.kind === 'signal') {
          expect(typeof meta.min, where).toBe('number');
          expect(typeof meta.max, where).toBe('number');
          expect(typeof meta.hardMin, where).toBe('number');
          expect(typeof meta.hardMax, where).toBe('number');
          // Frequencies and times that cannot be zero are spread by ratio.
          if ((meta.unit === 'Hz' || meta.unit === 's') && meta.min! > 0) {
            expect(meta.scale, where).toBe('log');
            expect(meta.hardMin, where).toBeGreaterThan(0);
          }
        }
        if (/(^|\.)(freq|lo|hi)$/.test(path)) expect(meta.pitch, where).toBe(true);
      });
    }
  });
});

describe('every physical source', () => {
  it('renders its defaults at a peak of about 1, finite, with no warnings', () => {
    for (const type of TYPES) {
      const { r, x } = play({ type });
      expect(r.warnings, type).toEqual([]);
      expect(x.every(Number.isFinite), type).toBe(true);
      expect(peakOf(x), type).toBeGreaterThan(0.7);
      expect(peakOf(x), type).toBeLessThanOrEqual(1.0001);
      const mean = x.reduce((a, b) => a + b, 0) / x.length;
      expect(Math.abs(mean), type).toBeLessThan(0.005);
    }
  });

  it('is deterministic, and a new seed is a new take', () => {
    for (const type of TYPES) {
      const a = play({ type }).x;
      const b = play({ type }).x;
      const c = play({ type }, { seed: 4 }).x;
      expect(a, type).toEqual(b);
      expect(a, type).not.toEqual(c);
    }
  });

  it('follows the common pitch parameter', () => {
    const modal = play({ type: 'modal', freq: 300, pitch: 12, modes: 4 });
    expect(peakNear(spectrum(modal.x), modal.sr, 600)).toBeCloseTo(600, 0);
    const string = play({ type: 'pluck', freq: 150 }, {}, { events: [{ t: 0, pitch: 12 }] });
    expect(peakNear(spectrum(string.x, 2400), string.sr, 300)).toBeCloseTo(300, 0);
    const low = play({ type: 'particles', density: 200, grain: { kind: 'ping', lo: 2000, hi: 2000 }, pitch: -12 });
    expect(centroid(low.x, low.sr)).toBeLessThan(1500);
  });

  it('stays finite, below clipping and audible at every hard limit', () => {
    for (const type of TYPES) {
      const def = getSource(type)!;
      const cases: Record<string, unknown>[] = [];
      for (const [name, meta] of Object.entries(def.params)) {
        const values = (m: ParamMeta): unknown[] =>
          m.kind === 'enum' ? [...m.options!] : m.kind === 'number' || m.kind === 'signal' ? [m.hardMin ?? m.min, m.hardMax ?? m.max] : [];
        if (meta.fields) {
          for (const [f, fm] of Object.entries(meta.fields)) for (const v of values(fm)) cases.push({ type, [name]: { [f]: v } });
        } else for (const v of values(meta)) cases.push({ type, [name]: v });
      }
      // Several limits at once, and the kinds that take the nested settings.
      cases.push(
        { type: 'modal', freq: 20000, modes: 96, decay: 0.001, stretch: 3, dent: 2, beat: 200, damping: 20 },
        { type: 'modal', freq: [[0, 5], [0.5, 20000]], modes: 96, stretch: 0.25, brightness: 1, exciter: { kind: 'impulse' } },
        { type: 'modal', exciter: { kind: 'scrape', duration: 0.001, density: 20000, roughness: 1, hardness: 1 } },
        { type: 'modal', exciter: { kind: 'roll', duration: 2, density: 0.5, roughness: 0, hardness: 0 } },
        { type: 'modal', exciter: { kind: 'noise', duration: 0.001, hardness: 0 }, freq: 5 },
        { type: 'pluck', freq: 12000, stiffness: 1, brightness: 1, decay: 60, position: 0.5 },
        { type: 'pluck', freq: [[0, 16], [0.3, 12000]], stiffness: 1, brightness: 0, mute: [[0, 0], [0.2, 1]] },
        { type: 'pluck', excite: 'bow', bowTime: 0.01, freq: 16, hardness: 1 },
        { type: 'pluck', excite: 'strike', hardness: 0, freq: 16, stiffness: 1, decay: 0.005 },
        { type: 'particles', density: 20000, duration: 0.5, spread: 1, grain: { kind: 'modal', decayLo: 5, decayHi: 5, lo: 10, hi: 20000 } },
        { type: 'particles', density: 0.01, duration: 0.001, grain: { kind: 'drop', decayLo: 0.0003, decayHi: 0.0003 } },
        { type: 'particles', distribution: 'bounce', interval: 0.002, ratio: 0.99, jitter: 1, grain: { kind: 'click', lo: 20000, hi: 20000 } },
        { type: 'particles', distribution: 'burst', density: 20000, duration: 60, grain: { kind: 'chirp', sweep: 8, pitchJitter: 48 } },
      );
      for (const source of cases.filter((c) => c.type === type)) {
        for (const sampleRate of [48000, 8000]) {
          const r = render(patchOf(source, { maxDuration: 1.5, output: { sampleRate } }));
          const x = r.channels[0];
          const label = `${JSON.stringify(source)} at ${sampleRate}`;
          expect(r.warnings, label).toEqual([]);
          expect(x.every(Number.isFinite), label).toBe(true);
          expect(peakOf(x), label).toBeLessThanOrEqual(1.0001);
          expect(peakOf(x), label).toBeGreaterThan(0.05);
        }
      }
    }
  });

  it('renders a second of sound quickly', () => {
    const cases = [
      { type: 'modal', modes: 64, decay: 1, shape: 'plate', beat: 2 },
      { type: 'pluck', decay: 1, stiffness: 0.8, freq: 80 },
      { type: 'particles', density: 500, grain: { kind: 'modal', decayLo: 0.02, decayHi: 0.2 } },
    ];
    for (const source of cases) {
      const patch = patchOf(source, { duration: 1 });
      render(patch);
      const started = performance.now();
      for (let i = 0; i < 5; i++) render(patch);
      // Typically 3 to 20 ms; the bound is loose so a busy machine does not fail the suite.
      expect((performance.now() - started) / 5, source.type).toBeLessThan(150);
    }
  });
});

describe('mode tables', () => {
  it('has the textbook ratios', () => {
    const rng = new Rng(1);
    const ratios = (shape: (typeof MODAL_SHAPES)[number], n: number) => Array.from(buildModes(shape, n, 0.8, rng).ratio);
    const near = (got: number[], want: number[], digits = 2) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, digits));
    near(ratios('bar', 5), [1, 2.757, 5.404, 8.933, 13.345]); // free-free bar
    near(ratios('tine', 4), [1, 6.267, 17.547, 34.386]); // clamped-free bar
    near(ratios('membrane', 6), [1, 1.5933, 2.1355, 2.2954, 2.6531, 2.9173], 3); // Bessel zeros
    near(ratios('bell', 5), [1, 2, 2.366, 3.012, 4]); // hum, prime, tierce, quint, nominal
    near(ratios('bowl', 3), [1, 2.828, 5.423]); // ring bending modes
    near(ratios('tube', 4), [1, 3, 5, 7]);
    near(ratios('string', 4), [1, 2, 3, 4]);
    near(ratios('plate', 2), [1, (4 + 1.272 ** 2) / (1 + 1.272 ** 2)]);
    for (const shape of MODAL_SHAPES) {
      const r = ratios(shape, 96);
      expect(r.length).toBe(96);
      for (let i = 1; i < r.length; i++) expect(r[i], `${shape} ${i}`).toBeGreaterThanOrEqual(r[i - 1]);
    }
  });

  it('computes Bessel functions', () => {
    expect(besselJ(0, 0)).toBeCloseTo(1, 10);
    expect(besselJ(0, 2.404826)).toBeCloseTo(0, 5);
    expect(besselJ(1, 1.841184)).toBeCloseTo(0.581865, 5);
    expect(besselJ(3, 25)).toBeCloseTo(0.108343, 4);
  });

  it('drives only the symmetric modes from the centre', () => {
    const rng = new Rng(1);
    const membrane = buildModes('membrane', 4, 0, rng).weight; // (0,1) (1,1) (2,1) (0,2)
    expect(membrane[0]).toBeGreaterThan(0.9);
    expect(membrane[1]).toBeLessThan(0.1);
    expect(membrane[3]).toBeGreaterThan(0.9);
    const bar = buildModes('bar', 4, 0, rng).weight;
    expect(bar[1]).toBeLessThan(0.1);
    expect(bar[0]).toBeGreaterThan(0.3);
    const end = buildModes('bar', 4, 1, rng).weight;
    for (const w of end) expect(w).toBeGreaterThan(0.9);
  });
});

describe('modal', () => {
  it('rings at the modes of its shape', () => {
    const { x, sr } = play({ type: 'modal', shape: 'bar', freq: 200, modes: 6, decay: 2, damping: 0, position: 0.85, exciter: { kind: 'impulse' } });
    const mag = spectrum(x);
    for (const ratio of [1, 2.757, 5.404, 8.933]) expect(peakNear(mag, sr, 200 * ratio, 0.02) / 200).toBeCloseTo(ratio, 2);
    const bell = play({ type: 'modal', shape: 'bell', freq: 150, modes: 5, decay: 3, damping: 0, exciter: { kind: 'impulse' } });
    expect(peakNear(spectrum(bell.x), bell.sr, 150 * 2.366, 0.02) / 150).toBeCloseTo(2.366, 2);
  });

  it('decays in `decay` seconds, or as its material says', () => {
    for (const decay of [0.2, 1.5]) {
      const { x, sr } = play({ type: 'modal', modes: 1, decay });
      expect(t60Of(x, sr) / decay).toBeGreaterThan(0.9);
      expect(t60Of(x, sr) / decay).toBeLessThan(1.1);
    }
    const lengths = ['metal', 'glass', 'ceramic', 'wood', 'plastic', 'rubber'].map((material) => play({ type: 'modal', material }).r.duration);
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeLessThan(lengths[i - 1]);
  });

  it('loses its high modes faster in lossy materials and with more damping', () => {
    const late = (source: Record<string, unknown>) => {
      const { x, sr } = play({ type: 'modal', freq: 300, decay: 1, modes: 16, ...source });
      return centroid(x, sr, Math.round(0.15 * sr), 8192);
    };
    expect(late({ material: 'wood' })).toBeLessThan(late({ material: 'metal' }) * 0.7);
    expect(late({ material: 'metal', damping: 4 })).toBeLessThan(late({ material: 'metal', damping: 0 }));
  });

  it('gets brighter with brightness, hardness and an edge strike', () => {
    const c = (source: Record<string, unknown>) => {
      const { x, sr } = play({ type: 'modal', freq: 300, ...source });
      return centroid(x, sr);
    };
    expect(c({ brightness: 0 })).toBeLessThan(c({ brightness: 0.5 }));
    expect(c({ brightness: 0.5 })).toBeLessThan(c({ brightness: 1 }));
    expect(c({ exciter: { hardness: 0 } })).toBeLessThan(c({ exciter: { hardness: 0.5 } }));
    expect(c({ exciter: { hardness: 0.5 } })).toBeLessThan(c({ exciter: { hardness: 1 } }));
    expect(c({ shape: 'membrane', position: 0 })).toBeLessThan(c({ shape: 'membrane', position: 1 }));
  });

  it('keeps a dented object the same object from hit to hit and take to take', () => {
    const tuned = (seed: number, dent: number, variant = 1) => {
      const { x, sr } = play({ type: 'modal', shape: 'bar', freq: 400, modes: 3, decay: 2, damping: 0, dent, variant, exciter: { kind: 'impulse' } }, { seed });
      return peakNear(spectrum(x), sr, 400 * 2.757, 0.3);
    };
    expect(tuned(1, 0) / 400).toBeCloseTo(2.757, 2);
    expect(Math.abs(tuned(1, 0.8) / 400 - 2.757)).toBeGreaterThan(0.02);
    expect(tuned(1, 0.8)).toBeCloseTo(tuned(9, 0.8), 3);
    expect(Math.abs(tuned(1, 0.8, 2) - tuned(1, 0.8, 1))).toBeGreaterThan(1);
  });

  it('beats when its modes are split', () => {
    const { x, sr } = play({ type: 'modal', modes: 1, freq: 500, decay: 6, beat: 4, exciter: { kind: 'impulse' } });
    // One mode split into a pair: the envelope dips and returns.
    const env: number[] = [];
    for (let i = 0; i < sr; i += 480) env.push(peakOf(x, i, i + 480));
    let dips = 0;
    for (let i = 1; i < env.length - 1; i++) if (env[i] < env[i - 1] && env[i] <= env[i + 1]) dips++;
    expect(dips).toBeGreaterThanOrEqual(2);
    expect(dips).toBeLessThanOrEqual(8);
  });

  it('follows a moving frequency', () => {
    const { x, sr } = play({ type: 'modal', modes: 1, freq: [[0, 400], [0.5, 200]], decay: 4, exciter: { kind: 'impulse' } });
    expect(peakNear(spectrum(x, sr, 16384), sr, 200, 0.2)).toBeCloseTo(200, 0);
    // Bending the mode must not change how loud it is.
    expect(peakOf(x, Math.round(0.2 * sr), Math.round(0.25 * sr))).toBeGreaterThan(0.6);
  });

  it('is driven for as long as a scrape or roll lasts', () => {
    for (const kind of ['scrape', 'roll', 'noise']) {
      const { r, x, sr } = play({ type: 'modal', material: 'wood', shape: 'box', freq: 180, exciter: { kind, duration: 0.8 } });
      expect(r.duration, kind).toBeGreaterThan(0.8);
      expect(r.duration, kind).toBeLessThan(1.15);
      if (kind !== 'noise') expect(rmsOf(x, Math.round(0.5 * sr), Math.round(0.7 * sr)), kind).toBeGreaterThan(0.03);
    }
    // Even ridges buzz at their rate.
    const comb = play({ type: 'modal', material: 'plastic', freq: 900, exciter: { kind: 'scrape', duration: 1, density: 110, roughness: 0, hardness: 1 } });
    const env = Float64Array.from(comb.x, (v) => Math.abs(v));
    expect(peakNear(spectrum(env, 4800, 32768), comb.sr, 110, 0.2)).toBeCloseTo(110, 0);
  });

  it('lets its modes fade out, so high-passing away the lows leaves no click in the tail', () => {
    // The door-panel recipe: a big plate with its lowest modes filtered away. A mode that stopped dead left a
    // one-sample click 1/w louder than its ring.
    const { x, sr } = play({
      type: 'modal',
      material: 'wood',
      shape: 'plate',
      freq: 34,
      decay: 0.2,
      modes: 64,
      brightness: 0.8,
      dent: 0.4,
      exciter: { kind: 'mallet', spread: 0.005 },
      filter: { mode: 'highpass', cutoff: 150, slope: 24 },
    });
    let jump = 0;
    for (let i = Math.round(0.08 * sr); i < x.length - 1; i++) jump = Math.max(jump, Math.abs(x[i + 1] - x[i]));
    expect(20 * Math.log10(jump / peakOf(x))).toBeLessThan(-70);
  });

  it('starts a slow scrape or roll at its first contact', () => {
    for (const kind of ['scrape', 'roll']) {
      const { x, sr } = play({ type: 'modal', material: 'wood', shape: 'plate', freq: 200, decay: 0.1, exciter: { kind, duration: 1, density: 6, roughness: 0.1 } });
      // The first ridge or bump is heard at once, not a sixth of a second later.
      expect(peakOf(x, 0, Math.round(0.02 * sr))).toBeGreaterThan(0.2 * peakOf(x));
    }
  });

  it('is damped by the end of a held event', () => {
    const { r } = play({ type: 'modal', decay: 3 }, {}, { events: [{ t: 0, dur: 0.2 }] });
    expect(r.duration).toBeLessThan(0.35);
  });

  it('spreads a blow over its modes with `exciter.spread`: a dense knock instead of a spike, and opt-in', () => {
    // A door: a big wooden panel, its modes crowding the low mids.
    const door = (spread?: number) => ({
      type: 'modal',
      material: 'wood',
      shape: 'plate',
      freq: 32,
      modes: 96,
      dent: 0.4,
      damping: 0.4,
      decay: 0.2,
      exciter: { kind: 'mallet', hardness: 0.6, ...(spread === undefined ? {} : { spread }) },
    });
    const crest = (x: ArrayLike<number>) => 20 * Math.log10(peakOf(x) / rmsOf(x));
    const plain = play(door()).x;
    // A spread of 0 is the same strike as none, so existing patches render as they did.
    expect(play(door(0)).x).toEqual(plain);
    const spread = play(door(0.008));
    expect(spread.r.warnings).toEqual([]);
    expect(crest(spread.x)).toBeLessThan(crest(plain) - 2);
    expect(rmsOf(spread.x)).toBeGreaterThan(0.3 * rmsOf(plain));
    // The same object: its modes, so its spectrum, are where they were.
    expect(Math.abs(centroid(spread.x, spread.sr) / centroid(plain, spread.sr) - 1)).toBeLessThan(0.35);
    // At the hard limit a smeared thump, still healthy.
    const wide = play(door(0.2)).x;
    expect(wide.every(Number.isFinite)).toBe(true);
    expect(peakOf(wide)).toBeGreaterThan(0.05);
    expect(peakOf(wide)).toBeLessThanOrEqual(1.0001);
  });
});

describe('pluck', () => {
  it('is in tune across its range, with harmonic partials', () => {
    for (const freq of [41.2, 110, 440, 1760]) {
      const { x, sr } = play({ type: 'pluck', freq, position: 0.07 });
      const mag = spectrum(x, 2400);
      expect(peakNear(mag, sr, freq, 0.03) / freq, `${freq}`).toBeCloseTo(1, 3);
      expect(peakNear(mag, sr, 3 * freq, 0.03) / freq, `${freq}`).toBeCloseTo(3, 2);
    }
  });

  it('stretches its partials with stiffness', () => {
    // The eighth partial over the first, found by walking up from one partial to the next.
    const eighth = (stiffness: number) => {
      const { x, sr } = play({ type: 'pluck', freq: 110, stiffness, brightness: 0.9, position: 0.07 });
      const mag = spectrum(x, 2400);
      const found = [peakNear(mag, sr, 110, 0.03)];
      expect(found[0]).toBeCloseTo(110, 0);
      for (let k = 1; k < 8; k++) {
        const step = k === 1 ? 110 : found[k - 1] - found[k - 2];
        const guess = found[k - 1] + step * 1.05;
        found.push(peakNear(mag, sr, guess, (0.4 * step) / guess));
      }
      return found[7] / found[0];
    };
    expect(eighth(0)).toBeCloseTo(8, 2);
    expect(eighth(0.4)).toBeGreaterThan(8.01);
    expect(eighth(0.4)).toBeLessThan(8.1);
    expect(eighth(0.8)).toBeGreaterThan(8.3);
    expect(eighth(1)).toBeGreaterThan(10);
  });

  it('rings for `decay` and loses its highs sooner when duller', () => {
    const long = play({ type: 'pluck', freq: 220, decay: 2, brightness: 1 });
    expect(t60Of(long.x, long.sr)).toBeGreaterThan(1.7);
    expect(t60Of(long.x, long.sr)).toBeLessThan(2.1);
    const short = play({ type: 'pluck', freq: 220, decay: 0.3, brightness: 1 });
    expect(t60Of(short.x, short.sr)).toBeGreaterThan(0.24);
    expect(t60Of(short.x, short.sr)).toBeLessThan(0.33);
    const late = (brightness: number) => {
      const { x, sr } = play({ type: 'pluck', freq: 220, brightness });
      return centroid(x, sr, Math.round(0.2 * sr), 8192);
    };
    expect(late(0)).toBeLessThan(late(0.5));
    expect(late(0.5)).toBeLessThan(late(1));
    // A dull string still keeps its fundamental for the whole decay.
    const dull = play({ type: 'pluck', freq: 220, decay: 2, brightness: 0 });
    expect(rmsOf(dull.x, dull.sr, Math.round(1.1 * dull.sr))).toBeGreaterThan(rmsOf(dull.x, 4800, 9600) * 0.02);
  });

  it('mutes', () => {
    expect(play({ type: 'pluck', mute: 0.6 }).r.duration).toBeLessThan(0.5);
    const { x, sr } = play({ type: 'pluck', decay: 3, mute: [[0, 0], [0.4, 0], [0.45, 1]] });
    expect(rmsOf(x, Math.round(0.3 * sr), Math.round(0.4 * sr))).toBeGreaterThan(0.02);
    expect(peakOf(x, Math.round(0.55 * sr))).toBeLessThan(0.01);
  });

  it('thins the tone near the bridge and hollows it in the middle', () => {
    const middle = play({ type: 'pluck', freq: 200, position: 0.5, brightness: 1 });
    const mag = spectrum(middle.x, 2400);
    const at = (f: number) => mag[Math.round((f * 65536) / middle.sr)];
    expect(at(400)).toBeLessThan(at(200) * 0.05);
    expect(at(800)).toBeLessThan(at(600) * 0.05);
  });

  it('glides', () => {
    const { x, sr } = play({ type: 'pluck', freq: [[0, 220], [0.3, 110]], decay: 3, brightness: 0.4 });
    expect(peakNear(spectrum(x, sr, 32768), sr, 110, 0.2)).toBeCloseTo(110, 0);
  });

  it('sustains under the bow, for the held time', () => {
    const { r, x, sr } = play({ type: 'pluck', excite: 'bow', freq: 196, bowTime: 1, decay: 0.5 });
    expect(r.duration).toBeGreaterThan(1.2);
    expect(rmsOf(x, Math.round(0.7 * sr), Math.round(0.9 * sr))).toBeGreaterThan(0.08);
    expect(peakNear(spectrum(x, 4800, 32768), sr, 196, 0.03)).toBeGreaterThan(193);
    expect(peakNear(spectrum(x, 4800, 32768), sr, 196, 0.03)).toBeLessThan(199);
    const held = play({ type: 'pluck', excite: 'bow', bowTime: 3 }, {}, { events: [{ t: 0, dur: 0.4 }] });
    expect(held.r.duration).toBeLessThan(0.6);
    const struck = play({ type: 'pluck', excite: 'strike', freq: 130 });
    expect(peakNear(spectrum(struck.x, 2400), struck.sr, 130, 0.03)).toBeCloseTo(130, 0);
  });
});

describe('particles', () => {
  const click = { kind: 'click', lo: 4000, hi: 4000, levelJitter: 0 };

  it('throws more particles from a louder event with velDensity, and only louder ones without', () => {
    const cloud = (velDensity?: number) => ({ type: 'particles', density: 200, duration: 1, grain: click, ...(velDensity === undefined ? {} : { velDensity }) });
    const count = (velDensity: number | undefined, vel: number) => onsets(play(cloud(velDensity), {}, { events: [{ t: 0, vel }] }).x, 0.05 * vel, 12).length;
    // Without it a soft event throws as many as a loud one; with it, about half as many at half the velocity.
    expect(play(cloud(0)).x).toEqual(play(cloud()).x);
    expect(Math.abs(count(undefined, 0.5) - count(undefined, 1))).toBeLessThan(0.15 * count(undefined, 1));
    expect(count(1, 0.5)).toBeLessThan(0.65 * count(1, 1));
    expect(count(1, 0.5)).toBeGreaterThan(0.35 * count(1, 1));
  });

  it('keeps a regular train in step with `polarity: same`, so it sounds at its rate', () => {
    const train = (polarity?: string) => ({
      type: 'particles',
      distribution: 'regular',
      jitter: 0,
      density: 700,
      duration: 1,
      grain: { kind: 'click', lo: 3000, hi: 3000, levelJitter: 0, ...(polarity ? { polarity } : {}) },
    });
    const plain = play(train()).x;
    expect(play(train('random')).x).toEqual(plain);
    const same = play(train('same'));
    const line = (x: ArrayLike<number>) => {
      const mag = spectrum(x, 4800, 32768);
      const bin = Math.round((700 * 32768) / same.sr);
      return Math.max(mag[bin - 1], mag[bin], mag[bin + 1]);
    };
    // Every click the same way: a strong line at 700 Hz. Flipped at random: hardly any.
    expect(line(same.x)).toBeGreaterThan(10 * line(plain));
    expect(peakNear(spectrum(same.x, 4800, 32768), same.sr, 700, 0.05)).toBeCloseTo(700, -1);
  });

  it('emits about density times duration particles', () => {
    for (const density of [20, 200]) {
      const { x } = play({ type: 'particles', density, duration: 2, grain: click });
      const count = onsets(x, 0.3, 12).length;
      expect(count).toBeGreaterThan(density * 2 * 0.75);
      expect(count).toBeLessThan(density * 2 * 1.25);
    }
  });

  it('spaces regular particles evenly', () => {
    const { x, sr } = play({ type: 'particles', distribution: 'regular', density: 10, jitter: 0, duration: 1, grain: click });
    const hits = onsets(x, 0.3, 100);
    expect(hits.length).toBe(10);
    hits.forEach((h, k) => expect(h / sr).toBeCloseTo(k * 0.1, 3));
    const loose = onsets(play({ type: 'particles', distribution: 'regular', density: 10, jitter: 1, duration: 1, grain: click }).x, 0.3, 100);
    expect(loose.some((h, k) => Math.abs(h / sr - k * 0.1) > 0.005)).toBe(true);
  });

  it('follows a density that builds', () => {
    const { x, sr } = play({ type: 'particles', density: [[0, 5], [2, 500]], duration: 2, grain: click });
    const hits = onsets(x, 0.3, 12);
    const early = hits.filter((h) => h < sr).length;
    expect(hits.length - early).toBeGreaterThan(early * 4);
  });

  it('thins a burst out from a dense start', () => {
    const { x, sr } = play({ type: 'particles', distribution: 'burst', density: 400, duration: 2, grain: click });
    const hits = onsets(x, 0.05, 12);
    expect(hits[0]).toBe(0);
    const firstQuarter = hits.filter((h) => h < 0.5 * sr).length;
    expect(firstQuarter).toBeGreaterThan(hits.length * 0.6);
    expect(peakOf(x, Math.round(1.5 * sr))).toBeLessThan(0.6);
  });

  it('bounces in shrinking gaps, each softer', () => {
    const { r, x, sr } = play({ type: 'particles', distribution: 'bounce', interval: 0.2, ratio: 0.7, jitter: 0, duration: 5, grain: { ...click, kind: 'ping', decayLo: 0.01, decayHi: 0.01 } });
    const hits = onsets(x, 0.02, 200).slice(0, 6);
    expect(hits.length).toBe(6);
    for (let k = 1; k < 5; k++) {
      const gap = (hits[k] - hits[k - 1]) / sr;
      expect(gap).toBeCloseTo(0.2 * 0.7 ** (k - 1), 2);
      expect(peakOf(x, hits[k], hits[k] + 300)).toBeLessThan(peakOf(x, hits[k - 1], hits[k - 1] + 300));
    }
    expect(r.duration).toBeLessThan(1);
  });

  it('draws frequencies from the range, lower when the range is', () => {
    const c = (lo: number, hi: number, kind: string) => {
      const { x, sr } = play({ type: 'particles', density: 300, grain: { kind, lo, hi, decayLo: 0.01, decayHi: 0.05 } });
      return centroid(x, sr, 0, 32768);
    };
    for (const kind of ['tick', 'click', 'ping', 'drop', 'chirp', 'crackle', 'modal', 'grain']) {
      expect(c(300, 600, kind), kind).toBeLessThan(c(4000, 8000, kind));
    }
    const one = play({ type: 'particles', density: 100, grain: { kind: 'ping', lo: 1000, hi: 1000, decayLo: 0.1, decayHi: 0.1 } });
    expect(peakNear(spectrum(one.x), one.sr, 1000, 0.05)).toBeCloseTo(1000, -1);
  });

  it('rings as long as the grain decay says', () => {
    const tail = (decay: number) => play({ type: 'particles', density: 50, duration: 0.5, grain: { kind: 'ping', decayLo: decay, decayHi: decay } }).r.duration - 0.5;
    expect(tail(0.02)).toBeLessThan(0.05);
    expect(tail(0.6)).toBeGreaterThan(0.3);
  });

  it('scatters in stereo only when asked', () => {
    const source = { type: 'particles', density: 100, grain: { kind: 'ping' } };
    const wide = render(patchOf({ ...source, spread: 1 }, { output: { channels: 2 } }));
    expect(wide.channels.length).toBe(2);
    let diff = 0;
    for (let i = 0; i < wide.channels[0].length; i++) diff = Math.max(diff, Math.abs(wide.channels[0][i] - wide.channels[1][i]));
    expect(diff).toBeGreaterThan(0.3);
    const narrow = render(patchOf(source, { output: { channels: 2 } }));
    expect(narrow.channels[0]).toEqual(narrow.channels[1]);
    // Folded to mono, the spread cloud is still there.
    expect(peakOf(play({ ...source, spread: 1 }).x)).toBeGreaterThan(0.4);
  });

  it('never renders an empty cloud', () => {
    const { r, x } = play({ type: 'particles', density: 0.01, duration: 0.2 });
    expect(r.warnings).toEqual([]);
    expect(peakOf(x)).toBeGreaterThan(0.5);
  });
});
