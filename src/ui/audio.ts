/** Playback through Web Audio: one sound at a time, with a position the playhead can read every frame. */
import type { RenderView } from './renderProtocol';

type Listener = (playing: boolean) => void;

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private length = 0;
  private looping = false;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(playing: boolean): void {
    this.listeners.forEach((fn) => fn(playing));
  }

  /** Call from a click or key press: browsers only start audio after a gesture. */
  async unlock(): Promise<boolean> {
    try {
      this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
      if (this.ctx.state !== 'running') {
        // resume() never settles without a gesture in some browsers; don't wait for it forever.
        await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 250))]);
      }
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  get playing(): boolean {
    return this.node !== null;
  }

  /** Seconds into the sound, or null when stopped. */
  position(): number | null {
    if (!this.node || !this.ctx) return null;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    if (this.looping && this.length > 0) return t % this.length;
    return Math.min(t, this.length);
  }

  async play(view: RenderView, from = 0, loop = false): Promise<boolean> {
    if (!(await this.unlock()) || !this.ctx) return false;
    this.stop(true);
    const ctx = this.ctx;
    const frames = view.channels[0].length;
    if (frames === 0) return false;
    const buffer = ctx.createBuffer(view.channels.length, frames, view.sampleRate);
    view.channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = loop;
    node.connect(ctx.destination);
    const at = Math.max(0, Math.min(from, view.duration - 0.005));
    node.onended = () => {
      if (this.node === node) {
        this.node = null;
        this.emit(false);
      }
    };
    node.start(0, at);
    this.node = node;
    this.startedAt = ctx.currentTime;
    this.offset = at;
    this.length = view.duration;
    this.looping = loop;
    this.emit(true);
    return true;
  }

  stop(silent = false): void {
    const node = this.node;
    if (!node) return;
    this.node = null;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Already stopped.
    }
    if (!silent) this.emit(false);
  }
}

export const player = new Player();
