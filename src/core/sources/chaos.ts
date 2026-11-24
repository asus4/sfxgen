import type { ParamMeta, SourceDef } from '../nodes';
import type { ParamValue } from '../format/types';
import { Svf, dcBlock } from '../dsp/filters';
import { TAU, type Buf } from '../dsp/math';
import type { Rng } from '../dsp/rng';

type Mode = 'logistic' | 'henon' | 'lorenz' | 'feedback' | 'bytebeat';
const MODES: readonly Mode[] = ['logistic', 'henon', 'lorenz', 'feedback', 'bytebeat'];

/** A small fixed set of bytebeat formulas (8-bit output from an integer counter t). */
const FORMULAS: Record<string, (t: number) => number> = {
  sierpinski: (t) => t & (t >> 8),
  melody: (t) => t * (42 & (t >> 10)),
  glitch: (t) => t * (((t >> 12) | (t >> 8)) & 63 & (t >> 4)),
  techno: (t) => ((t * 5) & (t >> 7)) | ((t * 3) & (t >> 10)),
  harmony: (t) => t * (((t >> 9) | (t >> 13)) & 25 & (t >> 6)),
  bitshift: (t) => (((t >> 6) | t | (t >> (t >> 16))) * 10 + ((t >> 11) & 7)) | 0,
  crush: (t) => (t * ((t >> 5) | (t >> 8))) >> ((t >> 16) & 7),
};
const FORMULA_NAMES = Object.keys(FORMULAS);

const RATE_DEFAULTS: Record<Mode, number> = { logistic: 3000, henon: 3000, lorenz: 220, feedback: 220, bytebeat: 8000 };
/** Output scale per mode, so each peaks near 1. */
const MODE_GAIN: Record<Mode, number> = { logistic: 1, henon: 0.8, lorenz: 1 / 18, feedback: 0.9, bytebeat: 0.75 };

const PARAMS: Record<string, ParamMeta> = {
  mode: {
    kind: 'enum',
    doc:
      'The generator. logistic: the logistic map iterated at `rate`, from a buzzy period-4 tone (rate/4) to fizzing noise. ' +
      'henon: the Henon map, a harsher, crunchier relative. lorenz: the Lorenz attractor integrated in time, a ' +
      'tone that wanders and flips between two lobes (alien, unstable electronics). feedback: two sines modulating ' +
      'each other (cross-FM), from a warm buzz to screaming noise. bytebeat: integer formulas on a counter, the sound ' +
      'of old computers and broken game consoles, with `chaos` corrupting them.',
    options: MODES,
    default: 'logistic',
  },
  rate: {
    kind: 'signal',
    doc:
      'Speed of the generator, Hz: map iterations per second (logistic, henon; a repeating orbit of k values sounds ' +
      'at rate/k), the attractor\'s rough pitch (lorenz), the first oscillator\'s frequency (feedback) or counter steps ' +
      'per second (bytebeat, 8000 classic). Default per mode: 3000, 3000, 220, 220, 8000.',
    default: 3000,
    min: 20,
    max: 20000,
    hardMin: 1,
    hardMax: 48000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  chaos: {
    kind: 'signal',
    doc:
      'How unstable, 0 to 1. 0 settles into a repeating pattern (a tone), 0.4 to 0.7 the edge of chaos where ' +
      'patterns appear and break, 1 fully chaotic noise. For bytebeat it is the corruption: skips, stutters and ' +
      'flipped bits. It can move (a machine losing control).',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  smooth: {
    kind: 'number',
    doc:
      'Output smoothing, 0 to 1: 0 raw stepped digital grit, 0.5 softened, 1 smooth and dark (maps and bytebeat: ' +
      'interpolated and low-passed at half the rate; lorenz and feedback: only the lowest harmonics left).',
    default: 0.2,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  ratio: {
    kind: 'number',
    doc: 'feedback only: frequency of the second oscillator as a multiple of `rate`. 1 or 2 locks into buzzy tones, 1.41 or 2.76 grinds.',
    default: 1.41,
    min: 0.25,
    max: 8,
    hardMin: 0.01,
    hardMax: 32,
    unit: 'x',
    scale: 'log',
  },
  formula: {
    kind: 'enum',
    doc:
      'bytebeat only: the formula. sierpinski: a fractal arpeggio. melody: a chiptune tune. glitch: busy, broken ' +
      'rhythms. techno: a sequenced loop. harmony: chords that shift. bitshift: data noise and squeals. crush: ' +
      'collapsing, grinding bits.',
    options: FORMULA_NAMES,
    default: 'melody',
  },
};

/** One step of a map or formula: its next output value. */
type Stepper = () => number;

function logisticStepper(chaos: Buf, idx: () => number, rng: Rng): Stepper {
  let x = rng.uniform(0.2, 0.8);
  return () => {
    // 3.5 is a period-4 cycle; chaos sets in at 3.57 and fills the whole range at 4.
    const r = 3.5 + 0.5 * chaos[idx()];
    x = r * x * (1 - x);
    // At r = 4 the map can land on 0 or 1 and stick there; nudge it back into the attractor.
    if (!(x > 1e-9 && x < 1 - 1e-9)) x = rng.uniform(0.1, 0.9);
    return 2 * x - 1;
  };
}

function henonStepper(chaos: Buf, idx: () => number, rng: Rng): Stepper {
  let x = rng.uniform(-0.1, 0.1);
  let y = 0;
  return () => {
    const a = 1.0 + 0.4 * chaos[idx()];
    const nx = 1 - a * x * x + y;
    y = 0.3 * x;
    x = nx;
    // Outside its basin the map runs off to infinity: start again near the attractor.
    if (!(Math.abs(x) < 4)) {
      x = rng.uniform(-0.1, 0.1);
      y = 0;
    }
    return x / 1.3;
  };
}

/** The bytebeat counter with corruption: stutters (loops of the last steps), skips and flipped bits. */
function bytebeatStepper(chaos: Buf, idx: () => number, rng: Rng, formula: (t: number) => number): Stepper {
  let t = rng.int(0, 63) * 1024;
  let loopStart = 0;
  let loopLen = 0;
  let loopsLeft = 0;
  let pos = 0;
  return () => {
    const c = chaos[idx()];
    if (loopsLeft > 0) {
      pos++;
      if (pos >= loopLen) {
        pos = 0;
        loopsLeft--;
      }
    } else {
      t++;
      if (c > 0) {
        const u = rng.next();
        if (u < 0.0008 * c) {
          loopLen = 1 << rng.int(7, 11);
          loopStart = Math.max(0, t - loopLen);
          loopsLeft = rng.int(1, 4);
          pos = 0;
        } else if (u < 0.0012 * c) t += 1 << rng.int(10, 14);
      }
    }
    const at = loopsLeft > 0 ? loopStart + pos : t;
    let v = formula(at | 0) & 255;
    if (c > 0 && rng.next() < 0.03 * c * c) v ^= 1 << rng.int(0, 7);
    return (v - 128) / 128;
  };
}

/** Nonlinear and digital generators: logistic and Henon maps, the Lorenz attractor, cross-FM and bytebeat. */
export const chaos: SourceDef = {
  kind: 'source',
  type: 'chaos',
  label: 'Chaos',
  category: 'texture',
  doc:
    'Nonlinear and digital generators: maps and attractors on the edge of chaos, cross-modulated sines and bytebeat ' +
    'formulas. Reach for it for glitches, data noise, broken or alien electronics, malfunctioning robots, sci-fi ' +
    'computers and creature textures: sounds that are structured but never quite repeat. `chaos` moves it from a ' +
    'stable tone into noise; `rate` is its speed or pitch; `smooth` takes the digital edge off. The seed sets the ' +
    'starting point, so every take differs.',
  defaultEnv: { attack: 0.005, hold: 0.25, decay: 0.3 },
  params: PARAMS,
  example: {
    type: 'chaos',
    mode: 'lorenz',
    rate: [[0, 180], [0.6, 900]],
    chaos: [[0, 0.2], [0.6, 0.9]],
    smooth: 0.3,
    env: { attack: 0.01, hold: 0.4, decay: 0.3 },
  },
  render(p, ctx) {
    const { n, sr } = ctx;
    const mode = (MODES.includes(p.mode as Mode) ? p.mode : 'logistic') as Mode;
    const rate = ctx.signal('rate', (p.rate ?? RATE_DEFAULTS[mode]) as ParamValue);
    // Above these the feedback pair only aliases, and Lorenz needs too many integration steps to be worth it.
    const cap = mode === 'feedback' ? 0.45 * sr : mode === 'lorenz' ? 16000 : Infinity;
    for (let k = 0; k < n; k++) if (rate[k] > cap) rate[k] = cap;
    const amount = ctx.signal('chaos');
    const smooth = ctx.num('smooth');
    const rng = ctx.rng.fork('chaos', mode);
    const out = new Float64Array(n);
    let i = 0;
    const idx = () => i;

    if (mode === 'lorenz') {
      // RK4, with enough substeps to stay accurate at high rates. One oscillation around a lobe takes about 0.7
      // time units, so `rate` Hz is roughly the pitch.
      let x = rng.uniform(-2, 2) + 1;
      let y = rng.uniform(-2, 2) + 1;
      let z = rng.uniform(18, 26);
      const sigma = 10;
      const beta = 8 / 3;
      for (i = 0; i < n; i++) {
        const rho = 24.8 + 30 * amount[i];
        const dt = rate[i] / (1.4 * sr);
        const steps = Math.max(1, Math.ceil(dt / 0.01));
        const h = dt / steps;
        for (let s = 0; s < steps; s++) {
          const k1x = sigma * (y - x);
          const k1y = x * (rho - z) - y;
          const k1z = x * y - beta * z;
          let ax = x + 0.5 * h * k1x;
          let ay = y + 0.5 * h * k1y;
          let az = z + 0.5 * h * k1z;
          const k2x = sigma * (ay - ax);
          const k2y = ax * (rho - az) - ay;
          const k2z = ax * ay - beta * az;
          ax = x + 0.5 * h * k2x;
          ay = y + 0.5 * h * k2y;
          az = z + 0.5 * h * k2z;
          const k3x = sigma * (ay - ax);
          const k3y = ax * (rho - az) - ay;
          const k3z = ax * ay - beta * az;
          ax = x + h * k3x;
          ay = y + h * k3y;
          az = z + h * k3z;
          const k4x = sigma * (ay - ax);
          const k4y = ax * (rho - az) - ay;
          const k4z = ax * ay - beta * az;
          x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
          y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
          z += (h / 6) * (k1z + 2 * k2z + 2 * k3z + k4z);
        }
        if (!(Math.abs(x) < 1e3 && Math.abs(y) < 1e3 && Math.abs(z) < 1e3)) {
          x = rng.uniform(-2, 2) + 1;
          y = rng.uniform(-2, 2) + 1;
          z = rng.uniform(18, 26);
        }
        out[i] = x;
      }
    } else if (mode === 'feedback') {
      // Two sines, each modulating the other's phase with the other's last output.
      const ratio = ctx.num('ratio');
      let pa = rng.next();
      let pb = rng.next();
      let a = 0;
      let b = 0;
      for (i = 0; i < n; i++) {
        const beta = 0.5 + 2.5 * amount[i];
        const na = Math.sin(TAU * pa + beta * b);
        const nb = Math.sin(TAU * pb + beta * a);
        a = na;
        b = nb;
        out[i] = 0.6 * a + 0.4 * b;
        pa += rate[i] / sr;
        pb += (rate[i] * ratio) / sr;
        pa -= Math.floor(pa);
        pb -= Math.floor(pb);
      }
    } else {
      // Step generators, run at `rate` and held (or blended toward linear interpolation by `smooth`).
      const step =
        mode === 'logistic'
          ? logisticStepper(amount, idx, rng)
          : mode === 'henon'
            ? henonStepper(amount, idx, rng)
            : bytebeatStepper(amount, idx, rng, FORMULAS[p.formula as string] ?? FORMULAS.melody);
      const blend = Math.min(1, 2 * smooth);
      let prev = 0;
      let cur = step();
      let ph = 0;
      for (i = 0; i < n; i++) {
        out[i] = cur + blend * (ph - 1) * (cur - prev);
        ph += rate[i] / sr;
        // A guard for absurd rates: at most 64 steps per sample.
        let guard = 0;
        while (ph >= 1 && guard++ < 64) {
          ph -= 1;
          prev = cur;
          cur = step();
        }
        if (ph >= 1) ph -= Math.floor(ph);
      }
    }

    // DC: maps and attractors sit off-centre, by an amount that moves with `chaos`.
    let mean = 0;
    for (let k = 0; k < n; k++) mean += out[k];
    mean /= Math.max(n, 1);
    const g = MODE_GAIN[mode];
    for (let k = 0; k < n; k++) out[k] = Number.isFinite(out[k]) ? (out[k] - mean) * g : 0;
    dcBlock(out, sr, 15);
    // Smoothing: a low-pass from far above the rate (raw) down to half the step rate of a map or bytebeat (no
    // images left), or to 1.5 times the pitch of lorenz and feedback (only the lowest harmonics left).
    if (smooth > 0) {
      const lp = new Svf('lowpass', sr);
      const pitched = mode === 'lorenz' || mode === 'feedback';
      const k = pitched ? Math.pow(2, 4 * (1 - smooth)) * 1.5 : Math.pow(2, 5 * (1 - smooth)) * 0.5;
      for (let s = 0; s < n; s++) out[s] = lp.tick(out[s], Math.min(rate[s] * k, 0.45 * sr), 0.707);
    }
    return out;
  },
};
