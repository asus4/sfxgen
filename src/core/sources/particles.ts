import type { ParamMap, SourceDef } from '../nodes';
import type { ParamValue } from '../format/types';
import { constantOf } from '../params';
import { clamp, TAU, type Buf } from '../dsp/math';
import type { Rng } from '../dsp/rng';
import { buildModes, materialOf, modeDecayFactor, MODAL_MATERIALS, MODAL_SHAPES, type ModalShape } from '../dsp/modes';

const LN1000 = Math.log(1000);
const MAX_GRAINS = 20000;
/** Grain samples one event may compute; past it, grains are cut short rather than the render stalling. */
const WORK_BUDGET = 12e6;

const DISTRIBUTIONS = ['random', 'regular', 'burst', 'bounce'] as const;
type Distribution = (typeof DISTRIBUTIONS)[number];

const GRAIN_KINDS = ['tick', 'click', 'ping', 'drop', 'chirp', 'crackle', 'modal', 'grain'] as const;
type GrainKind = (typeof GRAIN_KINDS)[number];

const GRAIN_FIELDS: ParamMap = {
  kind: {
    kind: 'enum',
    doc:
      'What one particle sounds like. tick: a tiny burst of noise around its frequency (gravel, sand, rain on ' +
      'leaves, hail, rustle). click: a bare broadband click, brighter with frequency (Geiger counter, relay, vinyl, ' +
      'static, ratchet). ping: a small pure ring (glass dust, tinkles, droplets on metal). drop: a water drop or ' +
      'bubble, a ring whose pitch rises (rain on water, pouring, boiling, fizz). chirp: a quick sweep by `sweep` ' +
      'octaves (sparks, zaps, birds, insects). crackle: a sharp pop with a ragged tail and wildly uneven levels ' +
      '(fire, embers, frying, ice, static). modal: a small struck object of `material` and `shape` (coins, shards, ' +
      'pebbles, nails, wood chips, shells). grain: a smooth window of tone or noise (`tone`) for granular clouds, ' +
      'shimmer and swarms.',
    options: GRAIN_KINDS,
    default: 'tick',
  },
  lo: {
    kind: 'signal',
    doc:
      'Lowest frequency a particle may have; each draws its own between `lo` and `hi`, evenly by ratio. The pair ' +
      'is the size range of the pieces. Breakpoints move the range over the event (bubbles rising, debris getting ' +
      'finer).',
    default: 800,
    min: 40,
    max: 12000,
    hardMin: 10,
    hardMax: 20000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  hi: {
    kind: 'signal',
    doc: 'Highest frequency a particle may have. Equal to `lo`, every particle has the same pitch.',
    default: 6000,
    min: 40,
    max: 16000,
    hardMin: 10,
    hardMax: 20000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  decayLo: {
    kind: 'number',
    doc:
      'Shortest ring of a particle (seconds to fall 60 dB; for `grain` the length of the window). 0.002 to 0.01 dry ' +
      'ticks, 0.03 to 0.15 small ringing things, 0.3+ glass and metal. Ignored by click.',
    default: 0.004,
    min: 0.001,
    max: 1,
    hardMin: 0.0003,
    hardMax: 5,
    unit: 's',
    scale: 'log',
  },
  decayHi: {
    kind: 'number',
    doc: 'Longest ring of a particle, seconds.',
    default: 0.03,
    min: 0.001,
    max: 2,
    hardMin: 0.0003,
    hardMax: 5,
    unit: 's',
    scale: 'log',
  },
  levelJitter: {
    kind: 'number',
    doc: 'How far below full level a particle may be, dB: 0 all equal (mechanical), 12 natural, 30 a few loud ones over a quiet bed.',
    default: 12,
    min: 0,
    max: 40,
    hardMin: 0,
    hardMax: 80,
    unit: 'dB',
  },
  pitchJitter: {
    kind: 'number',
    doc: 'Random detune of each particle on top of its place in the range, semitones. With `lo` = `hi` or `bounce` it is the only pitch variation.',
    default: 0,
    min: 0,
    max: 12,
    hardMin: 0,
    hardMax: 48,
    unit: 'st',
  },
  size: {
    kind: 'number',
    doc:
      'Ties pitch, level and ring together as size does: at 1 the low particles are the loud, long-ringing ones ' +
      '(big pieces) and the high ones faint and short; at 0 the three vary independently.',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  material: {
    kind: 'enum',
    doc: 'For kind modal: what the pieces are made of (see the modal source).',
    options: MODAL_MATERIALS,
    default: 'glass',
  },
  shape: {
    kind: 'enum',
    doc: 'For kind modal: the shape of the pieces. plate for shards and coins, bar for nails and sticks, random for rubble.',
    options: MODAL_SHAPES,
    default: 'plate',
  },
  tone: {
    kind: 'number',
    doc: 'For kind grain: 0 a puff of band noise, 1 a pure tone, between a breathy tone.',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  sweep: {
    kind: 'number',
    doc: 'For kind chirp: octaves the pitch moves over the particle. -2 a falling zap or spark, +1 a rising blip or chirrup.',
    default: -2,
    min: -4,
    max: 4,
    hardMin: -8,
    hardMax: 8,
  },
};

const PARAMS: ParamMap = {
  density: {
    kind: 'signal',
    doc:
      'Particles per second. 2 to 10 scattered drips and clicks, 20 to 100 a patter, 200 to 1000 a shower or sizzle, ' +
      '3000+ a hiss. Breakpoints over the event build or thin it: [[0, 5], [2, 400]] is rain setting in. For burst ' +
      'it is the rate at the first instant and thins as exp(-5 t / duration), so a burst emits about density x duration / 5 ' +
      'grains. Ignored by bounce.',
    default: 40,
    min: 0.5,
    max: 2000,
    hardMin: 0.01,
    hardMax: 20000,
    unit: 'Hz',
    scale: 'log',
  },
  duration: {
    kind: 'number',
    doc: 'Seconds over which particles are emitted (an event\'s `dur` ends it sooner). The last ones ring past it.',
    default: 1,
    min: 0.05,
    max: 10,
    hardMin: 0.001,
    hardMax: 60,
    unit: 's',
    scale: 'log',
  },
  distribution: {
    kind: 'enum',
    doc:
      'How particles fall in time. random: independent, like rain or a Geiger counter. regular: evenly spaced, ' +
      'loosened by `jitter` (ratchet, gear, card in spokes, dripping tap). burst: densest at the first instant and ' +
      'thinning to nothing by the end, the pieces getting quieter (debris after an impact, a spill, a shatter). ' +
      'bounce: one object bouncing to rest, each gap `ratio` times the last, starting at `interval` (ball, coin, ' +
      'dropped lid; every bounce is the same piece, softer each time).',
    options: DISTRIBUTIONS,
    default: 'random',
  },
  jitter: {
    kind: 'number',
    doc: 'Irregularity of regular spacing (0 a machine, 0.3 a hand, 1 nearly random) and of bounce gaps (a wobbling, spinning coin).',
    default: 0.1,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  interval: {
    kind: 'number',
    doc: 'Bounce: seconds between the first and second impact. 0.5 a ball from waist height, 0.15 a coin or bottle cap from a few centimetres.',
    default: 0.3,
    min: 0.02,
    max: 1.5,
    hardMin: 0.002,
    hardMax: 10,
    unit: 's',
    scale: 'log',
  },
  ratio: {
    kind: 'number',
    doc: 'Bounce: each gap is the last times this. 0.5 a dead thing that stops in a few hops, 0.75 a hard ball, 0.9 a ping-pong ball rattling to a buzz.',
    default: 0.7,
    min: 0.3,
    max: 0.95,
    hardMin: 0.05,
    hardMax: 0.99,
  },
  spread: {
    kind: 'number',
    doc: 'Stereo scatter: 0 mono, 1 each particle anywhere between hard left and hard right (stereo output only).',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  grain: {
    kind: 'object',
    doc: 'One particle: { kind, lo, hi, decayLo, decayHi, levelJitter, pitchJitter, size, material, shape, tone, sweep }.',
    fields: GRAIN_FIELDS,
  },
};

function field(obj: unknown, name: string): ParamValue | undefined {
  return obj && typeof obj === 'object' ? ((obj as Record<string, unknown>)[name] as ParamValue | undefined) : undefined;
}

interface Emission {
  /** Sample at which each particle starts. */
  at: number[];
  /** Level of each from the distribution itself (bounces and bursts fade), 0..1. */
  level: number[];
}

/** When the particles happen. */
function emit(dist: Distribution, density: Buf, end: number, sr: number, rng: Rng, jitter: number, interval: number, ratio: number): Emission {
  const at: number[] = [];
  const level: number[] = [];
  if (dist === 'bounce') {
    // A bouncing object: each flight is `ratio` times the last, and it lands as much slower.
    let t = 0;
    let gap = interval;
    let lv = 1;
    while (t * sr < end && at.length < 2000) {
      at.push(Math.floor(t * sr));
      level.push(lv);
      if (gap < 0.0012) break;
      t += gap * (1 + 0.6 * jitter * rng.uniform(-0.5, 0.5));
      gap *= ratio;
      lv *= Math.pow(ratio, 0.7);
    }
    return { at, level };
  }
  let acc = 0;
  // Regular and burst clouds start with a particle at the very first instant: the impact, the first tooth.
  let next = dist === 'random' ? rng.exponential(1) : 0;
  const fall = 5 / Math.max(end, 1);
  for (let i = 0; i < end && at.length < MAX_GRAINS; i++) {
    const thin = dist === 'burst' ? Math.exp(-fall * i) : 1;
    acc += (density[i] * thin) / sr;
    while (acc >= next && at.length < MAX_GRAINS) {
      let when = i;
      if (dist === 'regular') {
        // Jitter may pull the first grain before 0: hold it at 0 rather than lose it (the pattern would start late).
        when = Math.max(0, Math.round(i + (jitter * rng.uniform(-0.5, 0.5) * sr) / Math.max(density[i], 0.01)));
        next += 1;
      } else {
        next += rng.exponential(1);
      }
      if (when >= 0 && when < end) {
        at.push(when);
        // The last of the debris is the small stuff: 9 dB down by the end.
        level.push(dist === 'burst' ? Math.pow(10, (-9 * (i / end)) / 20) : 1);
      }
    }
  }
  // A cloud too thin to hold a particle by chance still gets one, rather than rendering silence.
  if (at.length === 0) {
    at.push(Math.floor(rng.next() * end * 0.5));
    level.push(1);
  }
  return { at, level };
}

interface ModePrototype {
  ratio: Float64Array;
  amp: Float64Array;
  decay: Float64Array;
}

/** Clouds of small events: debris, rain, fire, sparks, coins, bubbles, clicks, granular textures. */
export const particles: SourceDef = {
  kind: 'source',
  type: 'particles',
  label: 'Particles',
  category: 'texture',
  doc:
    'A cloud of tiny separate sounds, each with its own pitch, level and ring: what filtered noise can only smear. ' +
    'Reach for it whenever a sound is really many small things: gravel and debris after an impact (`burst`), rain ' +
    'and hail (`random` ticks or drops), fire and frying (crackle), sparks (chirp), spilled coins or broken glass ' +
    '(modal grains), bubbles and pouring (drop), a Geiger counter or ratchet (click), a coin or ball bouncing to ' +
    'rest (`bounce`), or a shimmering granular cloud (grain). Describe the pieces in `grain` (how they sound, the ' +
    'range of their sizes) and how they fall with `density`, `duration` and `distribution`. The common `pitch` ' +
    'parameter shifts the whole range and may move. Layer it after a modal or noise impact for the aftermath.',
  defaultEnv: { attack: 0, sustain: 1, release: 0.05 },
  params: PARAMS,
  example: {
    type: 'particles',
    distribution: 'burst',
    density: 300,
    duration: 1.2,
    spread: 0.7,
    grain: { kind: 'modal', material: 'glass', shape: 'plate', lo: 1800, hi: 9000, decayLo: 0.02, decayHi: 0.25 },
  },
  naturalLength(p) {
    const duration = constantOf(p.duration as ParamValue | undefined, PARAMS.duration);
    const ring = Math.max(
      constantOf(field(p.grain, 'decayLo'), GRAIN_FIELDS.decayLo),
      constantOf(field(p.grain, 'decayHi'), GRAIN_FIELDS.decayHi),
    );
    let emitted = duration;
    if (p.distribution === 'bounce') {
      const interval = constantOf(p.interval as ParamValue | undefined, PARAMS.interval);
      const ratio = constantOf(p.ratio as ParamValue | undefined, PARAMS.ratio);
      // A little over the sum of the gaps, for `jitter`.
      emitted = Math.min(duration, (1.3 * interval) / (1 - ratio));
    }
    return emitted + ring + 0.01;
  },
  render(p, ctx) {
    const { sr, n } = ctx;
    const g = p.grain;
    const dist: Distribution = DISTRIBUTIONS.includes(p.distribution as Distribution) ? (p.distribution as Distribution) : 'random';
    const kindRaw = field(g, 'kind') as unknown;
    const kind: GrainKind = GRAIN_KINDS.includes(kindRaw as GrainKind) ? (kindRaw as GrainKind) : 'tick';
    const spread = ctx.num('spread');
    const stereo = spread > 0;
    const left = new Float64Array(n);
    const right = stereo ? new Float64Array(n) : left;
    if (n === 0) return left;

    const window = Math.min(ctx.num('duration'), Number.isFinite(ctx.gate) ? ctx.gate : Infinity);
    const end = Math.min(n, Math.max(1, Math.round(window * sr)));
    const { at, level } = emit(dist, ctx.signal('density'), end, sr, ctx.rng.fork('times'), ctx.num('jitter'), ctx.num('interval'), ctx.num('ratio'));
    const count = at.length;
    if (count === 0) return left;

    const lo = ctx.signalOf(field(g, 'lo'), GRAIN_FIELDS.lo, 'grain.lo');
    const hi = ctx.signalOf(field(g, 'hi'), GRAIN_FIELDS.hi, 'grain.hi');
    const dA = ctx.numOf(field(g, 'decayLo'), GRAIN_FIELDS.decayLo);
    const dB = ctx.numOf(field(g, 'decayHi'), GRAIN_FIELDS.decayHi);
    const decayLo = Math.min(dA, dB);
    const decayHi = Math.max(dA, dB);
    const levelJitter = ctx.numOf(field(g, 'levelJitter'), GRAIN_FIELDS.levelJitter);
    const pitchJitter = ctx.numOf(field(g, 'pitchJitter'), GRAIN_FIELDS.pitchJitter);
    const size = ctx.numOf(field(g, 'size'), GRAIN_FIELDS.size);
    const tone = ctx.numOf(field(g, 'tone'), GRAIN_FIELDS.tone);
    const sweep = ctx.numOf(field(g, 'sweep'), GRAIN_FIELDS.sweep);
    const top = 0.45 * sr;

    // A handful of differently struck pieces to draw from, so a thousand shards don't cost a thousand mode tables.
    const prototypes: ModePrototype[] = [];
    if (kind === 'modal') {
      const mat = materialOf(field(g, 'material'));
      const shapeRaw = field(g, 'shape') as unknown;
      const shape = (MODAL_SHAPES as readonly string[]).includes(shapeRaw as string) ? (shapeRaw as ModalShape) : 'plate';
      const protoRng = ctx.rng.fork('pieces');
      for (let k = 0; k < 8; k++) {
        const set = buildModes(shape, 6, protoRng.next(), protoRng.fork('shape', k));
        const amp = new Float64Array(6);
        const decay = new Float64Array(6);
        for (let m = 0; m < 6; m++) {
          amp[m] = set.weight[m] * Math.pow(set.ratio[m], (mat.tilt + 2) / 6.0206) * Math.pow(10, protoRng.uniform(-3, 3) / 20);
          decay[m] = modeDecayFactor(mat, set.ratio[m], 1);
        }
        prototypes.push({ ratio: set.ratio, amp, decay });
      }
    }

    // Only an absurd cloud (thousands of long rings a second) is over the budget; its rings are then cut short.
    const cost = kind === 'modal' ? 3 : 1;
    const expected = count * Math.sqrt(decayLo * decayHi) * sr * cost;
    const maxLen = expected > WORK_BUDGET ? Math.max(64, Math.floor(WORK_BUDGET / (count * cost))) : Infinity;
    const tmp = new Float64Array(Math.min(n, Math.max(2048, Math.min(maxLen, Math.ceil(decayHi * sr) + 8))) + 4);
    const rng = ctx.rng.fork('grains');
    const noise = ctx.rng.fork('noise');
    // One bouncing object keeps its pitch and ring from bounce to bounce.
    const fixedU = rng.next();
    const fixedD = rng.next();

    for (let k = 0; k < count; k++) {
      const start = at[k];
      const bounce = dist === 'bounce';
      const uf = bounce ? fixedU : rng.next();
      const r1 = rng.next();
      const r2 = rng.next();
      const r3 = rng.next();
      const r4 = rng.next();
      const flip = rng.next() < 0.5;
      const jit = pitchJitter > 0 ? rng.gauss() * pitchJitter : 0;
      // uf = 1 is the lowest, biggest piece.
      const l = lo[start];
      const h = hi[start];
      const f = clamp(h * Math.pow(l / h, uf) * Math.pow(2, jit / 12), 10, top);
      const ul = r1 + (uf - r1) * size;
      const ud = bounce ? fixedD : r2 + (uf - r2) * size;
      const t60 = decayLo * Math.pow(decayHi / decayLo, ud);
      let amp = level[k] * Math.pow(10, (-(1 - ul) * levelJitter * (bounce ? 0.25 : 1)) / 20);
      const room = Math.min(n - start, tmp.length);
      if (room <= 1) continue;
      let len = Math.min(room, Math.max(2, Math.ceil(t60 * sr)));
      const k60 = LN1000 / (t60 * sr);
      const fall = Math.exp(-k60); // per-sample factor of a 60 dB decay over t60
      let e = 1;
      const w = (TAU * f) / sr;

      switch (kind) {
        case 'click': {
          // The response of a critically damped contact to a step: a sharp edge, then a small swing back. No DC.
          len = Math.min(room, Math.ceil(10 / w) + 2);
          const step = Math.exp(-w);
          for (let i = 0; i < len; i++) {
            tmp[i] = (1 - w * i) * e;
            e *= step;
          }
          break;
        }
        case 'ping': {
          // A ring and one inharmonic overtone that dies twice as fast.
          const r = Math.exp(-k60);
          const ratio2 = 2.2 + 1.4 * r3;
          const w2 = Math.min(w * ratio2, 0.9 * Math.PI);
          const c1 = r * Math.cos(w);
          const s1 = r * Math.sin(w);
          const c2 = r * r * Math.cos(w2);
          const s2 = r * r * Math.sin(w2);
          let a1 = 1;
          let b1 = 0;
          let a2 = 0.4;
          let b2 = 0;
          for (let i = 0; i < len; i++) {
            tmp[i] = b1 + b2;
            let t = c1 * a1 - s1 * b1;
            b1 = s1 * a1 + c1 * b1;
            a1 = t;
            t = c2 * a2 - s2 * b2;
            b2 = s2 * a2 + c2 * b2;
            a2 = t;
          }
          break;
        }
        case 'drop': {
          // A bubble (van den Doel 2005): as it nears the surface its pitch climbs, faster the faster it decays.
          const rise = (0.03 + 0.17 * r3) * (LN1000 / t60); // per second
          let phase = 0;
          for (let i = 0; i < len; i++) {
            tmp[i] = Math.sin(phase) * e;
            e *= fall;
            phase += Math.min(w * (1 + (rise * i) / sr), 0.9 * Math.PI);
          }
          break;
        }
        case 'chirp': {
          const perSample = Math.pow(2, sweep / (t60 * sr));
          const attack = Math.max(1, Math.round(0.0004 * sr));
          let inc = w;
          let phase = 0;
          for (let i = 0; i < len; i++) {
            tmp[i] = Math.sin(phase) * e * (i < attack ? i / attack : 1);
            e *= fall;
            phase += Math.min(inc, 0.9 * Math.PI);
            inc *= perSample;
          }
          break;
        }
        case 'crackle': {
          // A pop: a few cycles of a damped swing, with a ragged tail of noise. Most are faint, a few crack.
          const q = 0.8 + 3.2 * r3;
          const swing = Math.exp(-w / (2 * q));
          const c = swing * Math.cos(w);
          const s = swing * Math.sin(w);
          const a = Math.exp((-TAU * Math.min(2 * f, top)) / sr);
          let re = 1;
          let im = 0;
          let lp = 0;
          for (let i = 0; i < len; i++) {
            lp = (1 - a) * (noise.next() * 2 - 1) + a * lp;
            tmp[i] = re + 0.6 * lp * e;
            e *= fall;
            const t = c * re - s * im;
            im = s * re + c * im;
            re = t;
          }
          amp *= 0.1 + 0.9 * r4 * r4 * r4;
          break;
        }
        case 'modal': {
          const proto = prototypes[Math.floor(r3 * prototypes.length) % prototypes.length];
          tmp.fill(0, 0, len);
          for (let m = 0; m < proto.ratio.length; m++) {
            const wm = w * proto.ratio[m];
            if (wm >= 0.94 * Math.PI) continue;
            const tm = t60 * proto.decay[m];
            const r = Math.exp(-LN1000 / (tm * sr));
            const stop = Math.min(len, Math.ceil(tm * sr) + 1);
            const c = r * Math.cos(wm);
            const s = r * Math.sin(wm);
            let re = proto.amp[m];
            let im = 0;
            for (let i = 0; i < stop; i++) {
              tmp[i] += re;
              const t = c * re - s * im;
              im = s * re + c * im;
              re = t;
            }
          }
          break;
        }
        case 'grain': {
          // A Hann window of tone, of noise through a resonance at the same frequency, or of both.
          const r = Math.exp(-w / 8);
          const c = r * Math.cos(w);
          const s = r * Math.sin(w);
          let re = 0;
          let im = 0;
          let was = 0;
          // Scaled so the noise is about as loud as the tone it is mixed with.
          const nz = ((1 - tone) * Math.sqrt(1 - r * r) * 2.4) / Math.max(w, 1e-4);
          // Two rotating pointers: the tone, and the cosine of the Hann window.
          const tc = Math.cos(w);
          const ts = Math.sin(w);
          let tRe = Math.cos(TAU * r3);
          let tIm = Math.sin(TAU * r3);
          const wc = Math.cos(TAU / len);
          const ws = Math.sin(TAU / len);
          let wRe = Math.cos(Math.PI / len);
          let wIm = Math.sin(Math.PI / len);
          for (let i = 0; i < len; i++) {
            let t = c * re - s * im + (tone < 1 ? noise.next() * 2 - 1 : 0);
            im = s * re + c * im;
            re = t;
            tmp[i] = (tone * tIm + nz * (im - was)) * (0.5 - 0.5 * wRe);
            was = im;
            t = tc * tRe - ts * tIm;
            tIm = ts * tRe + tc * tIm;
            tRe = t;
            t = wc * wRe - ws * wIm;
            wIm = ws * wRe + wc * wIm;
            wRe = t;
          }
          break;
        }
        default: {
          // tick: a burst of noise through a broad resonance.
          const r = Math.exp(-w / 2.4);
          const c = r * Math.cos(w);
          const s = r * Math.sin(w);
          let re = 0;
          let im = 0;
          let was = 0;
          for (let i = 0; i < len; i++) {
            const t = c * re - s * im + (noise.next() * 2 - 1) * e;
            e *= fall;
            im = s * re + c * im;
            re = t;
            tmp[i] = im - was; // the difference makes the resonance a band-pass, with nothing below it
            was = im;
          }
        }
      }

      // A ring cut short by the work budget fades instead of stopping dead.
      if (kind !== 'click' && kind !== 'grain' && len < room && len < Math.ceil(t60 * sr) - 1) {
        const fade = Math.min(48, len >> 1);
        for (let i = 0; i < fade; i++) tmp[len - 1 - i] *= i / fade;
      }
      // Every particle at the same peak before its own level, whatever its kind and pitch. Half are upside down,
      // so the small offsets of short rings cancel over the cloud.
      if (flip) amp = -amp;
      let pk = 0;
      for (let i = 0; i < len; i++) {
        const a = tmp[i] < 0 ? -tmp[i] : tmp[i];
        if (a > pk) pk = a;
      }
      if (!(pk > 1e-12)) continue;
      const gain = amp / pk;
      if (stereo) {
        const pan = spread * (2 * rng.next() - 1);
        const gl = gain * Math.SQRT2 * Math.cos(((pan + 1) * Math.PI) / 4);
        const gr = gain * Math.SQRT2 * Math.sin(((pan + 1) * Math.PI) / 4);
        for (let i = 0; i < len; i++) {
          left[start + i] += gl * tmp[i];
          right[start + i] += gr * tmp[i];
        }
      } else {
        for (let i = 0; i < len; i++) left[start + i] += gain * tmp[i];
      }
    }

    let pk = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(left[i]);
      const b = stereo ? Math.abs(right[i]) : 0;
      if (a > pk) pk = a;
      if (b > pk) pk = b;
    }
    if (pk > 1e-12) {
      const norm = 1 / pk;
      for (let i = 0; i < n; i++) left[i] *= norm;
      if (stereo) for (let i = 0; i < n; i++) right[i] *= norm;
    }
    return stereo ? ([left, right] as [Buf, Buf]) : left;
  },
};
