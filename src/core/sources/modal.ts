import type { ParamMap, SourceDef } from '../nodes';
import type { ParamValue } from '../format/types';
import { constantOf } from '../params';
import { clamp, peak, TAU, type Buf } from '../dsp/math';
import { wander } from '../dsp/noise';
import { Rng, hashString } from '../dsp/rng';
import { buildModes, materialOf, modeDecayFactor, MODAL_MATERIALS, MODAL_SHAPES, type ModalShape } from '../dsp/modes';

const LN1000 = Math.log(1000);

const EXCITER_KINDS = ['impulse', 'mallet', 'noise', 'scrape', 'roll'] as const;
type ExciterKind = (typeof EXCITER_KINDS)[number];

const EXCITER_FIELDS: ParamMap = {
  kind: {
    kind: 'enum',
    doc:
      'What sets the object ringing. impulse: an ideal click that drives every mode (the brightest, cleanest strike). ' +
      'mallet: a blow with a contact time set by `hardness` (felt to steel). noise: a rough, crumbling hit that fades ' +
      'over `duration`. scrape: dragged across ridges or grit for `duration` (`density` ridges per second, ' +
      '`roughness` regular comb to random grit). roll: rolling or rattling for `duration` (`density` bumps per second, ' +
      'with the wobble of a turning object).',
    options: EXCITER_KINDS,
    default: 'mallet',
  },
  hardness: {
    kind: 'number',
    doc:
      'How hard the contact is: 0 a soft felt or rubber beater (long contact, only the lowest modes: a thud or a ' +
      'pure boom), 0.5 wood or a knuckle, 1 steel on steel (every mode: a bright clank). For noise, scrape and roll it is the brightness ' +
      'of the friction. Louder events (`vel`) hit a little harder.',
    default: 0.6,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  duration: {
    kind: 'number',
    doc: 'Seconds the noise fades over, or the scrape or roll lasts. The ring follows it. Ignored by impulse and mallet.',
    default: 0.4,
    min: 0.01,
    max: 4,
    hardMin: 0.001,
    hardMax: 30,
    unit: 's',
    scale: 'log',
  },
  density: {
    kind: 'signal',
    doc:
      'Ridges (scrape) or bumps (roll) per second: the speed of the motion. 20 to 80 is a slow ratchet or a heavy ' +
      'ball, 200 to 2000 a fast drag. Breakpoints speed it up or slow it to a stop.',
    default: 120,
    min: 5,
    max: 3000,
    hardMin: 0.5,
    hardMax: 20000,
    unit: 'Hz',
    scale: 'log',
  },
  roughness: {
    kind: 'number',
    doc:
      'Scrape: 0 evenly spaced ridges (a comb, a zip, a guiro: a buzzing pitch at `density`), 1 random grit with ' +
      'hiss. Roll: how uneven the bumps are and how much surface rumble there is.',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
};

const PARAMS: ParamMap = {
  material: {
    kind: 'enum',
    doc:
      'What it is made of: sets how fast high modes die and the default `decay`. metal rings long and bright (2.5 s), ' +
      'glass clear (1.2 s), ceramic a shorter clink (0.6 s), stone a hard click (0.14 s), wood a warm knock (0.25 s), ' +
      'plastic a dull tap (0.12 s), skin a drum head (0.5 s), rubber and cardboard dead thumps (0.08 s).',
    options: MODAL_MATERIALS,
    default: 'metal',
  },
  shape: {
    kind: 'enum',
    doc:
      'What the object is, which sets the spacing of its modes. bar: a free bar or rod, wide inharmonic gaps (1, 2.76, ' +
      '5.4: chimes, xylophone, pipe, wrench). tine: a bar held at one end (1, 6.27, 17.5: a thin ping with a high ' +
      'clang: fork, tongue, ruler). plate: a sheet, dense clangour (sheet metal, pan lid, sign, glass pane). membrane: a ' +
      'stretched skin (drums; struck in the centre it is a pitchless thud). bell: church-bell partials with the minor ' +
      'third; `freq` is the hum, the heard note is an octave above. bowl: rim modes (1, 2.83, 5.4: wine glass, cup, ' +
      'bowl, hoop). tube: the air in a pipe, odd harmonics (hollow: bottle, bamboo, slapped pipe). string: harmonics ' +
      '(wire, cable, spring; a tonal clang). box: an enclosed cavity, crowded low modes (crate, cabinet, drawer, ' +
      'body thump). random: an irregular lump with its own modes for each `variant` (rock, junk, debris).',
    options: MODAL_SHAPES,
    default: 'bar',
  },
  freq: {
    kind: 'signal',
    doc:
      'Frequency of the lowest mode: the size of the object. 60 to 150 a drum, tank or door; 200 to 600 a pan, ' +
      'bottle or plank; 800 to 3000 a glass, key or coin; above that tiny things. Breakpoints bend every mode ' +
      'together (a wobbling sheet, a filling glass).',
    default: 440,
    min: 30,
    max: 8000,
    hardMin: 5,
    hardMax: 20000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  decay: {
    kind: 'number',
    doc:
      'Seconds for the lowest mode to fall 60 dB. Left out, the material chooses (see `material`). Shorter is a ' +
      'damped, held or lying object; longer one hanging free.',
    min: 0.02,
    max: 8,
    hardMin: 0.001,
    hardMax: 60,
    unit: 's',
    scale: 'log',
  },
  damping: {
    kind: 'number',
    doc:
      'How much faster high modes die than the lowest, times the material\'s own loss: 0 all ring equally long ' +
      '(unnaturally pure), 1 the material itself, 2 to 4 a damp, cracked, wet or hand-held object whose ring dulls ' +
      'at once.',
    default: 1,
    min: 0,
    max: 4,
    hardMin: 0,
    hardMax: 20,
    unit: 'x',
  },
  brightness: {
    kind: 'number',
    doc:
      'Tilt of the mode levels: 0.5 is the material\'s own balance, 0 leaves little but the lowest mode (dark, ' +
      'heavy, thick), 1 makes high modes as loud as low ones (thin, splashy, brittle).',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  modes: {
    kind: 'number',
    doc: 'How many modes ring. 4 to 8 is a simple, pure object; 16 to 32 a realistic one; 48+ dense clangour (plates, crashes).',
    default: 24,
    min: 1,
    max: 64,
    step: 1,
    hardMin: 1,
    hardMax: 96,
  },
  stretch: {
    kind: 'number',
    doc:
      'Bends the spacing of the modes: each ratio is raised to this power. 1 is the shape\'s physics; below 1 crowds ' +
      'the modes together (thicker, heavier, more clustered); above 1 spreads them (thinner, glassier). On `string` ' +
      '1.02 to 1.1 is a stiff wire, like a piano\'s.',
    default: 1,
    min: 0.6,
    max: 1.5,
    hardMin: 0.25,
    hardMax: 3,
  },
  dent: {
    kind: 'number',
    doc:
      'Damage: detunes each mode at random and unevens their levels and decays. 0 a perfect object, 0.1 to 0.3 ' +
      'hand-made or worn, 0.5 to 1 dented, cracked, bent junk. `variant` picks the pattern.',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 2,
  },
  position: {
    kind: 'number',
    doc:
      'Where it is struck: 0 the centre (few modes, round and hollow), 1 the edge or end (every mode, bright and ' +
      'clangy). For `tine` 0 is the held end and 1 the tip; for `box` 0 is the middle and 1 a corner.',
    default: 0.4,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  beat: {
    kind: 'number',
    doc:
      'Splits every mode into a detuned pair that beats, as in bells, gongs, bowls and anything not quite round. ' +
      'Hz of the slowest wobble: 0 off, 0.5 to 3 a slow shimmer, 5 to 15 a fast flutter, 30+ rough.',
    default: 0,
    min: 0,
    max: 20,
    hardMin: 0,
    hardMax: 200,
    unit: 'Hz',
  },
  variant: {
    kind: 'number',
    doc:
      'Which object: picks the `dent` pattern and the modes of the `random` shape. The same number is the same ' +
      'object in every event and every take, so repeats sound like one thing being hit again.',
    default: 1,
    min: 1,
    max: 99,
    hardMin: 0,
    hardMax: 1000000,
    step: 1,
    advanced: true,
  },
  exciter: {
    kind: 'object',
    doc: 'What sets it ringing: { kind, hardness, duration, density, roughness }.',
    fields: EXCITER_FIELDS,
  },
};

function field(obj: unknown, name: string): ParamValue | undefined {
  return obj && typeof obj === 'object' ? ((obj as Record<string, unknown>)[name] as ParamValue | undefined) : undefined;
}

function exciterKind(p: Record<string, unknown>): ExciterKind {
  const k = field(p.exciter, 'kind') as unknown;
  return EXCITER_KINDS.includes(k as ExciterKind) ? (k as ExciterKind) : 'mallet';
}

const isContinuous = (k: ExciterKind) => k === 'noise' || k === 'scrape' || k === 'roll';

/** Two one-pole low-passes in series, in place: the softness of a contact. */
function soften(x: Buf, end: number, cutoff: number, sr: number): void {
  const a = Math.exp((-TAU * clamp(cutoff, 20, sr * 0.49)) / sr);
  const b = 1 - a;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < end; i++) {
    y1 = b * x[i] + a * y1;
    y2 = b * y1 + a * y2;
    x[i] = y2;
  }
}

export interface ExciterSettings {
  kind: ExciterKind;
  hardness: number;
  /** Hz of the object's lowest mode: a soft mallet is soft relative to it. */
  fundamental: number;
  duration: number;
  /** Per-sample events per second (scrape and roll). */
  density: Buf | null;
  roughness: number;
}

/** The force on the object over time. Returns the buffer and the sample at which the force stops. */
export function renderExciter(e: ExciterSettings, n: number, sr: number, rng: Rng): { x: Buf; end: number } {
  const x = new Float64Array(n);
  const h = clamp(e.hardness, 0, 1);
  if (e.kind === 'impulse') {
    x[0] = 1;
    return { x, end: 1 };
  }
  if (e.kind === 'mallet') {
    // A bell-shaped pulse of force. Its spectrum is a bell curve too, with no nulls, falling 6 dB by `reach`: from
    // just above the lowest mode (a soft beater on this object, whatever its size) to the top of the band.
    const base = 1.5 * clamp(e.fundamental, 20, sr / 4);
    const reach = base * Math.pow((0.6 * sr) / base, h);
    const sigma = (0.1874 * sr) / reach; // samples; sqrt(ln 4) / (2 pi) = 0.1874
    const len = Math.ceil(sigma * 6);
    if (len <= 2) {
      x[0] = 1;
      return { x, end: 1 };
    }
    const m = Math.min(len, n);
    for (let i = 0; i < m; i++) {
      const d = (i - 0.5 * (len - 1)) / sigma;
      x[i] = Math.exp(-0.5 * d * d);
    }
    return { x, end: m };
  }
  const end = Math.min(n, Math.max(1, Math.round(e.duration * sr)));
  if (e.kind === 'noise') {
    const k = LN1000 / (e.duration * sr);
    for (let i = 0; i < end; i++) x[i] = rng.gauss() * Math.exp(-k * i);
    soften(x, end, 300 * Math.pow(60, h), sr);
    return { x, end };
  }
  const rough = clamp(e.roughness, 0, 1);
  const dens = e.density;
  const pressure = wander(end, sr, 5, rng.fork('pressure'));
  let acc = 0;
  let next = 0; // the first contact is at the very start, so even the shortest scrape touches the object
  let turn = rng.next();
  for (let i = 0; i < end; i++) {
    const rate = dens ? dens[i] : 120;
    const perSample = rate / sr;
    acc += perSample;
    if (e.kind === 'scrape') {
      // Ridges: evenly spaced when smooth, scattered when rough, with a hiss of grit between them.
      while (acc >= next) {
        const amp = 1 - 0.7 * rough * rng.next();
        x[i] += rng.next() < 0.5 * rough ? -amp : amp;
        next += 1 - rough + rough * rng.exponential(1);
      }
      x[i] += rng.gauss() * 0.5 * rough * Math.sqrt(Math.min(perSample, 1));
      x[i] *= Math.max(0.2, 1 + 0.5 * rough * pressure[i]);
    } else {
      // Rolling: random bumps whose strength swells once a turn, over a low rumble of the surface.
      turn += perSample / 8;
      while (acc >= next) {
        x[i] += (1 - 0.8 * rough * rng.next()) * (1 + 0.7 * Math.sin(TAU * turn));
        next += rng.exponential(1);
      }
      x[i] += rng.gauss() * 0.25 * rough * Math.sqrt(Math.min(perSample, 1));
    }
  }
  soften(x, end, e.kind === 'scrape' ? 500 * Math.pow(40, h) : 150 * Math.pow(80, h), sr);
  const fadeIn = Math.min(Math.round(0.005 * sr), end >> 2);
  const fadeOut = Math.min(Math.round(0.02 * sr), end >> 2);
  for (let i = 0; i < fadeIn; i++) x[i] *= (i + 1) / (fadeIn + 1);
  for (let i = 0; i < fadeOut; i++) x[end - 1 - i] *= (i + 1) / (fadeOut + 1);
  return { x, end };
}

export interface Mode {
  /** Frequency over the fundamental's. */
  ratio: number;
  amp: number;
  /** Seconds to fall 60 dB. */
  t60: number;
  /** Hz to move this mode by, whatever the fundamental: one half of a beating pair. */
  split?: number;
}

/**
 * Runs an excitation through a bank of resonators, one per mode, and returns their sum. Each resonator is a
 * rotating complex number (so bending `freq` mid-ring never changes its amplitude), read as a band-pass with no
 * response at DC. A mode stops being computed once it has rung out after the excitation ends.
 */
export function resonate(x: Buf, exciteEnd: number, modes: Mode[], freq: Buf, sr: number): Buf {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let lo = Infinity;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (freq[i] < lo) lo = freq[i];
    if (freq[i] > hi) hi = freq[i];
  }
  const steady = hi - lo <= 1e-9 * hi;
  const top = 0.47 * sr;
  const BLOCK = 16;
  for (const m of modes) {
    if (!(m.amp !== 0) || lo * m.ratio >= top) continue;
    const r = Math.exp(-LN1000 / (Math.max(m.t60, 1e-4) * sr));
    const stop = Math.min(n, exciteEnd + Math.ceil(m.t60 * 1.35 * sr) + 2);
    let re = 0;
    let im = 0;
    if (steady) {
      const w = (TAU * freq[0] * m.ratio) / sr;
      const cr = r * Math.cos(w);
      const ci = r * Math.sin(w);
      const g = m.amp / w;
      for (let i = 0; i < stop; i++) {
        const t = cr * re - ci * im + x[i];
        im = ci * re + cr * im;
        re = t;
        out[i] += g * im;
      }
    } else {
      for (let i0 = 0; i0 < stop; i0 += BLOCK) {
        const f = freq[i0] * m.ratio;
        const w = (TAU * Math.min(f, top)) / sr;
        const cr = r * Math.cos(w);
        const ci = r * Math.sin(w);
        // A mode bent above the top of the band goes quiet instead of aliasing.
        const g = f >= top ? 0 : m.amp / w;
        const i1 = Math.min(stop, i0 + BLOCK);
        for (let i = i0; i < i1; i++) {
          const t = cr * re - ci * im + x[i];
          im = ci * re + cr * im;
          re = t;
          out[i] += g * im;
        }
      }
    }
  }
  // Each mode above is sin-phase with a gain of 1/w; the difference turns it into a band-pass ringing at `amp`.
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const s = out[i];
    out[i] = s - prev;
    prev = s;
  }
  return out;
}

export interface ObjectSettings {
  shape: ModalShape;
  material: unknown;
  count: number;
  /** T60 of the lowest mode, seconds. */
  decay: number;
  damping: number;
  /** 0..1, 0.5 the material's own. */
  brightness: number;
  stretch: number;
  dent: number;
  position: number;
  /** Hz, 0 for none. */
  beat: number;
}

/**
 * The modes of an object. `objectRng` decides what the object is (dents, random shapes, how each pair beats) and
 * must be the same for every strike on it; `strikeRng`, if given, varies each strike slightly, as no two real
 * hits land alike.
 */
export function objectModes(o: ObjectSettings, objectRng: Rng, strikeRng?: Rng): Mode[] {
  const mat = materialOf(o.material);
  const position = clamp(o.position + (strikeRng ? strikeRng.uniform(-0.03, 0.03) : 0), 0, 1);
  const { ratio, weight } = buildModes(o.shape, o.count, position, objectRng.fork('shape'));
  const tilt = mat.tilt + (clamp(o.brightness, 0, 1) - 0.5) * 18; // dB per octave
  const dentRng = objectRng.fork('dent');
  const beatRng = objectRng.fork('beat');
  const modes: Mode[] = [];
  for (let k = 0; k < ratio.length; k++) {
    let r = Math.pow(ratio[k], o.stretch);
    let amp = weight[k];
    let t60 = o.decay * modeDecayFactor(mat, r, o.damping);
    // Always draw, so that turning `dent` up bends the same object further instead of making another.
    const g1 = clamp(dentRng.gauss(), -2, 2);
    const g2 = clamp(dentRng.gauss(), -2, 2);
    const u = dentRng.next();
    if (o.dent > 0) {
      r *= Math.pow(2, (o.dent * 3 * g1 * (k === 0 ? 0.3 : 1)) / 12);
      amp *= Math.pow(10, (o.dent * 6 * g2) / 20);
      t60 *= Math.pow(2, -o.dent * 1.5 * u);
    }
    amp *= Math.pow(r, tilt / 6.0206);
    if (strikeRng) amp *= Math.pow(10, strikeRng.uniform(-1.5, 1.5) / 20);
    const b1 = beatRng.uniform(0.7, 1.3);
    const b2 = beatRng.uniform(0.5, 0.95);
    if (o.beat > 0) {
      // A doublet: the two halves of a mode that a perfectly round object would have at one frequency.
      const split = (o.beat * b1 * Math.sqrt(r)) / 2;
      modes.push({ ratio: r, amp, t60, split: -split });
      modes.push({ ratio: r, amp: amp * b2, t60, split });
    } else {
      modes.push({ ratio: r, amp, t60 });
    }
  }
  return modes;
}

/** Struck, scraped and rolled resonant objects. */
export const modal: SourceDef = {
  kind: 'source',
  type: 'modal',
  label: 'Modal object',
  category: 'physical',
  doc:
    'A resonant solid object, described by what it is: a `material` (how it loses its ring), a `shape` (which ' +
    'modes it has), a size (`freq`) and what sets it off (`exciter`: a strike, a noisy hit, a scrape or a roll). ' +
    'Reach for it for anything hit, dropped, knocked, clinked, dragged or rolled: pans, bottles, planks, bells, ' +
    'drums, coins, doors, pipes, rocks. It replaces the usual "sine thump plus a few decaying partials" with the ' +
    'real mode pattern of the object, so a metal bar, a wine glass and a wooden box differ the way they do in life. ' +
    'Make it broken with `dent`, shimmering with `beat`, held or wet with `damping`; change `position` and ' +
    '`exciter.hardness` for a different hit on the same thing. The ring is the envelope: leave `env` alone and set ' +
    '`decay`. An event\'s `dur` damps it like a hand.',
  defaultEnv: { attack: 0, sustain: 1, release: 0.04 },
  params: PARAMS,
  example: {
    type: 'modal',
    material: 'metal',
    shape: 'plate',
    freq: 310,
    decay: 1.4,
    dent: 0.5,
    modes: 40,
    position: 0.8,
    exciter: { kind: 'mallet', hardness: 0.85 },
  },
  naturalLength(p) {
    const decay = constantOf((p.decay as ParamValue | undefined) ?? materialOf(p.material).decay, PARAMS.decay);
    const kind = exciterKind(p);
    const dur = isContinuous(kind) ? constantOf(field(p.exciter, 'duration'), EXCITER_FIELDS.duration) : 0.005;
    return decay + dur + 0.01;
  },
  render(p, ctx) {
    const { sr, n } = ctx;
    const mat = materialOf(p.material);
    const shape = (MODAL_SHAPES as readonly string[]).includes(p.shape as string) ? (p.shape as ModalShape) : 'bar';
    const kind = exciterKind(p);
    const freq = ctx.signal('freq');
    const limit = 0.45 * sr;
    for (let i = 0; i < n; i++) if (freq[i] > limit) freq[i] = limit;

    const objectRng = new Rng(hashString('modal-object', Math.round(ctx.num('variant')) >>> 0));
    const modes = objectModes(
      {
        shape,
        material: p.material,
        count: Math.round(ctx.num('modes')),
        decay: ctx.num('decay', (p.decay as ParamValue | undefined) ?? mat.decay),
        damping: ctx.num('damping'),
        brightness: ctx.num('brightness'),
        stretch: ctx.num('stretch'),
        dent: ctx.num('dent'),
        position: ctx.num('position'),
        beat: ctx.num('beat'),
      },
      objectRng,
      ctx.rng.fork('strike'),
    );
    // Beating pairs sit a fixed number of Hz apart; turn that into ratios of the starting frequency.
    const f0 = Math.max(freq[0], 1);
    for (const m of modes) {
      if (m.split) m.ratio = Math.max(m.ratio + m.split / f0, 0.05);
    }

    // A louder event lands harder: brighter as well as louder.
    const hardness = clamp(ctx.numOf(field(p.exciter, 'hardness'), EXCITER_FIELDS.hardness) + 0.15 * Math.log2(Math.max(ctx.vel, 0.01)), 0, 1);
    const continuous = isContinuous(kind);
    const { x, end } = renderExciter(
      {
        kind,
        hardness,
        fundamental: f0,
        duration: ctx.numOf(field(p.exciter, 'duration'), EXCITER_FIELDS.duration),
        density: kind === 'scrape' || kind === 'roll' ? ctx.signalOf(field(p.exciter, 'density'), EXCITER_FIELDS.density, 'exciter.density') : null,
        roughness: ctx.numOf(field(p.exciter, 'roughness'), EXCITER_FIELDS.roughness),
      },
      n,
      sr,
      ctx.rng.fork('exciter'),
    );
    const out = resonate(x, end, modes, freq, sr);
    // Level by the ring, not by the instant of contact: a hard blow starts every mode at once, a spike a few
    // samples wide that would otherwise set the level and leave a bright clank far quieter than a soft thud.
    // The spike is kept, rounded off where it passes full scale.
    const ringFrom = continuous ? 0 : Math.min(n, end + Math.round(0.002 * sr));
    const whole = peak(out);
    let ring = 0;
    for (let i = ringFrom; i < n; i++) {
      const a = out[i] < 0 ? -out[i] : out[i];
      if (a > ring) ring = a;
    }
    const ref = Math.max(ring, 0.25 * whole);
    if (ref > 1e-12) {
      const g = 1 / ref;
      for (let i = 0; i < n; i++) out[i] *= g;
      for (let i = 0; i < ringFrom; i++) {
        const a = Math.abs(out[i]);
        if (a > 0.8) out[i] = Math.sign(out[i]) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
      }
    }
    return out;
  },
};
