/**
 * What a source or effect type declares about itself. The metadata is the single source of truth for
 * validation, the editor's controls, the agent guide (`sfxgen guide`) and the JSON Schema.
 */
import type { Envelope, ParamValue } from './format/types';
import type { Rng } from './dsp/rng';
import type { Buf } from './dsp/math';

export type ParamKind =
  /** A number that may move over time (constant, breakpoints, or a signal object). */
  | 'signal'
  /** A plain number fixed for the whole event. */
  | 'number'
  | 'enum'
  | 'bool'
  | 'string'
  /** An amplitude envelope (ADSR or points). */
  | 'envelope'
  /** A nested group of parameters (`fields`). */
  | 'object'
  /** A list; `item` describes each entry. */
  | 'array';

export type Unit = 'Hz' | 's' | 'ms' | 'dB' | 'st' | 'cents' | '%' | 'x' | '' | 'LUFS' | 'dBFS' | 'm' | 'm/s' | 'rpm';

export interface ParamMeta {
  kind: ParamKind;
  /** Short label for the editor. Defaults to the parameter name. */
  label?: string;
  /** One or two sentences on what it does to the sound. Agents read these. */
  doc: string;
  /** A few plain words for people, about what they will hear: the editor's tooltip. `doc` stays the agents' (and seeds
   * nested random streams, so it must not change for this). */
  hint?: string;
  default?: unknown;
  /** Soft range: the editor's knob range and the default mapping for controls. */
  min?: number;
  max?: number;
  /** Hard limits the renderer clamps to, so no value can blow up a filter. Default: none. */
  hardMin?: number;
  hardMax?: number;
  step?: number;
  unit?: Unit;
  /** `log` for frequencies and times: knobs spread evenly by ratio and breakpoints glide exponentially. */
  scale?: 'linear' | 'log';
  /** Multiplied by the voice's pitch (transposition, `pitch` param, event pitch). */
  pitch?: boolean;
  options?: readonly string[];
  fields?: Record<string, ParamMeta>;
  item?: ParamMeta;
  /** Hidden from the editor's default views. */
  advanced?: boolean;
}

export type ParamMap = Record<string, ParamMeta>;

export type NodeCategory =
  | 'tone'
  | 'noise'
  | 'physical'
  | 'texture'
  | 'voice'
  | 'machine'
  | 'filter'
  | 'dynamics'
  | 'color'
  | 'time'
  | 'space'
  | 'modulation'
  | 'pitch'
  | 'utility';

interface NodeDefBase {
  type: string;
  label: string;
  category: NodeCategory;
  /** What it is and when to reach for it, for agents. */
  doc: string;
  /** What it is, in a few plain words for people: the editor's tooltip. */
  hint?: string;
  params: ParamMap;
  /** A minimal working example of this node's spec, shown in the guide. */
  example?: Record<string, unknown>;
}

/** Everything a source needs to render one event. */
export interface VoiceContext {
  sr: number;
  /** Samples to render. */
  n: number;
  /** Seconds the note is held (`dur`), or Infinity. */
  gate: number;
  /** 0..1 */
  vel: number;
  /** Deterministic randomness for this voice. Fork it per purpose: `ctx.rng.fork('grains')`. */
  rng: Rng;
  /**
   * Per-sample pitch ratio from the voice's transposition and `pitch` parameter. Pitched parameters compiled with
   * `ctx.signal` are already multiplied by it.
   */
  pitchRatio: Buf;
  /** Compiles a parameter of this source to a per-sample curve, applying its metadata (pitch, clamps, curve). */
  signal(name: string, value?: ParamValue): Buf;
  /** A parameter as one number: its value at the start of the event. */
  num(name: string, value?: ParamValue): number;
  /**
   * Compiles any ParamValue against explicit metadata (for nested fields such as an FM operator's index). `key`
   * names its random stream, so two nested signals with modulators don't share one.
   */
  signalOf(value: ParamValue | undefined, meta: ParamMeta, key?: string): Buf;
  numOf(value: ParamValue | undefined, meta: ParamMeta): number;
  /** Reports a problem to the person or agent rendering the patch (shown with the render's warnings). */
  warn(message: string): void;
}

export interface SourceDef extends NodeDefBase {
  kind: 'source';
  /** The envelope used when the spec gives none. */
  defaultEnv: Envelope;
  /** Seconds the source rings on its own once struck, for `duration: "auto"`. Default: from the envelope. */
  naturalLength?(params: Record<string, unknown>): number;
  /**
   * Renders one event before the common voice stage (filter, envelope, gain, velocity), which the engine applies.
   * Return one channel, or two for a stereo source.
   */
  render(params: Record<string, unknown>, ctx: VoiceContext): Buf | [Buf, Buf];
}

/** Everything an effect needs to process a whole track, bus or master buffer. */
export interface FxContext {
  sr: number;
  /** Deterministic randomness for this effect instance. */
  rng: Rng;
  /** True when the patch is a loop: effects with memory should treat the buffer as circular where they can. */
  loop: boolean;
  /** Compiles a parameter to a per-sample curve over `n` samples, from the start of the buffer. */
  signal(name: string, n: number, value?: ParamValue): Buf;
  num(name: string, value?: ParamValue): number;
  /** Compiles a nested field (such as one EQ band's `freq`) against explicit metadata, over `n` samples. */
  signalOf(value: ParamValue | undefined, meta: ParamMeta, n: number, key?: string): Buf;
  numOf(value: ParamValue | undefined, meta: ParamMeta): number;
  /** Reports a problem to the person or agent rendering the patch (shown with the render's warnings). */
  warn(message: string): void;
}

export interface EffectDef extends NodeDefBase {
  kind: 'effect';
  /** Seconds of sound the effect can add after the input stops (reverb and delay tails). */
  tail?(params: Record<string, unknown>): number;
  /**
   * Seconds of output for `seconds` of input, for effects that stretch or shrink time (varispeed, Doppler).
   * Used by `duration: "auto"`; when absent the output lasts `seconds + tail(params)`.
   */
  length?(params: Record<string, unknown>, seconds: number): number;
  /** Does the effect make stereo from mono (so the engine should give it two channels when output is stereo)? */
  widens?: boolean;
  /**
   * Processes 1 or 2 channels and returns the result (same channel count unless `widens`; the length may change
   * for time effects). May work in place. The engine applies the wet/dry `mix` afterwards.
   */
  process(input: Buf[], params: Record<string, unknown>, ctx: FxContext): Buf[];
}

export type NodeDef = SourceDef | EffectDef;

/** Common parameters every source has, besides its own. */
export const COMMON_SOURCE_PARAMS: ParamMap = {
  gain: { kind: 'number', doc: 'Level of this source in dB.', hint: 'Level of this source', default: 0, min: -48, max: 12, unit: 'dB' },
  env: {
    kind: 'envelope',
    doc: 'Amplitude envelope: { attack, hold, decay, sustain, release, gate } in seconds, or { points: [[t, level], ...] }.',
    hint: 'How the level rises and falls',
  },
  pitch: {
    kind: 'signal',
    doc: 'Semitones added to every pitched parameter. Breakpoints make a whole-voice pitch sweep, and like every voice parameter they start again with each event; to play a melody across events, give each event its own `pitch`.',
    hint: 'Shift every pitch up or down',
    default: 0,
    min: -48,
    max: 48,
    unit: 'st',
  },
  filter: {
    kind: 'object',
    doc: 'Per-voice filter, applied before the envelope, so every event gets its own sweep.',
    hint: 'A filter on each event, so every hit gets its own sweep',
    fields: {
      mode: {
        kind: 'enum',
        doc: 'Filter shape.',
        hint: 'Filter type',
        options: ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'allpass', 'lowshelf', 'highshelf'],
        default: 'lowpass',
      },
      cutoff: {
        kind: 'signal',
        doc: 'Cutoff or centre frequency.',
        hint: 'Where the filter starts working',
        default: 2000,
        min: 20,
        max: 20000,
        hardMin: 5,
        hardMax: 24000,
        unit: 'Hz',
        scale: 'log',
      },
      q: {
        kind: 'signal',
        doc: 'Resonance: 0.707 is flat, 2 to 10 rings.',
        hint: 'Resonance: higher rings',
        default: 0.707,
        min: 0.3,
        max: 20,
        hardMin: 0.05,
        hardMax: 200,
        scale: 'log',
      },
      gain: { kind: 'number', doc: 'dB, for peak and shelf types.', hint: 'Boost or cut, for peak and shelf types', default: 0, min: -24, max: 24, unit: 'dB' },
      slope: { kind: 'enum', doc: '12 or 24 dB per octave.', hint: 'How steep the filter is', options: ['12', '24'], default: '12' },
      keytrack: { kind: 'number', doc: 'How much the cutoff follows pitch, 0 to 1.', hint: 'Higher notes open the filter more', default: 0, min: 0, max: 1 },
    },
  },
};

/** Common parameters every effect has. */
export const COMMON_EFFECT_PARAMS: ParamMap = {
  id: { kind: 'string', doc: 'Name for paths and controls: `tracks.x.fx.<id>.<param>`.', hint: 'Name to reach this effect from controls' },
  bypass: { kind: 'bool', doc: 'Skip this effect.', hint: 'Turn this effect off', default: false },
  mix: { kind: 'number', doc: 'Wet amount, 0 (dry) to 1 (fully processed).', hint: 'How much of the effect you hear', default: 1, min: 0, max: 1 },
};
