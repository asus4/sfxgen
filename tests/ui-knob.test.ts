import { describe, expect, it } from 'vitest';
import { dragToPosition, formatValue, keyDelta, parseValue, positionToValue, snap, stepByKey, valueToPosition } from '../src/ui/lib/knob';

describe('knob positions', () => {
  it('maps a linear range both ways', () => {
    const r = { min: -24, max: 24 };
    expect(valueToPosition(0, r)).toBeCloseTo(0.5);
    expect(positionToValue(0.25, r)).toBeCloseTo(-12);
    expect(valueToPosition(99, r)).toBe(1);
    expect(valueToPosition(-99, r)).toBe(0);
  });

  it('spreads a log range by ratio', () => {
    const r = { min: 20, max: 20000, scale: 'log' as const };
    expect(positionToValue(0.5, r)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
    expect(valueToPosition(200, r)).toBeCloseTo(1 / 3, 5);
    for (const p of [0, 0.1, 0.37, 0.9, 1]) expect(valueToPosition(positionToValue(p, r), r)).toBeCloseTo(p, 6);
  });

  it('gives a log range that starts at zero a usable low end', () => {
    const r = { min: 0, max: 2, scale: 'log' as const };
    expect(positionToValue(0, r)).toBe(0);
    expect(positionToValue(1, r)).toBe(2);
    expect(positionToValue(0.5, r)).toBeCloseTo(0.25);
    for (const p of [0.2, 0.5, 0.8]) expect(valueToPosition(positionToValue(p, r), r)).toBeCloseTo(p, 6);
  });

  it('handles a reversed range and a flat one', () => {
    expect(positionToValue(0.25, { min: 10, max: 0 })).toBeCloseTo(7.5);
    expect(valueToPosition(7.5, { min: 10, max: 0 })).toBeCloseTo(0.25);
    expect(valueToPosition(3, { min: 3, max: 3 })).toBe(0);
  });

  it('snaps to the step without float noise', () => {
    expect(snap(0.30000000000000004, 0.1, 0)).toBe(0.3);
    expect(positionToValue(0.52, { min: 1, max: 9, step: 1 })).toBe(5);
    expect(snap(7.4, undefined, 0)).toBe(7.4);
  });
});

describe('knob keys and drags', () => {
  const r = { min: 0, max: 100 };
  it('moves 1% per arrow, 10% per page, a tenth with Shift', () => {
    expect(stepByKey(50, 'ArrowUp', false, r)).toBeCloseTo(51);
    expect(stepByKey(50, 'ArrowLeft', false, r)).toBeCloseTo(49);
    expect(stepByKey(50, 'PageDown', false, r)).toBeCloseTo(40);
    expect(stepByKey(50, 'ArrowUp', true, r)).toBeCloseTo(50.1);
    expect(stepByKey(50, 'Home', false, r)).toBe(0);
    expect(stepByKey(50, 'End', false, r)).toBe(100);
    expect(stepByKey(50, 'a', false, r)).toBeNull();
    expect(keyDelta('Tab', false)).toBeNull();
  });

  it('always moves a stepped knob by at least one step, and stops at the ends', () => {
    const stepped = { min: 1, max: 64, step: 1 };
    expect(stepByKey(3, 'ArrowUp', false, stepped)).toBe(4);
    expect(stepByKey(3, 'ArrowDown', true, stepped)).toBe(2);
    expect(stepByKey(64, 'ArrowUp', false, stepped)).toBe(64);
    expect(stepByKey(1, 'ArrowDown', false, stepped)).toBe(1);
  });

  it('drags the whole travel in 180 px, ten times finer with Shift', () => {
    expect(dragToPosition(0.5, -90, false)).toBeCloseTo(1);
    expect(dragToPosition(0.5, 90, true)).toBeCloseTo(0.45);
    expect(dragToPosition(0.1, 400, false)).toBe(0);
  });
});

describe('value text', () => {
  it('formats in the unit a person reads', () => {
    expect(formatValue(1200, 'Hz')).toEqual({ text: '1.2', unit: 'kHz' });
    expect(formatValue(440, 'Hz')).toEqual({ text: '440', unit: 'Hz' });
    expect(formatValue(0.085, 's')).toEqual({ text: '85', unit: 'ms' });
    expect(formatValue(1.5, 's')).toEqual({ text: '1.5', unit: 's' });
    expect(formatValue(3, 'dB')).toEqual({ text: '+3', unit: 'dB' });
    expect(formatValue(-6.25, 'dB')).toEqual({ text: '-6.25', unit: 'dB' });
    expect(formatValue(0.5)).toEqual({ text: '0.5', unit: '' });
    expect(formatValue(0)).toEqual({ text: '0', unit: '' });
    expect(formatValue(NaN, 'Hz').text).toBe('–');
  });

  it('parses what a person types', () => {
    expect(parseValue('1.2k', 'Hz')).toBe(1200);
    expect(parseValue('85ms', 's')).toBeCloseTo(0.085);
    expect(parseValue(' -6 dB ', 'dB')).toBe(-6);
    expect(parseValue('.5')).toBe(0.5);
    expect(parseValue('abc')).toBeNull();
    expect(parseValue('')).toBeNull();
  });
});
