import type { Rng } from './rng';
import type { Buf } from './math';

export type NoiseColor = 'white' | 'pink' | 'brown' | 'blue' | 'violet' | 'velvet' | 'crackle' | 'digital';

/**
 * Fills a buffer with noise of a colour, at roughly unit RMS (the sparse colours are sparse by design).
 * `density` (events per second, may be a curve) drives `velvet`, `crackle` and `digital`.
 */
export function noise(color: NoiseColor, n: number, sr: number, rng: Rng, density: number | Buf = 2000): Buf {
  const out = new Float64Array(n);
  const dens = (i: number) => (typeof density === 'number' ? density : density[i]);
  switch (color) {
    case 'white':
      for (let i = 0; i < n; i++) out[i] = rng.gauss();
      break;
    case 'pink': {
      // Paul Kellet's refined pink filter on white noise: -3 dB per octave within 0.05 dB.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rng.gauss();
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.29;
        b6 = w * 0.115926;
      }
      break;
    }
    case 'brown': {
      // Leaky integral of white noise: -6 dB per octave, with the leak keeping it from wandering off.
      let y = 0;
      for (let i = 0; i < n; i++) {
        y = 0.997 * y + 0.0775 * rng.gauss();
        out[i] = y;
      }
      break;
    }
    case 'blue':
    case 'violet': {
      // Differentiated pink (blue, +3 dB/oct) or white (violet, +6 dB/oct).
      const src = color === 'blue' ? noise('pink', n, sr, rng) : noise('white', n, sr, rng);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        out[i] = (src[i] - prev) * (color === 'blue' ? 1.6 : 0.72);
        prev = src[i];
      }
      break;
    }
    case 'velvet': {
      // Sparse ±1 impulses, one per grid cell at a random position: smooth-sounding, very cheap noise.
      let i = 0;
      while (i < n) {
        const cell = Math.max(1, Math.round(sr / Math.max(dens(i), 1)));
        const at = i + Math.floor(rng.next() * cell);
        if (at < n) out[at] = rng.sign() * Math.sqrt(cell);
        i += cell;
      }
      break;
    }
    case 'crackle': {
      // Random pops with a heavy-tailed level: vinyl, fire, static.
      for (let i = 0; i < n; i++) {
        if (rng.next() < dens(i) / sr) {
          const level = Math.pow(rng.next(), 3) * 6;
          out[i] = rng.sign() * level;
          if (i + 1 < n) out[i + 1] = -0.5 * out[i];
        }
      }
      break;
    }
    case 'digital': {
      // Sample-and-hold random steps at `density` Hz: bit noise, computer babble.
      let hold = 0;
      let phase = 1;
      for (let i = 0; i < n; i++) {
        phase += dens(i) / sr;
        if (phase >= 1) {
          phase -= Math.floor(phase);
          hold = rng.uniform(-1, 1) * 1.7;
        }
        out[i] = hold;
      }
      break;
    }
  }
  return out;
}

/** Smooth random curve with unit-ish deviation and nothing faster than `rate` Hz: drift, flutter, wobble. */
export function wander(n: number, sr: number, rate: number, rng: Rng): Buf {
  const out = new Float64Array(n);
  // Random targets every half period, joined by cosine segments.
  const step = Math.max(2, Math.round(sr / Math.max(rate * 2, 0.01)));
  let a = rng.gauss() * 0.8;
  let b = rng.gauss() * 0.8;
  let k = Math.floor(rng.next() * step);
  for (let i = 0; i < n; i++) {
    const x = k / step;
    out[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * x));
    k++;
    if (k >= step) {
      k = 0;
      a = b;
      b = rng.gauss() * 0.8;
    }
  }
  return out;
}
