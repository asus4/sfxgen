/**
 * In-place radix-2 complex FFT, and the convolution and spectrum helpers built on it. Sizes must be powers of 2.
 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/** Forward (inverse = false) or inverse FFT of (re, im), in place. The inverse is scaled by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  // Bit reversal.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Linear convolution of a signal with an impulse response, `x.length + h.length - 1` samples long. */
export function convolve(x: Float64Array, h: Float64Array): Float64Array {
  const outLen = x.length + h.length - 1;
  if (h.length <= 64 || x.length <= 64) {
    const out = new Float64Array(outLen);
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      if (xi === 0) continue;
      for (let j = 0; j < h.length; j++) out[i + j] += xi * h[j];
    }
    return out;
  }
  const n = nextPow2(outLen);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  return ar.subarray(0, outLen).slice();
}

/** Circular convolution of two equal-length signals: keeps a loop exactly periodic. */
export function convolveCircular(x: Float64Array, h: Float64Array): Float64Array {
  const n = x.length;
  // Fold the response onto the loop length, then convolve via a size that holds both without wrapping twice.
  const folded = new Float64Array(n);
  for (let i = 0; i < h.length; i++) folded[i % n] += h[i];
  const size = nextPow2(2 * n);
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  ar.set(x);
  br.set(folded);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  const out = new Float64Array(n);
  for (let i = 0; i < 2 * n - 1; i++) out[i % n] += ar[i];
  return out;
}

/** Magnitude spectrum of one Hann-windowed frame (length must be a power of 2). Returns n/2 + 1 bins. */
export function magnitudeSpectrum(frame: ArrayLike<number>): Float64Array {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}
