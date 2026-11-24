/**
 * What a resonant object is made of and what shape it has, for modal synthesis: the frequency ratios of each
 * shape's modes (from the physics of the ideal object, or from measurements), how hard a strike at a given place
 * drives each mode, and how each material loses its high modes.
 */
import type { Rng } from './rng';
import { clamp } from './math';

export const MODAL_SHAPES = ['bar', 'tine', 'plate', 'membrane', 'bell', 'bowl', 'tube', 'string', 'box', 'random'] as const;
export type ModalShape = (typeof MODAL_SHAPES)[number];

export const MODAL_MATERIALS = ['metal', 'glass', 'ceramic', 'stone', 'wood', 'plastic', 'skin', 'rubber', 'cardboard'] as const;
export type ModalMaterial = (typeof MODAL_MATERIALS)[number];

export interface MaterialModel {
  /** T60 of the fundamental when the patch gives none, seconds. */
  decay: number;
  /** How much faster a mode dies per unit of (f / f1) ^ lossExp - 1: internal friction. */
  loss: number;
  lossExp: number;
  /** Natural tilt of the mode amplitudes, dB per octave above the fundamental. */
  tilt: number;
}

/**
 * Loss rises with frequency in every solid, but by very different amounts: steel and bronze keep their high modes
 * almost as long as the fundamental, wood and plastics have a roughly constant Q (decay time falls as 1/f) or
 * worse, and rubber and wet card swallow everything above the first few modes.
 */
export const MATERIALS: Record<ModalMaterial, MaterialModel> = {
  metal: { decay: 2.5, loss: 0.05, lossExp: 1, tilt: -1 },
  glass: { decay: 1.2, loss: 0.16, lossExp: 1, tilt: -2 },
  ceramic: { decay: 0.6, loss: 0.3, lossExp: 1, tilt: -3 },
  stone: { decay: 0.14, loss: 0.6, lossExp: 1, tilt: -3.5 },
  wood: { decay: 0.25, loss: 1, lossExp: 1.2, tilt: -4.5 },
  plastic: { decay: 0.12, loss: 1.5, lossExp: 1.1, tilt: -5.5 },
  skin: { decay: 0.5, loss: 0.8, lossExp: 1, tilt: -4.5 },
  rubber: { decay: 0.08, loss: 3, lossExp: 1.2, tilt: -8 },
  cardboard: { decay: 0.07, loss: 2.5, lossExp: 1, tilt: -7 },
};

export function materialOf(name: unknown): MaterialModel {
  return MATERIALS[name as ModalMaterial] ?? MATERIALS.metal;
}

/**
 * T60 of a mode at `ratio` times the fundamental, relative to the fundamental's. `damping` scales the material's
 * loss: 0 lets every mode ring as long as the fundamental, 1 is the material itself.
 */
export function modeDecayFactor(mat: MaterialModel, ratio: number, damping: number): number {
  return 1 / (1 + damping * mat.loss * (Math.pow(Math.max(ratio, 1), mat.lossExp) - 1));
}

// ---- Tables ----------------------------------------------------------------------------------------

/** Roots of cos(x) cosh(x) = 1: a bar free at both ends (xylophone and chime bars, rods, tubular bells). */
const FREE_BAR = [4.730041, 7.853205, 10.995608, 14.137165, 17.27876];
/** Roots of cos(x) cosh(x) = -1: a bar clamped at one end (tines, tongues, a ruler on a desk). */
const CLAMPED_BAR = [1.875104, 4.694091, 7.854757, 10.995541, 14.137168];

/**
 * An ideal circular membrane: [m nodal diameters, n nodal circles, frequency / f(0,1)], the zeros j(m,n) of the
 * Bessel functions J_m divided by j(0,1) = 2.404826, in rising order.
 */
// prettier-ignore
const MEMBRANE: readonly (readonly [number, number, number])[] = [
  [0, 1, 1.00000], [1, 1, 1.59334], [2, 1, 2.13555], [0, 2, 2.29542], [3, 1, 2.65307], [1, 2, 2.91730], [4, 1, 3.15546], [2, 2, 3.50015],
  [0, 3, 3.59848], [5, 1, 3.64745], [3, 2, 4.05893], [6, 1, 4.13174], [1, 3, 4.23044], [4, 2, 4.60104], [7, 1, 4.61005], [2, 3, 4.83189],
  [0, 4, 4.90328], [8, 1, 5.08357], [5, 2, 5.13077], [3, 3, 5.41212], [1, 4, 5.54040], [9, 1, 5.55313], [6, 2, 5.65084], [4, 3, 5.97654],
  [10, 1, 6.01936], [2, 4, 6.15261], [7, 2, 6.16314], [0, 5, 6.20873], [11, 1, 6.48274], [5, 3, 6.52861], [8, 2, 6.66900], [3, 4, 6.74621],
  [1, 5, 6.84899], [12, 1, 6.94364], [6, 3, 7.07071], [9, 2, 7.16943], [4, 4, 7.32526], [13, 1, 7.40238], [2, 5, 7.46824], [0, 6, 7.51450],
  [7, 3, 7.60454], [10, 2, 7.66520], [14, 1, 7.85920], [5, 4, 7.89252], [3, 5, 8.07103], [8, 3, 8.13137], [1, 6, 8.15687], [11, 2, 8.15692],
  [15, 1, 8.31430], [6, 4, 8.45001], [12, 2, 8.64508], [9, 3, 8.65221], [4, 5, 8.66048], [16, 1, 8.76785], [2, 6, 8.78109], [0, 7, 8.82045],
  [7, 4, 8.99921], [13, 2, 9.13008], [10, 3, 9.16781], [17, 1, 9.22000], [5, 5, 9.23884], [3, 6, 9.39059], [1, 7, 9.46434], [8, 4, 9.54130],
  [14, 2, 9.61225], [18, 1, 9.67088], [11, 3, 9.67881], [6, 5, 9.80782], [4, 6, 9.98784], [9, 4, 10.07719], [15, 2, 10.09187], [2, 7, 10.09225],
  [19, 1, 10.12059], [0, 8, 10.12650], [12, 3, 10.18572], [7, 5, 10.36871], [16, 2, 10.56917], [20, 1, 10.56922], [5, 6, 10.57471], [10, 4, 10.60761],
  [13, 3, 10.68897], [3, 7, 10.70688], [1, 8, 10.77154], [8, 5, 10.92254], [21, 1, 11.01687], [17, 2, 11.04437], [11, 4, 11.13317], [6, 6, 11.15264],
  [14, 3, 11.18891], [4, 7, 11.31021], [2, 8, 11.40231], [0, 9, 11.43263], [22, 1, 11.46359], [9, 5, 11.47017], [18, 2, 11.51763], [12, 4, 11.65436],
];

/**
 * Partials of a church bell, measured (Fletcher and Rossing, The Physics of Musical Instruments, table 21.1),
 * relative to the hum: hum, prime, tierce (the minor third that makes a bell a bell), quint, nominal, deciem,
 * undeciem, duodeciem, upper octave, upper undeciem, upper sixth, triple octave.
 */
const BELL = [1, 2, 2.366, 3.012, 4, 5.028, 5.324, 6.022, 8.332, 10.866, 13.592, 16.43];

/** Sides of the plate (simply supported, thin) and of the box (an air cavity with hard walls), longest side 1. */
const PLATE_ASPECT = 1.272;
const BOX_SIDES = [1, 0.79, 0.61] as const;

export interface ModeSet {
  /** Frequency of each mode over the fundamental's, rising, the first 1. */
  ratio: Float64Array;
  /** 0..1: how strongly a strike at the given position drives each mode. */
  weight: Float64Array;
}

/** J_m(x) by the trapezoid rule on Bessel's integral, which converges geometrically for a periodic integrand. */
export function besselJ(m: number, x: number): number {
  const steps = Math.max(24, Math.ceil(1.5 * (Math.abs(x) + m)) + 12);
  let sum = 0;
  for (let k = 0; k <= steps; k++) {
    const t = (Math.PI * k) / steps;
    sum += (k === 0 || k === steps ? 0.5 : 1) * Math.cos(m * t - x * Math.sin(t));
  }
  return sum / steps;
}

/** Shape of a free-free bar's mode (1-based) at x in 0..1, between -1 and 1. Accurate to 2 % even for the first. */
function freeBarShape(mode: number, betaL: number, x: number): number {
  const bx = betaL * x;
  const sym = mode % 2 === 1 ? 1 : -1;
  return 0.5 * (Math.cos(bx) - Math.sin(bx) + Math.exp(-bx) + sym * Math.exp(-(betaL - bx)));
}

/** Shape of a clamped-free bar's mode (1-based) at x in 0..1 from the clamp. */
function clampedBarShape(mode: number, betaL: number, x: number): number {
  const bx = betaL * x;
  const sym = mode % 2 === 1 ? 1 : -1;
  return 0.5 * (Math.sin(bx) - Math.cos(bx) + Math.exp(-bx) + sym * Math.exp(-(betaL - bx)));
}

function pairsByFrequency<T>(count: number, make: (i: number, j: number) => { f: number; tag: T } | null, span: number) {
  const all: { f: number; tag: T }[] = [];
  for (let i = 0; i <= span; i++) {
    for (let j = 0; j <= span; j++) {
      const m = make(i, j);
      if (m) all.push(m);
    }
  }
  all.sort((a, b) => a.f - b.f);
  return all.slice(0, count);
}

/**
 * The modes of a shape: frequency ratios and how strongly a strike at `position` (0 = the centre, 1 = the edge or
 * the end) drives each. `rng` invents the modes of the `random` shape.
 */
export function buildModes(shape: ModalShape, count: number, position: number, rng: Rng): ModeSet {
  const n = Math.max(1, Math.floor(count));
  const ratio = new Float64Array(n);
  const weight = new Float64Array(n);
  const s = clamp(position, 0, 1);
  // Distance from one end, as a fraction of the length: the centre at 0.5, never quite on a clamped edge.
  const x = 0.5 - 0.47 * s;
  switch (shape) {
    case 'bar':
    case 'tine': {
      const roots = shape === 'bar' ? FREE_BAR : CLAMPED_BAR;
      for (let k = 0; k < n; k++) {
        const betaL = k < roots.length ? roots[k] : ((2 * k + (shape === 'bar' ? 3 : 1)) * Math.PI) / 2;
        ratio[k] = (betaL * betaL) / (roots[0] * roots[0]);
        // A bar is struck between its middle and its free end; a tine between its clamp (0) and its tip (1).
        weight[k] = shape === 'bar' ? freeBarShape(k + 1, betaL, 0.5 - 0.5 * s) : clampedBarShape(k + 1, betaL, 0.08 + 0.92 * s);
      }
      break;
    }
    case 'string':
      for (let k = 0; k < n; k++) {
        ratio[k] = k + 1;
        weight[k] = Math.sin(Math.PI * (k + 1) * x);
      }
      break;
    case 'tube':
      // The air in a pipe closed at one end: odd harmonics. Struck near the closed end (0) or the open one (1).
      for (let k = 0; k < n; k++) {
        ratio[k] = 2 * k + 1;
        weight[k] = Math.cos(((2 * k + 1) * Math.PI * 0.5 * s * 0.9));
      }
      break;
    case 'membrane':
      for (let k = 0; k < n; k++) {
        const row = MEMBRANE[Math.min(k, MEMBRANE.length - 1)];
        const [m, , r] = row;
        // Past the table, modes keep the density of a membrane (the count below f grows as f squared).
        ratio[k] = k < MEMBRANE.length ? r : MEMBRANE[MEMBRANE.length - 1][2] * Math.sqrt((k + 1) / MEMBRANE.length);
        const top = m === 0 ? 1 : 0.582 * Math.pow(m, -0.27); // the largest value J_m reaches
        weight[k] = besselJ(m, r * 2.404826 * 0.95 * s) / top;
      }
      break;
    case 'plate': {
      const modes = pairsByFrequency(n, (i, j) => (i >= 1 && j >= 1 ? { f: i * i + j * j * PLATE_ASPECT * PLATE_ASPECT, tag: [i, j] } : null), Math.ceil(Math.sqrt(n) * 2) + 2);
      const y = 0.5 - 0.41 * s;
      modes.forEach((m, k) => {
        ratio[k] = m.f / modes[0].f;
        weight[k] = Math.sin(Math.PI * m.tag[0] * x) * Math.sin(Math.PI * m.tag[1] * y);
      });
      break;
    }
    case 'box': {
      const span = Math.ceil(Math.cbrt(n) * 2) + 2;
      const all: { f: number; w: number }[] = [];
      const [a, b, c] = BOX_SIDES;
      // A source in a corner (1) drives every cavity mode, one in the middle (0) only the even ones.
      const px = 0.5 * (1 - s) + 0.02;
      const py = 0.5 * (1 - s) + 0.035;
      const pz = 0.5 * (1 - s) + 0.05;
      for (let p = 0; p <= span; p++) {
        for (let q = 0; q <= span; q++) {
          for (let r = 0; r <= span; r++) {
            if (p + q + r === 0) continue;
            all.push({
              f: Math.hypot(p / a, q / b, r / c),
              w: Math.cos(Math.PI * p * px) * Math.cos(Math.PI * q * py) * Math.cos(Math.PI * r * pz),
            });
          }
        }
      }
      all.sort((u, v) => u.f - v.f);
      for (let k = 0; k < n; k++) {
        ratio[k] = all[k].f / all[0].f;
        weight[k] = all[k].w;
      }
      break;
    }
    case 'bell':
      for (let k = 0; k < n; k++) {
        // Above the measured partials they keep crowding together, as on a real bell.
        ratio[k] = k < BELL.length ? BELL[k] : ratio[k - 1] * (1 + 0.2 * Math.pow(0.93, k - BELL.length + 1));
        weight[k] = 0.35 + 0.65 * Math.sin(Math.PI * (k + 1) * x);
      }
      // Struck on the sound bow, the strike note's octave (the nominal) and the tierce speak loudest.
      if (n > 4) weight[4] = Math.max(Math.abs(weight[4]), 0.9);
      break;
    case 'bowl':
      // Bending modes of a ring with m = 2, 3, ... waves around the rim: wine glasses, bowls, cups, hoops.
      for (let k = 0; k < n; k++) {
        const m = k + 2;
        ratio[k] = ((m * (m * m - 1)) / Math.sqrt(m * m + 1)) / (6 / Math.sqrt(5));
        weight[k] = 0.3 + 0.7 * Math.sin(Math.PI * (k + 1) * x);
      }
      break;
    default: {
      // No regular shape: a lump, a rock, a piece of junk. Irregular gaps, no two objects alike.
      let r = 1;
      for (let k = 0; k < n; k++) {
        ratio[k] = r;
        r *= 1 + rng.uniform(0.05, 0.5);
        weight[k] = 0.25 + 0.75 * Math.sin(Math.PI * (k + 1) * x);
      }
    }
  }
  // A real strike has some width, so no mode is ever left out entirely.
  for (let k = 0; k < n; k++) weight[k] = 0.06 + 0.94 * Math.min(1, Math.abs(weight[k]));
  return { ratio, weight };
}
