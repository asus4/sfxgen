import { describe, expect, it } from 'vitest';
import { positionAt } from '../src/ui/audio';
import { INKS, CONTROL_COLORS } from '../src/ui/lib/inks';

describe('playback position', () => {
  it('advances from the offset and stops at the end of a one-shot', () => {
    const v = { startedAt: 10, offset: 0.2, length: 1, looping: false };
    expect(positionAt(v, 10)).toBeCloseTo(0.2);
    expect(positionAt(v, 10.5)).toBeCloseTo(0.7);
    expect(positionAt(v, 12)).toBe(1);
    // A voice scheduled slightly ahead has not moved yet.
    expect(positionAt(v, 9.99)).toBeCloseTo(0.2);
  });

  it('wraps a loop, so a swap lands on the same place in the cycle', () => {
    const v = { startedAt: 0, offset: 0, length: 4, looping: true };
    expect(positionAt(v, 9.5)).toBeCloseTo(1.5);
    // The swapped-in voice starts where the old one will be at the swap time.
    const when = 9.515;
    const next = { startedAt: when, offset: positionAt(v, when), length: 4, looping: true };
    expect(positionAt(next, 12)).toBeCloseTo(positionAt(v, 12));
  });
});

/** Chroma of a hex colour in HSV terms, 0..1. */
function saturation(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255];
  const max = Math.max(...c);
  return max === 0 ? 0 : (max - Math.min(...c)) / max;
}

describe('colours', () => {
  it('keeps layer inks calm and control colours vivid, so neither is taken for the other', () => {
    for (const ink of INKS) expect(saturation(ink.hex)).toBeLessThan(0.56);
    for (const c of CONTROL_COLORS) expect(saturation(c)).toBeGreaterThan(0.38);
    expect(new Set(INKS.map((i) => i.hex)).size).toBe(INKS.length);
    // The first layer is never pink.
    expect(INKS[0].name).toBe('Slate blue');
  });
});
