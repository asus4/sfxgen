import type { EffectDef, ParamMeta } from '../nodes';
import type { Rng } from '../dsp/rng';
import { filterBuffer } from '../dsp/filters';
import { noise as makeNoise } from '../dsp/noise';
import { activeRms, compress, crackle, hum, muLaw, wobbleHead, type Wobble } from '../dsp/wear';
import { clamp, type Buf } from '../dsp/math';

const MODES = ['tv', 'radio', 'phone', 'walkie', 'megaphone', 'vinyl', 'tape', 'cassette', 'intercom'] as const;
type Mode = (typeof MODES)[number];

/** What one medium does to a sound, at amount 1, age 0.5 and typical noise and wow. */
interface Medium {
  /** One speaker: the output is the same in every channel. */
  mono: boolean;
  /** Band edges (Hz) and slopes (dB per octave). */
  lo: number;
  hi: number;
  loSlope: 12 | 24;
  hiSlope: 12 | 24;
  /** How many octaves `hi` drops from age 0.5 to age 1. */
  ageHi: number;
  /** Resonances: [Hz, dB, Q]. */
  peaks: [number, number, number][];
  /** Saturation (gain into tanh at the nominal level) and its asymmetry. */
  drive: number;
  bias: number;
  /** Broadcast compression: threshold (dBFS at the nominal level) and ratio. */
  comp?: [number, number, number, number];
  /** Bits of μ-law telephone companding. */
  mu?: number;
  /** Hard clipping: gain into a clip at ±0.35. */
  clip?: number;
  /** Reflections inside a box or horn: [ms, gain]. */
  box?: [number, number];
  /** Transport wobble and slow drift (seconds), at wow 0.5. */
  wobble: Wobble[];
  drift: number;
  /** Noise levels in dB relative to the sound's RMS, at noise 0.5 (and age 0.5 where it matters). */
  hiss: number;
  hissColor: 'white' | 'pink' | 'bright';
  /** The hiss passes through the medium's band (it comes out of the same speaker). */
  hissInBand: boolean;
  hum?: number;
  /** Clicks per second at age 0.5 and their level. */
  crackle?: [number, number];
  /** CRT line-output whine, dB. */
  whine?: number;
  /** AM fading depth (dB at age 0.5) and a faint heterodyne whistle (dB). */
  fading?: number;
  whistle?: number;
  /** Tape dropouts per second at age 0.5. */
  dropouts?: number;
  /** Walkie-talkie squelch: noise only while transmitting, and a burst when the carrier drops. */
  squelch?: boolean;
}

// prettier-ignore
const MEDIA: Record<Mode, Medium> = {
  tv: {
    mono: true, lo: 120, hi: 7000, loSlope: 12, hiSlope: 24, ageHi: 1, peaks: [[1700, 3, 0.8], [420, -1.5, 1]],
    drive: 1.2, bias: 0.03, box: [2.3, 0.12],
    wobble: [{ rate: 0.47, depth: 0.00042 }, { rate: 0.83, depth: 0.0002 }, { rate: 6.3, depth: 0.000016 }, { rate: 9.7, depth: 0.000008 }], drift: 0,
    hiss: -54, hissColor: 'white', hissInBand: true, hum: -62, whine: -60,
  },
  radio: {
    mono: true, lo: 120, hi: 4500, loSlope: 24, hiSlope: 24, ageHi: 1.2, peaks: [[1000, 2, 0.8], [2800, 1.5, 1.5]],
    drive: 1.4, bias: 0.05, comp: [-24, 4, 0.005, 0.2],
    wobble: [], drift: 0,
    hiss: -40, hissColor: 'white', hissInBand: true, crackle: [6, -24], fading: 3, whistle: -50,
  },
  phone: {
    mono: true, lo: 300, hi: 3400, loSlope: 24, hiSlope: 24, ageHi: 0.6, peaks: [[1500, 3, 1], [1000, 2, 2]],
    drive: 1, bias: 0.02, mu: 8,
    wobble: [], drift: 0,
    hiss: -52, hissColor: 'white', hissInBand: true, hum: -58,
  },
  walkie: {
    mono: true, lo: 400, hi: 2800, loSlope: 24, hiSlope: 24, ageHi: 0.5, peaks: [[1500, 3, 1.5]],
    drive: 1.5, bias: 0, comp: [-26, 8, 0.002, 0.08], clip: 3,
    wobble: [], drift: 0,
    hiss: -32, hissColor: 'white', hissInBand: true, squelch: true,
  },
  megaphone: {
    mono: true, lo: 450, hi: 5500, loSlope: 24, hiSlope: 24, ageHi: 0.8, peaks: [[1200, 7, 2.5], [2600, 5, 3.5], [1800, -3, 4]],
    drive: 5, bias: 0.05, box: [0.45, 0.4],
    wobble: [], drift: 0,
    hiss: -50, hissColor: 'white', hissInBand: true,
  },
  vinyl: {
    mono: false, lo: 25, hi: 14000, loSlope: 12, hiSlope: 12, ageHi: 1.5, peaks: [[120, 2, 0.7]],
    drive: 0.8, bias: 0.02,
    wobble: [{ rate: 0.555, depth: 0.00043 }, { rate: 1.11, depth: 0.00006 }, { rate: 7, depth: 0.000008 }], drift: 0.00015,
    hiss: -52, hissColor: 'pink', hissInBand: false, crackle: [12, -22],
  },
  tape: {
    mono: false, lo: 30, hi: 18000, loSlope: 12, hiSlope: 12, ageHi: 2, peaks: [[70, 2.5, 1.2]],
    drive: 1.6, bias: 0.02,
    wobble: [{ rate: 0.6, depth: 0.00012 }, { rate: 1.3, depth: 0.00006 }, { rate: 7.5, depth: 0.000012 }, { rate: 12, depth: 0.000006 }], drift: 0.0001,
    hiss: -58, hissColor: 'bright', hissInBand: false, dropouts: 0.15,
  },
  cassette: {
    mono: false, lo: 35, hi: 9000, loSlope: 12, hiSlope: 24, ageHi: 1.3, peaks: [[90, 3, 1]],
    drive: 2.2, bias: 0.03,
    wobble: [{ rate: 0.8, depth: 0.00035 }, { rate: 1.7, depth: 0.00015 }, { rate: 8, depth: 0.00003 }, { rate: 13, depth: 0.000015 }], drift: 0.0003,
    hiss: -48, hissColor: 'bright', hissInBand: false, dropouts: 0.4,
  },
  intercom: {
    mono: true, lo: 350, hi: 4000, loSlope: 24, hiSlope: 24, ageHi: 0.8, peaks: [[800, 5, 2], [2600, 4, 3]],
    drive: 2.5, bias: 0.04, box: [1.1, 0.3],
    wobble: [], drift: 0,
    hiss: -50, hissColor: 'white', hissInBand: true, hum: -40,
  },
};

const PARAMS: Record<string, ParamMeta> = {
  mode: {
    kind: 'enum',
    doc:
      'What the sound is heard through. tv: a 1970s CRT set, small boxy speaker, light tape wobble, faint hiss, ' +
      'hum and line whine. radio: AM, squashed and narrow, with static and slow fading. phone: a telephone line, ' +
      '300 to 3400 Hz with digital grain. walkie: a two-way radio, narrow and crunchy, with squelch noise at the end. ' +
      'megaphone: a horn and an overdriven amp. vinyl: a record, crackle, warp wow and warmth. tape: reel-to-reel, ' +
      'saturation, head bump, gentle wow and hiss. cassette: like tape but duller, hissier and wobblier. intercom: a ' +
      'door or PA intercom, a cheap speaker in a metal box, with mains buzz.',
    options: MODES,
    default: 'tv',
  },
  amount: {
    kind: 'number',
    doc: 'How strongly the medium colours the sound (band, resonances, distortion), 0 to 1: 1 the full character, 0.5 a cleaner set.',
    default: 1,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  noise: {
    kind: 'number',
    doc: 'The medium\'s own noise (hiss, hum, crackle, static, squelch): 0.5 typical for the mode, 0 none, 1 heavy.',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  wow: {
    kind: 'number',
    doc: 'Speed wobble of media with moving parts (tv, vinyl, tape, cassette): 0.5 typical, 0 steady, 1 badly worn or warped.',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
  age: {
    kind: 'number',
    doc: 'Wear, 0 to 1: 0 new and clean, 0.5 typical, 1 old (duller, more distorted, more crackle and dropouts).',
    default: 0.5,
    min: 0,
    max: 1,
    hardMin: 0,
    hardMax: 1,
  },
};

/** dB offset of a 0..1 knob whose middle (0.5) is the medium's typical level; 0 switches it off. */
function knobDb(v: number): number {
  return v <= 0.001 ? -Infinity : 30 * Math.log10(v / 0.5);
}

function colouredNoise(n: number, sr: number, color: Medium['hissColor'], rng: Rng): Buf {
  if (color === 'pink') return makeNoise('pink', n, sr, rng);
  const x = makeNoise('white', n, sr, rng);
  if (color === 'bright') {
    // Tape hiss leans bright: tilt up above 2 kHz.
    const lo = x.slice();
    filterBuffer(lo, 'lowpass', 2000, 0.707, sr);
    for (let i = 0; i < n; i++) x[i] = 0.5 * lo[i] + 1.4 * (x[i] - lo[i]);
  }
  return x;
}

function rmsOf(x: Buf): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(x.length, 1));
}

/** Old and small media: TV speakers, AM radio, telephones, walkie-talkies, megaphones, vinyl, tape, intercoms. */
export const medium: EffectDef = {
  kind: 'effect',
  type: 'medium',
  label: 'Medium',
  category: 'color',
  doc:
    'Puts the sound through a playback or transmission medium: an old TV, AM radio, telephone, walkie-talkie, ' +
    'megaphone, vinyl, tape, cassette or intercom, each with its band, resonances, distortion, wobble and noise. ' +
    'The loudness of the sound is kept; `noise` adds the medium\'s own hiss, hum, crackle and static around it ' +
    '(the walkie\'s only while it transmits, ending in a squelch burst). Put it last in a chain, after reverb, for ' +
    'a sound heard through the device.',
  params: PARAMS,
  example: { type: 'medium', mode: 'radio', amount: 1, noise: 0.6, age: 0.7 },
  tail(params) {
    return params.mode === 'walkie' ? 0.35 : 0.02;
  },
  process(input, p, ctx) {
    const sr = ctx.sr;
    const n = input[0].length;
    const mode: Mode = MODES.includes(p.mode as Mode) ? (p.mode as Mode) : 'tv';
    const m = MEDIA[mode];
    const amount = ctx.num('amount');
    const noiseKnob = ctx.num('noise');
    const wowKnob = ctx.num('wow');
    const age = ctx.num('age');
    const level = activeRms(input);
    if (level <= 0) return input;

    // Work at a nominal level (RMS 0.2), so the distortion does not depend on how loud the input is.
    const pre = 0.2 / level;
    let chans: Buf[];
    if (m.mono && input.length === 2) {
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.5 * (input[0][i] + input[1][i]) * pre;
      chans = [x];
    } else chans = input.map((x) => x.map((v) => v * pre));

    // The transport: wow, flutter and drift as a moving read head (one transport for every channel).
    const wowScale = wowKnob <= 0 ? 0 : Math.pow(wowKnob / 0.5, 1.3);
    if (wowScale > 0 && (m.wobble.length > 0 || m.drift > 0)) {
      chans = wobbleHead(chans, sr, m.wobble.map((w) => ({ rate: w.rate, depth: w.depth * wowScale })), m.drift * wowScale, ctx.rng.fork('transport'), ctx.loop);
    }

    const ageMul = 0.7 + 0.6 * age;
    const lo = Math.max(20 * Math.pow(m.lo / 20, amount), 15);
    const hi = Math.min(20000 * Math.pow(m.hi / 20000, amount) * Math.pow(2, -m.ageHi * (age - 0.5)), sr * 0.45);
    const k = (0.3 + (m.drive - 0.3) * amount) * ageMul;
    const bias = m.bias * amount;
    const satNorm = 1 / (k * (1 - Math.tanh(k * bias) ** 2));
    const boxRng = ctx.rng.fork('box');
    chans = chans.map((x) => {
      if (m.comp) compress(x, sr, m.comp[0], 1 + (m.comp[1] - 1) * amount, m.comp[2], m.comp[3]);
      // Saturation, normalised to unit gain for quiet sounds; the bias adds even harmonics (and DC, removed below).
      const t0 = Math.tanh(k * bias);
      for (let i = 0; i < n; i++) x[i] = (Math.tanh(k * (x[i] + bias)) - t0) * satNorm;
      if (m.clip) {
        const g = 1 + (m.clip * ageMul - 1) * amount;
        for (let i = 0; i < n; i++) x[i] = clamp(x[i] * g, -0.35, 0.35) / Math.sqrt(g);
      }
      if (m.mu) {
        const bits = Math.round(16 - (16 - m.mu) * amount);
        for (let i = 0; i < n; i++) x[i] = muLaw(x[i] * 2, bits) * 0.5;
      }
      // The speaker's band and resonances.
      filterBuffer(x, 'highpass', lo, 0.707, sr, { slope: m.loSlope });
      if (hi < sr * 0.449) filterBuffer(x, 'lowpass', hi, 0.707, sr, { slope: m.hiSlope });
      for (const [f, g, q] of m.peaks) if (f < sr * 0.45) filterBuffer(x, 'peak', f, q, sr, { gainDb: g * amount });
      if (m.box) {
        // Reflections inside the cabinet or horn: a short feed-forward echo.
        const d = Math.round((m.box[0] / 1000) * sr * (1 + 0.02 * boxRng.uniform(-1, 1)));
        const g = m.box[1] * amount;
        if (d > 0 && g > 0) for (let i = n - 1; i >= d; i--) x[i] += g * x[i - d];
      }
      return x;
    });

    // Slow AM fading: the signal swells and sinks, and the receiver's gain brings the noise up as it sinks.
    let fade: Buf | null = null;
    if (m.fading) {
      const depth = (m.fading * age) / 0.5;
      fade = new Float64Array(n);
      const fr = ctx.rng.fork('fading');
      const step = Math.round(sr * 2.5);
      let a = fr.gauss();
      let b = fr.gauss();
      let kk = Math.floor(fr.next() * step);
      for (let i = 0; i < n; i++) {
        const v = a + (b - a) * (0.5 - 0.5 * Math.cos((Math.PI * kk) / step));
        fade[i] = Math.pow(10, (clamp(v, -2, 2) * depth * 0.5) / 20);
        if (++kk >= step) {
          kk = 0;
          a = b;
          b = fr.gauss();
        }
      }
      for (const x of chans) for (let i = 0; i < n; i++) x[i] *= fade[i];
    }

    // Tape dropouts: brief dips where the oxide is worn.
    if (m.dropouts) {
      const rate = m.dropouts * Math.pow(age / 0.5, 2) * (wowKnob > 0 ? 1 : 0.5);
      const dr = ctx.rng.fork('dropouts');
      let t = rate > 0 ? dr.exponential(sr / rate) : Infinity;
      const dip = new Float64Array(n).fill(1);
      while (t < n) {
        const len = Math.round(dr.uniform(0.015, 0.06) * sr);
        const depth = dr.uniform(0.25, 0.8);
        const at = Math.floor(t);
        for (let i = 0; i < len && at + i < n; i++) dip[at + i] = Math.min(dip[at + i], 1 - depth * Math.sin((Math.PI * i) / len) ** 2);
        t += dr.exponential(sr / rate) + len;
      }
      for (const x of chans) for (let i = 0; i < n; i++) x[i] *= dip[i];
    }

    // Keep the loudness of the sound: match its active RMS to the input's.
    const after = activeRms(chans);
    const post = after > 0 ? level / after : 0;
    for (const x of chans) for (let i = 0; i < n; i++) x[i] *= post;

    // The medium's own noise, relative to the sound's level.
    const nDb = knobDb(noiseKnob);
    if (Number.isFinite(nDb)) {
      const gain = (db: number) => level * Math.pow(10, (db + nDb) / 20);
      // Where the noise runs: everywhere (with a short fade-in), or only while a walkie transmits. In a loop the
      // end fades out as the start fades in, so the part the renderer folds back onto the start adds up evenly.
      const gate = new Float64Array(n).fill(1);
      const fadeLen = Math.min(Math.floor(n / 2), Math.round((ctx.loop ? 0.05 : 0.01) * sr));
      for (let i = 0; i < fadeLen; i++) {
        gate[i] = ctx.loop ? Math.sin((0.5 * Math.PI * i) / fadeLen) : i / fadeLen;
        if (ctx.loop) gate[n - 1 - i] = Math.sin((0.5 * Math.PI * i) / fadeLen);
      }
      let burst: { start: number; len: number } | null = null;
      if (m.squelch) {
        const pk = Math.max(...chans.map((x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0)));
        const floor = pk * 0.01;
        let first = -1;
        let last = -1;
        for (const x of chans) {
          let i = 0;
          while (i < n && Math.abs(x[i]) <= floor) i++;
          if (i < n && (first < 0 || i < first)) first = i;
          let j = n - 1;
          while (j >= 0 && Math.abs(x[j]) <= floor) j--;
          last = Math.max(last, j);
        }
        gate.fill(0);
        if (first >= 0) {
          const open = Math.max(0, first - Math.round(0.03 * sr));
          const close = Math.min(n, last + Math.round(0.06 * sr));
          const ramp = Math.round(0.004 * sr);
          for (let i = open; i < close; i++) gate[i] = Math.min(1, (i - open) / ramp, (close - i) / ramp);
          burst = { start: close, len: Math.round((0.12 + 0.1 * age) * sr) };
        }
      }
      const out = chans.map(() => new Float64Array(n));
      const nr = ctx.rng.fork('noise');
      // Hiss: one stream per channel (stereo media), through the speaker's band when it comes out of it.
      out.forEach((o, c) => {
        const h = colouredNoise(n, sr, m.hissColor, nr.fork('hiss', c));
        if (m.hissInBand) {
          filterBuffer(h, 'highpass', lo, 0.707, sr, { slope: m.loSlope });
          if (hi < sr * 0.449) filterBuffer(h, 'lowpass', hi, 0.707, sr, { slope: m.hiSlope });
        }
        const g = gain(m.hiss + 4 * (age - 0.5)) / Math.max(rmsOf(h), 1e-12);
        for (let i = 0; i < n; i++) o[i] += h[i] * g * gate[i] * (fade ? 1 / fade[i] : 1);
      });
      if (m.hum !== undefined) {
        const h = hum(n, sr, 60, 12, 0.5 + 0.5 * age, nr.fork('hum'));
        filterBuffer(h, 'highpass', lo, 0.707, sr, { slope: m.loSlope });
        const g = gain(m.hum) / Math.max(rmsOf(h), 1e-12);
        for (const o of out) for (let i = 0; i < n; i++) o[i] += h[i] * g * gate[i];
      }
      if (m.whine !== undefined && sr > 2 * 16200) {
        const g = gain(m.whine + 6 * (age - 0.5)) * Math.SQRT2;
        const w = hum(n, sr, 15734, 1, 0, nr.fork('whine'));
        for (const o of out) for (let i = 0; i < n; i++) o[i] += g * w[i] * Math.SQRT1_2 * gate[i];
      }
      if (m.whistle !== undefined) {
        // A faint beat note from a neighbouring station, drifting slowly.
        const wr = nr.fork('whistle');
        const f0 = wr.uniform(1800, 3200);
        const g = gain(m.whistle + 8 * (age - 0.5)) * Math.SQRT2;
        let ph = 0;
        for (let i = 0; i < n; i++) {
          ph += (2 * Math.PI * f0 * (1 + 0.01 * Math.sin((2 * Math.PI * 0.11 * i) / sr))) / sr;
          for (const o of out) o[i] += g * Math.sin(ph) * gate[i];
        }
      }
      if (m.crackle) {
        const density = m.crackle[0] * Math.pow(age / 0.5, 1.5) * Math.max(noiseKnob / 0.5, 0);
        const { x: cr, times } = crackle(n, sr, density, nr.fork('crackle'));
        if (m.hissInBand) {
          filterBuffer(cr, 'highpass', lo, 0.707, sr);
          if (hi < sr * 0.449) filterBuffer(cr, 'lowpass', hi, 0.707, sr);
        } else filterBuffer(cr, 'highpass', 300, 0.707, sr);
        // A typical click peaks this many dB below the sound's peaks; a few pops are much louder.
        const g = 3 * level * Math.pow(10, (m.crackle[1] + 6 * (age - 0.5)) / 20);
        const bal = nr.fork('balance');
        const pan = times.map(() => bal.uniform(-0.6, 0.6));
        out.forEach((o, c) => {
          if (out.length === 1) {
            for (let i = 0; i < n; i++) o[i] += cr[i] * g * gate[i];
            return;
          }
          // Stereo: the same clicks in both channels with a random balance.
          let k2 = 0;
          let gc = 1;
          for (let i = 0; i < n; i++) {
            while (k2 < times.length && times[k2] <= i) {
              gc = 1 + (c === 0 ? -pan[k2] : pan[k2]);
              k2++;
            }
            o[i] += cr[i] * g * gc * gate[i];
          }
        });
      }
      if (burst) {
        // The squelch tail: a loud burst of band-passed noise as the carrier drops, cut off sharply.
        const b = colouredNoise(n, sr, 'white', nr.fork('squelch'));
        filterBuffer(b, 'highpass', Math.max(lo, 300), 0.707, sr);
        filterBuffer(b, 'lowpass', Math.min(hi * 1.4, sr * 0.45), 0.707, sr);
        const g = (gain(-6) / Math.max(rmsOf(b), 1e-12)) * Math.pow(10, -nDb / 40);
        const ramp = Math.round(0.003 * sr);
        for (let i = 0; i < burst.len && burst.start + i < n; i++) {
          const e = Math.min(1, i / ramp, (burst.len - i) / ramp);
          for (const o of out) o[burst.start + i] += b[burst.start + i] * g * e;
        }
      }
      for (let c = 0; c < chans.length; c++) for (let i = 0; i < n; i++) chans[c][i] += out[c][i];
    }

    if (m.mono && input.length === 2) return [chans[0], chans[0].slice()];
    return chans;
  },
};
