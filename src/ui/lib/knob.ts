/**
 * Knob math: positions 0..1 against values on a linear or log scale, keyboard steps and value formatting.
 * Pure, so it is tested without a DOM.
 */

export interface KnobRange {
  min: number;
  max: number;
  /** `log` spreads a positive range evenly by ratio; a range touching zero falls back to a cubic curve. */
  scale?: 'linear' | 'log';
  step?: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function isTrueLog(r: KnobRange): boolean {
  return r.scale === 'log' && r.min > 0 && r.max > 0;
}

/** Position 0..1 of a value on the knob's travel. Values outside the range pin to the ends. */
export function valueToPosition(value: number, r: KnobRange): number {
  if (r.max === r.min || !Number.isFinite(value)) return 0;
  if (isTrueLog(r)) return clamp01(Math.log(Math.max(value, 1e-12) / r.min) / Math.log(r.max / r.min));
  const lin = clamp01((value - r.min) / (r.max - r.min));
  // A log-ish parameter whose range starts at zero (an attack time): give the low end most of the travel.
  return r.scale === 'log' ? Math.cbrt(lin) : lin;
}

export function snap(value: number, step: number | undefined, min: number): number {
  if (!step || step <= 0) return value;
  const snapped = min + Math.round((value - min) / step) * step;
  // Trim float noise such as 0.30000000000000004.
  return Number(snapped.toFixed(10));
}

/** The value at a position 0..1, snapped to the step. */
export function positionToValue(position: number, r: KnobRange): number {
  const p = clamp01(position);
  let v: number;
  if (isTrueLog(r)) v = r.min * Math.pow(r.max / r.min, p);
  else if (r.scale === 'log') v = r.min + (r.max - r.min) * p * p * p;
  else v = r.min + (r.max - r.min) * p;
  v = snap(v, r.step, r.min);
  const lo = Math.min(r.min, r.max);
  const hi = Math.max(r.min, r.max);
  return v < lo ? lo : v > hi ? hi : v;
}

export type KnobKey = 'ArrowUp' | 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'PageUp' | 'PageDown' | 'Home' | 'End';

/** Fraction of the travel a key moves: arrows 1%, pages 10%, a tenth of that with Shift. */
export function keyDelta(key: string, fine: boolean): number | 'min' | 'max' | null {
  const k = fine ? 0.1 : 1;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      return 0.01 * k;
    case 'ArrowDown':
    case 'ArrowLeft':
      return -0.01 * k;
    case 'PageUp':
      return 0.1 * k;
    case 'PageDown':
      return -0.1 * k;
    case 'Home':
      return 'min';
    case 'End':
      return 'max';
    default:
      return null;
  }
}

/** The value after a key press, or null when the key is not the knob's. Stepped knobs always move one step. */
export function stepByKey(value: number, key: string, fine: boolean, r: KnobRange): number | null {
  const d = keyDelta(key, fine);
  if (d === null) return null;
  if (d === 'min') return r.min;
  if (d === 'max') return r.max;
  const next = positionToValue(valueToPosition(value, r) + d, r);
  if (r.step && next === snap(value, r.step, r.min)) {
    // The move was smaller than a step: take one whole step so the key always does something.
    const lo = Math.min(r.min, r.max);
    const hi = Math.max(r.min, r.max);
    const dir = (d > 0 ? 1 : -1) * (r.max >= r.min ? 1 : -1);
    return Math.min(hi, Math.max(lo, snap(value + dir * r.step, r.step, r.min)));
  }
  return next;
}

/** Travel for a vertical drag: 180 px for the whole range, ten times that with Shift. */
export function dragToPosition(startPosition: number, dyPx: number, fine: boolean): number {
  return clamp01(startPosition - dyPx / (fine ? 1800 : 180));
}

function sig(v: number, digits: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  const decimals = Math.max(0, Math.min(6, digits - 1 - Math.floor(Math.log10(a))));
  const s = v.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export interface FormattedValue {
  text: string;
  unit: string;
}

/** A value as a person reads it: 1.2 kHz, 85 ms, +3 dB. */
export function formatValue(value: number, unit = ''): FormattedValue {
  if (!Number.isFinite(value)) return { text: '–', unit };
  switch (unit) {
    case 'Hz':
      return Math.abs(value) >= 1000 ? { text: sig(value / 1000, 3), unit: 'kHz' } : { text: sig(value, 3), unit: 'Hz' };
    case 's':
      return Math.abs(value) < 1 ? { text: sig(value * 1000, 3), unit: 'ms' } : { text: sig(value, 3), unit: 's' };
    case 'dB':
    case 'st':
    case 'cents':
      return { text: (value > 0 ? '+' : '') + sig(value, 3), unit };
    default:
      return { text: sig(value, 3), unit };
  }
}

/** Reads what a person typed into a value field: "1.2k", "85ms", "0.3 s", "-6dB". */
export function parseValue(text: string, unit = ''): number | null {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(text);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const suffix = m[2].toLowerCase();
  if (suffix === 'k' || suffix === 'khz') v *= 1000;
  else if (suffix === 'ms' && unit === 's') v /= 1000;
  else if (suffix === 's' && unit === 'ms') v *= 1000;
  return v;
}
