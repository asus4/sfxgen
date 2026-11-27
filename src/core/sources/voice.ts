import type { ParamMeta, SourceDef } from '../nodes';
import { FormantBank, vowelPattern, type FormantPattern } from '../dsp/formants';
import { wander } from '../dsp/noise';
import { clamp } from '../dsp/math';
import { dcBlock } from '../dsp/filters';
import type { Rng } from '../dsp/rng';

const PARAMS: Record<string, ParamMeta> = {
  freq: {
    kind: 'signal',
    doc:
      'Pitch of the glottal pulses. 60 to 120 a big creature or a man, 180 to 300 a small animal or a shout, 500+ a ' +
      'critter squeak. Breakpoints shape the inflection: a rise and fall reads as a roar.',
    hint: 'Pitch of the voice',
    default: 110,
    min: 30,
    max: 1200,
    hardMin: 8,
    hardMax: 4000,
    unit: 'Hz',
    scale: 'log',
    pitch: true,
  },
  vowel: {
    kind: 'signal',
    doc:
      'The vowel the throat shapes: 0 a (ah), 1 e (eh), 2 i (ee), 3 o (oh), 4 u (oo), 5 ü (German "über"), 6 ö ' +
      '(German "schön"); fractions blend neighbours. ü and ö are rounded: covered and darker than i and e, for ' +
      'ghosts, laments and hollow throats. Moving it makes the creature talk: [[0, 0], [0.5, 3]] is "ah-oh", ' +
      '[[0, 4], [0.3, 0]] a "wah".',
    hint: 'Which vowel: ah, eh, ee, oh, oo',
    default: 0,
    min: 0,
    max: 6,
    hardMin: 0,
    hardMax: 6,
  },
  formants: {
    kind: 'array',
    doc:
      'Custom formants instead of `vowel`: `[[freq, q, gain], ...]`, up to 8, with Hz, resonance (centre/bandwidth, ' +
      '5 to 15 is vocal) and an optional linear level (omit it for the natural level). Scaled by `size` like the vowels.',
    hint: 'A custom throat shape instead of a vowel',
    item: {
      kind: 'array',
      doc: 'One formant: [centre Hz, q, gain]. q defaults to 8; leave out gain for the natural level.',
      hint: 'One resonance',
      item: { kind: 'number', doc: 'The centre in Hz, then q (0.5 to 50), then a linear level (0 to 4).', hint: 'Pitch, sharpness, then level' },
    },
  },
  size: {
    kind: 'signal',
    doc:
      'Size of the throat: divides every formant frequency. 0.5 a tiny critter or a child, 1 an adult, 2 a big beast, ' +
      '3+ a kaiju. Independent of pitch, so a small high voice or a huge low one are both easy.',
    hint: 'Size of the throat: critter to kaiju',
    default: 1,
    min: 0.3,
    max: 4,
    hardMin: 0.1,
    hardMax: 10,
    unit: 'x',
    scale: 'log',
  },
  resonance: {
    kind: 'number',
    doc: 'Sharpness of the formants (multiplies their q): 0.5 broad and muffled, 1 natural, 2 to 3 whistly, hollow or robotic.',
    hint: 'Muffled to whistly',
    default: 1,
    min: 0.3,
    max: 4,
    hardMin: 0.1,
    hardMax: 10,
    unit: 'x',
    scale: 'log',
  },
  tension: {
    kind: 'signal',
    doc:
      'How pressed the vocal folds are: 0 soft and dull (a sigh, a moan), 0.5 normal, 1 pressed and buzzy (a strained ' +
      'shout, a robot). Louder events (vel) press a little harder.',
    hint: 'Soft sigh to strained shout',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  breath: {
    kind: 'signal',
    doc: 'Aspiration noise through the same throat: 0 clean, 0.2 natural, 0.5 husky, 1 a whisper with no tone left.',
    hint: 'Clean to whisper',
    default: 0.1,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  jitter: {
    kind: 'number',
    doc: 'Random cycle-to-cycle pitch wobble, percent: 0 mechanical (a robot), 0.5 to 1.5 alive, 4 to 10 rough and old.',
    hint: 'Pitch wobble: robot to rough',
    default: 1,
    min: 0,
    max: 10,
    hardMin: 0,
    hardMax: 30,
    unit: '%',
  },
  shimmer: {
    kind: 'number',
    doc: 'Random cycle-to-cycle level wobble, dB: 0 steady, 0.5 to 1 natural, 3 to 6 shaky and broken.',
    hint: 'Level wobble: steady to shaky',
    default: 0.6,
    min: 0,
    max: 6,
    hardMin: 0,
    hardMax: 20,
    unit: 'dB',
  },
  growl: {
    kind: 'signal',
    doc:
      'Subharmonic roughness: every other pulse weakens and shifts (period doubling), adding a tone an octave down ' +
      'while the harmonics stay clean. 0.3 gruff, 0.6 a monster growl, 1 a deep snarl an octave below `freq`.',
    hint: 'A gruff growl an octave down',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  rasp: {
    kind: 'signal',
    doc: 'Noisy, irregular roughness (a torn, hoarse throat): fast random flutter of the pulses. 0.3 hoarse, 0.7 a snarling hiss-roar, 1 shredded.',
    hint: 'A hoarse, torn throat',
    default: 0,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
};

/** PolyBLEP residual for a unit jump at phase 0 (as in the band-limited oscillators). */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function gaussClamped(rng: Rng, limit = 2.5): number {
  return clamp(rng.gauss(), -limit, limit);
}

/** Custom formants, sorted by frequency; null when the spec has none. */
function customFormants(value: unknown): { freq: number; q: number; gain: number }[] | null {
  if (!Array.isArray(value)) return null;
  const list: { freq: number; q: number; gain: number }[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || typeof item[0] !== 'number' || !Number.isFinite(item[0]) || item[0] <= 0) continue;
    const q = typeof item[1] === 'number' && Number.isFinite(item[1]) && item[1] > 0 ? clamp(item[1], 0.5, 50) : 8;
    const gain = typeof item[2] === 'number' && Number.isFinite(item[2]) ? clamp(item[2], 0, 4) : NaN;
    list.push({ freq: clamp(item[0], 20, 24000), q, gain });
  }
  if (list.length === 0) return null;
  return list.sort((a, b) => a.freq - b.freq).slice(0, 8);
}

/** RMS the level follower aims for, which puts the default voice's peak near 1. */
const TARGET_RMS = 0.4;
/** How much of a level difference the follower removes (1 would flatten every change of pitch, vowel or size). */
const LEVELLING = 0.8;
/** Aspiration noise level against the pulses. */
const BREATH_GAIN = 0.55;

/** A vocal source: glottal pulses with jitter, growl and breath through a morphing formant throat. */
export const voice: SourceDef = {
  kind: 'source',
  type: 'voice',
  label: 'Voice',
  category: 'voice',
  doc:
    'A throat: shaped glottal pulses at `freq` (with natural `jitter` and `shimmer`) and `breath`, through formants ' +
    'that morph between vowels and scale with `size`. Reach for it for creatures, monsters, robots, grunts, moans, ' +
    'critter squeaks and whispers: anything with a throat. `growl` adds a clean subharmonic snarl, `rasp` a torn ' +
    'hoarseness, `tension` goes from a sigh to a strained shout. Pitch and vowel curves are what make it emote: a ' +
    'rising then falling `freq` with `vowel` moving from 0 to 3 is a roar.',
  hint: 'A throat: creatures, monsters, robots and voices',
  defaultEnv: { attack: 0.03, hold: 0.25, decay: 0.4 },
  params: PARAMS,
  example: {
    type: 'voice',
    freq: [[0, 70], [0.25, 120], [0.8, 95], [1.3, 55]],
    vowel: [[0, 3], [0.3, 0], [1.3, 3.6]],
    size: 2.4,
    growl: 0.55,
    rasp: 0.25,
    breath: 0.15,
    env: { attack: 0.08, hold: 0.7, decay: 0.6 },
  },
  render(p, ctx) {
    const { n, sr } = ctx;
    const freq = ctx.signal('freq');
    const vowel = ctx.signal('vowel');
    const size = ctx.signal('size');
    const tension = ctx.signal('tension');
    const breath = ctx.signal('breath');
    const growl = ctx.signal('growl');
    const rasp = ctx.signal('rasp');
    const resonance = ctx.num('resonance');
    const jitter = ctx.num('jitter') / 100;
    const shimmer = ctx.num('shimmer');
    const custom = customFormants(p.formants);

    const cycles = ctx.rng.fork('cycles');
    const air = ctx.rng.fork('breath');
    // Rasp: a smooth random flutter in the 25 to 160 Hz region, where roughness is strongest.
    const flutter = wander(n, sr, clamp(0.6 * freq[0], 25, 160), ctx.rng.fork('rasp'));
    const press = 0.25 * (clamp(ctx.vel, 0, 2) - 1);

    const bank = new FormantBank(sr, 8);
    const pattern: FormantPattern = { freq: [], q: [], gain: [] };
    const out = new Float64Array(n);

    let phase = 0;
    let cycle = 0;
    let period = 1;
    let amp = 1;
    let tilt = 0;
    let airLow = 0;
    const airHp = 1 - Math.exp((-2 * Math.PI * 400) / sr);
    const B = 32;
    for (let b0 = 0; b0 < n; b0 += B) {
      const len = Math.min(B, n - b0);
      const im = b0 + (len >> 1);
      const sz = size[im];
      if (custom) {
        pattern.freq.length = pattern.q.length = pattern.gain.length = custom.length;
        custom.forEach((f, k) => {
          pattern.freq[k] = f.freq / sz;
          pattern.q[k] = f.q * resonance;
          pattern.gain[k] = f.gain;
        });
      } else {
        vowelPattern(vowel[im], sz, resonance, pattern);
      }
      bank.set(pattern);
      // Tension tilts the pulse spectrum (the glottis' return phase): a one-pole low-pass from 1 kHz to 18 kHz.
      const tb = clamp(tension[im] + press, 0, 1);
      const tiltA = 1 - Math.exp((-2 * Math.PI * Math.min(1000 * Math.pow(2, 4.2 * tb), 0.45 * sr)) / sr);
      // Higher voices pack more pulses into a second; level them partly so a pitch sweep stays even.
      const comp = clamp(Math.pow(110 / Math.max(freq[im], 1), 0.35), 0.3, 2.5);
      for (let j = 0; j < len; j++) {
        const i = b0 + j;
        const dphi = Math.min(freq[i] / sr / period, 0.45);
        phase += dphi;
        if (phase >= 1) {
          // A new glottal cycle: draw its jitter and shimmer; growl alternates weak, shifted pulses.
          phase -= Math.floor(phase);
          cycle++;
          const g = growl[i];
          const odd = (cycle & 1) === 1;
          const jit = (jitter + 0.06 * rasp[i]) * gaussClamped(cycles);
          period = Math.max(0.2, 1 + jit) * (1 + (odd ? 0.08 : -0.08) * g);
          amp = Math.pow(10, (shimmer * gaussClamped(cycles)) / 20) * (odd ? 1 - 0.85 * g : 1);
        }
        const t = clamp(tension[i] + press, 0, 1);
        const oq = 0.8 - 0.45 * t;
        const sq = 2 + t;
        const tp = (oq * sq) / (1 + sq);
        const tn = oq - tp;
        // Flow derivative of a Rosenberg pulse, scaled so the closing jump is 1, band-limited at the closure.
        let v: number;
        if (phase < tp) {
          const u = phase / tp;
          v = 3 * (u - u * u) * (tn / tp);
        } else if (phase < oq) v = -(phase - tp) / tn;
        else v = 0;
        let rel = phase - oq;
        if (rel < 0) rel += 1;
        v += 0.5 * blep(rel, dphi);
        tilt += tiltA * (v - tilt);
        const r = rasp[i];
        const rough = r > 0 ? Math.max(0, 1 + 1.4 * r * flutter[i]) : 1;
        const b = breath[i];
        // Aspiration: high-passed noise, stronger while the glottis is open.
        const w = air.uniform(-1.7320508, 1.7320508);
        airLow += airHp * (w - airLow);
        const noise = (w - airLow) * (phase < oq ? 1 : 0.4);
        const src = tilt * amp * rough * comp * (1 - b * b) + noise * b * BREATH_GAIN;
        out[i] = bank.tick(src);
      }
    }
    dcBlock(out, sr);
    // Level: a slow, zero-phase RMS follower brings any pitch, size, vowel or custom formant set to within a few dB
    // of the same loudness (a whisper too). The envelope comes after the source, so its shape is untouched.
    const power = new Float64Array(n);
    const a = 1 - Math.exp(-1 / (0.02 * sr));
    const lead = Math.min(n, Math.round(0.02 * sr));
    let s = 0;
    for (let i = 0; i < lead; i++) s += out[i] * out[i];
    s /= Math.max(lead, 1);
    for (let i = 0; i < n; i++) {
      s += a * (out[i] * out[i] - s);
      power[i] = s;
    }
    s = power[n - 1] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
      s += a * (power[i] - s);
      power[i] = s;
    }
    for (let i = 0; i < n; i++) {
      const rms = Math.sqrt(power[i] + 1e-12);
      out[i] *= clamp(Math.exp(LEVELLING * Math.log(TARGET_RMS / rms)), 0.05, 40);
    }
    return out;
  },
};
