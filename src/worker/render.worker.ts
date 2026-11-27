/**
 * The editor's render worker. A render blocks it, so the client keeps one live request in flight and only the newest
 * patch waiting. The TrackCache here lets a knob on one track re-render that track alone.
 */
import { TrackCache, encodeWav, loudness, render, type Patch, type RenderResult } from '../core';
import { magnitudeSpectrum } from '../core/dsp/fft';
import { computePeaks } from '../ui/lib/peaks';
import type { RenderJobOptions, RenderView, SpectrogramGrid, WorkerRequest, WorkerResponse } from '../ui/renderProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cache = new TrackCache(64);
/** Mono mixdown of the last live render, kept for the spectrogram. */
let lastMix: { id: number; samples: Float32Array; sampleRate: number } | null = null;

function toView(id: number, r: RenderResult): RenderView {
  return {
    id,
    sampleRate: r.sampleRate,
    channels: r.channels,
    duration: r.duration,
    tracks: (r.tracks ?? []).map((t) => ({ id: t.id, start: t.start, buffer: t.buffer, peak: t.peak })),
    warnings: r.warnings,
    normalizeGainDb: r.normalizeGainDb,
    timeMs: r.timeMs,
  };
}

function buffersOf(view: RenderView): ArrayBuffer[] {
  return [...view.channels.map((c) => c.buffer as ArrayBuffer), ...view.tracks.map((t) => t.buffer.buffer as ArrayBuffer)];
}

function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0].slice();
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) out[i] = (channels[0][i] + channels[1][i]) * 0.5;
  return out;
}

function scale(buffers: Float32Array[], gainDb: number): void {
  if (!gainDb) return;
  const g = Math.pow(10, gainDb / 20);
  for (const b of buffers) for (let i = 0; i < b.length; i++) b[i] *= g;
}

function peakDb(channels: Float32Array[]): number {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > p) p = Math.abs(ch[i]);
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

function job(patch: Patch, opts: RenderJobOptions): RenderResult {
  return render(patch, { sampleRate: opts.sampleRate, channels: opts.channels, keepTracks: opts.keepTracks });
}

/** A log-frequency spectrogram, `width` columns by `height` rows, as levels 0..255. */
function spectrogram(samples: Float32Array, sampleRate: number, width: number, height: number, id: number): SpectrogramGrid {
  const size = 1024;
  const half = size / 2;
  const minHz = 40;
  const maxHz = Math.min(20000, sampleRate / 2);
  const mags = new Float32Array(width * height);
  const frame = new Float64Array(size);
  // Row -> fractional FFT bin range.
  const edges = new Float64Array(height + 1);
  for (let r = 0; r <= height; r++) edges[r] = ((minHz * Math.pow(maxHz / minHz, r / height)) / sampleRate) * size;
  let top = 1e-9;
  for (let x = 0; x < width; x++) {
    const centre = Math.round(((x + 0.5) / width) * samples.length);
    for (let i = 0; i < size; i++) {
      const s = centre - half + i;
      frame[i] = s >= 0 && s < samples.length ? samples[s] : 0;
    }
    const spec = magnitudeSpectrum(frame);
    for (let r = 0; r < height; r++) {
      const lo = edges[r];
      const hi = edges[r + 1];
      let m = 0;
      if (hi - lo < 1) {
        // Narrower than one bin: interpolate.
        const c = (lo + hi) / 2;
        const i0 = Math.min(half - 1, Math.floor(c));
        const f = c - i0;
        m = spec[i0] * (1 - f) + spec[i0 + 1] * f;
      } else {
        for (let i = Math.floor(lo); i < Math.min(half, Math.ceil(hi)); i++) if (spec[i] > m) m = spec[i];
      }
      mags[(height - 1 - r) * width + x] = m;
      if (m > top) top = m;
    }
  }
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const db = 20 * Math.log10(mags[i] / top + 1e-9);
    data[i] = Math.max(0, Math.min(255, Math.round(((db + 80) / 80) * 255)));
  }
  return { id, width, height, data, minHz, maxHz };
}

function handle(req: WorkerRequest): { res: WorkerResponse; transfer: ArrayBuffer[] } {
  switch (req.kind) {
    case 'live': {
      const r = render(req.patch, { keepTracks: true, cache });
      scale([...r.channels, ...(r.tracks ?? []).map((t) => t.buffer)], req.gainDb);
      lastMix = { id: req.id, samples: mono(r.channels), sampleRate: r.sampleRate };
      const view = toView(req.id, r);
      return { res: { kind: 'live', id: req.id, ok: true, view }, transfer: buffersOf(view) };
    }
    case 'render': {
      const view = toView(req.id, job(req.patch, req.opts));
      return { res: { kind: 'render', id: req.id, ok: true, view }, transfer: buffersOf(view) };
    }
    case 'wav': {
      const r = job(req.patch, req.opts);
      scale(r.channels, req.gainDb);
      const bytes = encodeWav(r.channels, r.sampleRate, req.bitDepth);
      const pk = peakDb(r.channels);
      const warnings = pk > 0 ? [...r.warnings, `peaks at ${pk.toFixed(1)} dBFS: it will clip`] : r.warnings;
      return {
        res: { kind: 'wav', id: req.id, ok: true, bytes, duration: r.duration, warnings, peakDb: pk, lufs: loudness(r.channels, r.sampleRate).integrated },
        transfer: [bytes.buffer as ArrayBuffer],
      };
    }
    case 'sound': {
      const r = render(req.patch, {});
      const view = toView(req.id, r);
      const peaks = computePeaks(mono(r.channels), r.sampleRate, 0, r.duration, req.bins).data;
      return {
        res: { kind: 'sound', id: req.id, ok: true, view, lufs: loudness(r.channels, r.sampleRate).integrated, peakDb: peakDb(r.channels), peaks },
        transfer: [...buffersOf(view), peaks.buffer as ArrayBuffer],
      };
    }
    case 'thumb': {
      // Half the sample rate is plenty for a picture this small.
      const r = render(req.patch, { sampleRate: 24000, channels: 1 });
      const peaks = computePeaks(r.channels[0], r.sampleRate, 0, r.duration, req.bins).data;
      return { res: { kind: 'thumb', id: req.id, ok: true, peaks, duration: r.duration }, transfer: [peaks.buffer as ArrayBuffer] };
    }
    case 'spectro': {
      const grid = lastMix ? spectrogram(lastMix.samples, lastMix.sampleRate, req.width, req.height, lastMix.id) : null;
      return { res: { kind: 'spectro', id: req.id, ok: true, grid }, transfer: grid ? [grid.data.buffer as ArrayBuffer] : [] };
    }
  }
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    const { res, transfer } = handle(req);
    scope.postMessage(res, transfer);
  } catch (err) {
    const res: WorkerResponse = { kind: req.kind, id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(res);
  }
};
