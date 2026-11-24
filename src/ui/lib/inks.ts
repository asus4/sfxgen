/** The riso ink set. Tracks take inks in this order unless the patch names a colour. */
import type { Track } from '../../core';

export const INKS = [
  { name: 'Fluorescent pink', hex: '#FF48B0' },
  { name: 'Blue', hex: '#0078BF' },
  { name: 'Yellow', hex: '#FFE800' },
  { name: 'Teal', hex: '#00838A' },
  { name: 'Orange', hex: '#FF6C2F' },
  { name: 'Green', hex: '#00A95C' },
  { name: 'Purple', hex: '#765BA7' },
  { name: 'Red', hex: '#FF665E' },
] as const;

export function inkAt(index: number): string {
  return INKS[((index % INKS.length) + INKS.length) % INKS.length].hex;
}

export function trackInk(track: Track, index: number): string {
  return typeof track.color === 'string' && track.color ? track.color : inkAt(index);
}

/** Is black or white text more readable on this ink? */
export function textOn(hex: string): '#111' | '#fff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#111';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.5 ? '#111' : '#fff';
}
