import { describe, expect, it } from 'vitest';
import { ICON_BOUNDS, ICON_PATHS, Icon } from '../src/ui/components/Icon';

describe('icons', () => {
  it('knows where every icon is drawn, inside its 24-unit grid', () => {
    expect(Object.keys(ICON_BOUNDS).sort()).toEqual(Object.keys(ICON_PATHS).sort());
    for (const [name, [x0, y0, x1, y1]] of Object.entries(ICON_BOUNDS)) {
      expect(x0, name).toBeGreaterThanOrEqual(0);
      expect(y0, name).toBeGreaterThanOrEqual(0);
      expect(x1, name).toBeLessThanOrEqual(24);
      expect(y1, name).toBeLessThanOrEqual(24);
      expect(x1, name).toBeGreaterThanOrEqual(x0);
      expect(y1, name).toBeGreaterThanOrEqual(y0);
    }
  });

  it('lays an icon out by its ink, at the same scale for every icon', () => {
    // The grid is drawn from 4 to 20; with the 2-unit stroke its box is 18 units, so 12 px at 16 px a grid.
    const grid = Icon({ name: 'grid', size: 16 }).props as { width: number; height: number; viewBox: string };
    expect(grid.viewBox).toBe('3 3 18 18');
    expect(grid.width).toBe(12);
    expect(grid.height).toBe(12);
    // A chevron is short: its box is only as tall as its ink.
    const down = Icon({ name: 'down', size: 24 }).props as { height: number };
    expect(down.height).toBe(8);
    // The play triangle keeps a little room on its left, so it reads as centred in a round button.
    const play = Icon({ name: 'play', size: 24, fill: true }).props as { viewBox: string };
    const [x, , w] = play.viewBox.split(' ').map(Number);
    expect(7 - x).toBeGreaterThan(20 + 0.75 - (x + w) + 1);
  });
});
