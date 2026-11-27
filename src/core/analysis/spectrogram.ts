/**
 * spectrogram(): an image an agent looks at instead of listening.
 *
 *   +--------------------------------------------------------------+
 *   |      | waveform strip: min/max in blue, RMS lighter, red = clip |
 *   |  10k | log-frequency spectrogram, inferno colours               |
 *   |   1k |   (black = quiet ... pale yellow = loudest)              |
 *   |  100 |                                                          |
 *   |      | 0.1s      0.2s      0.3s       time axis                 |
 *   +--------------------------------------------------------------+
 *
 * The frequency axis is logarithmic. Each row blends three Hann STFTs (about 5, 21 and 85 ms at any sample rate;
 * the shorter two grow on long sounds): the short one above ~2 kHz keeps clicks and transients sharp, the long one
 * below ~500 Hz resolves low tones.
 * Faint lines mark 100 Hz, 1 kHz and 10 kHz, and time every 100 ms (coarser for long sounds, finer for very short
 * ones). `caption` says exactly what is drawn.
 */
import { fft, nextPow2 } from '../dsp/fft';

export interface SpectrogramOptions {
  /** Image width, px. Default 900. */
  width?: number;
  /** Image height, px, including the waveform strip and the time axis. Default 360. */
  height?: number;
  /** Lowest and highest frequency shown, Hz (log axis). Default 20 Hz to min(20 kHz, sampleRate / 2). */
  minHz?: number;
  maxHz?: number;
  /** Dynamic range shown, dB below the loudest point. Default 90. */
  rangeDb?: number;
  /** Height of the waveform strip drawn above the spectrogram, px (0 for none). Default 20% of the height. */
  waveformHeight?: number;
  /** Axis labels (frequencies on the left, times along the bottom). Default true. */
  labels?: boolean;
}

export interface SpectrogramImage {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  rgba: Uint8ClampedArray;
  /** One paragraph saying what the image shows and how to read it (axes, grid, colours). */
  caption: string;
}

type Rgb = readonly [number, number, number];

const BG: Rgb = [14, 15, 20];
const WAVE: Rgb = [92, 136, 226];
const WAVE_RMS: Rgb = [188, 210, 255];
const WAVE_ZERO: Rgb = [52, 56, 72];
const CLIP: Rgb = [255, 72, 72];
const LABEL: Rgb = [206, 210, 222];

/** Inferno (matplotlib, CC0), 10 stops; perceptually even and readable from black to pale yellow. */
const INFERNO: Rgb[] = [
  [0, 0, 4],
  [27, 12, 66],
  [75, 12, 107],
  [120, 28, 109],
  [165, 44, 96],
  [207, 68, 70],
  [237, 105, 37],
  [251, 154, 6],
  [247, 208, 60],
  [252, 255, 164],
];

const LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (INFERNO.length - 1);
    const k = Math.min(INFERNO.length - 2, Math.floor(x));
    const f = x - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(INFERNO[k][c] * (1 - f) + INFERNO[k + 1][c] * f);
  }
  return lut;
})();

/** A 3x5 pixel font for the axis labels; each glyph is five rows of three bits. */
const FONT: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 3, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 2, 2, 2],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '.': [0, 0, 0, 0, 2],
  k: [4, 5, 6, 6, 5],
  s: [0, 3, 4, 1, 6],
  H: [5, 5, 7, 5, 5],
  z: [0, 7, 1, 2, 7],
  m: [0, 0, 7, 7, 5],
};
const GLYPH_SCALE = 2;
const ADVANCE = 4 * GLYPH_SCALE;
const GLYPH_H = 5 * GLYPH_SCALE;

class Canvas {
  readonly rgba: Uint8ClampedArray;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.rgba = new Uint8ClampedArray(w * h * 4);
  }
  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.rgba[o] = c[0];
    this.rgba[o + 1] = c[1];
    this.rgba[o + 2] = c[2];
    this.rgba[o + 3] = 255;
  }
  /** Blends white over a pixel. */
  lighten(x: number, y: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    for (let c = 0; c < 3; c++) this.rgba[o + c] = this.rgba[o + c] * (1 - alpha) + 255 * alpha;
  }
  fill(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(this.w, x1); x++) this.set(x, y, c);
  }
  textWidth(text: string): number {
    return text.length * ADVANCE - GLYPH_SCALE;
  }
  text(x: number, y: number, text: string, c: Rgb): void {
    let cx = x;
    for (const ch of text) {
      const g = FONT[ch];
      if (g) {
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 3; col++) {
            if (!(g[row] & (4 >> col))) continue;
            for (let dy = 0; dy < GLYPH_SCALE; dy++) {
              for (let dx = 0; dx < GLYPH_SCALE; dx++) this.set(cx + col * GLYPH_SCALE + dx, y + row * GLYPH_SCALE + dy, c);
            }
          }
        }
      }
      cx += ADVANCE;
    }
  }
}

const smoothstep = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function formatHzLabel(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

function formatTimeLabel(t: number, step: number): string {
  const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${t.toFixed(digits)}s`;
}

const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];

/**
 * Power of every pixel (plotW x specH), blending three resolutions row by row. Power is |X|^2 scaled so a sine of
 * amplitude A at a bin centre reads A^2 in every resolution.
 *
 * A long window smears a hit over its whole length, so a bounce would show low-frequency energy 40 ms before it
 * lands. Each longer window is therefore gated by the next shorter one, row by row: around a row's frequency (an
 * octave, widened to hold the shorter window's main lobe) a column may not hold more energy than the shorter
 * window measures there, within 1 dB. Steady sounds read the same in both and pass untouched.
 */
function pixelPower(
  chs: ArrayLike<number>[],
  n: number,
  sr: number,
  plotW: number,
  rows: { lo: number; hi: number; centre: number }[],
): Float64Array {
  const specH = rows.length;
  const out = new Float64Array(plotW * specH);
  // About 5, 21 and 85 ms. On long sounds a column outlasts the short window, which then aliases against anything
  // periodic (a saw's reset every 12 ms shows as stripes), so the short and middle windows grow to span two columns.
  const S0 = nextPow2(Math.round(sr * 0.005));
  const spc = n / plotW;
  const S = Math.max(S0, Math.min(4 * S0, nextPow2(Math.ceil(2 * spc))));
  const M = Math.max(4 * S0, 2 * S);
  const L = 16 * S0;
  const LOW = 500;
  const HIGH = 2000;
  const wShort = (f: number) => smoothstep(Math.log2(f / HIGH) + 0.5);
  const wLong = (f: number) => 1 - smoothstep(Math.log2(f / LOW) + 0.5);
  const resolutions = [
    { nfft: S, weight: wShort },
    { nfft: M, weight: (f: number) => Math.max(0, 1 - wShort(f) - wLong(f)) },
    { nfft: L, weight: wLong },
  ];
  const actives = resolutions.map((res) => rows.map((row, i) => (res.weight(row.centre) > 1e-4 ? i : -1)).filter((i) => i >= 0));
  /** Gating band around a row, for a pair whose shorter window has `refN` points. */
  const gateBand = (f: number, refN: number) => {
    const bin = sr / refN;
    return [Math.max(0, Math.min(f / Math.SQRT2, f - 2.5 * bin)), Math.max(f * Math.SQRT2, f + 2.5 * bin)];
  };
  /** refColumns[r]: per column, the energy resolution r measures in each gating band of resolution r + 1's rows. */
  const refColumns: Float64Array[] = [];
  resolutions.forEach((res, r) => {
    const N = res.nfft;
    const active = actives[r];
    const binHz = sr / N;
    const toBins = (band: number[]) => [Math.max(1, Math.ceil(band[0] / binHz)), Math.min(N / 2, Math.floor(band[1] / binHz))];
    const bins = active.map((row) => {
      const lo = Math.ceil(rows[row].lo / binHz);
      const hi = Math.floor(rows[row].hi / binHz);
      return { lo: Math.max(0, lo), hi: Math.min(N / 2, hi), centre: rows[row].centre / binHz };
    });
    // Own gating bands (against the shorter window before this one) and the next window's bands, measured here.
    const ownGate = r > 0 ? active.map((row) => toBins(gateBand(rows[row].centre, resolutions[r - 1].nfft))) : [];
    const nextRows = r + 1 < resolutions.length ? actives[r + 1] : [];
    const nextGate = nextRows.map((row) => toBins(gateBand(rows[row].centre, N)));
    const win = hann(N);
    let wsum = 0;
    let wsq = 0;
    for (let i = 0; i < N; i++) {
      wsum += win[i];
      wsq += win[i] * win[i];
    }
    const norm = 4 / (wsum * wsum);
    const eNorm = 2 / (N * wsq);
    const hop = Math.max(1, Math.round(Math.max(N / 4, spc / 4)));
    const frames = Math.floor((n - 1) / hop) + 1;
    const stride = active.length + ownGate.length + nextGate.length;
    const values = new Float64Array(frames * stride);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const power = new Float64Array(N / 2 + 1);
    const prefix = new Float64Array(N / 2 + 2);
    const bandSum = (b: number[]) => (b[1] >= b[0] ? prefix[b[1] + 1] - prefix[b[0]] : 0);
    for (let j = 0; j < frames; j++) {
      const start = j * hop - N / 2;
      power.fill(0);
      for (const ch of chs) {
        for (let i = 0; i < N; i++) {
          const k = start + i;
          re[i] = k >= 0 && k < n ? ch[k] * win[i] : 0;
          im[i] = 0;
        }
        fft(re, im);
        for (let k = 0; k <= N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
      }
      for (let k = 0; k <= N / 2; k++) prefix[k + 1] = prefix[k] + power[k];
      const o = j * stride;
      for (let a = 0; a < active.length; a++) {
        const b = bins[a];
        let v = 0;
        if (b.hi >= b.lo) {
          for (let k = b.lo; k <= b.hi; k++) if (power[k] > v) v = power[k];
        } else {
          const k0 = Math.min(N / 2, Math.floor(b.centre));
          const k1 = Math.min(N / 2, k0 + 1);
          const f = b.centre - k0;
          v = power[k0] * (1 - f) + power[k1] * f;
        }
        values[o + a] = v * norm;
      }
      for (let g = 0; g < ownGate.length; g++) values[o + active.length + g] = bandSum(ownGate[g]) * eNorm;
      for (let g = 0; g < nextGate.length; g++) values[o + active.length + ownGate.length + g] = bandSum(nextGate[g]) * eNorm;
    }
    // Columns: the mean of the frames centred in them, else interpolated (in dB) between the two nearest.
    const columns = new Float64Array(plotW * stride);
    for (let c = 0; c < plotW; c++) {
      const s0 = c * spc;
      const s1 = (c + 1) * spc;
      const j0 = Math.ceil(s0 / hop);
      const j1 = Math.min(frames - 1, Math.ceil(s1 / hop) - 1);
      const pos = Math.min(frames - 1, (s0 + s1) / 2 / hop);
      const ja = Math.floor(pos);
      const jb = Math.min(frames - 1, ja + 1);
      const f = pos - ja;
      for (let a = 0; a < stride; a++) {
        let v: number;
        if (j1 >= j0) {
          v = 0;
          for (let j = j0; j <= j1; j++) v += values[j * stride + a];
          v /= j1 - j0 + 1;
        } else {
          const va = values[ja * stride + a] + 1e-30;
          const vb = values[jb * stride + a] + 1e-30;
          v = Math.exp(Math.log(va) * (1 - f) + Math.log(vb) * f);
        }
        columns[c * stride + a] = v;
      }
    }
    const ref = new Float64Array(plotW * nextGate.length);
    for (let c = 0; c < plotW; c++) {
      for (let g = 0; g < nextGate.length; g++) ref[c * nextGate.length + g] = columns[c * stride + active.length + ownGate.length + g];
    }
    refColumns.push(ref);
    for (let c = 0; c < plotW; c++) {
      for (let a = 0; a < active.length; a++) {
        let gain = 1;
        if (r > 0) {
          const mine = columns[c * stride + active.length + a];
          const theirs = refColumns[r - 1][c * active.length + a];
          if (mine > 0) gain = Math.min(1, (1.25 * theirs) / mine);
        }
        const row = active[a];
        out[row * plotW + c] += res.weight(rows[row].centre) * gain * columns[c * stride + a];
      }
    }
  });
  return out;
}

export function spectrogram(channels: ArrayLike<number>[], sampleRate: number, opts: SpectrogramOptions = {}): SpectrogramImage {
  const W = Math.max(64, Math.round(opts.width ?? 900));
  const H = Math.max(48, Math.round(opts.height ?? 360));
  const sr = sampleRate;
  const chs = channels.filter((c) => c && c.length > 0);
  const n = chs.length ? Math.min(...chs.map((c) => c.length)) : 0;
  const duration = sr > 0 ? n / sr : 0;
  const canvas = new Canvas(W, H);
  canvas.fill(0, 0, W, H, BG);

  const nyquist = sr / 2;
  const maxHz = Math.min(opts.maxHz ?? 20000, nyquist);
  const minHz = Math.max(1, Math.min(opts.minHz ?? 20, maxHz / 2));
  const rangeDb = Math.max(10, opts.rangeDb ?? 90);
  const waveH = Math.max(0, Math.min(Math.round(opts.waveformHeight ?? H * 0.2), H - 24));
  let labels = opts.labels !== false;
  let gutter = labels ? 30 : 0;
  let axis = labels ? 16 : 0;
  const sep = waveH > 0 ? 2 : 0;
  if (H - waveH - sep - axis < 40 || W - gutter < 100) {
    labels = false;
    gutter = 0;
    axis = 0;
  }
  const plotX = gutter;
  const plotW = W - gutter;
  const specY = waveH + sep;
  const specH = H - specY - axis;

  if (n === 0 || !(sr > 0)) {
    return { width: W, height: H, rgba: canvas.rgba, caption: `Spectrogram ${W}x${H}: empty (no samples).` };
  }

  // Waveform strip.
  let clipped = false;
  if (waveH > 0) {
    const mid = Math.floor(waveH / 2);
    const scale = (waveH / 2 - 2) / 1;
    for (let x = 0; x < plotW; x++) canvas.set(plotX + x, mid, WAVE_ZERO);
    const spc = n / plotW;
    for (let x = 0; x < plotW; x++) {
      const i0 = Math.floor(x * spc);
      const i1 = Math.min(n - 1, Math.max(i0, Math.ceil((x + 1) * spc)));
      let lo = Infinity;
      let hi = -Infinity;
      let sq = 0;
      let count = 0;
      let clip = false;
      for (const ch of chs) {
        for (let i = i0; i <= i1; i++) {
          const v = ch[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          sq += v * v;
          count++;
          if (v >= 0.9999 || v <= -0.9999) clip = true;
        }
      }
      if (clip) clipped = true;
      const rms = Math.sqrt(sq / Math.max(1, count));
      const yTop = Math.max(0, Math.round(mid - Math.min(1, hi) * scale));
      const yBot = Math.min(waveH - 1, Math.round(mid - Math.max(-1, lo) * scale));
      for (let y = yTop; y <= yBot; y++) canvas.set(plotX + x, y, clip ? CLIP : WAVE);
      const rTop = Math.round(mid - Math.min(1, rms) * scale);
      const rBot = Math.round(mid + Math.min(1, rms) * scale);
      if (!clip) for (let y = Math.max(yTop, rTop); y <= Math.min(yBot, rBot); y++) canvas.set(plotX + x, y, WAVE_RMS);
    }
  }

  // Spectrogram.
  const ratio = minHz / maxHz;
  const rowFreq = (y: number) => maxHz * Math.pow(ratio, y / specH);
  const rows = Array.from({ length: specH }, (_, y) => ({ hi: rowFreq(y), lo: rowFreq(y + 1), centre: rowFreq(y + 0.5) }));
  const power = pixelPower(chs, n, sr, plotW, rows);
  let maxP = 0;
  for (let i = 0; i < power.length; i++) if (power[i] > maxP) maxP = power[i];
  const refDb = maxP > 0 ? 10 * Math.log10(maxP) : 0;
  for (let y = 0; y < specH; y++) {
    for (let x = 0; x < plotW; x++) {
      const p = power[y * plotW + x];
      const db = p > 0 ? 10 * Math.log10(p) - refDb : -Infinity;
      const v = Math.max(0, Math.min(1, 1 + db / rangeDb));
      const k = Math.round(v * 255) * 3;
      canvas.set(plotX + x, specY + y, [LUT[k], LUT[k + 1], LUT[k + 2]]);
    }
  }

  // Grid: frequency decades, then time.
  const yOf = (f: number) => specY + Math.round((Math.log(f / maxHz) / Math.log(ratio)) * specH);
  const freqLines = [100, 1000, 10000].filter((f) => f > minHz && f < maxHz);
  for (const f of freqLines) {
    const y = yOf(f);
    for (let x = 0; x < plotW; x++) canvas.lighten(plotX + x, y, 0.2);
  }
  const pxPerSec = plotW / duration;
  const lineStep = STEPS.find((s) => s >= Math.min(0.1, duration / 4) && s * pxPerSec >= 12) ?? STEPS[STEPS.length - 1];
  const labelStep = STEPS.find((s) => s >= lineStep && Math.abs(s / lineStep - Math.round(s / lineStep)) < 1e-9 && s * pxPerSec >= 52) ?? lineStep;
  const timeLines: number[] = [];
  for (let k = 1; k * lineStep < duration - 1e-9; k++) timeLines.push(k * lineStep);
  const isLabelled = (t: number) => Math.abs(t / labelStep - Math.round(t / labelStep)) < 1e-6;
  for (const t of timeLines) {
    const x = plotX + Math.round(t * pxPerSec);
    const strong = isLabelled(t) && labelStep !== lineStep;
    for (let y = specY; y < specY + specH; y++) canvas.lighten(x, y, strong ? 0.26 : 0.16);
    for (let y = 0; y < waveH; y++) canvas.lighten(x, y, strong ? 0.14 : 0.08);
  }

  // Labels.
  if (labels) {
    for (const f of freqLines) {
      const text = formatHzLabel(f);
      const y = Math.min(specY + specH - GLYPH_H, Math.max(specY, yOf(f) - GLYPH_H / 2));
      canvas.text(gutter - 4 - canvas.textWidth(text), y, text, LABEL);
    }
    canvas.text(gutter - 4 - canvas.textWidth('Hz'), specY + 1, 'Hz', LABEL);
    const ty = specY + specH + Math.max(2, Math.floor((axis - GLYPH_H) / 2));
    for (const t of timeLines.filter(isLabelled)) {
      const text = formatTimeLabel(t, labelStep);
      const x = plotX + Math.round(t * pxPerSec) - Math.round(canvas.textWidth(text) / 2);
      canvas.text(Math.min(W - canvas.textWidth(text), Math.max(plotX, x)), ty, text, LABEL);
    }
  }

  const fmtF = (f: number) => (f >= 1000 ? `${Math.round(f / 100) / 10} kHz` : `${Math.round(f)} Hz`);
  const fmtStep = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s} s`);
  const parts = [
    `Spectrogram ${W}x${H} of ${duration.toFixed(3)} s at ${sr} Hz.`,
    waveH > 0
      ? `Top ${waveH} px: the waveform (linear, full scale top to bottom; blue min/max, lighter RMS${clipped ? ', red where it clips' : ''}).`
      : '',
    `Below: time left to right, frequency on a log axis from ${fmtF(minHz)} (bottom) to ${fmtF(maxHz)} (top)` +
      (freqLines.length ? `, faint horizontal lines at ${freqLines.map(fmtF).join(', ')}` : '') +
      (timeLines.length ? `, faint vertical lines every ${fmtStep(lineStep)}` : '') +
      (labels ? ' (labelled at the left and bottom)' : '') +
      '.',
    `Colour is level: black is ${rangeDb} dB or more below the loudest point, then purple, red, orange, and pale yellow at the loudest.`,
  ];
  return { width: W, height: H, rgba: canvas.rgba, caption: parts.filter(Boolean).join(' ') };
}
