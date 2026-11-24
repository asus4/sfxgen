/**
 * Low-frequency oscillators for the modulation effects (tremolo, chorus, flanger, phaser): a per-sample rate that
 * may move, a start phase in cycles, and a softener for the shapes that jump, so nothing clicks.
 */
import type { Rng } from './rng';
import { TAU, type Buf } from './math';
import { smoothTwoWay } from './dynamics';

export const FX_LFO_SHAPES = ['sine', 'triangle', 'square', 'saw', 'ramp', 'random'] as const;
export type FxLfoShape = (typeof FX_LFO_SHAPES)[number];

/** Is this shape continuous (no jumps that need softening)? */
export function lfoIsSmooth(shape: FxLfoShape): boolean {
  return shape === 'sine' || shape === 'triangle';
}

/**
 * Renders an LFO from -1 to 1 with a per-sample rate in Hz, starting at `phase0` cycles. Sine and triangle start at
 * 0 and rise; square starts high; saw falls from 1 and ramp rises from -1 once a cycle; random holds a new value
 * each cycle (drawn from `rng`).
 */
export function renderFxLfo(shape: FxLfoShape, rate: Buf, sr: number, phase0: number, rng: Rng): Buf {
  const n = rate.length;
  const out = new Float64Array(n);
  let ph = phase0 - Math.floor(phase0);
  let held = rng.uniform(-1, 1);
  for (let i = 0; i < n; i++) {
    let v: number;
    switch (shape) {
      case 'sine':
        v = Math.sin(TAU * ph);
        break;
      case 'triangle':
        v = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
        break;
      case 'square':
        v = ph < 0.5 ? 1 : -1;
        break;
      case 'saw':
        v = 1 - 2 * ph;
        break;
      case 'ramp':
        v = 2 * ph - 1;
        break;
      default:
        v = held;
    }
    out[i] = v;
    ph += rate[i] / sr;
    if (ph >= 1 || ph < 0) {
      ph -= Math.floor(ph);
      held = rng.uniform(-1, 1);
    }
  }
  return out;
}

/** Softens the jumps of square, saw, ramp and random shapes (zero-phase, `seconds` per pass). In place. */
export function softenLfo(x: Buf, sr: number, seconds = 0.0008): Buf {
  return smoothTwoWay(x, seconds, sr);
}
