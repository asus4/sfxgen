/**
 * The tone, dynamics and modulation effects, rendered through the public `render()` in small patches: defaults,
 * examples and extremes stay finite and audible, and each effect does what its docs promise.
 */
import { describe, expect, it } from 'vitest';
import { render, validatePatch, type EffectSpec, type Patch, type SourceSpec } from '../src/core';
import { SHAPE_EFFECTS } from '../src/core/effects/catalog-shape';
import { fft } from '../src/core/dsp/fft';

const SR = 48000;

const SAW: SourceSpec = { type: 'osc', wave: 'saw', freq: [[0, 330], [0.3, 110]], env: { attack: 0.002, decay: 0.45 } };
const HIT: SourceSpec = { type: 'osc', wave: 'sine', freq: [[0, 240], [0.04, 60]], env: { attack: 0.0005, decay: 0.35 } };
const NOISE: SourceSpec = { type: 'noise', color: 'white', gain: -12, env: { attack: 0.001 } };
const sine = (freq: number, gain = 0): SourceSpec => ({ type: 'osc', wave: 'sine', freq, gain, env: { attack: 0.001 } });

interface Opts {
  source?: SourceSpec;
  duration?: number | 'auto';
  stereo?: boolean;
  /** No normalisation, DC filter or fades: the samples as the effects left them. */
  raw?: boolean;
}

function patch(fx: EffectSpec[], o: Opts = {}): Patch {
  return {
    format: 'sfxgen/1',
    name: 'shape effects test',
    duration: o.duration ?? 0.5,
    seed: 5,
    output: { sampleRate: SR, channels: o.stereo ? 2 : 1 },
    tracks: [{ id: 'a', source: o.source ?? SAW, fx }],
    master: o.raw ? { normalize: { mode: 'none' }, dcBlock: false, fadeIn: 0, fadeOut: 0 } : {},
  };
}

function run(fx: EffectSpec[], o: Opts = {}) {
  const r = render(patch(fx, o));
  // Raw renders skip normalisation, so levels over full scale are expected there.
  expect(r.warnings.filter((w) => !(o.raw && w.includes('will clip on export')))).toEqual([]);
  for (const ch of r.channels) for (const v of ch) if (!Number.isFinite(v)) throw new Error('non-finite sample');
  return r;
}

const db = (g: number) => 20 * Math.log10(Math.max(g, 1e-15));
const sec = (t: number) => Math.round(t * SR);
function peak(x: ArrayLike<number>, a = 0, b = x.length) {
  let p = 0;
  for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}
function rms(x: ArrayLike<number>, a = 0, b = x.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
function corr(a: ArrayLike<number>, b: ArrayLike<number>) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
}
function maxStep(x: ArrayLike<number>, a = 1, b = x.length) {
  let m = 0;
  for (let i = Math.max(a, 1); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}
/** Peak level in 5 ms blocks. */
function envelope(x: ArrayLike<number>, a = 0, b = x.length) {
  const out: number[] = [];
  for (let i = a; i + 240 <= b; i += 240) out.push(peak(x, i, i + 240));
  return out;
}
/** Averaged power spectrum (Welch, 4096-point Hann frames), and the level in dB near a frequency. */
function powerSpectrum(x: ArrayLike<number>) {
  const N = 4096;
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return (f: number, width = 1) => {
    const k = Math.round((f / SR) * N);
    let s = 0;
    for (let j = k - width; j <= k + width; j++) s += acc[j] / frames;
    return 10 * Math.log10(s / (2 * width + 1));
  };
}

describe('every shape effect', () => {
  for (const def of Object.values(SHAPE_EFFECTS)) {
    it(`${def.type}: defaults, example and extremes are finite and audible`, () => {
      const stereo = !!def.widens;
      for (const source of [SAW, HIT, NOISE]) {
        const r = run([{ type: def.type }], { source, stereo, duration: source === NOISE ? 0.4 : 'auto' });
        expect(r.channels.length).toBe(stereo ? 2 : 1);
        expect(Math.max(...r.channels.map((ch) => peak(ch)))).toBeGreaterThan(0.5);
      }
      // The example validates without a single warning and renders.
      const example = def.example as EffectSpec;
      const p = patch([example], { stereo });
      const v = validatePatch(p);
      expect(v.errors).toEqual([]);
      expect(v.warnings).toEqual([]);
      run([example], { stereo });
      // Every numeric parameter at both hard limits, alone and all together, in mono and stereo.
      const lows: EffectSpec = { type: def.type };
      const highs: EffectSpec = { type: def.type };
      for (const [name, meta] of Object.entries(def.params)) {
        if (meta.kind !== 'number' && meta.kind !== 'signal') continue;
        for (const [limit, all] of [
          [meta.hardMin, lows],
          [meta.hardMax, highs],
        ] as const) {
          if (limit === undefined) continue;
          all[name] = limit;
          for (const st of [false, true]) {
            const r = run([{ type: def.type, [name]: limit }], { source: HIT, stereo: st });
            expect(r.warnings).not.toContain('the patch renders silence');
          }
        }
      }
      for (const spec of [lows, highs]) for (const st of [false, true]) run([spec], { source: NOISE, stereo: st, duration: 0.3 });
    });
  }

  it('renders inside loops, on buses and on the master', () => {
    for (const def of Object.values(SHAPE_EFFECTS)) {
      const fx = [def.example as EffectSpec];
      const loop: Patch = { ...patch(fx, { source: NOISE, stereo: true, duration: 0.25 }), loop: { mode: 'wrap' } };
      const r = render(loop);
      expect(r.warnings, def.type).toEqual([]);
      expect(r.channels[0].length).toBe(sec(0.25));
      const glued: Patch = {
        ...patch([], { source: HIT, stereo: true }),
        tracks: [
          { id: 'hit', source: HIT, sends: { glue: 0 }, gain: -60 },
          { id: 'air', source: { ...NOISE, env: { attack: 0.001, decay: 0.2 } }, sends: { glue: -6 }, gain: -60 },
        ],
        buses: [{ id: 'glue', fx }],
        master: { fx },
      };
      const g = render(glued);
      expect(g.warnings, def.type).toEqual([]);
      for (const ch of g.channels) expect(ch.every(Number.isFinite)).toBe(true);
    }
  });

  it('renders the same samples every time, in a chain of all of them', () => {
    const chain: EffectSpec[] = Object.values(SHAPE_EFFECTS).map((d) => ({ ...(d.example as EffectSpec), mix: 0.8 }));
    const a = run(chain, { stereo: true, source: SAW });
    const b = run(chain, { stereo: true, source: SAW });
    expect(a.channels[0]).toEqual(b.channels[0]);
    expect(a.channels[1]).toEqual(b.channels[1]);
  });

  it('keeps typical settings fast (1 s of stereo noise each)', () => {
    const base = () => run([], { source: NOISE, stereo: true, duration: 1 });
    base();
    for (const def of Object.values(SHAPE_EFFECTS)) {
      const fx = [def.example as EffectSpec];
      run(fx, { source: NOISE, stereo: true, duration: 1 });
      const t0 = performance.now();
      run(fx, { source: NOISE, stereo: true, duration: 1 });
      const t1 = performance.now();
      base();
      const t2 = performance.now();
      // The target is well under 30 ms on a laptop; the bound is loose for slow CI machines.
      expect(t1 - t0 - (t2 - t1), def.type).toBeLessThan(120);
    }
  });
});

describe('eq', () => {
  it('boosts, cuts and shelves by the asked amount', () => {
    const level = (fx: EffectSpec[], f: number) => db(peak(run(fx, { source: sine(f, -20), raw: true }).channels[0], sec(0.2), sec(0.4)));
    expect(level([{ type: 'eq', bands: [{ mode: 'peak', freq: 1000, gain: 12, q: 2 }] }], 1000)).toBeCloseTo(-8, 1);
    expect(level([{ type: 'eq', bands: [{ mode: 'peak', freq: 1000, gain: 12, q: 2 }] }], 100)).toBeCloseTo(-20, 0);
    expect(level([{ type: 'eq', bands: [{ mode: 'highshelf', freq: 2000, gain: -6 }] }], 12000)).toBeCloseTo(-26, 0);
    const cut = level([{ type: 'eq', bands: [{ mode: 'lowcut', freq: 1000, slope: '24' }] }], 250);
    expect(cut).toBeGreaterThan(-20 - 50);
    expect(cut).toBeLessThan(-20 - 46);
    expect(level([{ type: 'eq', bands: [{ mode: 'notch', freq: 1000, q: 4 }] }], 1000)).toBeLessThan(-60);
    // Cuts and shelves are flat at q 0.707: -3 dB at the corner of a 12 dB cut.
    expect(level([{ type: 'eq', bands: [{ mode: 'highcut', freq: 1000 }] }], 1000)).toBeCloseTo(-23, 0);
  });

  it('reaches a band by its id from a control', () => {
    const p = patch([{ type: 'eq', id: 'tone', bands: [{ id: 'air', mode: 'peak', freq: 1000, gain: 0, q: 2 }] }], { source: sine(1000, -20), raw: true });
    p.controls = [{ id: 'bite', label: 'Bite', value: 1, targets: [{ path: 'tracks.a.fx.tone.bands.air.gain', from: 0, to: 12 }] }];
    expect(validatePatch(p).warnings).toEqual([]);
    const r = render(p);
    expect(r.warnings).toEqual([]);
    expect(db(peak(r.channels[0], sec(0.2), sec(0.4)))).toBeCloseTo(-8, 1);
  });
});

describe('drive', () => {
  it('keeps silence silent at any bias, in every mode', () => {
    for (const mode of ['tanh', 'soft', 'hard', 'fold', 'tube', 'fuzz', 'rectify']) {
      for (const bias of [-0.5, 0.5]) {
        const x = run([{ type: 'drive', mode, amount: 18, bias }], { source: HIT, duration: 1, raw: true }).channels[0];
        expect(peak(x, 0, sec(0.2)), `${mode} at bias ${bias}`).toBeGreaterThan(0.1);
        expect(peak(x, sec(0.8)), `${mode} at bias ${bias}`).toBeLessThan(1e-3);
      }
    }
  });
});

describe('compressor', () => {
  it('follows its static curve (dBFS reference)', () => {
    const out = (inDb: number) =>
      db(peak(run([{ type: 'compressor', threshold: -20, ratio: 4, knee: 0, reference: 'dbfs' }], { source: sine(1000, inDb), raw: true }).channels[0], sec(0.3), sec(0.45)));
    expect(out(0)).toBeCloseTo(-15, 1);
    expect(out(-10)).toBeCloseTo(-17.5, 1);
    expect(out(-30)).toBeCloseTo(-30, 1);
  });

  it('measures the threshold from the input peak by default, so the level does not matter', () => {
    const gr = (inDb: number) =>
      inDb - db(peak(run([{ type: 'compressor', threshold: -12, ratio: 4, knee: 0 }], { source: sine(1000, inDb), raw: true }).channels[0], sec(0.3), sec(0.45)));
    expect(gr(-30)).toBeCloseTo(9, 1);
    expect(gr(0)).toBeCloseTo(9, 1);
  });

  it('makes a hit punchier at its defaults, and autoMakeup keeps its loudness', () => {
    const crest = (x: Float32Array) => db(peak(x) / rms(x, 0, sec(0.3)));
    const dry = run([], { source: HIT, raw: true }).channels[0];
    const wet = run([{ type: 'compressor' }], { source: HIT, raw: true }).channels[0];
    expect(crest(wet)).toBeGreaterThan(crest(dry) + 1.5);
    const auto = run([{ type: 'compressor', autoMakeup: true }], { source: HIT, raw: true }).channels[0];
    expect(db(rms(auto) / rms(dry))).toBeCloseTo(0, 1);
  });

  it('adds makeup on top of autoMakeup', () => {
    const auto = run([{ type: 'compressor', autoMakeup: true }], { source: HIT, raw: true }).channels[0];
    const boosted = run([{ type: 'compressor', autoMakeup: true, makeup: 6 }], { source: HIT, raw: true }).channels[0];
    expect(db(rms(boosted) / rms(auto))).toBeCloseTo(6, 1);
  });

  it('links stereo channels', () => {
    const p = patch([{ type: 'compressor', threshold: -20, ratio: 4, reference: 'dbfs' }], { source: sine(500), raw: true, stereo: true });
    p.tracks[0].pan = -0.9;
    const r = render(p);
    const [l, r2] = r.channels;
    const inL = Math.cos(((-0.9 + 1) * Math.PI) / 4) * Math.SQRT2;
    const inR = Math.sin(((-0.9 + 1) * Math.PI) / 4) * Math.SQRT2;
    const grL = db(inL / peak(l, sec(0.3), sec(0.45)));
    const grR = db(inR / peak(r2, sec(0.3), sec(0.45)));
    expect(grL).toBeGreaterThan(6);
    expect(grR).toBeCloseTo(grL, 1);
  });
});

describe('limiter', () => {
  it('never goes over its ceiling', () => {
    for (const lookahead of [0.0001, 0.003, 0.02]) {
      for (const release of [0.001, 0.06, 2]) {
        const r = run([{ type: 'limiter', reference: 'dbfs', ceiling: -3, gain: 18, lookahead, release }], { source: { ...NOISE, gain: 0 }, raw: true, stereo: true });
        const ceiling = 10 ** (-3 / 20);
        for (const ch of r.channels) expect(peak(ch)).toBeLessThanOrEqual(ceiling * (1 + 1e-6));
        expect(peak(r.channels[0])).toBeGreaterThan(ceiling * 0.99);
      }
    }
  });

  it('by default keeps the peak and pushes the body up by `gain`', () => {
    const dry = run([], { source: HIT, raw: true }).channels[0];
    const wet = run([{ type: 'limiter', gain: 6 }], { source: HIT, raw: true }).channels[0];
    expect(db(peak(wet) / peak(dry))).toBeCloseTo(0, 2);
    expect(db(rms(wet) / rms(dry))).toBeGreaterThan(1);
  });
});

describe('transient', () => {
  const attackToBody = (x: Float32Array) => db(rms(x, 0, sec(0.01)) / rms(x, sec(0.04), sec(0.15)));
  /** Seconds until the 5 ms envelope stays below -40 dB of the peak. */
  const ringTime = (x: Float32Array) => {
    const env = envelope(x);
    const p = Math.max(...env);
    let last = 0;
    env.forEach((e, i) => {
      if (e > p * 0.01) last = i;
    });
    return (last * 240) / SR;
  };

  it('adds or removes attack', () => {
    const dry = attackToBody(run([], { source: HIT, raw: true }).channels[0]);
    expect(attackToBody(run([{ type: 'transient', attack: 9 }], { source: HIT, raw: true }).channels[0])).toBeGreaterThan(dry + 4);
    expect(attackToBody(run([{ type: 'transient', attack: -9 }], { source: HIT, raw: true }).channels[0])).toBeLessThan(dry - 4);
  });

  it('lengthens or tightens the body', () => {
    const dry = ringTime(run([], { source: HIT, raw: true }).channels[0]);
    expect(ringTime(run([{ type: 'transient', attack: 0, sustain: -12 }], { source: HIT, raw: true }).channels[0])).toBeLessThan(dry - 0.03);
    expect(ringTime(run([{ type: 'transient', attack: 0, sustain: 9 }], { source: HIT, raw: true }).channels[0])).toBeGreaterThan(dry + 0.03);
  });

  it('works the same at any level', () => {
    const loud = run([{ type: 'transient', attack: 9, sustain: -6 }], { source: HIT }).channels[0];
    const quiet = run([{ type: 'transient', attack: 9, sustain: -6 }], { source: { ...HIT, gain: -36 } }).channels[0];
    let diff = 0;
    for (let i = 0; i < loud.length; i++) diff = Math.max(diff, Math.abs(loud[i] - quiet[i]));
    expect(diff).toBeLessThan(1e-4);
  });
});

describe('gate', () => {
  it('chops the tail below its threshold and keeps the onset', () => {
    const dry = run([], { source: HIT, raw: true }).channels[0];
    const gated = run([{ type: 'gate', threshold: -20 }], { source: HIT, raw: true }).channels[0];
    expect(db(rms(gated, sec(0.25), sec(0.33)) / rms(dry, sec(0.25), sec(0.33)))).toBeLessThan(-60);
    expect(db(rms(gated, 0, sec(0.005)) / rms(dry, 0, sec(0.005)))).toBeCloseTo(0, 1);
    const expander = run([{ type: 'gate', threshold: -20, range: -12 }], { source: HIT, raw: true }).channels[0];
    expect(db(rms(expander, sec(0.25), sec(0.33)) / rms(dry, sec(0.25), sec(0.33)))).toBeCloseTo(-12, 0);
  });
});

describe('crush', () => {
  it('quantises to the asked number of bits, against the input peak', () => {
    for (const gain of [0, -30]) {
      const x = run([{ type: 'crush', bits: 3 }], { source: sine(440, gain), raw: true }).channels[0];
      const levels = new Set(Array.from(x.subarray(sec(0.05), sec(0.45))));
      expect(levels.size).toBeLessThanOrEqual(9);
      expect(levels.size).toBeGreaterThanOrEqual(7);
    }
  });

  it('holds samples at the reduced rate', () => {
    const x = run([{ type: 'crush', bits: 16, rate: 4000 }], { source: sine(440), raw: true }).channels[0];
    let runs = 0;
    let len = 0;
    for (let i = sec(0.05) + 1; i < sec(0.45); i++) {
      if (x[i] === x[i - 1]) len++;
      else runs++;
    }
    expect((len + runs) / runs).toBeCloseTo(12, 0);
  });
});

describe('tremolo', () => {
  it('chops with a square wave without clicking', () => {
    const dry = run([], { source: sine(1000, -6), raw: true }).channels[0];
    const x = run([{ type: 'tremolo', rate: 10, depth: 1, shape: 'square' }], { source: sine(1000, -6), raw: true }).channels[0];
    const env = envelope(x, sec(0.05), sec(0.45));
    expect(Math.min(...env)).toBeLessThan(0.01 * Math.max(...env));
    expect(Math.max(...env)).toBeGreaterThan(0.95 * peak(dry));
    expect(maxStep(x, sec(0.01))).toBeLessThan(maxStep(dry, sec(0.01)) * 1.05);
  });

  it('auto-pans in stereo', () => {
    const [l, r] = run([{ type: 'tremolo', rate: 4, depth: 1, stereo: 0.5 }], { source: sine(1000), raw: true, stereo: true }).channels;
    expect(corr(envelope(l).map((v) => v - 0.5), envelope(r).map((v) => v - 0.5))).toBeLessThan(-0.9);
  });
});

describe('ringmod', () => {
  it('replaces each frequency with its sum and difference with the carrier', () => {
    const x = run([{ type: 'ringmod', freq: 300 }], { source: sine(440), raw: true, duration: 1 }).channels[0];
    const at = powerSpectrum(x.subarray(sec(0.05)));
    expect(at(140)).toBeGreaterThan(at(440) + 40);
    expect(at(740)).toBeGreaterThan(at(440) + 40);
  });
});

describe('chorus, flanger, phaser and width', () => {
  it('chorus makes stereo from a mono layer', () => {
    const [l, r] = run([{ type: 'chorus' }], { source: NOISE, stereo: true }).channels;
    expect(corr(l, r)).toBeLessThan(0.9);
    expect(run([{ type: 'chorus' }], { source: NOISE }).channels.length).toBe(1);
  });

  it('flanger combs at odd multiples of 1 / (2 delay)', () => {
    const x = run([{ type: 'flanger', depth: 0, delay: 0.001, feedback: 0 }], { source: NOISE, raw: true, duration: 1 }).channels[0];
    const at = powerSpectrum(x);
    expect(at(500, 2)).toBeLessThan(at(1000, 2) - 20);
    expect(at(1500, 2)).toBeLessThan(at(2000, 2) - 20);
  });

  it('phaser notches where its allpasses turn the phase over', () => {
    const x = run([{ type: 'phaser', depth: 0, freq: 1000, stages: '2', feedback: 0 }], { source: NOISE, raw: true, duration: 1 }).channels[0];
    const at = powerSpectrum(x);
    expect(at(1000, 2)).toBeLessThan(at(250, 2) - 20);
    expect(at(1000, 2)).toBeLessThan(at(4000, 2) - 20);
  });

  it('width folds to mono at 0 and a Haas delay widens a mono layer', () => {
    const [l0, r0] = run([{ type: 'width', width: 0, haas: 0.01 }], { source: NOISE, stereo: true, raw: true }).channels;
    expect(Array.from(l0)).toEqual(Array.from(r0));
    const [l, r] = run([{ type: 'width', haas: 0.01, width: 1 }], { source: NOISE, stereo: true, raw: true }).channels;
    expect(Math.abs(corr(l, r))).toBeLessThan(0.3);
  });
});

describe('reverse', () => {
  it('lands the climax at `at` and is silent after it', () => {
    for (const at of [0.2, 0.4]) {
      const x = run([{ type: 'reverse', at }], { source: { ...HIT, env: { attack: 0.0005, decay: 0.12 } }, duration: 1, raw: true }).channels[0];
      const end = Math.round(at * SR);
      // The loudest moment is the hit's own start, now at `at`; nothing follows.
      let peakAt = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[peakAt])) peakAt = i;
      expect(Math.abs(peakAt - end) / SR).toBeLessThan(0.01);
      expect(Math.max(...Array.from(x.subarray(end + 2)).map(Math.abs))).toBe(0);
    }
  });

  it('plays the whole buffer backwards with align end', () => {
    const dry = run([], { source: HIT, raw: true }).channels[0];
    const rev = run([{ type: 'reverse', align: 'end' }], { source: HIT, raw: true }).channels[0];
    expect(rev.length).toBe(dry.length);
    for (let i = 0; i < dry.length; i += 97) expect(rev[i]).toBe(dry[dry.length - 1 - i]);
    const twice = run([{ type: 'reverse', align: 'end' }, { type: 'reverse', align: 'end' }], { source: HIT, raw: true }).channels[0];
    expect(Array.from(twice)).toEqual(Array.from(dry));
  });

  it('by default starts the reversed sound where the track starts', () => {
    // A 0.15 s hit in a 1 s patch: the swell peaks near 0.15 s, not at the end.
    const x = run([{ type: 'reverse' }], { source: { ...HIT, env: { attack: 0.0005, decay: 0.12 } }, duration: 1, raw: true }).channels[0];
    let at = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i;
    expect(at / SR).toBeGreaterThan(0.1);
    expect(at / SR).toBeLessThan(0.2);
    expect(peak(x, sec(0.3))).toBe(0);
  });
});

describe('formant', () => {
  it('puts the formants of each vowel in place, at the input loudness', () => {
    const buzz: SourceSpec = { type: 'osc', wave: 'saw', freq: 110, gain: -6, env: { attack: 0.002 } };
    const dry = run([], { source: buzz, raw: true, duration: 1 }).channels[0];
    const a = run([{ type: 'formant', vowel: 0 }], { source: buzz, raw: true, duration: 1 }).channels[0];
    const i = run([{ type: 'formant', vowel: 2 }], { source: buzz, raw: true, duration: 1 }).channels[0];
    const sa = powerSpectrum(a);
    const si = powerSpectrum(i);
    // "a" opens the first formant to about 650 Hz; "i" keeps it near 290 Hz and lifts the second to about 1870 Hz.
    expect(sa(660) - sa(330)).toBeGreaterThan(6);
    expect(si(330) - si(660)).toBeGreaterThan(6);
    expect(si(1870) - sa(1870)).toBeGreaterThan(6);
    expect(db(rms(a) / rms(dry))).toBeCloseTo(0, 1);
  });

  it('speaks the rounded ü and ö darker than e, and stays finite at both ends', () => {
    const buzz: SourceSpec = { type: 'osc', wave: 'saw', freq: 110, gain: -6, env: { attack: 0.002 } };
    const e = powerSpectrum(run([{ type: 'formant', vowel: 1 }], { source: buzz, raw: true, duration: 1 }).channels[0]);
    const oe = run([{ type: 'formant', vowel: 6 }], { source: buzz, raw: true, duration: 1 }).channels[0];
    const so = powerSpectrum(oe);
    // e's third formant is at 2600 Hz; ö's sits at 2200 Hz, where e has a valley.
    expect(so(2200) - e(2200)).toBeGreaterThan(3);
    expect(e(2600) - so(2600)).toBeGreaterThan(3);
    for (const v of [0, 5, 6]) expect(Number.isFinite(rms(run([{ type: 'formant', vowel: v }], { source: buzz, raw: true, duration: 0.3 }).channels[0]))).toBe(true);
  });
});
