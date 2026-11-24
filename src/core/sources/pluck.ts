import type { ParamMap, SourceDef } from '../nodes';
import type { ParamValue } from '../format/types';
import { constantOf, isConstant } from '../params';
import { clamp, peak, TAU } from '../dsp/math';
import { nextPow2 } from '../dsp/fft';
import { dcBlock } from '../dsp/filters';

const EXCITE = ['pluck', 'strike', 'bow'] as const;
type Excite = (typeof EXCITE)[number];

const PARAMS: ParamMap = {
  freq: {
    kind: 'signal',
    doc:
      'Pitch of the string. 40 to 100 a bass string or a long cable, 110 to 660 guitar range, above 1000 short ' +
      'wires and pings. It may glide: breakpoints bend the ringing string (a dive, a whammy, a "boing" that drops).',
    default: 220,
    min: 30,
    max: 4000,
    hardMin: 16,
    hardMax: 12000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  decay: {
    kind: 'number',
    doc:
      'Seconds for the fundamental to fall 60 dB. 0.1 to 0.4 a damped or rubbery twang, 1 to 3 a guitar string, ' +
      '5+ a long steel wire. High harmonics always die sooner (see `brightness`).',
    default: 2.5,
    min: 0.05,
    max: 10,
    hardMin: 0.005,
    hardMax: 60,
    unit: 's',
    scale: 'log',
  },
  brightness: {
    kind: 'signal',
    doc:
      'How long the high harmonics last: 0 a dull thump that turns to a sine at once (gut, rubber band, felt), ' +
      '0.5 nylon, 0.7 steel, 1 an endless bright wire (harpsichord, zing). It may move: sweep it down for a string ' +
      'being damped.',
    default: 0.7,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  position: {
    kind: 'number',
    doc:
      'Where along the string it is excited, as a fraction of its length: 0.5 the middle (round, hollow, odd ' +
      'harmonics only), 0.15 to 0.25 a normal pluck, 0.03 to 0.08 right at the bridge (thin, nasal, twangy).',
    default: 0.18,
    min: 0.02,
    max: 0.5,
    hardMin: 0,
    hardMax: 0.5,
  },
  stiffness: {
    kind: 'number',
    doc:
      'How much the string is a rod: stiffness makes high harmonics travel faster, so they go sharp. 0 an ideal ' +
      'string, 0.2 to 0.45 piano and thick wound strings (the 14th harmonic up to 1 % sharp), 0.5 to 0.7 a stiff ' +
      'wire with a clangy edge, 0.8 to 1 a coil spring whose overtones run away (at 1: 1, 2.06, 3.2, 4.6, 6.4 ' +
      'times the pitch) and whose every trip round smears into a chirp: boing, sproing, spring-reverb twang. ' +
      'Best with `freq` below 150.',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  excite: {
    kind: 'enum',
    doc:
      'pluck: a pick or finger lets go (a burst as long as one period). strike: a hammer blow (piano, dulcimer, ' +
      'a cable hit with a wrench; rounder attack). bow: noisy friction drives the string for as long as the event ' +
      'is held (`dur`), or `bowTime` if it has none: an airy, singing, scraped tone that swells in.',
    options: EXCITE,
    default: 'pluck',
  },
  hardness: {
    kind: 'number',
    doc:
      'Brightness of the attack: 0 the flesh of a thumb or a felt hammer, 0.6 a plectrum, 1 a metal edge. For bow, ' +
      'how gritty the friction is. Louder events (`vel`) dig in a little harder.',
    default: 0.6,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  mute: {
    kind: 'signal',
    doc:
      'Damping by a hand on the string: 0 open, 0.3 to 0.6 palm mute (short, dull, percussive), 1 fully choked (a ' +
      'pitched thud). Breakpoints stop a ringing string: [[0, 0], [0.4, 0], [0.45, 1]].',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  bowTime: {
    kind: 'number',
    doc: 'Seconds the bow stays on the string when the event has no `dur`. The string rings on for `decay` after it lifts.',
    default: 0.6,
    min: 0.05,
    max: 5,
    hardMin: 0.01,
    hardMax: 30,
    unit: 's',
    scale: 'log',
  },
};

/** T60 with a hand on the string. */
function mutedDecay(decay: number, mute: number): number {
  return Math.max(0.012, decay * Math.pow(1 - clamp(mute, 0, 1), 2.5));
}

/** Phase delay in samples at w (radians per sample) of the first-order all-pass (a + z^-1) / (1 + a z^-1). */
function allpassDelay(a: number, w: number): number {
  const s = Math.sin(w);
  const c = Math.cos(w);
  return -(Math.atan2(-s, a + c) - Math.atan2(-a * s, 1 + a * c)) / w;
}

/** A waveguide string: plucked, struck or bowed, from nylon to piano wire to a coil spring. */
export const pluck: SourceDef = {
  kind: 'source',
  type: 'pluck',
  label: 'String',
  category: 'physical',
  doc:
    'A vibrating string modelled as a travelling wave in a loop (a waveguide, the descendant of Karplus-Strong): ' +
    'every harmonic is there at the start and each fades at its own rate, which no stack of sine partials imitates. ' +
    'Reach for it for plucks, twangs, harp and koto notes, rubber bands, taut cables and fence wires, piano-like ' +
    'strikes (`excite: strike`, a little `stiffness`), muted thunks (`mute`), cartoon boings and springs (high ' +
    '`stiffness`, low `freq`, often with `freq` gliding), and scraped or bowed wires (`excite: bow`). The ring is the ' +
    'envelope: leave `env` alone and set `decay`.',
  defaultEnv: { attack: 0, sustain: 1, release: 0.08 },
  params: PARAMS,
  example: { type: 'pluck', freq: [[0, 98], [0.5, 82]], decay: 1.2, stiffness: 0.85, brightness: 0.8, position: 0.1 },
  naturalLength(p) {
    const decay = constantOf(p.decay as ParamValue | undefined, PARAMS.decay);
    const mute = isConstant(p.mute as ParamValue | undefined) ? constantOf(p.mute as ParamValue | undefined, PARAMS.mute) : 0;
    const bow = p.excite === 'bow' ? constantOf(p.bowTime as ParamValue | undefined, PARAMS.bowTime) : 0;
    return mutedDecay(decay, mute) + bow + 0.02;
  },
  render(p, ctx) {
    const { sr, n } = ctx;
    const out = new Float64Array(n);
    if (n === 0) return out;
    const excite: Excite = EXCITE.includes(p.excite as Excite) ? (p.excite as Excite) : 'pluck';
    const freq = ctx.signal('freq');
    const brightness = ctx.signal('brightness');
    const mute = ctx.signal('mute');
    const decay = ctx.num('decay');
    const stiffness = ctx.num('stiffness');
    const position = ctx.num('position');
    const hardness = clamp(ctx.num('hardness') + 0.15 * Math.log2(Math.max(ctx.vel, 0.01)), 0, 1);
    const rng = ctx.rng.fork('excite');

    let fLo = Infinity;
    let fHi = 0;
    const fTop = sr / 4.5;
    for (let i = 0; i < n; i++) {
      if (freq[i] > fTop) freq[i] = fTop;
      if (freq[i] < fLo) fLo = freq[i];
      if (freq[i] > fHi) fHi = freq[i];
    }
    const f0 = freq[0];
    const period0 = sr / f0;

    // Stiffness: a chain of all-passes that hold low frequencies back longer than high ones. `stiffness` sets how
    // much of the loop is made of them: a few percent bends the harmonics sharp, most of it makes a spring.
    let apCount = 0;
    let apCoef = 0;
    const shortest = sr / fHi;
    const dispersive = Math.min(0.92 * Math.pow(stiffness, 1.5) * period0, shortest - 6);
    if (stiffness > 0 && dispersive > 1.2) {
      apCoef = -(0.4 + 0.52 * stiffness);
      const each = (1 - apCoef) / (1 + apCoef);
      apCount = Math.min(96, Math.max(1, Math.round(dispersive / each)));
      // With one or two stages, fit the coefficient so the total is what was asked for.
      const per = dispersive / apCount;
      if (apCount < 3 && per > 1.05) apCoef = (1 - per) / (1 + per);
    }
    const apX = new Float64Array(apCount);
    const apY = new Float64Array(apCount);

    // ---- Excitation ----
    const ex = new Float64Array(n);
    let exEnd: number;
    const tone = Math.max(2 * f0, 500 * Math.pow(44, hardness)); // Hz: where the attack's spectrum rolls off
    if (excite === 'strike') {
      const sigma = (0.1874 * sr) / Math.min(tone, 0.6 * sr);
      const len = Math.max(1, Math.ceil(sigma * 6));
      exEnd = Math.min(len, n);
      for (let i = 0; i < exEnd; i++) {
        const d = (i - 0.5 * (len - 1)) / sigma;
        ex[i] = len <= 2 ? (i === 0 ? 1 : 0) : Math.exp(-0.5 * d * d);
      }
    } else {
      const held = Number.isFinite(ctx.gate) ? ctx.gate : Infinity;
      const len = excite === 'bow' ? Math.max(1, Math.round(Math.min(held, ctx.num('bowTime')) * sr)) : Math.max(2, Math.round(period0));
      exEnd = Math.min(len, n);
      const a = Math.exp((-TAU * Math.min(tone, 0.45 * sr)) / sr);
      let y1 = 0;
      let y2 = 0;
      let noiseEnergy = 0;
      for (let i = 0; i < exEnd; i++) {
        y1 = (1 - a) * rng.gauss() + a * y1;
        y2 = (1 - a) * y1 + a * y2;
        ex[i] = y2;
        noiseEnergy += y2 * y2;
      }
      if (excite === 'pluck') {
        // The string snapping off the pick is one rounded pulse, which gives every harmonic its textbook level;
        // the noise, a fifth of the energy, is the roughness of the pick, different on every take.
        let p1 = 0;
        let p2 = 0;
        let pulseEnergy = 0;
        const pulse = new Float64Array(exEnd);
        for (let i = 0; i < exEnd; i++) {
          p1 = (1 - a) * (i === 0 ? 1 : 0) + a * p1;
          p2 = (1 - a) * p1 + a * p2;
          pulse[i] = p2;
          pulseEnergy += p2 * p2;
        }
        const rough = Math.sqrt((0.25 * pulseEnergy) / Math.max(noiseEnergy, 1e-30));
        for (let i = 0; i < exEnd; i++) ex[i] = pulse[i] + rough * ex[i];
      }
      if (excite === 'bow') {
        // The loop resonates at 0 Hz as at every harmonic, so the friction must have nothing down there.
        const b = Math.exp((-TAU * 0.5 * fLo) / sr);
        let l1 = 0;
        let l2 = 0;
        for (let i = 0; i < exEnd; i++) {
          l1 = (1 - b) * ex[i] + b * l1;
          l2 = (1 - b) * l1 + b * l2;
          ex[i] -= 2 * l1 - l2;
        }
        // The bow bites in over 40 ms and lifts over 60.
        const fadeIn = Math.min(Math.round(0.04 * sr), exEnd >> 1);
        const fadeOut = Math.min(Math.round(0.06 * sr), exEnd >> 1);
        for (let i = 0; i < fadeIn; i++) ex[i] *= i / fadeIn;
        for (let i = 0; i < fadeOut; i++) ex[exEnd - 1 - i] *= i / fadeOut;
      }
    }
    // What is heard of a string is its pull on the bridge, whose harmonics fall as 1 / n (6 dB per octave) where
    // the travelling wave's are level: tilt the excitation above the fundamental.
    {
      const span = Math.min(n, exEnd + Math.round(3 * period0));
      const a = Math.exp((-TAU * f0) / sr);
      let y = 0;
      for (let i = 0; i < span; i++) {
        y = (1 - a) * ex[i] + a * y;
        ex[i] = y;
      }
      exEnd = span;
    }
    if (excite !== 'bow') {
      // A string cannot be left displaced on average: spread the opposite of the blow's sum over one period.
      let sum = 0;
      for (let i = 0; i < exEnd; i++) sum += ex[i];
      const span = Math.min(n, Math.max(exEnd, Math.round(period0)));
      for (let i = 0; i < span; i++) ex[i] -= sum / span;
      exEnd = span;
    }
    // Exciting the string at one point is the same as feeding it the signal and its echo off the near end.
    const comb = Math.round(clamp(position, 0, 0.5) * period0);
    if (comb >= 1) {
      const end = Math.min(n, exEnd + comb);
      for (let i = end - 1; i >= comb; i--) ex[i] -= ex[i - comb];
      exEnd = end;
    }

    // ---- The loop ----
    const size = nextPow2(Math.ceil(sr / fLo) + 16);
    const mask = size - 1;
    const line = new Float64Array(size);
    let write = 0;
    let lp = 0;
    let gain = 0;
    let pole = 0;
    let extraDelay = 0;
    for (let i = 0; i < n; i++) {
      const f = freq[i];
      if ((i & 15) === 0) {
        const w = (TAU * f) / sr;
        const sw = Math.sin(w);
        const cw = Math.cos(w);
        const m = clamp(mute[i], 0, 1);
        // Once round the loop takes 1 / f seconds and must lose 60 dB in the (muted) decay time.
        const perLoop = Math.pow(10, -3 / (f * mutedDecay(decay, m)));
        // The loss filter: the same frequency dies at the same rate on a low string as on a high one, which takes
        // a cutoff rising with the square root of the pitch. It never falls so low that the fundamental could not
        // last its `decay`.
        const wanted = 400 * Math.pow(250, clamp(brightness[i], 0, 1)) * Math.sqrt(f / 220) * Math.pow(0.06, m);
        const needed = f / Math.sqrt(1 / (perLoop * perLoop) - 1);
        pole = Math.exp((-TAU * Math.max(wanted, needed, 1.2 * f)) / sr);
        const lpMag = (1 - pole) / Math.sqrt(1 - 2 * pole * cw + pole * pole);
        const lpDelay = Math.atan2(pole * sw, 1 - pole * cw) / w;
        gain = Math.min(perLoop / lpMag, 0.99998);
        extraDelay = lpDelay + (apCount > 0 ? apCount * allpassDelay(apCoef, w) : 0);
      }
      // Read the line `delay` samples back with third-order Lagrange interpolation.
      const delay = Math.max(sr / f - extraDelay, 2);
      const base = Math.floor(delay) - 1;
      const d = delay - base;
      const i0 = write - base + 1 + size; // the tap `base` samples back; line[write] is one back
      const s0 = line[i0 & mask];
      const s1 = line[(i0 - 1) & mask];
      const s2 = line[(i0 - 2) & mask];
      const s3 = line[(i0 - 3) & mask];
      const d1 = d - 1;
      const d2 = d - 2;
      const d3 = d - 3;
      let v = (-d1 * d2 * d3 * s0) / 6 + (d * d2 * d3 * s1) / 2 - (d * d1 * d3 * s2) / 2 + (d * d1 * d2 * s3) / 6;
      lp = (1 - pole) * v + pole * lp;
      v = lp;
      for (let k = 0; k < apCount; k++) {
        const y = apCoef * v + apX[k] - apCoef * apY[k];
        apX[k] = v;
        apY[k] = y;
        v = y;
      }
      const next = (i < exEnd ? ex[i] : 0) + gain * v;
      write = (write + 1) & mask;
      line[write] = next;
      out[i] = next;
    }
    // The loop holds on to any offset as long as it holds a note, and a glide can leave one behind: drop it here,
    // below anything the string plays.
    dcBlock(out, sr, Math.min(20, 0.5 * fLo));
    const pk = peak(out);
    if (pk > 1e-12) {
      const g = 1 / pk;
      for (let i = 0; i < n; i++) out[i] *= g;
    }
    return out;
  },
};
