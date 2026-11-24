/**
 * The editor's side of the render worker. `live` is for the open patch: one render in flight, and only the newest
 * patch waits behind it, so a fast knob drag never queues a backlog. Everything else is a promise per job.
 * Gallery thumbnails use a second worker so browsing never delays the sound being edited.
 */
import type { Patch } from '../core';
import type { RenderJobOptions, RenderView, SpectrogramGrid, WorkerRequest, WorkerResponse } from './renderProtocol';

type Pending = { resolve: (res: WorkerResponse) => void; reject: (err: Error) => void };
// A request without its id: the client numbers them.
type Body = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

function spawn(): Worker {
  return new Worker(new URL('../worker/render.worker.ts', import.meta.url), { type: 'module', name: 'sfxgen-render' });
}

class Channel {
  private worker: Worker | null = null;
  private jobs = new Map<number, Pending>();
  private next = 1;

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = spawn();
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const job = this.jobs.get(e.data.id);
        if (!job) return;
        this.jobs.delete(e.data.id);
        if (e.data.ok) job.resolve(e.data);
        else job.reject(new Error(e.data.error));
      };
      this.worker.onerror = (e) => {
        for (const job of this.jobs.values()) job.reject(new Error(e.message || 'render worker failed'));
        this.jobs.clear();
      };
    }
    return this.worker;
  }

  send(body: Body): Promise<WorkerResponse> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.ensure().postMessage({ ...body, id } as WorkerRequest);
    });
  }
}

export interface LiveListener {
  onStart(): void;
  onResult(view: RenderView, patch: Patch): void;
  onError(message: string): void;
}

export class RenderClient {
  private main = new Channel();
  private thumbs = new Channel();
  private busy = false;
  private waiting: Patch | null = null;
  private listener: LiveListener | null = null;
  private serial = 0;
  private settled: (() => void)[] = [];

  listen(listener: LiveListener): void {
    this.listener = listener;
  }

  /** Renders the open patch. Called on every change; the newest patch always wins. */
  live(patch: Patch): void {
    if (this.busy) {
      this.waiting = patch;
      return;
    }
    this.busy = true;
    this.listener?.onStart();
    const serial = ++this.serial;
    this.main
      .send({ kind: 'live', patch })
      .then((res) => {
        if (res.ok && res.kind === 'live') this.listener?.onResult({ ...res.view, id: serial }, patch);
      })
      .catch((err: Error) => this.listener?.onError(err.message))
      .finally(() => {
        this.busy = false;
        const next = this.waiting;
        this.waiting = null;
        if (next) this.live(next);
        else this.settled.splice(0).forEach((fn) => fn());
      });
  }

  /** Resolves once no live render is running or waiting: the view on screen matches the patch. */
  idle(): Promise<void> {
    if (!this.busy && !this.waiting) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
  }

  async render(patch: Patch, opts: RenderJobOptions = {}): Promise<RenderView> {
    const res = await this.main.send({ kind: 'render', patch, opts });
    if (res.ok && res.kind === 'render') return res.view;
    throw new Error('render failed');
  }

  async wav(patch: Patch, opts: RenderJobOptions, bitDepth: 16 | 24 | 32): Promise<{ bytes: Uint8Array; duration: number; warnings: string[] }> {
    const res = await this.main.send({ kind: 'wav', patch, opts, bitDepth });
    if (res.ok && res.kind === 'wav') return { bytes: res.bytes, duration: res.duration, warnings: res.warnings };
    throw new Error('export failed');
  }

  /** The spectrogram of the last live render. */
  async spectrogram(width: number, height: number): Promise<SpectrogramGrid | null> {
    const res = await this.main.send({ kind: 'spectro', width, height });
    return res.ok && res.kind === 'spectro' ? res.grid : null;
  }

  async thumb(patch: Patch, bins: number): Promise<{ peaks: Float32Array; duration: number }> {
    const res = await this.thumbs.send({ kind: 'thumb', patch, bins });
    if (res.ok && res.kind === 'thumb') return { peaks: res.peaks, duration: res.duration };
    throw new Error('thumbnail failed');
  }
}

export const renderClient = new RenderClient();
