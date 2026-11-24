import type { EffectDef, ParamMeta } from '../nodes';
import { cubicAt } from '../dsp/fracdelay';
import { Svf } from '../dsp/filters';
import { clamp, peak, type Buf } from '../dsp/math';
import { isBreakpoints, isSignalObject } from '../params';

const C = 343;
/** Half the distance between the ears, metres. */
const EAR = 0.09;
const DIRECTIONS = ['left-to-right', 'right-to-left', 'front-to-back'] as const;
type Direction = (typeof DIRECTIONS)[number];

const PARAMS: Record<string, ParamMeta> = {
  speed: {
    kind: 'signal',
    doc:
      'Speed of the source along its straight path, metres per second: 1.5 a walker, 5 a bee, 15 a car in town, ' +
      '30 on a highway, 70 a race car, 250 a jet or a bullet. It may move (a car accelerating past).',
    default: 30,
    min: 1,
    max: 150,
    hardMin: 0,
    hardMax: 320,
    unit: 'm/s',
    scale: 'log',
  },
  distance: {
    kind: 'number',
    doc:
      'How close the path passes the listener, metres. 0.5 skims the ear (a sharp, sudden swoosh), 5 a passing car ' +
      'on a sidewalk, 50 a distant plane (a slow, gentle swell).',
    default: 5,
    min: 0.5,
    max: 100,
    hardMin: 0.1,
    hardMax: 2000,
    unit: 'm',
    scale: 'log',
  },
  time: {
    kind: 'number',
    doc: 'When the listener hears the source at its closest, seconds from the start of the buffer. Default: the middle of the sound.',
    min: 0,
    max: 10,
    hardMin: -60,
    hardMax: 60,
    unit: 's',
  },
  direction: {
    kind: 'enum',
    doc: 'Which way it travels: across in front of the listener, or front-to-back (straight over the head; no panning).',
    options: DIRECTIONS,
    default: 'left-to-right',
  },
  amount: {
    kind: 'number',
    doc: 'How much of the Doppler pitch bend to keep: 1 physical, 0 none (level and panning only), 2 exaggerated for cartoon fly-bys.',
    default: 1,
    min: 0,
    max: 2,
    hardMin: 0,
    hardMax: 4,
  },
  air: {
    kind: 'number',
    doc: 'Air absorption: highs fade with distance. 1 is physical, 3 to 6 makes distant parts much duller (haze, rain), 0 off.',
    default: 1,
    min: 0,
    max: 4,
    hardMin: 0,
    hardMax: 20,
  },
  rolloff: {
    kind: 'number',
    doc: 'How fast the level falls with distance: 1 physical (-6 dB per doubling), 0.5 gentler, 2 dramatic.',
    default: 1,
    min: 0,
    max: 2,
    hardMin: 0,
    hardMax: 4,
  },
};

function maxOf(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (isBreakpoints(v)) return Math.max(...v.map((p) => p[1]));
  if (isSignalObject(v)) {
    const s = v as { value?: number; env?: [number, number][] };
    if (s.env && s.env.length) return Math.max(...s.env.map((p) => p[1]));
    if (typeof s.value === 'number') return s.value;
  }
  return fallback;
}

/**
 * For each output sample, the fractional input (emission) sample heard then, through an arrival map that grows
 * monotonically: `arrival(j)` is when emission j reaches this ear, in samples.
 */
function emissionTimes(arrival: Float64Array, nOut: number): Float64Array {
  const te = new Float64Array(nOut).fill(-1);
  const n = arrival.length;
  let j = 0;
  for (let i = 0; i < nOut; i++) {
    if (i < arrival[0]) continue;
    while (j + 1 < n && arrival[j + 1] <= i) j++;
    if (j + 1 >= n) {
      if (i <= arrival[n - 1] + 1) te[i] = n - 1;
      continue;
    }
    const a = arrival[j];
    const b = arrival[j + 1];
    te[i] = j + (b > a ? (i - a) / (b - a) : 0);
  }
  return te;
}

/** A source flying past: propagation delay (the Doppler bend falls out of it), distance level, air and panning. */
export const doppler: EffectDef = {
  kind: 'effect',
  type: 'doppler',
  label: 'Doppler fly-by',
  category: 'space',
  widens: true,
  doc:
    'Moves the sound past the listener on a straight path: the moving propagation delay bends the pitch up on ' +
    'the approach and down on the way out, the level follows the distance, the air dulls it far away, and in ' +
    'stereo it pans across with the delay between the ears. Feed it a steady sound (an engine tone, noise for a ' +
    'whoosh, buzzing for a bee) that lasts the whole pass. The sound arrives late by its travel time, as it does.',
  params: PARAMS,
  example: { type: 'doppler', speed: 40, distance: 4, time: 1.2 },
  length(params, seconds) {
    const v = Math.min(Math.max(maxOf(params.speed, 30), 0), 320);
    const d = clamp(typeof params.distance === 'number' ? params.distance : 5, 0.1, 2000);
    const amount = clamp(typeof params.amount === 'number' ? params.amount : 1, 0, 4);
    const tc = typeof params.time === 'number' ? params.time : seconds / 2;
    const x = v * Math.max(Math.abs(seconds - tc), Math.abs(tc));
    return seconds + (amount * (Math.hypot(d, x) - d)) / C + 0.01;
  },
  process(input, p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    // A point source: mono in.
    let x: Buf = input[0];
    if (input.length === 2) {
      x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.5 * (input[0][i] + input[1][i]);
    }
    const pk = peak(x);
    if (pk <= 0) return input;
    // The sound's active span, for the default pass time.
    let first = 0;
    let last = n - 1;
    const floor = pk * 1e-4;
    while (first < n - 1 && Math.abs(x[first]) <= floor) first++;
    while (last > first && Math.abs(x[last]) <= floor) last--;
    const tc = p.time === undefined ? (first + last) / 2 / sr : ctx.num('time');
    const d = ctx.num('distance');
    const air = ctx.num('air');
    const rolloff = ctx.num('rolloff');
    const dir: Direction = DIRECTIONS.includes(p.direction as Direction) ? (p.direction as Direction) : 'left-to-right';
    const speed = ctx.signal('speed', n);
    let vMax = 0;
    for (let i = 0; i < n; i++) vMax = Math.max(vMax, speed[i]);
    // The arrival map must keep rising: the bent speed of sound stays above the source's speed.
    const amount = Math.min(ctx.num('amount'), vMax > 0 ? (0.95 * C) / vMax : Infinity);

    // Position along the path at every emission sample, 0 at the pass.
    const jc = tc * sr;
    const X = new Float64Array(n);
    const j0 = Math.round(clamp(jc, 0, n - 1));
    let acc = (j0 - jc) * (speed[j0] / sr);
    X[j0] = acc;
    for (let j = j0 + 1; j < n; j++) X[j] = acc += speed[j - 1] / sr;
    acc = X[j0];
    for (let j = j0 - 1; j >= 0; j--) X[j] = acc -= speed[j] / sr;

    const stereo = input.length === 2;
    const ears = stereo && dir !== 'front-to-back' ? [-EAR, EAR] : [0];
    const flip = dir === 'right-to-left' ? -1 : 1;
    const extra = (amount * (Math.hypot(d, Math.max(Math.abs(X[0]), Math.abs(X[n - 1])) + EAR) - d)) / C;
    const nOut = n + Math.ceil(extra * sr) + 4;
    // Emission j reaches an ear after the extra path beyond the closest approach.
    const arrivalAt = (ear: number) => {
      const arrival = new Float64Array(n);
      for (let j = 0; j < n; j++) arrival[j] = j + (amount * (Math.hypot(d, flip * X[j] - ear) - d) * sr) / C;
      return arrival;
    };
    // On a fast approach the input is read faster than real time: low-pass it under the new Nyquist first.
    const centre = arrivalAt(0);
    let maxSpeedUp = 1;
    for (let j = 1; j < n; j++) maxSpeedUp = Math.max(maxSpeedUp, 1 / Math.max(centre[j] - centre[j - 1], 1e-3));
    if (maxSpeedUp > 1.02) {
      const f1 = new Svf('lowpass', sr);
      const f2 = new Svf('lowpass', sr);
      const xf = new Float64Array(n);
      let fc = sr * 0.45;
      for (let j = 0; j < n; j++) {
        if ((j & 15) === 0) fc = (sr * 0.45) * Math.min(j + 1 < n ? centre[j + 1] - centre[j] : 1, 1);
        xf[j] = f2.tick(f1.tick(x[j], fc, 0.5412), fc, 1.3066);
      }
      x = xf;
    }
    const outs: Buf[] = [];
    for (const ear of ears) {
      const te = emissionTimes(ear === 0 ? centre : arrivalAt(ear), nOut);
      const out = new Float64Array(nOut);
      let lp1 = 0;
      let lp2 = 0;
      for (let i = 0; i < nOut; i++) {
        const t = te[i];
        if (t < 0) {
          lp1 *= 0.5;
          lp2 *= 0.5;
          continue;
        }
        const ti = Math.min(Math.floor(t), n - 1);
        const pos = X[ti] + (t - ti) * (speed[ti] / sr);
        const lateral = flip * pos;
        const r = Math.hypot(d, lateral);
        let y = cubicAt(x, t) * Math.pow(d / r, rolloff);
        if (air > 0) {
          // Two one-poles whose cutoff falls as 1/√distance: absorption grows with the square of frequency.
          const fc = clamp(52700 / Math.sqrt(r * air), 150, sr * 0.45);
          const a = Math.exp((-2 * Math.PI * fc * Math.SQRT2) / sr);
          lp1 = (1 - a) * y + a * lp1;
          lp2 = (1 - a) * lp1 + a * lp2;
          y = lp2;
        }
        if (ears.length === 2) {
          // Equal-power pan by the angle of arrival (up to about 20 dB between the ears, as a head gives), on top
          // of the delay between the ears.
          const pan = 0.85 * clamp(lateral / r, -1, 1);
          const g = ear < 0 ? Math.cos(((pan + 1) * Math.PI) / 4) : Math.sin(((pan + 1) * Math.PI) / 4);
          y *= g * Math.SQRT2;
        }
        out[i] = y;
      }
      outs.push(out);
    }
    if (stereo && outs.length === 1) outs.push(outs[0].slice());
    return outs;
  },
};
