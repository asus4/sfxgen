/**
 * Deterministic randomness. Every random choice in a render comes from a stream named after what it is for,
 * so the same patch and seed always give the same samples, and changing one parameter does not reshuffle the
 * randomness of another layer.
 */

/** 32-bit FNV-1a hash of a string, mixed with a seed. */
export function hashString(text: string, seed = 0x811c9dc5): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche, so short keys that differ by one character still land far apart.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** A new independent stream, keyed by a name. */
  fork(...keys: (string | number)[]): Rng {
    return new Rng(hashString(keys.join('/'), this.state));
  }

  /** Uniform in [0, 1). mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform on a log scale: right for frequencies and times. */
  logUniform(lo: number, hi: number): number {
    return Math.exp(this.uniform(Math.log(lo), Math.log(hi)));
  }

  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }

  /** Standard normal (Box-Muller). */
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** ±1 */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Exponential interval with the given mean: the gaps of a Poisson process. */
  exponential(mean: number): number {
    let u = 0;
    while (u <= 1e-12) u = this.next();
    return -Math.log(u) * mean;
  }
}
