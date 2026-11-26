import { describe, expect, it } from 'vitest';
import { Rng, hashString, render, renderVoice, validatePatch, getSource, type Patch, type SourceSpec } from '../src/core';
import { fft, magnitudeSpectrum } from '../src/core/dsp/fft';
import { FormantBank, vowelPattern } from '../src/core/dsp/formants';
import { voiceLength } from '../src/core/render';

const SR = 48000;
const HOLD = { attack: 0.005, sustain: 1 };

/** One event of a source (source, voice filter, envelope), mono, without normalisation. */
function voice(spec: SourceSpec, seconds = 1, opts: { seed?: number; vel?: number; sr?: number } = {}): Float64Array {
  const sr = opts.sr ?? SR;
  const out = renderVoice(spec, { t: 0, pitch: 0, vel: opts.vel ?? 1, dur: Infinity }, Math.round(seconds * sr), sr, new Rng(hashString('test', opts.seed ?? 1)), []);
  return out.length === 1 ? out[0] : out[0].map((v, i) => 0.5 * (v + out[1][i]));
}

function peakOf(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

function allFinite(x: ArrayLike<number>): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

function mean(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}

function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Power spectrum averaged over frames of `size` between t0 and t1 seconds. */
function spectrum(x: Float64Array, t0 = 0.05, t1 = 0.6, size = 8192, sr = SR): Float64Array {
  const acc = new Float64Array(size / 2 + 1);
  for (let s = Math.round(t0 * sr); s + size <= Math.min(x.length, Math.round(t1 * sr)); s += size / 2) {
    const m = magnitudeSpectrum(x.subarray(s, s + size));
    for (let k = 0; k < acc.length; k++) acc[k] += m[k] * m[k];
  }
  return acc;
}

const binOf = (hz: number, size = 8192, sr = SR) => Math.round((hz * size) / sr);

/**
 * Energy within ±width Hz of a frequency (at least ±2 bins, so a tone between bins counts in full), dB relative to
 * the strongest such window anywhere in the spectrum.
 */
function levelAt(spec: Float64Array, hz: number, width = 15, size = 8192): number {
  const w = Math.max(2, binOf(width, size));
  const sum = (c: number) => {
    let e = 0;
    for (let k = c - w; k <= c + w; k++) if (k >= 0 && k < spec.length) e += spec[k];
    return e;
  };
  let top = 0;
  for (let c = 0; c < spec.length; c++) top = Math.max(top, sum(c));
  return 10 * Math.log10(sum(binOf(hz, size)) / top + 1e-30);
}

function centroid(spec: Float64Array, size = 8192): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k < spec.length; k++) {
    num += spec[k] * ((k * SR) / size);
    den += spec[k];
  }
  return num / den;
}

/** The strongest bin's frequency. */
function strongest(spec: Float64Array, size = 8192, minHz = 20): number {
  let best = binOf(minHz, size);
  for (let k = best; k < spec.length; k++) if (spec[k] > spec[best]) best = k;
  return (best * SR) / size;
}

function patchOf(source: SourceSpec): Patch {
  return { format: 'sfxgen/1', name: 'test', duration: 'auto', seed: 5, tracks: [{ id: 't', source }] };
}

const TONAL = ['fm', 'additive', 'voice', 'machine', 'chaos'];

describe('tonal sources: common checks', () => {
  for (const type of TONAL) {
    it(`${type}: renders its defaults finite, audible and near unit peak`, () => {
      const x = voice({ type });
      expect(allFinite(x)).toBe(true);
      const p = peakOf(x);
      expect(p).toBeGreaterThan(0.3);
      expect(p).toBeLessThan(2);
      expect(Math.abs(mean(x))).toBeLessThan(0.01);
    });

    it(`${type}: its example validates and renders without warnings`, () => {
      const def = getSource(type)!;
      expect(def.doc.length).toBeGreaterThan(80);
      const patch = patchOf(def.example as SourceSpec);
      const v = validatePatch(patch);
      expect(v.errors).toEqual([]);
      expect(v.warnings).toEqual([]);
      const r = render(patch);
      expect(r.warnings).toEqual([]);
      expect(r.duration).toBeGreaterThan(0.1);
      expect(allFinite(r.channels[0])).toBe(true);
    });

    it(`${type}: every parameter is documented with sane metadata`, () => {
      const def = getSource(type)!;
      const check = (name: string, m: NonNullable<ReturnType<typeof getSource>>['params'][string]) => {
        expect(m.doc.length, name).toBeGreaterThan(20);
        if (m.kind === 'signal' || m.kind === 'number') {
          if (m.min !== undefined && m.max !== undefined) expect(m.min, name).toBeLessThan(m.max);
          if (m.hardMin !== undefined && m.min !== undefined) expect(m.hardMin, name).toBeLessThanOrEqual(m.min);
          if (m.hardMax !== undefined && m.max !== undefined) expect(m.hardMax, name).toBeGreaterThanOrEqual(m.max);
          if (m.unit === 'Hz') expect(m.scale, name).toBe('log');
        }
        for (const [k, f] of Object.entries(m.fields ?? {})) check(`${name}.${k}`, f);
        if (m.item) check(`${name}[]`, m.item);
      };
      for (const [name, m] of Object.entries(def.params)) check(name, m);
    });

    it(`${type}: is deterministic, and the seed changes the take`, () => {
      const spec = { type };
      const a = voice(spec, 0.5, { seed: 3 });
      const b = voice(spec, 0.5, { seed: 3 });
      expect(a).toEqual(b);
      if (type !== 'fm') {
        const c = voice(spec, 0.5, { seed: 4 });
        expect(c).not.toEqual(a);
      }
    });

    it(`${type}: renders a 1 s event quickly`, () => {
      voice({ type, env: HOLD } as SourceSpec, 0.2);
      const t = performance.now();
      voice({ type, env: HOLD } as SourceSpec, 1);
      expect(performance.now() - t).toBeLessThan(150);
    });
  }
});

describe('fm', () => {
  it('a lone carrier is a sine at freq', () => {
    const s = spectrum(voice({ type: 'fm', freq: 500, ops: [{ ratio: 1 }], env: HOLD }));
    expect(strongest(s)).toBeCloseTo(500, -1);
    expect(levelAt(s, 1000)).toBeLessThan(-80);
  });

  it('a modulator makes sidebands at the carrier plus multiples of its frequency', () => {
    const s = spectrum(voice({ type: 'fm', freq: 1000, ops: [{ ratio: 1 }, { ratio: 2, index: 1.5 }], env: HOLD }));
    expect(levelAt(s, 1000)).toBeGreaterThan(-3);
    expect(levelAt(s, 3000)).toBeGreaterThan(-15);
    expect(levelAt(s, 2000)).toBeLessThan(-60);
  });

  it('a decaying index envelope makes the tone mellow as it rings', () => {
    const x = voice({ type: 'fm', freq: 400, ops: [{ ratio: 1 }, { ratio: 3.5, index: 6, env: { decay: 0.4, sustain: 0 } }], env: HOLD }, 1.5);
    expect(centroid(spectrum(x, 0, 0.2, 4096))).toBeGreaterThan(2 * centroid(spectrum(x, 1, 1.4, 4096)));
  });

  it('softer events are darker', () => {
    const spec = { type: 'fm', freq: 300, ops: [{ ratio: 1 }, { ratio: 2, index: 4 }], env: HOLD };
    expect(centroid(spectrum(voice(spec, 1, { vel: 0.2 })))).toBeLessThan(0.8 * centroid(spectrum(voice(spec, 1, { vel: 1 }))));
  });

  it('keeps the sidebands below Nyquist at high pitch (no aliasing)', () => {
    // Carrier 4 kHz, modulator 10.8 kHz: without the guard, index 20 folds sidebands back to 19.6 and 1.2 kHz.
    const s = spectrum(voice({ type: 'fm', freq: 4000, ops: [{ ratio: 1 }, { ratio: 2.7, index: 20 }], env: HOLD }));
    expect(levelAt(s, 19600)).toBeLessThan(-60);
    expect(levelAt(s, 1200)).toBeLessThan(-60);
    // ...while the real sidebands at |4000 ± 10800| keep the tone bright.
    expect(levelAt(s, 6800)).toBeGreaterThan(-10);
    expect(levelAt(s, 14800)).toBeGreaterThan(-10);
  });

  it('pairs makes two carriers, stack chains them', () => {
    const pairs = spectrum(voice({ type: 'fm', freq: 200, algorithm: 'pairs', ops: [{ ratio: 1 }, { ratio: 1, index: 0 }, { ratio: 3.3 }, { ratio: 1, index: 0 }], env: HOLD }));
    expect(levelAt(pairs, 200)).toBeGreaterThan(-4);
    expect(levelAt(pairs, 660)).toBeGreaterThan(-4);
    const stack = spectrum(voice({ type: 'fm', freq: 200, algorithm: 'stack', ops: [{ ratio: 1 }, { ratio: 1, index: 0 }, { ratio: 3.3, index: 5 }], env: HOLD }));
    // ops[2] only reaches ops[1], whose index is 0, so the carrier stays a sine.
    expect(levelAt(stack, 660)).toBeLessThan(-60);
  });

  it('stays finite and bounded at its hard limits', () => {
    const extremes: SourceSpec[] = [
      { type: 'fm', freq: 20000, ops: [{ ratio: 64, feedback: 4 }, { ratio: 64, index: 100, feedback: 4 }, { ratio: 0, index: 100 }, { fixed: 24000, index: 100, feedback: 4 }] },
      { type: 'fm', freq: 60, algorithm: 'parallel', ops: [{ ratio: 1, feedback: 4 }, { ratio: 16, index: 100, feedback: 4 }, { fixed: 1, index: 100 }, { ratio: 0.25, index: 100, detune: -1200 }] },
      { type: 'fm', freq: 0.5, ops: [{ ratio: 0.001 }, { ratio: 64, index: 100 }] },
    ];
    for (const spec of extremes) {
      const x = voice({ ...spec, env: HOLD } as SourceSpec, 0.5);
      expect(allFinite(x)).toBe(true);
      expect(peakOf(x)).toBeLessThan(2);
    }
    expect(peakOf(voice({ ...extremes[1], env: HOLD } as SourceSpec, 0.5))).toBeGreaterThan(0.3);
  });
});

describe('additive', () => {
  it('builds a harmonic series with odd/even balance and tilt', () => {
    const all = spectrum(voice({ type: 'additive', freq: 200, harmonics: 8, tilt: -6, decay: 0, env: HOLD }));
    for (let k = 1; k <= 8; k++) expect(levelAt(all, 200 * k)).toBeGreaterThan(-30);
    // -6 dB per octave: the 4th harmonic sits 12 dB below the fundamental.
    expect(Math.abs(levelAt(all, 800) - levelAt(all, 200) + 12)).toBeLessThan(0.5);
    const odd = spectrum(voice({ type: 'additive', freq: 200, harmonics: 8, odd: 1, decay: 0, env: HOLD }));
    expect(levelAt(odd, 400)).toBeLessThan(-80);
    expect(levelAt(odd, 600)).toBeGreaterThan(-20);
  });

  it('stretches partials like a stiff string', () => {
    const s = spectrum(voice({ type: 'additive', freq: 100, harmonics: 12, stretch: 0.005, decay: 0, env: HOLD }), 0.05, 0.6, 16384);
    const tenth = (10 * Math.sqrt(1 + 0.005 * 100)) / Math.sqrt(1.005);
    expect(levelAt(s, 100 * tenth, 3, 16384)).toBeGreaterThan(levelAt(s, 1000, 3, 16384) + 20);
  });

  it('damping makes the highs die first, and the partials set the natural length', () => {
    const spec = { type: 'additive', freq: 300, harmonics: 6, tilt: 0, decay: 1, damping: 1 };
    const x = voice(spec as SourceSpec, 1);
    const early = spectrum(x, 0, 0.2, 4096);
    const late = spectrum(x, 0.5, 0.7, 4096);
    const ratio = (s: Float64Array) => levelAt(s, 1800, 30, 4096) - levelAt(s, 300, 30, 4096);
    expect(ratio(late)).toBeLessThan(ratio(early) - 20);
    expect(voiceLength(spec as SourceSpec, Infinity)).toBeCloseTo(1.02, 2);
    expect(voiceLength({ type: 'additive', decay: 0 }, Infinity)).toBe(Infinity);
  });

  it('plays explicit partials with their own decays', () => {
    const x = voice({ type: 'additive', freq: 500, partials: [{ ratio: 1, decay: 3 }, { ratio: 2.76, amp: 1, decay: 0.3 }], env: HOLD }, 1);
    const early = spectrum(x, 0, 0.1, 4096);
    const late = spectrum(x, 0.6, 0.9, 4096);
    expect(levelAt(early, 1380, 30, 4096)).toBeGreaterThan(-12);
    expect(levelAt(late, 1380, 30, 4096)).toBeLessThan(-60);
    expect(levelAt(late, 500, 30, 4096)).toBeGreaterThan(-3);
  });

  it('renders stereo partials when width is set', () => {
    const out = renderVoice({ type: 'additive', width: 1 }, { t: 0, pitch: 0, vel: 1, dur: Infinity }, 4800, SR, new Rng(1), []);
    expect(out.length).toBe(2);
    expect(out[0]).not.toEqual(out[1]);
  });

  it('stays finite and bounded at its hard limits', () => {
    for (const spec of [
      { type: 'additive', freq: 20000, harmonics: 128, stretch: 0.5, tilt: 24, decay: 120, damping: 6, beat: 200, width: 1 },
      { type: 'additive', freq: 1, harmonics: 128, tilt: -60, decay: 0, damping: 0 },
      { type: 'additive', freq: 30, harmonics: 128, tilt: 24, odd: 0, decay: 0 },
      { type: 'additive', partials: [{ ratio: 512, amp: 16 }, { ratio: 0.001, amp: 16, decay: 120 }], tilt: -60 },
    ]) {
      const x = voice({ ...spec, env: HOLD } as SourceSpec, 0.3);
      expect(allFinite(x)).toBe(true);
      expect(peakOf(x)).toBeLessThan(3);
    }
  });
});

describe('voice', () => {
  it('voices at freq', () => {
    const s = spectrum(voice({ type: 'voice', freq: 150, jitter: 0, shimmer: 0, breath: 0, env: HOLD }), 0.1, 0.9, 16384);
    // The harmonics are exact multiples of freq.
    for (const k of [1, 2, 3, 4]) expect(levelAt(s, 150 * k, 3, 16384)).toBeGreaterThan(levelAt(s, 150 * k + 75, 3, 16384) + 20);
  });

  it('puts the formants of each vowel where they belong, scaled by size', () => {
    // The bank's impulse response, unwindowed (it starts at its loudest).
    const response = (vowel: number, size: number) => {
      const bank = new FormantBank(SR, 8);
      bank.set(vowelPattern(vowel, size, 1));
      const re = new Float64Array(16384);
      for (let i = 0; i < re.length; i++) re[i] = bank.tick(i === 0 ? 1 : 0);
      const im = new Float64Array(re.length);
      fft(re, im);
      return re.map((v, k) => Math.hypot(v, im[k]));
    };
    /** The strongest frequency within ±span of hz. */
    const near = (m: Float64Array, hz: number, span = 0.12) => {
      let best = 0;
      let at = 0;
      for (let k = binOf(hz * (1 - span), 16384); k <= binOf(hz * (1 + span), 16384); k++) if (m[k] > best) [best, at] = [m[k], k];
      return (at * SR) / 16384;
    };
    const a = response(0, 1);
    expect(Math.abs(near(a, 650) - 650)).toBeLessThan(15);
    expect(Math.abs(near(a, 1080) - 1080)).toBeLessThan(15);
    expect(Math.abs(near(a, 2650, 0.05) - 2650)).toBeLessThan(30);
    const i = response(2, 1);
    expect(Math.abs(near(i, 290) - 290)).toBeLessThan(10);
    expect(Math.abs(near(i, 1870) - 1870)).toBeLessThan(20);
    const big = response(0, 2);
    expect(Math.abs(near(big, 325) - 325)).toBeLessThan(10);
    expect(Math.abs(near(big, 540) - 540)).toBeLessThan(10);
    // The rounded front vowels after u: ü and ö pull the third formant down near the second.
    const ue = response(5, 1);
    expect(Math.abs(near(ue, 270) - 270)).toBeLessThan(10);
    expect(Math.abs(near(ue, 1650, 0.06) - 1650)).toBeLessThan(25);
    expect(Math.abs(near(ue, 2100, 0.06) - 2100)).toBeLessThan(30);
    const oe = response(6, 1);
    expect(Math.abs(near(oe, 1450, 0.06) - 1450)).toBeLessThan(25);
    expect(Math.abs(near(oe, 2200, 0.06) - 2200)).toBeLessThan(30);
  });

  it('growl adds the subharmonic an octave down', () => {
    const base = { type: 'voice', freq: 160, jitter: 0, shimmer: 0, breath: 0, env: HOLD };
    const sub = (g: number) => levelAt(spectrum(voice({ ...base, growl: g } as SourceSpec), 0.1, 0.9, 16384), 80, 3, 16384);
    expect(sub(0.8)).toBeGreaterThan(sub(0) + 25);
  });

  it('tension brightens, and the level stays even across pitch, size, vowel and breath', () => {
    const at = (extra: Record<string, unknown>) => voice({ type: 'voice', freq: 120, env: HOLD, ...extra } as SourceSpec);
    const soft = at({ tension: 0 });
    const pressed = at({ tension: 1 });
    expect(centroid(spectrum(pressed))).toBeGreaterThan(1.4 * centroid(spectrum(soft)));
    const levels = [soft, pressed, at({ breath: 1 }), at({ size: 3, freq: 50 }), at({ size: 0.4, freq: 900 }), at({ vowel: 4 }), at({ vowel: 6 })].map(rms);
    expect(Math.max(...levels) / Math.min(...levels)).toBeLessThan(2.5);
  });

  it('stays finite and bounded at its hard limits', () => {
    for (const spec of [
      { type: 'voice', freq: 4000, size: 0.1, resonance: 10, tension: 1, breath: 1, jitter: 30, shimmer: 20, growl: 1, rasp: 1 },
      { type: 'voice', freq: 8, size: 10, resonance: 0.1, tension: 0, breath: 0, jitter: 30, shimmer: 20, growl: 1, rasp: 1 },
      { type: 'voice', freq: 100, formants: [[1e6, 1e6, 1e6], [0.001, 0.001, 0], [5, -3, -1], ['x']] },
      { type: 'voice', vowel: [[0, 0], [0.3, 4], [0.31, 0]], size: [[0, 0.1], [0.3, 10]], freq: [[0, 8], [0.3, 4000]] },
    ]) {
      const x = voice({ ...spec, env: HOLD } as SourceSpec, 0.5);
      expect(allFinite(x)).toBe(true);
      expect(peakOf(x)).toBeGreaterThan(0.05);
      expect(peakOf(x)).toBeLessThan(4);
    }
  });
});

describe('machine', () => {
  const KINDS = ['motor', 'servo', 'drill', 'engine', 'turbine', 'rotor'];

  it('every kind renders at defaults near unit peak and strains audibly under load', () => {
    for (const kind of KINDS) {
      const idle = voice({ type: 'machine', kind, load: 0, env: HOLD }, 1);
      const strained = voice({ type: 'machine', kind, load: 1, env: HOLD }, 1);
      const x = voice({ type: 'machine', kind }, 1);
      expect(allFinite(x), kind).toBe(true);
      expect(peakOf(x), kind).toBeGreaterThan(0.4);
      expect(peakOf(x), kind).toBeLessThan(2);
      // Strain shows as brightness, or (a turbine's roar) as a much louder sound.
      const brighter = centroid(spectrum(strained, 0.2, 0.9)) > 1.15 * centroid(spectrum(idle, 0.2, 0.9));
      const louder = rms(strained) > 1.6 * rms(idle);
      expect(brighter || louder, kind).toBe(true);
    }
  });

  it('an engine fires cylinders * rpm / 120 times a second', () => {
    // 4 cylinders at 3000 rpm: 100 Hz and its harmonics; nothing between them but the uneven-cylinder sidebands.
    const s = spectrum(voice({ type: 'machine', kind: 'engine', rpm: 3000, cylinders: 4, roughness: 0, env: HOLD }, 2), 0.2, 1.9, 16384);
    for (const k of [1, 2, 3]) expect(levelAt(s, 100 * k, 2, 16384)).toBeGreaterThan(levelAt(s, 100 * k + 50, 2, 16384) + 10);
  });

  it('a turbine whines at blades * rpm / 60 and a motor hums at rpm / 30', () => {
    const t = spectrum(voice({ type: 'machine', kind: 'turbine', rpm: 6000, blades: 20, load: 0, env: HOLD }, 1), 0.2, 0.9);
    expect(levelAt(t, 2000, 10)).toBeGreaterThan(-3);
    const m = spectrum(voice({ type: 'machine', kind: 'motor', rpm: 4500, load: 0, whine: 0, env: HOLD }, 1), 0.2, 0.9, 16384);
    expect(levelAt(m, 150, 3, 16384)).toBeGreaterThan(-6);
  });

  it('a rotor slaps blades * rpm / 60 times a second', () => {
    const x = voice({ type: 'machine', kind: 'rotor', rpm: 360, blades: 2, roughness: 0, env: HOLD }, 2);
    // Envelope autocorrelation peaks at the slap interval (1/12 s).
    const hop = 48;
    const env: number[] = [];
    for (let i = 0; i + hop <= x.length; i += hop) {
      let s = 0;
      for (let j = 0; j < hop; j++) s += x[i + j] * x[i + j];
      env.push(Math.sqrt(s / hop));
    }
    // The envelope's strongest rhythm, from 4 to 40 Hz, is the slap rate.
    const m = mean(env);
    const rateHz = SR / hop;
    let best = 0;
    let bestHz = 0;
    for (let f = 4; f <= 40; f += 0.25) {
      let re = 0;
      let im = 0;
      env.forEach((v, i) => {
        re += (v - m) * Math.cos((2 * Math.PI * f * i) / rateHz);
        im += (v - m) * Math.sin((2 * Math.PI * f * i) / rateHz);
      });
      if (Math.hypot(re, im) > best) [best, bestHz] = [Math.hypot(re, im), f];
    }
    expect(bestHz).toBeCloseTo(12, 0);
  });

  it('follows rpm breakpoints: a spin-up raises the pitch', () => {
    const x = voice({ type: 'machine', kind: 'servo', rpm: [[0, 3000], [1, 12000]], load: 0, env: HOLD }, 1);
    expect(centroid(spectrum(x, 0.75, 0.95, 4096))).toBeGreaterThan(1.3 * centroid(spectrum(x, 0.05, 0.25, 4096)));
  });

  it('stays finite and bounded at its hard limits', () => {
    for (const kind of KINDS) {
      for (const spec of [
        { type: 'machine', kind, rpm: 200000, load: 1, roughness: 1, whine: 2, teeth: 2000, cylinders: 16, blades: 120, size: 0.1 },
        { type: 'machine', kind, rpm: 60, load: 0, roughness: 0, whine: 0, teeth: 1, cylinders: 1, blades: 1, size: 10 },
        { type: 'machine', kind, rpm: 1, load: 1, roughness: 1 },
      ]) {
        const x = voice({ ...spec, env: HOLD } as SourceSpec, 0.5);
        expect(allFinite(x), JSON.stringify(spec)).toBe(true);
        expect(peakOf(x), JSON.stringify(spec)).toBeLessThan(4);
      }
    }
  });
});

describe('chaos', () => {
  const MODES = ['logistic', 'henon', 'lorenz', 'feedback', 'bytebeat'];

  it('every mode moves from a tone toward noise as chaos rises', () => {
    // Spectral flatness: low for a line spectrum, higher for noise.
    const flatness = (s: Float64Array) => {
      let lg = 0;
      let ar = 0;
      let c = 0;
      for (let k = binOf(100); k < binOf(12000); k++) {
        lg += Math.log(s[k] + 1e-30);
        ar += s[k];
        c++;
      }
      return Math.exp(lg / c) / (ar / c);
    };
    for (const mode of ['logistic', 'henon', 'feedback']) {
      const calm = flatness(spectrum(voice({ type: 'chaos', mode, chaos: 0, smooth: 0, env: HOLD }), 0.2, 0.9));
      const wild = flatness(spectrum(voice({ type: 'chaos', mode, chaos: 1, smooth: 0, env: HOLD }), 0.2, 0.9));
      expect(wild, mode).toBeGreaterThan(10 * calm);
    }
  });

  it('the logistic map at chaos 0 is a period-4 cycle: lines at rate/4 and rate/2', () => {
    const s = spectrum(voice({ type: 'chaos', mode: 'logistic', rate: 4000, chaos: 0, smooth: 0, env: HOLD }), 0.1, 0.9);
    expect(levelAt(s, 2000)).toBeGreaterThan(-3);
    expect(levelAt(s, 1000)).toBeGreaterThan(-30);
    expect(levelAt(s, 1500)).toBeLessThan(-60);
  });

  it('bytebeat formulas differ, and chaos corrupts them', () => {
    const takes = ['sierpinski', 'melody', 'glitch', 'techno', 'harmony', 'bitshift', 'crush'].map((formula) =>
      voice({ type: 'chaos', mode: 'bytebeat', formula, chaos: 0, smooth: 0, env: HOLD }, 0.5),
    );
    for (let a = 0; a < takes.length; a++) for (let b = a + 1; b < takes.length; b++) expect(takes[a]).not.toEqual(takes[b]);
    const clean = voice({ type: 'chaos', mode: 'bytebeat', chaos: 0, env: HOLD }, 1);
    const broken = voice({ type: 'chaos', mode: 'bytebeat', chaos: 1, env: HOLD }, 1);
    expect(broken).not.toEqual(clean);
  });

  it('smooth takes the edge off: much less energy above three times the rate', () => {
    const above = (s: Float64Array, hz: number) => {
      let hi = 0;
      let all = 0;
      s.forEach((v, k) => {
        all += v;
        if ((k * SR) / 8192 > hz) hi += v;
      });
      return 10 * Math.log10(hi / all + 1e-30);
    };
    for (const mode of MODES) {
      const rate = mode === 'bytebeat' ? 4000 : mode === 'lorenz' || mode === 'feedback' ? 300 : 2000;
      const raw = above(spectrum(voice({ type: 'chaos', mode, rate, chaos: 0.8, smooth: 0, env: HOLD })), 3 * rate);
      const smooth = above(spectrum(voice({ type: 'chaos', mode, rate, chaos: 0.8, smooth: 1, env: HOLD })), 3 * rate);
      expect(smooth, mode).toBeLessThan(raw - 10);
    }
  });

  it('stays finite, bounded and centred at its hard limits', () => {
    for (const mode of MODES) {
      for (const spec of [
        { type: 'chaos', mode, rate: 48000, chaos: 1, smooth: 0, ratio: 32 },
        { type: 'chaos', mode, rate: 20, chaos: 0, smooth: 1, ratio: 0.01 },
        { type: 'chaos', mode, rate: [[0, 1], [0.5, 48000]], chaos: [[0, 0], [0.5, 1]], smooth: 0.5 },
      ]) {
        const x = voice({ ...spec, env: HOLD } as SourceSpec, 1);
        expect(allFinite(x), JSON.stringify(spec)).toBe(true);
        expect(peakOf(x), JSON.stringify(spec)).toBeLessThan(3);
        expect(Math.abs(mean(x)), JSON.stringify(spec)).toBeLessThan(0.02);
      }
      expect(peakOf(voice({ type: 'chaos', mode, rate: 20, chaos: 1, env: HOLD } as SourceSpec, 1)), mode).toBeGreaterThan(0.05);
    }
  });
});
