/**
 * The ink set: calm, mid-light colours that read on the dark display and are never mistaken for the instrument's
 * own signals (LEDs, the agent highlight, a control's colour). Tracks and sound groups take them in this order
 * unless the patch names a colour.
 */
import type { Track } from '../../core';

export const INKS = [
  { name: 'Slate blue', hex: '#7C93C4' },
  { name: 'Sage', hex: '#8DB38B' },
  { name: 'Ochre', hex: '#D0A85C' },
  { name: 'Terracotta', hex: '#C8846A' },
  { name: 'Teal', hex: '#5EA8A7' },
  { name: 'Plum', hex: '#A683B1' },
  { name: 'Sand', hex: '#C7B699' },
  { name: 'Steel', hex: '#8A9BA8' },
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

/**
 * Control colours: each control gets one, and the display shows it where that control acts. A set of its own, so
 * a control's colour is never mistaken for a track's ink.
 */
export const CONTROL_COLORS = ['#35c8ff', '#b4f03a', '#ffb020', '#b79bff', '#ff7a5c', '#5ff0c0'] as const;

export function controlColor(index: number): string {
  return CONTROL_COLORS[((index % CONTROL_COLORS.length) + CONTROL_COLORS.length) % CONTROL_COLORS.length];
}
