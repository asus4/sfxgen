import type { ParamMeta, SourceDef, VoiceContext } from '../nodes';
import type { ParamValue } from '../format/types';
import { oscillator } from '../dsp/oscillators';
import { Svf, dcBlock, filterBuffer } from '../dsp/filters';
import { noise, wander } from '../dsp/noise';
import { TAU, clamp, type Buf } from '../dsp/math';
import type { Rng } from '../dsp/rng';

type Kind = 'motor' | 'engine' | 'turbine' | 'rotor' | 'servo' | 'drill';
const KINDS: readonly Kind[] = ['motor', 'engine', 'turbine', 'rotor', 'servo', 'drill'];

/** What each kind assumes when a parameter is left out. */
const KIND_DEFAULTS: Record<Kind, { rpm: number; teeth: number; whine: number; blades: number; gain: number }> = {
  motor: { rpm: 3000, teeth: 12, whine: 0.3, blades: 2, gain: 0.9 },
  servo: { rpm: 9000, teeth: 10, whine: 0.5, blades: 2, gain: 0.62 },
  drill: { rpm: 18000, teeth: 14, whine: 0.4, blades: 2, gain: 0.8 },
  engine: { rpm: 900, teeth: 6, whine: 0.05, blades: 2, gain: 1.1 },
  turbine: { rpm: 9000, teeth: 1, whine: 0.6, blades: 22, gain: 1.1 },
  rotor: { rpm: 330, teeth: 520, whine: 0.1, blades: 2, gain: 0.72 },
};

const PARAMS: Record<string, ParamMeta> = {
  kind: {
    kind: 'enum',
    doc:
      'What turns. motor: electric hum, brush noise and gear whine (fans, conveyors, electric cars, power tools). ' +
      'servo: a small fast geared motor (robots, camera gimbals, toys), buzzing harder as it strains. drill: motor, ' +
      'gearbox and a spinning bit that chops and grinds. engine: combustion firing pulses through an exhaust pipe ' +
      '(cars, motorbikes, generators, lawnmowers). turbine: jet whine and roar. rotor: blade slaps and downwash ' +
      '(helicopters, big fans, propellers).',
    options: KINDS,
    default: 'motor',
  },
  rpm: {
    kind: 'signal',
    doc:
      'Shaft speed in revolutions per minute; breakpoints spin it up, bog it down or wind it off. Typical: motor ' +
      '1000 to 6000 (hum at rpm/30 Hz), servo 4000 to 15000, drill 8000 to 30000, engine 700 idle to 7000 redline, ' +
      'turbine 2000 to 15000, rotor 250 to 400 (helicopter) or 600 to 2000 (fan). Default per kind: motor 3000, ' +
      'servo 9000, drill 18000, engine 900, turbine 9000, rotor 330.',
    default: 3000,
    min: 60,
    max: 30000,
    hardMin: 1,
    hardMax: 200000,
    unit: 'rpm',
    scale: 'log',
    pitch: true,
  },
  load: {
    kind: 'signal',
    doc:
      'Strain, 0 to 1: rougher, brighter, louder firing and more grinding, brush noise and buzz. 0 coasting, 0.3 ' +
      'normal work, 0.8 straining, 1 about to stall. Move it with breakpoints together with `rpm` (load up while rpm ' +
      'sags is a machine biting into something).',
    default: 0.3,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  roughness: {
    kind: 'number',
    doc:
      'Cycle-to-cycle variation, 0 to 1: 0 a perfectly even machine, 0.3 a healthy real one, 0.6 worn and uneven ' +
      '(an old engine\'s lope), 1 broken (misfires, wobbling speed).',
    default: 0.25,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  whine: {
    kind: 'number',
    doc:
      'Level of the gear-mesh whine (on a turbine, the blade whine; on an engine, a supercharger or alternator), 0 ' +
      'to 1. Default per kind: motor 0.3, servo 0.5, drill 0.4, engine 0.05, turbine 0.6, rotor 0.1.',
    default: 0.3,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 2,
  },
  teeth: {
    kind: 'number',
    doc:
      'Gear teeth per revolution: the whine sits at rpm/60 * teeth Hz. Default per kind: motor 12, servo 10, drill ' +
      '14, engine 6, rotor 520 (the gearbox up to its drive turbine, about 2.9 kHz at 330 rpm). Unused by turbine.',
    default: 12,
    min: 3,
    max: 600,
    step: 1,
    hardMin: 1,
    hardMax: 2000,
    scale: 'log',
  },
  cylinders: {
    kind: 'number',
    doc:
      'Engine only: 1 thumps like a dirt bike or lawnmower, 2 a twin, 4 a car, 6 smooth, 8 a V8 rumble. Fires ' +
      'cylinders * rpm / 120 times a second, each cylinder a little different.',
    default: 4,
    min: 1,
    max: 12,
    step: 1,
    hardMin: 1,
    hardMax: 16,
  },
  blades: {
    kind: 'number',
    doc:
      'Rotor: blades per revolution, slapping blades * rpm / 60 times a second (2 a helicopter, 4 to 7 a fan). ' +
      'Turbine: fan blades, setting the whine at blades * rpm / 60 Hz (default 22).',
    default: 2,
    min: 2,
    max: 40,
    step: 1,
    hardMin: 1,
    hardMax: 120,
  },
  size: {
    kind: 'number',
    doc:
      'Size of the machine: lowers its body, pipe and air resonances. 0.4 a toy or a model, 1 normal, 2 a truck, a ' +
      'ship\'s engine or a heavy-lift helicopter.',
    default: 1,
    min: 0.3,
    max: 3,
    hardMin: 0.1,
    hardMax: 10,
    unit: 'x',
    scale: 'log',
  },
};

// ---- Helpers ------------------------------------------------------------------------------------------

interface Ctx {
  n: number;
  sr: number;
  rng: Rng;
  rpm: Buf;
  load: Buf;
  roughness: number;
  whine: number;
  teeth: number;
  cylinders: number;
  blades: number;
  size: number;
}

/** A sine whose frequency follows a curve times `mul`, faded out near Nyquist; added into `out` at `level`. */
function addTone(out: Buf, freq: Buf, mul: number, level: number, sr: number, phase0 = 0): void {
  if (level === 0) return;
  let ph = phase0;
  const lo = 0.4 * sr;
  const hi = 0.47 * sr;
  for (let i = 0; i < out.length; i++) {
    const f = freq[i] * mul;
    const fade = f < lo ? 1 : f > hi ? 0 : (hi - f) / (hi - lo);
    out[i] += level * fade * Math.sin(TAU * ph);
    ph += f / sr;
    if (ph >= 1) ph -= Math.floor(ph);
  }
}

/** The times (fractional samples) at which a running phase driven by `rate` (per second) passes each whole number. */
function eventTimes(rate: Buf, sr: number, phase0: number): number[] {
  const at: number[] = [];
  let p = phase0;
  for (let i = 0; i < rate.length; i++) {
    const step = Math.max(rate[i], 0) / sr;
    const next = p + step;
    for (let m = Math.floor(p) + 1; m <= next && step > 0; m++) at.push(i + (m - p) / step);
    p = next;
    if (at.length > 2_000_000) break;
  }
  return at;
}

/** Adds fn(tau) for tau = sample - at over [at, at + len) into buf. */
function stamp(buf: Buf, at: number, len: number, fn: (tau: number) => number): void {
  const start = Math.max(0, Math.ceil(at));
  const end = Math.min(buf.length, Math.floor(at + len));
  for (let j = start; j < end; j++) buf[j] += fn(j - at);
}

function scaled(x: Buf, k: number): Buf {
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

function freqOf(c: Ctx, mul: number, wobble?: Buf): Buf {
  const f = new Float64Array(c.n);
  for (let i = 0; i < c.n; i++) f[i] = (c.rpm[i] / 60) * mul * (wobble ? 1 + wobble[i] : 1);
  return f;
}

/** Brush and commutator noise: band-passed noise chopped at the commutation rate. */
function brushNoise(c: Ctx, hum: Buf, centre: number, level: Buf): Buf {
  const w = noise('white', c.n, c.sr, c.rng.fork('brush'));
  new Svf('bandpass', c.sr).process(w, centre, 0.8);
  let ph = 0;
  for (let i = 0; i < c.n; i++) {
    const chop = 0.5 + 0.5 * Math.cos(TAU * ph);
    w[i] *= chop * chop * chop * chop * level[i];
    ph += hum[i] / c.sr;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  return w;
}

/**
 * Electric hum: a band-limited saw and a square an octave up, darker unless strained. The octave is exact: detuned,
 * it beat slowly against the saw's second harmonic and the hum swelled by 3 dB over a few seconds at constant speed.
 */
function humOf(c: Ctx, fh: Buf, saw: number, square: number, base: number, open: number): Buf {
  const a = oscillator('saw', fh, c.sr, c.rng.next());
  const fh2 = fh.map((f) => f * 2);
  const b = oscillator('square', fh2, c.sr, c.rng.next());
  const y = new Float64Array(c.n);
  for (let i = 0; i < c.n; i++) y[i] = saw * a[i] + square * b[i];
  const cutoff = new Float64Array(c.n);
  for (let i = 0; i < c.n; i++) cutoff[i] = Math.min(base + open * c.load[i], 0.45 * c.sr);
  return filterBuffer(y, 'lowpass', cutoff, 0.9, c.sr);
}

// ---- Kinds --------------------------------------------------------------------------------------------

function renderMotor(c: Ctx): Buf {
  const { n, sr } = c;
  const meanFr = c.rpm.reduce((a, b) => a + b, 0) / n / 60;
  const wob = scaled(wander(n, sr, clamp(meanFr, 2, 40), c.rng.fork('wobble')), 0.012 * c.roughness);
  const fh = freqOf(c, 2, wob);
  const y = humOf(c, fh, 0.55, 0.25, 700, 5000);
  // The housing rings a little.
  const body = filterBuffer(y.slice(), 'bandpass', 900 / c.size, 2, sr);
  for (let i = 0; i < n; i++) y[i] = 0.75 * y[i] + 0.6 * body[i];
  const fr = freqOf(c, 1, wob);
  addTone(y, fr, c.teeth, 0.35 * c.whine, sr, c.rng.next());
  addTone(y, fr, 2 * c.teeth, 0.1 * c.whine, sr, c.rng.next());
  addTone(y, fr, 0.41 * c.teeth, 0.18 * c.whine, sr, c.rng.next());
  // Unbalance: a soft thump once per turn.
  addTone(y, fr, 1, 0.12, sr);
  const level = c.load.map((l) => (0.08 + 0.45 * l) * (0.5 + c.roughness));
  const brush = brushNoise(c, fh, 2500 / Math.sqrt(c.size), level);
  for (let i = 0; i < n; i++) y[i] += brush[i];
  // Sparks under strain.
  const sparks = noise('crackle', n, sr, c.rng.fork('sparks'), c.load.map((l) => 5 + 500 * l * l));
  filterBuffer(sparks, 'highpass', 1500, 0.7, sr);
  for (let i = 0; i < n; i++) y[i] += 0.12 * c.load[i] * sparks[i];
  return y;
}

function renderServo(c: Ctx): Buf {
  const { n, sr } = c;
  // Cogging and the control loop make a small servo's speed wobble at about 17 Hz, more as it strains.
  const ph0 = c.rng.uniform(0, TAU);
  const drift = wander(n, sr, 6, c.rng.fork('wobble'));
  const wob = new Float64Array(n);
  for (let i = 0; i < n; i++) wob[i] = (0.01 + 0.05 * c.load[i]) * Math.sin(TAU * 17 * (i / sr) + ph0) + 0.015 * c.roughness * drift[i];
  const fh = freqOf(c, 2, wob);
  const y = humOf(c, fh, 0.45, 0.35, 1400, 6000);
  const fr = freqOf(c, 1, wob);
  // Three gear stages, each slower than the last.
  addTone(y, fr, c.teeth, 0.4 * c.whine, sr, c.rng.next());
  addTone(y, fr, c.teeth / 3.3, 0.22 * c.whine, sr, c.rng.next());
  addTone(y, fr, c.teeth / (3.3 * 3.1), 0.12 * c.whine, sr, c.rng.next());
  // The control frame (50 Hz pulses) buzzes through the motor as it holds against a load.
  const frame = oscillator('pulse', new Float64Array(n).fill(50), sr, 0, 0.08);
  filterBuffer(frame, 'bandpass', 1200, 0.6, sr);
  for (let i = 0; i < n; i++) y[i] += frame[i] * (0.03 + 0.6 * c.load[i] * c.load[i]);
  const brush = brushNoise(c, fh, 3200, c.load.map((l) => (0.06 + 0.3 * l) * (0.5 + c.roughness)));
  for (let i = 0; i < n; i++) y[i] += brush[i];
  // A small plastic housing: two resonances, then no deep bass and no air.
  const r1 = filterBuffer(y.slice(), 'bandpass', 1800 / c.size, 3, sr);
  const r2 = filterBuffer(y.slice(), 'bandpass', 3400 / c.size, 3, sr);
  for (let i = 0; i < n; i++) y[i] += 0.7 * r1[i] + 0.45 * r2[i];
  filterBuffer(y, 'highpass', 130 / Math.sqrt(c.size), 0.7, sr);
  filterBuffer(y, 'lowpass', Math.min(7500 / Math.sqrt(c.size), 0.45 * sr), 0.7, sr);
  return y;
}

function renderDrill(c: Ctx): Buf {
  const { n, sr } = c;
  const meanFr = c.rpm.reduce((a, b) => a + b, 0) / n / 60;
  const wob = scaled(wander(n, sr, clamp(meanFr / 4, 2, 40), c.rng.fork('wobble')), 0.01 * c.roughness);
  const fh = freqOf(c, 2, wob);
  const y = scaled(humOf(c, fh, 0.55, 0.3, 2500, 4000), 0.9);
  const fr = freqOf(c, 1, wob);
  addTone(y, fr, c.teeth, 0.32 * c.whine, sr, c.rng.next());
  addTone(y, fr, c.teeth * 1.57, 0.16 * c.whine, sr, c.rng.next());
  // The bit turns at a twelfth of the motor: its two flutes chop the sound, and its edges catch three times a turn.
  const chuck = freqOf(c, 1 / 12, wob);
  const grit = noise('white', n, sr, c.rng.fork('grit'));
  filterBuffer(grit, 'bandpass', 4000 / Math.sqrt(c.size), 0.6, sr);
  const grind = noise('white', n, sr, c.rng.fork('grind'));
  filterBuffer(grind, 'bandpass', 2000 / Math.sqrt(c.size), 0.5, sr);
  const chatter = wander(n, sr, 140, c.rng.fork('chatter'));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const flutes = 0.68 + 0.32 * Math.sin(TAU * 2 * ph);
    const s = Math.abs(Math.sin(TAU * 3 * ph));
    const catchy = s * s * s * s;
    const l = c.load[i];
    const ch = Math.max(chatter[i], 0);
    const g = grind[i] * (0.3 + 1.5 * ch * ch) * 1.5;
    y[i] = y[i] * flutes + 0.35 * grit[i] * (0.25 + 0.75 * catchy) * (0.6 + 0.6 * l) + 0.8 * l * Math.tanh(2.5 * g) / 2.5;
    ph += chuck[i] / sr;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  return y;
}

function renderEngine(c: Ctx): Buf {
  const { n, sr } = c;
  const cyl = Math.round(c.cylinders);
  const rough = c.roughness;
  // Each cylinder fires a little differently: its own strength and a small timing error.
  const cylRng = c.rng.fork('cylinders');
  const gains: number[] = [];
  const offsets: number[] = [];
  for (let k = 0; k < cyl; k++) {
    gains.push(clamp(1 + (0.06 + 0.35 * rough) * cylRng.gauss(), 0.3, 1.8));
    offsets.push(0.04 * rough * clamp(cylRng.gauss(), -2.5, 2.5));
  }
  const fire = new Float64Array(n);
  for (let i = 0; i < n; i++) fire[i] = (cyl * c.rpm[i]) / 120;
  const times = eventTimes(fire, sr, 0.999);
  const exc = new Float64Array(n);
  const ev = c.rng.fork('firing');
  const grit = c.rng.fork('grit');
  const sz = Math.sqrt(c.size);
  times.forEach((at, k) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(at)));
    const l = c.load[i];
    const interval = sr / Math.max(fire[i], 1e-3);
    const slot = k % cyl;
    // A worn engine misfires now and then.
    if (ev.next() < Math.max(0, rough - 0.6) * 0.3) return;
    // Faster firing packs more pulses into a second: level them partly, so idle to redline climbs about 7 dB, not 20.
    const pace = clamp(Math.pow(30 / Math.max(fire[i], 1e-3), 0.3), 0.2, 1.5);
    const amp = gains[slot] * (1 + 0.25 * rough * clamp(ev.gauss(), -2.5, 2.5)) * (0.6 + 0.6 * l) * pace;
    const w = clamp((1.3 - 0.7 * l) * 1e-3 * sr * sz, 6, 0.4 * interval);
    const pos = at + offsets[slot] * interval;
    // The exhaust pulse: a sharp push and a gentler suck back, with no net offset.
    stamp(exc, pos, 3 * w, (tau) =>
      tau < w ? amp * 0.5 * (1 - Math.cos((TAU * tau) / w)) : -amp * 0.25 * (1 - Math.cos((TAU * (tau - w)) / (2 * w))),
    );
    // Combustion crackle riding on each pulse.
    const tauN = Math.min(0.0012 * sr, interval / 4);
    const g = amp * (0.15 + 0.45 * l);
    stamp(exc, pos, 4 * tauN, (tau) => g * grit.uniform(-1, 1) * Math.exp(-tau / tauN));
  });
  // The exhaust pipe: a comb resonance at its length, damped at the top.
  const pipe = 130 / c.size;
  const delay = sr / pipe;
  const line = new Float64Array(Math.ceil(delay) + 2);
  let w = 0;
  let damp = 0;
  const dampA = 1 - Math.exp((-TAU * 2500) / sr);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rd = w - delay;
    const r = rd < 0 ? rd + line.length : rd;
    const i0 = Math.floor(r);
    const f = r - i0;
    const back = line[i0 % line.length] * (1 - f) + line[(i0 + 1) % line.length] * f;
    damp += dampA * (back - damp);
    const v = exc[i] + 0.55 * damp;
    line[w] = v;
    w = (w + 1) % line.length;
    y[i] = v;
  }
  // The muffler opens up as the engine works harder.
  const cutoff = c.load.map((l) => Math.min((700 + 2500 * l) / sz, 0.45 * sr));
  filterBuffer(y, 'lowpass', cutoff, 0.8, sr);
  // Valve train: tiny ticks, twice per firing.
  const ticks = new Float64Array(n);
  const tickTimes = eventTimes(fire.map((f) => 2 * f), sr, 0.5);
  const tr = c.rng.fork('ticks');
  for (const at of tickTimes) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(at)));
    const tauT = Math.min(0.0003 * sr, sr / Math.max(8 * fire[i], 1e-3));
    const g = 0.05 * (1 + c.load[i]) * (0.7 + 0.6 * tr.next());
    stamp(ticks, at, 5 * tauT, (tau) => g * tr.uniform(-1, 1) * Math.exp(-tau / tauT));
  }
  filterBuffer(ticks, 'bandpass', 5000, 1, sr);
  for (let i = 0; i < n; i++) y[i] += ticks[i];
  const fr = freqOf(c, 1);
  addTone(y, fr, c.teeth, 0.25 * c.whine, sr, c.rng.next());
  return y;
}

function renderTurbine(c: Ctx): Buf {
  const { n, sr } = c;
  const blades = Math.round(c.blades);
  const wob = scaled(wander(n, sr, 3, c.rng.fork('wobble')), 0.004 * (0.3 + c.roughness));
  const fbp = freqOf(c, blades, wob);
  const y = new Float64Array(n);
  // Blade whine of the fan and of a second, faster spool, with shaft-rate sidebands from blade-to-blade differences.
  const tone = new Float64Array(n);
  addTone(tone, fbp, 1, 1, sr, c.rng.next());
  addTone(tone, fbp, 2, 0.25, sr, c.rng.next());
  addTone(tone, fbp, 1.37, 0.45, sr, c.rng.next());
  addTone(tone, fbp, 2.74, 0.12, sr, c.rng.next());
  let ph = 0;
  for (let i = 0; i < n; i++) {
    y[i] += c.whine * 0.5 * tone[i] * (1 + 0.15 * (0.3 + c.roughness) * Math.sin(TAU * ph));
    ph += fbp[i] / blades / sr;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  // Buzz-saw under load: every blade's shock a little different, so all the shaft harmonics come up.
  const bladeRng = c.rng.fork('blades');
  const bladeGain = Array.from({ length: blades }, () => 1 + 0.6 * clamp(bladeRng.gauss(), -1.5, 1.5));
  const buzz = new Float64Array(n);
  eventTimes(fbp, sr, 0).forEach((at, k) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(at)));
    const l = c.load[i];
    if (l < 0.05) return;
    const interval = sr / Math.max(fbp[i], 1);
    if (interval < 4) return;
    const wdt = Math.max(3, 0.35 * interval);
    const g = bladeGain[k % blades] * l * l;
    stamp(buzz, at, wdt, (tau) => g * Math.sin((Math.PI * tau) / wdt) ** 2);
  });
  filterBuffer(buzz, 'highpass', 250, 0.7, sr);
  // Jet roar, fan hiss and combustion rumble.
  const roar = noise('white', n, sr, c.rng.fork('roar'));
  filterBuffer(roar, 'bandpass', c.load.map((l) => (300 + 1700 * l) / c.size), 0.5, sr);
  const hiss = noise('white', n, sr, c.rng.fork('hiss'));
  filterBuffer(hiss, 'highpass', Math.min(3500 / c.size, 0.4 * sr), 0.7, sr);
  const rumble = noise('brown', n, sr, c.rng.fork('rumble'));
  filterBuffer(rumble, 'lowpass', 150 / c.size, 0.7, sr);
  const gust = wander(n, sr, 2, c.rng.fork('gust'));
  for (let i = 0; i < n; i++) {
    const l = c.load[i];
    const turb = 1 + 0.15 * gust[i];
    y[i] += 0.5 * buzz[i] + turb * (0.35 * (0.3 + 0.45 * l) * roar[i] + 0.05 * (0.5 + l) * hiss[i] + 0.35 * l * rumble[i]);
  }
  return y;
}

function renderRotor(c: Ctx): Buf {
  const { n, sr } = c;
  const blades = Math.round(c.blades);
  const rough = c.roughness;
  const sz = Math.sqrt(c.size);
  const fb = freqOf(c, blades);
  const bladeRng = c.rng.fork('blades');
  // The first blade slaps hardest; the others are a little off.
  const bladeGain = Array.from({ length: blades }, (_, k) => (k === 0 ? 1 : 1 - (0.12 + 0.2 * rough) * Math.abs(bladeRng.gauss())));
  const slapEnv = new Float64Array(n);
  const thump = new Float64Array(n);
  const ev = c.rng.fork('slaps');
  const fHi = 150 / c.size;
  const fLo = 72 / c.size;
  eventTimes(fb, sr, 0.999).forEach((at, k) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(at)));
    const l = c.load[i];
    const rate = Math.max(fb[i], 0.1);
    const interval = sr / rate;
    const amp = clamp(bladeGain[k % blades] * (1 + 0.12 * rough * ev.gauss()), 0.1, 2) * (0.7 + 0.5 * l);
    const pos = at + 0.02 * rough * clamp(ev.gauss(), -2.5, 2.5) * interval;
    const tauS = Math.min(0.016, 0.22 / rate) * sz * sr;
    const att = 0.0004 * sr;
    stamp(slapEnv, pos, 6 * tauS, (tau) => amp * Math.min(1, tau / att) * Math.exp(-tau / tauS));
    const tauP = 0.012 * sr;
    const tauA = Math.min(0.03, 0.35 / rate) * sr;
    stamp(thump, pos, 5 * tauA, (tau) => {
      const phs = TAU * (fLo * tau + (fHi - fLo) * tauP * (1 - Math.exp(-tau / tauP))) / sr;
      return 0.8 * amp * Math.min(1, tau / att) * Math.exp(-tau / tauA) * Math.sin(phs);
    });
  });
  const slap = noise('white', n, sr, c.rng.fork('slap'));
  for (let i = 0; i < n; i++) slap[i] *= slapEnv[i];
  filterBuffer(slap, 'bandpass', c.load.map((l) => (450 + 600 * l) / c.size), 0.6, sr);
  // Downwash: rough low air, puffed by each blade.
  const air = noise('white', n, sr, c.rng.fork('air'));
  filterBuffer(air, 'lowpass', 650 / c.size, 0.6, sr);
  const y = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const chop = 0.55 + 0.45 * Math.cos(TAU * ph);
    y[i] = 1.3 * slap[i] + thump[i] + 0.3 * air[i] * chop * chop;
    ph += fb[i] / sr;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  const fr = freqOf(c, 1);
  addTone(y, fr, c.teeth, 0.12 * c.whine, sr, c.rng.next());
  addTone(y, fr, 2 * c.teeth, 0.05 * c.whine, sr, c.rng.next());
  return y;
}

const RENDER: Record<Kind, (c: Ctx) => Buf> = {
  motor: renderMotor,
  servo: renderServo,
  drill: renderDrill,
  engine: renderEngine,
  turbine: renderTurbine,
  rotor: renderRotor,
};

function contextOf(p: Record<string, unknown>, ctx: VoiceContext, kind: Kind): Ctx {
  const d = KIND_DEFAULTS[kind];
  const or = (name: string, fallback: number) => (p[name] ?? fallback) as ParamValue;
  return {
    n: ctx.n,
    sr: ctx.sr,
    rng: ctx.rng.fork('machine', kind),
    rpm: ctx.signal('rpm', or('rpm', d.rpm)),
    load: ctx.signal('load'),
    roughness: ctx.num('roughness'),
    whine: ctx.num('whine', or('whine', d.whine)),
    teeth: ctx.num('teeth', or('teeth', d.teeth)),
    cylinders: ctx.num('cylinders'),
    blades: ctx.num('blades', or('blades', d.blades)),
    size: ctx.num('size'),
  };
}

/** Rotating machinery driven by rpm: motors, servos, drills, engines, turbines and rotors. */
export const machine: SourceDef = {
  kind: 'source',
  type: 'machine',
  label: 'Machine',
  category: 'machine',
  doc:
    'Rotating machinery driven by `rpm`: pick the `kind` (motor, servo, drill, engine, turbine, rotor) and move ' +
    '`rpm` with breakpoints so it spins up, holds, strains and winds down; every tone, pulse and chop follows it. ' +
    '`load` is the strain (rougher, brighter, louder), `roughness` how uneven it is, `whine` its gear whine. For a ' +
    'helicopter, layer the main rotor with a second, small, fast rotor for the tail (4 blades, about 1000 rpm, size ' +
    '0.4) and a quiet turbine; for a car pass-by, put an engine through doppler.',
  defaultEnv: { attack: 0.05, hold: 1, decay: 0.6 },
  params: PARAMS,
  example: {
    type: 'machine',
    kind: 'servo',
    rpm: [[0, 3000], [0.08, 11000], [0.45, 11000], [0.6, 6000]],
    load: [[0, 0.2], [0.4, 0.3], [0.55, 0.9]],
    env: { attack: 0.01, hold: 0.5, decay: 0.15 },
  },
  render(p, ctx) {
    const kind = (KINDS.includes(p.kind as Kind) ? p.kind : 'motor') as Kind;
    const c = contextOf(p, ctx, kind);
    const y = RENDER[kind](c);
    scaled(y, KIND_DEFAULTS[kind].gain);
    for (let i = 0; i < y.length; i++) if (!Number.isFinite(y[i])) y[i] = 0;
    return dcBlock(y, ctx.sr);
  },
};
