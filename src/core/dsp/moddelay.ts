/**
 * A fractional delay line for modulated delays (chorus, flanger, the Haas delay in width): a power-of-two ring
 * buffer read with 4-point cubic (Catmull-Rom) interpolation, so a sweeping delay time glides without zipper
 * noise. Write the new sample after reading, so a feedback path can use what it read.
 */
export class ModDelayLine {
  private readonly buf: Float64Array;
  private readonly mask: number;
  private w = 0;

  /** `maxDelay` in samples: the longest delay that will be read. */
  constructor(maxDelay: number) {
    let size = 16;
    while (size < maxDelay + 8) size <<= 1;
    this.buf = new Float64Array(size);
    this.mask = size - 1;
  }

  /** The longest delay this line can read, in samples. */
  get capacity(): number {
    return this.buf.length - 4;
  }

  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /**
   * The input from `d` samples before the next write (fractional; 2 samples at least, so the interpolation never
   * reaches a sample that has not been written yet).
   */
  read(d: number): number {
    const cap = this.buf.length - 4;
    const dd = d < 2 ? 2 : d > cap ? cap : d;
    const pos = this.w - dd;
    const i = Math.floor(pos);
    const f = pos - i;
    const m = this.mask;
    const b = this.buf;
    const xm1 = b[(i - 1) & m];
    const x0 = b[i & m];
    const x1 = b[(i + 1) & m];
    const x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
}
