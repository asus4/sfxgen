/**
 * Playback through Web Audio: one sound at a time, with a position the playhead can read every frame. A sound
 * that changes while it plays is swapped in at the same position with a short crossfade, so a loop keeps looping.
 */
import type { RenderView } from './renderProtocol';

type Listener = (playing: boolean) => void;

interface Voice {
  node: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time at which `offset` seconds of the sound are heard. */
  startedAt: number;
  offset: number;
  length: number;
  looping: boolean;
  level: number;
}

/** Seconds: long enough to hide the seam, short enough to feel instant. */
const FADE = 0.012;
/** Seconds ahead that a swap is scheduled, so both buffers change on the same sample. */
const AHEAD = 0.015;

const toGain = (db: number) => Math.pow(10, db / 20);

export class Player {
  private ctx: AudioContext | null = null;
  private voice: Voice | null = null;
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
    return this.voice !== null;
  }

  get looping(): boolean {
    return !!this.voice?.looping;
  }

  /** Seconds into the sound, or null when stopped. */
  position(): number | null {
    const v = this.voice;
    if (!v || !this.ctx) return null;
    return positionAt(v, this.ctx.currentTime);
  }

  private start(ctx: AudioContext, view: RenderView, at: number, when: number, loop: boolean, gainDb: number, fadeIn: boolean): Voice | null {
    const frames = view.channels[0].length;
    if (frames === 0) return null;
    const buffer = ctx.createBuffer(view.channels.length, frames, view.sampleRate);
    view.channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = loop;
    const gain = ctx.createGain();
    const level = toGain(gainDb);
    if (fadeIn) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level, when + FADE);
    } else gain.gain.value = level;
    node.connect(gain).connect(ctx.destination);
    const voice: Voice = { node, gain, startedAt: when, offset: at, length: view.duration, looping: loop, level };
    node.onended = () => {
      if (this.voice === voice) {
        this.voice = null;
        this.emit(false);
      }
    };
    node.start(when, at);
    return voice;
  }

  private release(voice: Voice, when: number): void {
    voice.node.onended = null;
    try {
      voice.gain.gain.cancelScheduledValues(when);
      voice.gain.gain.setValueAtTime(voice.level, when);
      voice.gain.gain.linearRampToValueAtTime(0, when + FADE);
      voice.node.stop(when + FADE + 0.005);
    } catch {
      // Already stopped.
    }
  }

  /** `gainDb` is applied on the way out, for sounds whose project gain is not in the buffer. */
  async play(view: RenderView, from = 0, loop = false, gainDb = 0): Promise<boolean> {
    if (!(await this.unlock()) || !this.ctx) return false;
    this.stop(true);
    const at = Math.max(0, Math.min(from, view.duration - 0.005));
    const voice = this.start(this.ctx, view, at, this.ctx.currentTime, loop, gainDb, false);
    if (!voice) return false;
    this.voice = voice;
    this.emit(true);
    return true;
  }

  /**
   * Replaces what is playing with a new version of the same sound, at the same position: both change on one
   * sample, crossfaded over a few milliseconds. A one-shot that is now shorter than where playback had got to
   * simply ends. Returns false when nothing was playing.
   */
  swap(view: RenderView, loop: boolean, gainDb = 0): boolean {
    const old = this.voice;
    const ctx = this.ctx;
    if (!old || !ctx) return false;
    const when = ctx.currentTime + AHEAD;
    let at = positionAt(old, when);
    if (loop && view.duration > 0) at %= view.duration;
    this.release(old, when);
    const voice = at < view.duration - 0.004 ? this.start(ctx, view, at, when, loop, gainDb, true) : null;
    this.voice = voice;
    if (!voice) this.emit(false);
    return !!voice;
  }

  /** Changes the level of what is playing (a fader moved), without a click. */
  setGain(gainDb: number): void {
    const v = this.voice;
    if (!v || !this.ctx) return;
    v.level = toGain(gainDb);
    v.gain.gain.setTargetAtTime(v.level, this.ctx.currentTime, 0.01);
  }

  /** Resolves when the sound that is playing now ends or is stopped. */
  whenEnded(): Promise<void> {
    if (!this.voice) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe((playing) => {
        if (playing) return;
        off();
        resolve();
      });
    });
  }

  stop(silent = false): void {
    const voice = this.voice;
    if (!voice || !this.ctx) return;
    this.voice = null;
    this.release(voice, this.ctx.currentTime);
    if (!silent) this.emit(false);
  }
}

/** Where a voice is in its sound at a context time. Exported for tests. */
export function positionAt(v: Pick<Voice, 'startedAt' | 'offset' | 'length' | 'looping'>, time: number): number {
  const t = v.offset + Math.max(0, time - v.startedAt);
  if (v.looping && v.length > 0) return t % v.length;
  return Math.min(t, v.length);
}

export const player = new Player();
