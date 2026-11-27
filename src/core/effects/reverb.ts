import type { EffectDef, ParamMeta } from '../nodes';
import type { ParamValue } from '../format/types';
import { constantOf } from '../params';
import { designLate, earlyTaps, renderEarly, renderLate, type EarlyShape } from '../dsp/fdn';
import { renderSpring } from '../dsp/spring';
import { filterBuffer } from '../dsp/filters';
import { hashString } from '../dsp/rng';
import type { Buf } from '../dsp/math';

const SPACES = [
  'room',
  'hall',
  'plate',
  'chamber',
  'cathedral',
  'cave',
  'closet',
  'bathroom',
  'car',
  'stairwell',
  'tunnel',
  'tank',
  'spring',
  'forest',
] as const;
type Space = (typeof SPACES)[number];

interface Preset {
  size: number;
  decay: number;
  damping: number;
  predelay: number;
  early: number;
  diffusion: number;
  width: number;
  lowcut: number;
  highcut: number;
  /** Low-band decay over mid-band decay. */
  bass: number;
  /** High-shelf crossover at damping 0.5, Hz. */
  cross: number;
  /** Line modulation, 0..1. */
  mod: number;
  er: EarlyShape;
  engine?: 'spring';
  /** Keep the lines as short as the space even when the decay is long: modes ring, as in metal. */
  ring?: boolean;
  /** Diffuser length over the mean line length. */
  diffTime?: number;
  /** Level of the diffuser's own output: a dense onset before the loop's first pass (plates). */
  onset?: number;
}

const box = (width: number, height: number, absorb: number, jitter = 0): EarlyShape => ({ kind: 'box', width, height, absorb, jitter });
const flutter = (width: number, height: number, absorb: number, axis: 'x' | 'z', count: number): EarlyShape => ({
  kind: 'flutter',
  width,
  height,
  absorb,
  axis,
  count,
});

// prettier-ignore
const PRESETS: Record<Space, Preset> = {
  room:      { size: 6,   decay: 0.7,  damping: 0.5,  predelay: 3,   early: 0.6,  diffusion: 0.75, width: 0.8, lowcut: 60,  highcut: 12000, bass: 1.05, cross: 3500, mod: 0.7,  er: box(0.75, 0.45, 0.8), onset: 0.2 },
  hall:      { size: 30,  decay: 2.4,  damping: 0.45, predelay: 18,  early: 0.4,  diffusion: 0.9,  width: 1,   lowcut: 30,  highcut: 11000, bass: 1.25, cross: 3000, mod: 0.8,  er: box(0.6, 0.4, 0.85), onset: 0.3 },
  plate:     { size: 2,   decay: 2,    damping: 0.2,  predelay: 8,   early: 0,    diffusion: 1,    width: 1,   lowcut: 100, highcut: 14000, bass: 0.85, cross: 5000, mod: 0.7,  er: { kind: 'none' }, diffTime: 1, onset: 0.7 },
  chamber:   { size: 9,   decay: 1.3,  damping: 0.35, predelay: 6,   early: 0.55, diffusion: 0.85, width: 0.9, lowcut: 80,  highcut: 12000, bass: 1,    cross: 4000, mod: 0.6,  er: box(0.65, 0.5, 0.9), onset: 0.25 },
  cathedral: { size: 50,  decay: 6,    damping: 0.55, predelay: 30,  early: 0.3,  diffusion: 0.9,  width: 1,   lowcut: 30,  highcut: 9000,  bass: 1.35, cross: 2500, mod: 0.9,  er: box(0.4, 0.55, 0.9), onset: 0.3 },
  cave:      { size: 25,  decay: 3.5,  damping: 0.6,  predelay: 20,  early: 0.6,  diffusion: 0.6,  width: 1,   lowcut: 40,  highcut: 8000,  bass: 1.2,  cross: 2500, mod: 0.6,  er: box(0.6, 0.4, 0.85, 0.3), onset: 0.3 },
  closet:    { size: 1.4, decay: 0.25, damping: 0.7,  predelay: 0.3, early: 0.8,  diffusion: 0.7,  width: 0.5, lowcut: 120, highcut: 8000,  bass: 0.85, cross: 2500, mod: 0.3,  er: box(0.6, 1.6, 0.55), onset: 0.15 },
  bathroom:  { size: 2.8, decay: 0.9,  damping: 0.15, predelay: 1,   early: 0.75, diffusion: 0.6,  width: 0.7, lowcut: 100, highcut: 14000, bass: 0.95, cross: 5000, mod: 0.5,  er: flutter(0.75, 0.9, 0.93, 'x', 8), onset: 0.2 },
  car:       { size: 2,   decay: 0.15, damping: 0.6,  predelay: 0.2, early: 0.9,  diffusion: 0.5,  width: 0.6, lowcut: 150, highcut: 9000,  bass: 0.75, cross: 3000, mod: 0.2,  er: box(0.72, 0.55, 0.65), onset: 0.15 },
  stairwell: { size: 4,   decay: 2.2,  damping: 0.35, predelay: 2,   early: 0.6,  diffusion: 0.4,  width: 0.9, lowcut: 60,  highcut: 10000, bass: 1.1,  cross: 3500, mod: 0.35, er: flutter(0.6, 4, 0.92, 'x', 14), onset: 0.5 },
  tunnel:    { size: 40,  decay: 2.8,  damping: 0.45, predelay: 4,   early: 0.7,  diffusion: 0.5,  width: 1,   lowcut: 40,  highcut: 9000,  bass: 1.15, cross: 3000, mod: 0.5,  er: flutter(0.12, 0.11, 0.88, 'x', 14), onset: 0.4 },
  tank:      { size: 3,   decay: 3,    damping: 0.1,  predelay: 1,   early: 0.5,  diffusion: 0.55, width: 0.8, lowcut: 60,  highcut: 12000, bass: 1,    cross: 6000, mod: 0.05, er: box(0.9, 0.8, 0.97), ring: true, onset: 0.2 },
  spring:    { size: 0.4, decay: 2.2,  damping: 0.4,  predelay: 0,   early: 0,    diffusion: 0.3,  width: 0.8, lowcut: 80,  highcut: 5000,  bass: 1,    cross: 3000, mod: 0,    er: { kind: 'none' }, engine: 'spring' },
  forest:    { size: 30,  decay: 0.9,  damping: 0.75, predelay: 10,  early: 0.6,  diffusion: 0.7,  width: 1,   lowcut: 100, highcut: 7000,  bass: 0.8,  cross: 2000, mod: 0.7,  er: { kind: 'scatter', count: 18, spread: 1, absorb: 0.5 }, onset: 0.25 },
};

const PARAMS: Record<string, ParamMeta> = {
  mix: { kind: 'number', doc: 'Wet amount, 0 to 1. Default 0.3 on a track or the master, where the dry sound passes too; on a bus (sends) every effect defaults to fully wet.', hint: 'How much room you hear against the dry sound', default: 0.3, min: 0, max: 1, hardMin: 0, hardMax: 1 },
  space: {
    kind: 'enum',
    doc:
      'The kind of space; it sets every other parameter, which you then override. room: a furnished living room. ' +
      'hall: a concert hall, long and lush. plate: the classic studio plate, dense and bright with no early ' +
      'echoes. chamber: a hard-walled echo chamber. cathedral: stone, huge, very long. cave: big, dark, irregular ' +
      'rock. closet: tiny and muffled. bathroom: small, bright tiles with a little flutter. car: a car interior, ' +
      'short and boxy. stairwell: tall concrete, ringing flutter. tunnel: long concrete tube, flutter between the ' +
      'walls. tank: inside a metal tank, metallic and ringing. spring: a spring reverb, the boingy chirp of guitar ' +
      'amps. forest: scattered reflections off trees, soft and short.',
    hint: 'The kind of space: room, hall, cave, car…',
    options: SPACES,
    default: 'room',
  },
  size: {
    kind: 'number',
    doc:
      'Size of the space in metres (roughly its longest dimension): spaces the echoes and the early reflections. ' +
      'Closet 1.4, car 2, bathroom 3, room 6, chamber 9, hall 30, cathedral 50. For spring it is the spring length ' +
      '(0.2 tight to 1 loose). Default: from `space`.',
    hint: 'How big the space is',
    min: 1,
    max: 60,
    hardMin: 0.2,
    hardMax: 200,
    unit: 'm',
    scale: 'log',
  },
  decay: {
    kind: 'number',
    doc:
      'Reverb time (RT60): seconds for the tail to fall 60 dB in the mids. Car 0.15, room 0.7, hall 2.4, ' +
      'cathedral 6; above 10 is an endless wash. Default: from `space`.',
    hint: 'How long the tail lasts',
    min: 0.1,
    max: 10,
    hardMin: 0.05,
    hardMax: 30,
    unit: 's',
    scale: 'log',
  },
  damping: {
    kind: 'number',
    doc:
      'How much faster the highs die than the mids, 0 to 1: 0 bright (tile, metal, plate), 0.5 a furnished room, ' +
      '0.8 dark (curtains, carpet, forest). Default: from `space`.',
    hint: 'Bright and hard, or dark and soft',
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  predelay: {
    kind: 'number',
    doc:
      'Milliseconds between the dry sound and the reverb: 0 to 5 is close to a wall, 20 to 40 separates the dry ' +
      'sound from a big space so it stays clear. Default: from `space`.',
    hint: 'A gap before the reverb, to keep the sound clear',
    min: 0,
    max: 100,
    hardMin: 0,
    hardMax: 500,
    unit: 'ms',
  },
  early: {
    kind: 'number',
    doc:
      'Level of the early reflections, the first echoes off the nearest walls that tell the ear the shape and ' +
      'size of the space: 0 none (a pure tail), 0.5 typical, 1 strong (small hard rooms, cars). Default: from `space`.',
    hint: 'The first echoes, which tell the shape of the room',
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 2,
  },
  diffusion: {
    kind: 'number',
    doc:
      'How smeared the echoes are, 0 to 1: low lets discrete echoes and flutter through (stairwells, tunnels), ' +
      'high is a smooth wash (plates, halls). Default: from `space`.',
    hint: 'Separate echoes or a smooth wash',
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  width: {
    kind: 'number',
    doc: 'Stereo width of the reverb: 0 mono, 1 natural, up to 1.5 wider than life (stereo output only). Default: from `space`.',
    hint: 'How wide the reverb sounds',
    min: 0,
    max: 1.5,
    hardMin: 0,
    hardMax: 2,
  },
  lowcut: {
    kind: 'number',
    doc: 'High-pass on what enters the reverb, Hz: 150 to 300 keeps big spaces from booming and muddying. Default: from `space`.',
    hint: 'Keeps the reverb from booming',
    min: 20,
    max: 1000,
    hardMin: 10,
    hardMax: 5000,
    unit: 'Hz',
    scale: 'log',
  },
  highcut: {
    kind: 'number',
    doc: 'Low-pass on what enters the reverb, Hz: 3000 to 6000 for a dark, distant space. Default: from `space`.',
    hint: 'Darker, more distant reverb',
    min: 1000,
    max: 20000,
    hardMin: 200,
    hardMax: 24000,
    unit: 'Hz',
    scale: 'log',
  },
  bass: {
    kind: 'number',
    doc:
      'How long the lows (below about 250 Hz) ring, times `decay`: 1 as long as the mids, 0.3 to 0.6 a space whose ' +
      'walls soak up the boom (a heavy hit blooms, then the tail stays clear instead of humming one low note), 1.2 to ' +
      '1.5 a boomy hall or cave. `lowcut` only thins what goes in; this shortens what rings. Default: from `space`.',
    hint: 'How long the lows ring',
    min: 0.2,
    max: 2,
    hardMin: 0.1,
    hardMax: 3,
  },
};

interface Resolved {
  space: Space;
  pre: Preset;
  size: number;
  decay: number;
  damping: number;
  predelay: number;
  early: number;
  diffusion: number;
  width: number;
  lowcut: number;
  highcut: number;
  /** Low decay over the mids'. */
  bass: number;
}

function resolve(p: Record<string, unknown>): Resolved {
  const space: Space = (SPACES as readonly string[]).includes(p.space as string) ? (p.space as Space) : 'room';
  const pre = PRESETS[space];
  const num = (name: keyof Preset & keyof typeof PARAMS) =>
    p[name] === undefined ? (pre[name] as number) : constantOf(p[name] as ParamValue, PARAMS[name]);
  return {
    space,
    pre,
    size: num('size'),
    decay: num('decay'),
    damping: num('damping'),
    predelay: num('predelay'),
    early: num('early'),
    diffusion: num('diffusion'),
    width: num('width'),
    lowcut: num('lowcut'),
    highcut: num('highcut'),
    bass: num('bass'),
  };
}

/** Mean free path of the space, metres: 4V/S of its box, or a share of its size when it has no walls. */
function meanFreePath(r: Resolved): number {
  const er = r.pre.er;
  if (er.kind === 'box' || er.kind === 'flutter') {
    const L = r.size;
    const W = r.size * er.width;
    const H = r.size * er.height;
    return (4 * L * W * H) / (2 * (L * W + L * H + W * H));
  }
  return 0.4 * r.size;
}

/** Calibrates the late level: about the input's energy over the first pass, whatever the size. */
const LATE_GAIN = 2.2;
const EARLY_GAIN = 0.9;
const SPRING_GAIN = 0.85;

function sameContent(a: Buf, b: Buf): boolean {
  if (a === b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bandLimit(x: Buf, lowcut: number, highcut: number, sr: number): Buf {
  const y = x.slice();
  if (lowcut > 15) filterBuffer(y, 'highpass', lowcut, 0.707, sr);
  if (highcut < sr * 0.45) filterBuffer(y, 'lowpass', highcut, 0.707, sr);
  return y;
}

function delayed(x: Buf, samples: number): Buf {
  if (samples <= 0) return x;
  const y = new Float64Array(x.length);
  if (samples < x.length) y.set(x.subarray(0, x.length - samples), samples);
  return y;
}

export const reverb: EffectDef = {
  kind: 'effect',
  type: 'reverb',
  label: 'Reverb',
  category: 'space',
  widens: true,
  doc:
    'Puts the sound in a space: early reflections and a dense, smooth tail (a 16-line feedback delay network with ' +
    'frequency-dependent decay). Pick a `space`, then override what you need: `decay` for length, `size` for scale, ' +
    '`damping` for darkness, `predelay` to keep the dry sound clear. It returns only the reverb, so on a track ' +
    'set `mix` to 0.15 to 0.4 (more is farther away); on a bus that several tracks send to, leave `mix` at 1.',
  hint: 'Puts the sound in a space',
  params: PARAMS,
  example: { type: 'reverb', space: 'hall', decay: 3, mix: 0.3 },
  tail(params) {
    const r = resolve(params);
    const longest = r.decay * Math.max(1, r.bass);
    return r.predelay / 1000 + 0.08 + longest * 1.1;
  },
  process(input, p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    const r = resolve(p);
    const stereoOut = input.length === 2;
    const stereoIn = stereoOut && !sameContent(input[0], input[1]);
    let mono: Buf;
    if (input.length === 2) {
      mono = new Float64Array(n);
      for (let i = 0; i < n; i++) mono[i] = 0.5 * (input[0][i] + input[1][i]);
    } else mono = input[0];
    const pd = Math.round((r.predelay / 1000) * sr);
    const monoIn = delayed(bandLimit(mono, r.lowcut, r.highcut, sr), pd);
    const dampHigh = 0.1 + 0.9 * Math.pow(1 - r.damping, 1.4);
    const cross = r.pre.cross * Math.pow(2, (0.5 - r.damping) * 1.5);
    const seed = hashString(`reverb/${r.space}`);

    let late: Buf[];
    if (r.pre.engine === 'spring') {
      const roundTrip = 0.045 * Math.pow(r.size / 0.4, 0.7);
      late = renderSpring(monoIn, n, { sr, t60: r.decay, roundTrip: Math.min(Math.max(roundTrip, 0.012), 0.25), damping: r.damping, chirp: 0.72 }, stereoOut);
      for (const ch of late) for (let i = 0; i < n; i++) ch[i] *= SPRING_GAIN;
    } else {
      const mfp = meanFreePath(r);
      // As long as the space suggests, and long enough for the decay that the loop's modes overlap instead of
      // ringing (metal keeps its short, ringing loop on purpose).
      let meanDelay = (1.3 * mfp) / 343;
      if (!r.pre.ring) meanDelay = Math.max(meanDelay, 0.006 + 0.015 * r.decay);
      meanDelay = Math.min(Math.max(meanDelay, 0.0015), 0.12);
      const design = designLate({
        sr,
        meanDelay,
        spread: 3,
        t60: r.decay,
        bassRatio: r.bass,
        highRatio: dampHigh,
        crossLow: 250,
        crossHigh: cross,
        modDepth: r.pre.mod * 0.00035,
        modRate: 0.25 + 0.6 * r.pre.mod,
        diffusionTime: Math.min((r.pre.diffTime ?? 0.9) * meanDelay, 0.06),
        diffusion: r.diffusion,
        earlyDiffuse: r.pre.onset ?? 0,
        seed,
      });
      const inL = stereoIn ? delayed(bandLimit(input[0], r.lowcut, r.highcut, sr), pd) : monoIn;
      const inR = stereoIn ? delayed(bandLimit(input[1], r.lowcut, r.highcut, sr), pd) : null;
      late = renderLate(inL, inR, n, design, stereoOut);
      // Same onset level for any size: a short loop recirculates more often, so it is turned down.
      const g = LATE_GAIN * Math.sqrt(design.meanDelay / 0.02);
      for (const ch of late) for (let i = 0; i < n; i++) ch[i] *= g;
    }

    if (r.early > 0 && r.pre.er.kind !== 'none') {
      const taps = earlyTaps(r.size, r.pre.er, seed ^ 0x5eed);
      const early = renderEarly(monoIn, n, taps, sr, stereoOut, cross * 1.5, r.early * EARLY_GAIN);
      for (let c = 0; c < late.length; c++) {
        const l = late[c];
        const e = early[c];
        for (let i = 0; i < n; i++) l[i] += e[i];
      }
    }

    if (stereoOut && late.length === 2 && r.width !== 1) {
      const [l, rr] = late;
      for (let i = 0; i < n; i++) {
        const m = 0.5 * (l[i] + rr[i]);
        const s = 0.5 * (l[i] - rr[i]) * r.width;
        l[i] = m + s;
        rr[i] = m - s;
      }
    }
    return late;
  },
};
