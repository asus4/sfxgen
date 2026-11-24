import { describe as group, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { analyze, describeLines, encodePng, spectrogram, type Analysis } from '../src/core/analysis';
import { render, type Patch } from '../src/core';

const SR = 48000;

/** A sine, optionally faded in and out (ms) so its edges don't click. */
function tone(hz: number, seconds: number, amp = 1, opts: { phase?: number; fadeMs?: number; sr?: number } = {}): Float32Array {
  const sr = opts.sr ?? SR;
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + (opts.phase ?? 0));
  const fade = Math.round(((opts.fadeMs ?? 0) / 1000) * sr);
  for (let i = 0; i < fade; i++) {
    x[i] *= i / fade;
    x[n - 1 - i] *= i / fade;
  }
  return x;
}

/** Deterministic white noise (xorshift + Box-Muller). */
function noise(seconds: number, amp: number, seed = 1): Float32Array {
  let s = seed >>> 0 || 1;
  const u = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) + 0.5) / 4294967296;
  };
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  return x;
}

function finiteNumbers(a: Analysis): void {
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'number') expect(Number.isFinite(v), `${path} = ${v}`).toBe(true);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(a, 'analysis');
  expect(JSON.parse(JSON.stringify(a))).toEqual(a);
}

group('analyze', () => {
  it('finds the pitch, centroid and band of a 440 Hz sine', () => {
    const a = analyze([tone(440, 1, 0.5, { fadeMs: 5 })], SR);
    expect(a.pitchHz).not.toBeNull();
    expect(Math.abs(a.pitchHz! - 440)).toBeLessThan(0.5);
    expect(a.pitchClarity).toBeGreaterThan(0.95);
    expect(Math.abs(a.centroidHz - 440)).toBeLessThan(5);
    expect(a.bands.find((b) => b.band.startsWith('low-mid'))!.db).toBeGreaterThan(-0.1);
    expect(a.peaks[0].hz).toBeCloseTo(440, 0);
    expect(a.peakDb).toBeCloseTo(-6.02, 1);
    expect(a.crestDb).toBeCloseTo(3.01, 1);
    finiteNumbers(a);
  });

  it('measures an exponential decay: decay20 = tau ln 10, gone (-60 dB) at tau ln 1000', () => {
    const tau = 0.05;
    const x = tone(1000, 1);
    for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-i / SR / tau);
    const a = analyze([x], SR);
    expect(a.decay20Seconds).toBeCloseTo(tau * Math.log(10), 2);
    expect(Math.abs(a.audibleSeconds - tau * Math.log(1000))).toBeLessThan(0.005);
    expect(a.attackMs).toBeLessThan(1);
    expect(a.tailDb).toBeLessThan(-60);
    expect(a.onsets).toHaveLength(1);
  });

  it('reads a -20 dBFS 1 kHz sine at -23 LUFS (BS.1770) and a stereo -23 dBFS one at -23 LUFS (EBU 3341)', () => {
    const mono = analyze([tone(1000, 3, 0.1)], SR);
    expect(mono.lufs).toBeCloseTo(-23.01, 1);
    expect(mono.rmsDb).toBeCloseTo(-23.01, 1);
    const amp = 10 ** (-23 / 20);
    const stereo = analyze([tone(1000, 3, amp), tone(1000, 3, amp)], SR);
    expect(stereo.lufs).toBeCloseTo(-23, 1);
    expect(stereo.stereoCorrelation).toBeCloseTo(1, 3);
  });

  it('sees a downward sweep in the centroid thirds and the pitch track', () => {
    const n = SR / 2;
    const x = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += (2 * Math.PI * 4000 * Math.pow(200 / 4000, i / n)) / SR;
      x[i] = 0.8 * Math.sin(phase);
    }
    const a = analyze([x], SR);
    const [c0, c1, c2] = a.centroidThirds;
    expect(c0).toBeGreaterThan(c1);
    expect(c1).toBeGreaterThan(c2);
    expect(c0 / c2).toBeGreaterThan(4);
    expect(a.pitchTrack.length).toBeGreaterThan(4);
    expect(a.pitchTrack[0][1]).toBeGreaterThan(4 * a.pitchTrack[a.pitchTrack.length - 1][1]);
    // A constant-level sweep has no attack to speak of.
    expect(a.attackMs).toBeLessThan(1);
    expect(describeLines(a).join(' ')).toMatch(/downward sweep/);
  });

  it('finds the peak between samples (true peak)', () => {
    // fs/4 at 45 degrees: every sample is at 0.707 (-3 dBFS) but the wave peaks at 1 between them.
    const a = analyze([tone(SR / 4, 0.5, 1, { phase: Math.PI / 4, fadeMs: 10 })], SR);
    expect(a.peakDb).toBeCloseTo(-3.01, 1);
    expect(Math.abs(a.truePeakDb)).toBeLessThan(0.1);
    // 12 kHz is above the pitch range: no pitch, rather than a wrong one.
    expect(a.pitchHz).toBeNull();
  });

  it('measures the attack of a 20 ms ramp (10% to 90%: 16 ms)', () => {
    const x = tone(300, 0.5, 0.5);
    for (let i = 0; i < x.length; i++) x[i] *= Math.min(1, i / SR / 0.02);
    const a = analyze([x], SR);
    expect(Math.abs(a.attackMs - 16)).toBeLessThan(1.5);
    expect(a.peakTimeMs).toBeGreaterThan(17);
  });

  it('counts hits, even when they overlap', () => {
    const n = SR / 2;
    const x = new Float32Array(n);
    const starts = [0.02, 0.1, 0.18, 0.26, 0.34];
    for (const t of starts) {
      const at = Math.round(t * SR);
      for (let i = 0; i < 0.06 * SR && at + i < n; i++) x[at + i] += 0.5 * Math.exp(-i / SR / 0.01) * Math.sin((2 * Math.PI * 900 * i) / SR);
    }
    const a = analyze([x], SR);
    expect(a.onsets).toHaveLength(starts.length);
    a.onsets.forEach((t, i) => expect(Math.abs(t - starts[i])).toBeLessThan(0.001));
    expect(describeLines(a).join(' ')).toMatch(/5 hits/);
  });

  it('does not count beating partials as hits', () => {
    // Two partials 30 Hz apart beat 30 times a second as they decay: one strike, not thirty.
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = 0.4 * Math.exp(-t / 0.3) * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 470 * t));
    }
    const a = analyze([x], SR);
    expect(a.onsets).toHaveLength(1);
  });

  it('calls noise unpitched and bright', () => {
    const a = analyze([noise(0.5, 0.2)], SR);
    expect(a.pitchHz).toBeNull();
    expect(a.pitchClarity).toBeLessThan(0.5);
    expect(a.peaks).toEqual([]);
    expect(a.zeroCrossRate).toBeGreaterThan(10000);
    expect(a.centroidHz).toBeGreaterThan(8000);
    expect(describeLines(a).join(' ')).toMatch(/Unpitched/);
  });

  it('reports clipping, DC, clicks and phase problems', () => {
    const l = tone(200, 0.3, 1.2);
    const r = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) {
      l[i] += 0.05;
      r[i] = -l[i];
    }
    const a = analyze([l, r], SR);
    expect(a.clippedSamples).toBeGreaterThan(100);
    expect(a.dcOffset).toBeCloseTo(0.05, 2);
    expect(a.stereoCorrelation).toBeCloseTo(-1, 2);
    expect(a.tailDb).toBeGreaterThan(-3);
    const text = describeLines(a).join('\n');
    expect(text).toMatch(/clipping/);
    expect(text).toMatch(/DC offset/);
    expect(text).toMatch(/out of phase/);
    expect(text).toMatch(/click/);
  });

  it('describes silence, and survives tiny and odd inputs', () => {
    const quiet = analyze([new Float32Array(4800)], SR);
    expect(quiet.peakDb).toBe(-120);
    expect(quiet.lufs).toBe(-120);
    expect(describeLines(quiet)[0]).toMatch(/^Silent/);
    finiteNumbers(quiet);
    finiteNumbers(analyze([], SR));
    finiteNumbers(analyze([Float32Array.from([0.5, -0.5, 0.25])], SR));
    finiteNumbers(analyze([tone(300, 0.2, 0.5, { sr: 8000 })], 8000));
    finiteNumbers(analyze([tone(300, 0.2, 0.5, { sr: 96000 })], 96000));
  });

  it('describes real renders in 4 to 8 short lines', () => {
    const patch: Patch = {
      format: 'sfxgen/1',
      name: 'test',
      duration: 'auto',
      seed: 3,
      tracks: [
        { id: 'body', source: { type: 'osc', wave: 'sine', freq: [[0, 170], [0.09, 55]], env: { attack: 0.001, decay: 0.4 } } },
        { id: 'slap', gain: -6, source: { type: 'noise', color: 'brown', env: { attack: 0.0005, decay: 0.06 } } },
      ],
    };
    const r = render(patch);
    const a = analyze(r.channels, r.sampleRate);
    finiteNumbers(a);
    const lines = describeLines(a);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const line of lines) expect(line.length).toBeLessThan(260);
    expect(lines.join(' ')).toMatch(/Attack/);
    expect(lines.join(' ')).toMatch(/glides down/);
  });
});

group('spectrogram', () => {
  it('renders 900x360 by default and explains itself', () => {
    const img = spectrogram([tone(1000, 0.3, 0.5, { fadeMs: 5 })], SR);
    expect(img.width).toBe(900);
    expect(img.height).toBe(360);
    expect(img.rgba.length).toBe(900 * 360 * 4);
    expect(img.caption).toMatch(/log axis/);
    expect(img.caption).toMatch(/100 Hz, 1 kHz, 10 kHz/);
    expect(img.caption).toMatch(/every 100 ms/);
  });

  it('draws a tone on its row of the log axis', () => {
    const W = 400;
    const H = 300;
    const img = spectrogram([tone(1500, 0.5, 0.5, { fadeMs: 5 })], SR, { width: W, height: H, waveformHeight: 0, labels: false });
    // Rows run from 20 kHz (top) to 20 Hz (bottom) on a log scale.
    const expected = (Math.log(1500 / 20000) / Math.log(20 / 20000)) * H;
    const x = W / 2;
    let best = 0;
    let bestY = -1;
    for (let y = 0; y < H; y++) {
      const o = (y * W + x) * 4;
      const v = img.rgba[o] + img.rgba[o + 1] + img.rgba[o + 2];
      if (v > best) {
        best = v;
        bestY = y;
      }
    }
    expect(Math.abs(bestY - expected)).toBeLessThan(3);
  });

  it('draws the waveform strip, red where it clips', () => {
    const img = spectrogram([tone(200, 0.2, 1.1)], SR, { width: 300, height: 200, waveformHeight: 60 });
    let red = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 300; x++) {
        const o = (y * 300 + x) * 4;
        if (img.rgba[o] > 200 && img.rgba[o + 1] < 100) red++;
      }
    }
    expect(red).toBeGreaterThan(100);
    expect(img.caption).toMatch(/red where it clips/);
  });
});

// ---- PNG, checked with an independent decoder --------------------------------------------------------

function crcBitwise(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(png: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8Array; chunks: string[] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  const chunks: string[] = [];
  while (off < png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const data = png.subarray(off + 8, off + 8 + len);
    expect(view.getUint32(off + 8 + len), `CRC of ${type}`).toBe(crcBitwise(png.subarray(off + 4, off + 8 + len)));
    chunks.push(type);
    if (type === 'IHDR') {
      const h = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      expect(data[8]).toBe(8);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      expect([data[10], data[11], data[12]]).toEqual([0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels] : 0;
      const p = a + b - c;
      const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][filter];
      expect(filter).toBeLessThanOrEqual(4);
      pixels[y * stride + i] = (line[i] + pred) & 0xff;
    }
  }
  return { width, height, channels, pixels, chunks };
}

group('encodePng', () => {
  it('writes a valid RGB PNG with correct CRCs and filtering', async () => {
    const img = spectrogram([tone(440, 0.2, 0.5)], SR, { width: 120, height: 80 });
    const png = await encodePng(img.width, img.height, img.rgba);
    const d = decodePng(png);
    expect(d.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([d.width, d.height, d.channels]).toEqual([120, 80, 3]);
    for (let i = 0, j = 0; i < img.rgba.length; i += 4, j += 3) {
      if (d.pixels[j] !== img.rgba[i] || d.pixels[j + 1] !== img.rgba[i + 1] || d.pixels[j + 2] !== img.rgba[i + 2]) {
        throw new Error(`pixel ${i / 4} differs`);
      }
    }
  });

  it('keeps alpha when a pixel is translucent', async () => {
    const w = 7;
    const h = 5;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff;
    const d = decodePng(await encodePng(w, h, rgba));
    expect(d.channels).toBe(4);
    expect([...d.pixels]).toEqual([...rgba]);
  });

  it('rejects a buffer of the wrong size', async () => {
    await expect(encodePng(4, 4, new Uint8ClampedArray(10))).rejects.toThrow(/expected 64 bytes/);
  });
});
