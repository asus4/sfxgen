import { describe, expect, it } from 'vitest';
import { render, validatePatch, getEffect, type Patch, type EffectSpec, type SourceSpec } from '../src/core';
import { magnitudeSpectrum } from '../src/core/dsp/fft';

const SR = 48000;

function patch(source: SourceSpec, fx: EffectSpec[], extra: Partial<Patch> = {}): Patch {
  return {
    format: 'sfxgen/1',
    name: 'space test',
    duration: 'auto',
    seed: 5,
    output: { sampleRate: SR, channels: 1 },
    tracks: [{ id: 'a', source, fx }],
    ...extra,
  };
}

const burst: SourceSpec = { type: 'noise', color: 'pink', env: { attack: 0.002, decay: 0.08 } };
const tone = (freq: number, seconds: number): SourceSpec => ({
  type: 'osc',
  wave: 'sine',
  freq,
  env: { attack: 0.01, hold: seconds, decay: 0.05 },
});

function stats(x: Float32Array) {
  let peak = 0;
  let finite = true;
  let sum = 0;
  for (const v of x) {
    if (!Number.isFinite(v)) finite = false;
    else {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
  }
  return { peak, finite, rms: Math.sqrt(sum / Math.max(x.length, 1)) };
}

function energy(x: ArrayLike<number>, a: number, b: number): number {
  let e = 0;
  for (let i = Math.max(0, Math.floor(a)); i < Math.min(x.length, Math.floor(b)); i++) e += x[i] * x[i];
  return e;
}

const dB = (ratio: number) => 10 * Math.log10(Math.max(ratio, 1e-30));

/** Frequency from zero crossings between two times (seconds). */
function zcFreq(x: ArrayLike<number>, t0: number, t1: number): number {
  let count = 0;
  const a = Math.round(t0 * SR);
  const b = Math.round(t1 * SR);
  for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) count++;
  return count / 2 / (t1 - t0);
}

function lastAbove(x: ArrayLike<number>, floor: number): number {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > floor) return i;
  return -1;
}

function expectHealthy(r: ReturnType<typeof render>) {
  for (const ch of r.channels) {
    const s = stats(ch);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeGreaterThan(1e-4);
  }
  expect(r.warnings.filter((w) => w.includes('invalid samples') || w.includes('failed'))).toEqual([]);
}

describe('catalog', () => {
  it('registers every space effect with documented parameters', () => {
    for (const type of ['reverb', 'delay', 'resonator', 'varispeed', 'pitch', 'doppler', 'medium']) {
      const def = getEffect(type);
      expect(def, type).toBeDefined();
      expect(def!.doc.length).toBeGreaterThan(80);
      expect(def!.example).toBeDefined();
      for (const [name, meta] of Object.entries(def!.params)) {
        expect(meta.doc.length, `${type}.${name}`).toBeGreaterThan(20);
        if (meta.kind === 'number' || meta.kind === 'signal') {
          expect(meta.hardMin, `${type}.${name}`).toBeDefined();
          expect(meta.hardMax, `${type}.${name}`).toBeDefined();
        }
        if (meta.unit === 'Hz') expect(meta.scale, `${type}.${name}`).toBe('log');
      }
      expect(validatePatch(patch(burst, [def!.example as EffectSpec])).errors).toEqual([]);
    }
  });
});

describe('reverb', () => {
  it('adds a decaying tail in every space', () => {
    for (const space of getEffect('reverb')!.params.space.options!) {
      const r = render(patch(burst, [{ type: 'reverb', space, mix: 0.5 }], { duration: 1.2 }));
      expectHealthy(r);
      const x = r.channels[0];
      // Sound after the dry burst has died (60 dB in 0.08 s), fading away by the end.
      expect(x.length / SR, space).toBeGreaterThan(0.15);
      const early = energy(x, 0.085 * SR, 0.115 * SR);
      expect(early, space).toBeGreaterThan(0);
      expect(energy(x, x.length - 0.03 * SR, x.length), space).toBeLessThan(early * 0.1);
    }
  });

  it('decays at the given RT60 in the mids', () => {
    for (const decay of [0.5, 2]) {
      const src: SourceSpec = { ...burst, filter: { mode: 'bandpass', cutoff: 700, q: 1.5 } };
      const r = render(patch(src, [{ type: 'reverb', space: 'hall', decay, damping: 0, early: 0 }], { duration: decay * 1.5 + 0.3, master: { normalize: { mode: 'none' }, fadeOut: 0.001 } }));
      const x = r.channels[0];
      // Energy drop between two windows of the tail, scaled to 60 dB.
      const t1 = 0.15;
      const t2 = 0.15 + decay * 0.5;
      const w = 0.05 * SR;
      const drop = dB(energy(x, t1 * SR, t1 * SR + w) / energy(x, t2 * SR, t2 * SR + w));
      const rt60 = ((t2 - t1) * 60) / drop;
      expect(rt60).toBeGreaterThan(decay * 0.8);
      expect(rt60).toBeLessThan(decay * 1.25);
    }
  });

  it('is wide in stereo and mono at width 0', () => {
    const stereo = (width: number) => render(patch(burst, [{ type: 'reverb', space: 'hall', width, mix: 1 }], { output: { sampleRate: SR, channels: 2 } }));
    const [l, r] = stereo(1).channels;
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < l.length; i++) {
      lr += l[i] * r[i];
      ll += l[i] * l[i];
      rr += r[i] * r[i];
    }
    expect(Math.abs(lr / Math.sqrt(ll * rr))).toBeLessThan(0.3);
    const [l0, r0] = stereo(0).channels;
    for (let i = 0; i < l0.length; i += 97) expect(l0[i]).toBeCloseTo(r0[i], 6);
  });

  it('stays stable at the limits', () => {
    const cases: EffectSpec[] = [
      { type: 'reverb', space: 'room', size: 0.2, decay: 30, damping: 0 },
      { type: 'reverb', space: 'cathedral', size: 200, decay: 0.05 },
      { type: 'reverb', space: 'tank', decay: 30, diffusion: 0, early: 2, width: 2 },
      { type: 'reverb', space: 'spring', size: 0.2, decay: 30, damping: 1 },
      { type: 'reverb', space: 'plate', predelay: 500, lowcut: 5000, highcut: 200 },
    ];
    for (const fx of cases) {
      const r = render(patch(burst, [fx], { duration: 2, output: { sampleRate: SR, channels: 2 }, master: { normalize: { mode: 'none' } } }));
      for (const ch of r.channels) {
        const s = stats(ch);
        expect(s.finite, JSON.stringify(fx)).toBe(true);
        expect(s.peak, JSON.stringify(fx)).toBeLessThan(20);
      }
    }
  });

  it('is deterministic and quick', () => {
    const p = patch({ type: 'noise', color: 'pink', env: { attack: 0.01, hold: 0.9, decay: 0.1 } }, [{ type: 'reverb', space: 'hall', decay: 2 }]);
    render(p);
    const a = render(p);
    const b = render(p);
    expect(a.channels[0]).toEqual(b.channels[0]);
    expect(a.duration).toBeGreaterThan(2.5);
    // A 2 s reverb on 1 s of sound renders in well under the 100 ms budget on a desktop; this only catches regressions.
    expect(a.timeMs).toBeLessThan(1000);
  });
});

describe('delay', () => {
  it('echoes at the set time and repeats with feedback', () => {
    const click: SourceSpec = { type: 'noise', color: 'white', env: { attack: 0.0005, decay: 0.01 } };
    const r = render(patch(click, [{ type: 'delay', time: 200, feedback: 0.5, mix: 0.5 }], { master: { normalize: { mode: 'none' } } }));
    expectHealthy(r);
    const x = r.channels[0];
    const e1 = energy(x, 0.19 * SR, 0.215 * SR);
    const e2 = energy(x, 0.39 * SR, 0.415 * SR);
    const gap = energy(x, 0.25 * SR, 0.35 * SR);
    expect(e1).toBeGreaterThan(gap * 100);
    expect(e2).toBeGreaterThan(gap * 10);
    expect(e2).toBeLessThan(e1);
    expect(r.duration).toBeGreaterThan(1);
  });

  it('ping-pongs between the channels', () => {
    const click: SourceSpec = { type: 'noise', color: 'white', env: { attack: 0.0005, decay: 0.01 } };
    const r = render(patch(click, [{ type: 'delay', time: 150, feedback: 0.6, pingpong: true }], { output: { sampleRate: SR, channels: 2 } }));
    const [l, rr] = r.channels;
    const win = (c: Float32Array, t: number) => energy(c, (t - 0.01) * SR, (t + 0.02) * SR);
    expect(win(l, 0.15)).toBeGreaterThan(win(rr, 0.15) * 10);
    expect(win(rr, 0.3)).toBeGreaterThan(win(l, 0.3) * 10);
  });

  it('stays stable at full feedback, wobble and drive', () => {
    for (const fx of [
      { type: 'delay', time: 0.5, feedback: 0.98, drive: 1 },
      { type: 'delay', time: 4000, feedback: -0.98, tone: 100, highpass: 8000 },
      { type: 'delay', time: [[0, 20], [0.5, 900]], feedback: 0.98, modulation: 100, rate: 20 },
    ] as EffectSpec[]) {
      const r = render(patch(tone(330, 0.5), [fx], { duration: 2 }));
      expect(stats(r.channels[0]).finite).toBe(true);
    }
  });
});

describe('resonator', () => {
  it('rings at its frequency in every mode', () => {
    for (const mode of ['comb', 'tube', 'string', 'metal']) {
      const r = render(patch({ type: 'noise', color: 'white', env: { attack: 0.002, hold: 0.4, decay: 0.05 } }, [{ type: 'resonator', mode, freq: 300, decay: 1.2 }], { master: { normalize: { mode: 'none' } } }));
      expectHealthy(r);
      const x = r.channels[0];
      // While the noise plays, 300 Hz (the fundamental, or the lowest metal mode) stands well above the spectrum
      // just around it.
      const spec = magnitudeSpectrum(Float64Array.from(x.subarray(Math.round(0.05 * SR), Math.round(0.05 * SR) + 16384)));
      const at = (f: number) => {
        const k = Math.round((f * 16384) / SR);
        let m = 0;
        for (let j = k - 2; j <= k + 2; j++) m = Math.max(m, spec[j]);
        return m;
      };
      expect(dB((at(300) / at(225)) ** 2), mode).toBeGreaterThan(10);
      expect(dB((at(300) / at(375)) ** 2), mode).toBeGreaterThan(10);
    }
  });

  it('keeps white noise near its own level', () => {
    const src: SourceSpec = { type: 'noise', color: 'white', env: { attack: 0.002, hold: 0.5, decay: 0.01 } };
    const dry = render(patch(src, [], { master: { normalize: { mode: 'none' } } })).channels[0];
    for (const mode of ['comb', 'tube', 'string', 'metal']) {
      const wet = render(patch(src, [{ type: 'resonator', mode, freq: 220, decay: 1 }], { master: { normalize: { mode: 'none' } } })).channels[0];
      const ratio = dB(energy(wet, 0.1 * SR, 0.5 * SR) / energy(dry, 0.1 * SR, 0.5 * SR));
      expect(Math.abs(ratio), mode).toBeLessThan(4);
    }
  });

  it('handles chords, sweeps and extremes', () => {
    for (const fx of [
      { type: 'resonator', mode: 'metal', freq: [[0, 100], [1, 3000]], decay: 30, brightness: 1, chord: [0, 4, 7, 12, 16, 19, 24, 28] },
      { type: 'resonator', mode: 'comb', freq: 8000, decay: 30, brightness: 1 },
      { type: 'resonator', mode: 'tube', freq: 20, decay: 0.005, brightness: 0 },
      { type: 'resonator', mode: 'string', freq: [[0, 20], [1, 8000]], decay: [[0, 0.005], [1, 30]] },
    ] as EffectSpec[]) {
      const r = render(patch(burst, [fx], { duration: 1.5, output: { sampleRate: SR, channels: 2 } }));
      expectHealthy(r);
    }
  });
});

describe('varispeed', () => {
  it('halves the pitch and doubles the length at 0.5', () => {
    const p = (rate: number) => patch(tone(440, 0.5), [{ type: 'varispeed', rate }]);
    const normal = render(p(1));
    const slow = render(p(0.5));
    const fast = render(p(2));
    expectHealthy(slow);
    expect(slow.duration / normal.duration).toBeGreaterThan(1.8);
    expect(slow.duration / normal.duration).toBeLessThan(2.2);
    expect(fast.duration / normal.duration).toBeLessThan(0.6);
    expect(zcFreq(slow.channels[0], 0.2, 0.8)).toBeCloseTo(220, -1);
    expect(zcFreq(fast.channels[0], 0.05, 0.2)).toBeCloseTo(880, -1);
  });

  it('ends a tape stop in silence, without a click', () => {
    const r = render(patch(tone(300, 1), [{ type: 'varispeed', rate: [[0, 1], [0.4, 1], [1.2, 0]] }], { master: { normalize: { mode: 'none' }, fadeOut: 0.001 } }));
    expectHealthy(r);
    const x = r.channels[0];
    // Content runs to about 1.2 s (the read head reaches 0.8 s of input), and fades to nothing as it stops.
    const end = lastAbove(x, 1e-3);
    expect(end / SR).toBeGreaterThan(1.05);
    expect(end / SR).toBeLessThan(1.3);
    expect(energy(x, 1.15 * SR, 1.2 * SR)).toBeLessThan(energy(x, 0.2 * SR, 0.25 * SR) * 0.05);
    expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-4);
  });

  it('spins up from a standstill', () => {
    const r = render(patch(tone(300, 1), [{ type: 'varispeed', rate: [[0, 0], [0.5, 1]] }]));
    expectHealthy(r);
    expect(Math.abs(r.channels[0][10])).toBeLessThan(1e-3);
  });
});

describe('pitch', () => {
  it('shifts a tone and keeps the duration', () => {
    const p = (semitones: number) => patch(tone(220, 0.6), [{ type: 'pitch', semitones }], { duration: 0.8, master: { normalize: { mode: 'none' } } });
    const dry = render(p(0));
    for (const st of [12, -12, 7]) {
      const r = render(p(st));
      expectHealthy(r);
      expect(r.duration).toBeCloseTo(dry.duration, 2);
      const f = zcFreq(r.channels[0], 0.1, 0.5);
      expect(f / (220 * 2 ** (st / 12))).toBeGreaterThan(0.98);
      expect(f / (220 * 2 ** (st / 12))).toBeLessThan(1.02);
      const level = dB(energy(r.channels[0], 0.1 * SR, 0.5 * SR) / energy(dry.channels[0], 0.1 * SR, 0.5 * SR));
      expect(Math.abs(level)).toBeLessThan(1.5);
    }
  });

  it('glides and survives extreme grains', () => {
    for (const fx of [
      { type: 'pitch', semitones: [[0, -36], [0.5, 36]] },
      { type: 'pitch', semitones: 5, grain: 5 },
      { type: 'pitch', semitones: -5, grain: 500 },
    ] as EffectSpec[]) {
      const r = render(patch(tone(220, 0.6), [fx], { output: { sampleRate: SR, channels: 2 } }));
      expectHealthy(r);
    }
  });
});

describe('doppler', () => {
  it('bends the pitch up on the approach and down after, as physics says', () => {
    const r = render(patch(tone(1000, 3.5), [{ type: 'doppler', speed: 30, distance: 2, time: 2, air: 0 }], { duration: 4 }));
    expectHealthy(r);
    const x = r.channels[0];
    // Far from the pass the shift is c / (c ∓ v): 1096 Hz coming, 920 Hz going.
    expect(zcFreq(x, 0.4, 0.8)).toBeCloseTo(1096, -1);
    expect(zcFreq(x, 3.2, 3.6)).toBeCloseTo(920, -1);
    // Loudest at the pass.
    expect(energy(x, 1.95 * SR, 2.05 * SR)).toBeGreaterThan(energy(x, 0.5 * SR, 0.6 * SR) * 10);
  });

  it('pans across in stereo', () => {
    const r = render(patch(tone(500, 3.5), [{ type: 'doppler', speed: 20, distance: 3, time: 2 }], { duration: 4, output: { sampleRate: SR, channels: 2 } }));
    const [l, rr] = r.channels;
    expect(energy(l, 0.4 * SR, 0.8 * SR)).toBeGreaterThan(energy(rr, 0.4 * SR, 0.8 * SR) * 4);
    expect(energy(rr, 3.2 * SR, 3.6 * SR)).toBeGreaterThan(energy(l, 3.2 * SR, 3.6 * SR) * 4);
  });

  it('stays sane at the limits', () => {
    for (const fx of [
      { type: 'doppler', speed: 320, distance: 0.1, amount: 4, air: 20, rolloff: 4 },
      { type: 'doppler', speed: 0 },
      { type: 'doppler', speed: [[0, 0], [2, 300]], distance: 1, direction: 'right-to-left' },
      { type: 'doppler', time: -60, direction: 'front-to-back' },
    ] as EffectSpec[]) {
      const r = render(patch(tone(400, 1.5), [fx], { duration: 2, output: { sampleRate: SR, channels: 2 } }));
      for (const ch of r.channels) expect(stats(ch).finite).toBe(true);
    }
  });
});

describe('medium', () => {
  const src: SourceSpec = { type: 'noise', color: 'pink', env: { attack: 0.005, hold: 0.5, decay: 0.05 } };
  const flat = { master: { normalize: { mode: 'none' as const } } };

  it('keeps the loudness of the sound in every mode', () => {
    const dry = render(patch(src, [], flat)).channels[0];
    for (const mode of getEffect('medium')!.params.mode.options!) {
      const r = render(patch(src, [{ type: 'medium', mode }], { ...flat, output: { sampleRate: SR, channels: 2 } }));
      expectHealthy(r);
      const ratio = dB(energy(r.channels[0], 0.05 * SR, 0.5 * SR) / energy(dry, 0.05 * SR, 0.5 * SR));
      expect(Math.abs(ratio), mode).toBeLessThan(3);
    }
  });

  it('narrows a phone to the telephone band', () => {
    const r = render(patch(src, [{ type: 'medium', mode: 'phone', noise: 0 }, { type: 'filter', mode: 'lowpass', cutoff: 150, slope: '24' }], flat));
    const dry = render(patch(src, [{ type: 'filter', mode: 'lowpass', cutoff: 150, slope: '24' }], flat));
    expect(dB(energy(r.channels[0], 0, 0.5 * SR) / energy(dry.channels[0], 0, 0.5 * SR))).toBeLessThan(-20);
  });

  it('adds its own noise, and none at noise 0', () => {
    for (const mode of ['tv', 'tape', 'vinyl', 'radio']) {
      const noisy = render(patch(src, [{ type: 'medium', mode }], { ...flat, duration: 1 })).channels[0];
      const clean = render(patch(src, [{ type: 'medium', mode, noise: 0 }], { ...flat, duration: 1 })).channels[0];
      expect(energy(noisy, 0.7 * SR, 0.9 * SR), mode).toBeGreaterThan(0);
      expect(energy(clean, 0.7 * SR, 0.9 * SR), mode).toBeLessThan(energy(noisy, 0.7 * SR, 0.9 * SR) * 1e-3);
    }
  });

  it('opens a walkie for the transmission and closes it with a squelch burst', () => {
    const r = render(patch(src, [{ type: 'medium', mode: 'walkie' }], flat));
    const x = r.channels[0];
    const end = 0.555;
    // A loud burst just after the sound, then silence.
    expect(energy(x, (end + 0.07) * SR, (end + 0.15) * SR)).toBeGreaterThan(energy(x, 0.1 * SR, 0.18 * SR) * 0.02);
    expect(energy(x, (end + 0.3) * SR, x.length)).toBe(0);
    expect(r.duration).toBeGreaterThan(end + 0.15);
  });

  it('is deterministic and stable at every knob extreme', () => {
    for (const mode of getEffect('medium')!.params.mode.options!) {
      for (const knobs of [{ amount: 0, noise: 0, wow: 0, age: 0 }, { amount: 1, noise: 1, wow: 1, age: 1 }]) {
        const p = patch(src, [{ type: 'medium', mode, ...knobs }]);
        const a = render(p);
        expectHealthy(a);
        expect(a.channels[0]).toEqual(render(p).channels[0]);
      }
    }
  });
});
