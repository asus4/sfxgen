/** Hooks shared by the canvases and panels. */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { applyControls, metaAt, type Patch } from '../core';
import { useEditor } from './store';

/** The element's size in CSS pixels, kept up to date. */
export function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (Math.abs(s.width - width) < 0.5 && Math.abs(s.height - height) < 0.5 ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The patch as the renderer hears it: every control applied. */
export function useAppliedPatch(): Patch {
  const patch = useEditor((s) => s.patch);
  return useMemo(() => (patch.controls?.length ? applyControls(patch, metaAt).patch : patch), [patch]);
}

/** Sizes a canvas for the screen's pixel density and returns a context scaled to CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/** A value that only changes identity when its JSON does. */
export function useStable<T>(value: T): T {
  const ref = useRef(value);
  const json = JSON.stringify(value);
  const last = useRef(json);
  if (last.current !== json) {
    last.current = json;
    ref.current = value;
  }
  return ref.current;
}

/** Nice tick spacing for a timeline of this length. */
export function timeTicks(duration: number, maxTicks = 8): number[] {
  if (!(duration > 0)) return [];
  const steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
  const step = steps.find((s) => duration / s <= maxTicks) ?? 10;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) out.push(Number(t.toFixed(4)));
  return out;
}
