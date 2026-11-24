/** Messages between the editor and its render worker (src/worker/render.worker.ts). */
import type { Patch } from '../core';

export interface RenderedTrack {
  id: string;
  start: number;
  buffer: Float32Array;
  peak: number;
}

/** A finished render as the editor keeps it. */
export interface RenderView {
  /** Counts up with every live render request; results never arrive out of order. */
  id: number;
  sampleRate: number;
  channels: Float32Array[];
  duration: number;
  tracks: RenderedTrack[];
  warnings: string[];
  normalizeGainDb: number;
  timeMs: number;
}

export interface SpectrogramGrid {
  id: number;
  width: number;
  height: number;
  /** Row-major, top row is the highest frequency; 0 is -80 dB under the loudest bin, 255 the loudest. */
  data: Uint8Array;
  minHz: number;
  maxHz: number;
}

export interface RenderJobOptions {
  sampleRate?: number;
  channels?: 1 | 2;
  keepTracks?: boolean;
}

export type WorkerRequest =
  | { kind: 'live'; id: number; patch: Patch }
  | { kind: 'render'; id: number; patch: Patch; opts: RenderJobOptions }
  | { kind: 'wav'; id: number; patch: Patch; opts: RenderJobOptions; bitDepth: 16 | 24 | 32 }
  | { kind: 'thumb'; id: number; patch: Patch; bins: number }
  | { kind: 'spectro'; id: number; width: number; height: number };

export type WorkerResponse =
  | { kind: 'live'; id: number; ok: true; view: RenderView }
  | { kind: 'render'; id: number; ok: true; view: RenderView }
  | { kind: 'wav'; id: number; ok: true; bytes: Uint8Array; duration: number; warnings: string[] }
  | { kind: 'thumb'; id: number; ok: true; peaks: Float32Array; duration: number }
  | { kind: 'spectro'; id: number; ok: true; grid: SpectrogramGrid | null }
  | { kind: WorkerRequest['kind']; id: number; ok: false; error: string };
