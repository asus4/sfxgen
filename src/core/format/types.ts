/**
 * The sfxgen patch format, version 1.
 *
 * A patch is one sound effect: layered tracks, each a sound source played by one or more events and run through
 * its own effects, mixed through optional buses into a master chain. Every number is in a plain unit
 * (seconds, Hz, dB, semitones) and any numeric parameter can move over time. Controls are the short list of
 * knobs an agent chooses for a person to tweak; each one drives one or more parameters.
 *
 * docs/FORMAT.md explains the format for people and agents. Keep the two in step.
 */

export const FORMAT_ID = 'sfxgen/1' as const;

// ---- Values that move over time ------------------------------------------------------------

/**
 * How a segment between two breakpoints is drawn.
 * - `linear`: straight line.
 * - `exp`: constant ratio per second (natural for frequencies and times; needs both ends above 0).
 * - `smooth`: ease in and out.
 * - `hold`: stays at the start value, then jumps.
 * - a number from -1 to 1: bend. Negative moves fast first, positive moves slowly first, 0 is linear.
 */
export type CurveName = 'linear' | 'exp' | 'smooth' | 'hold';
export type Curve = CurveName | number;

/** `[time in seconds, value]`, or `[time, value, curve]` where the curve shapes the segment that ends here. */
export type Breakpoint = [number, number] | [number, number, Curve];

export type ModUnit = 'value' | 'st' | 'cents' | 'oct' | 'pct' | 'db';
export type LfoShape = 'sine' | 'triangle' | 'square' | 'saw' | 'ramp' | 'random' | 'smooth-random';

/** A wobble added on top of a parameter. */
export interface Modulator {
  /** Names it for paths and controls: `tracks.x.source.freq.mod.wobble.depth`. */
  id?: string;
  /** `lfo` repeats a shape; `wander` is smooth random drift with nothing faster than `rate`. */
  type: 'lfo' | 'wander';
  /** Hz. A breakpoint list makes the rate itself move (a tumble that speeds up). */
  rate: number | Breakpoint[];
  /** Peak deviation, in `unit`. A breakpoint list fades it in or out. */
  depth: number | Breakpoint[];
  /** Default: `st` for parameters on a log scale (frequencies), `value` for the rest. */
  unit?: ModUnit;
  shape?: LfoShape;
  /** Start phase, 0 to 1. */
  phase?: number;
  /** Seconds before the modulator starts. */
  delay?: number;
  /** Seconds to reach full depth after the delay. */
  fade?: number;
}

export interface SignalObject {
  /** Constant base value, used when there is no `env`. */
  value?: number;
  /** Breakpoints over time, from the start of the event. */
  env?: Breakpoint[];
  /** Default curve for segments without their own. Default: `exp` on log-scale parameters, else `linear`. */
  curve?: Curve;
  mod?: Modulator[];
}

/** A number, a breakpoint list (shorthand for `{ env }`), or a full signal object. */
export type ParamValue = number | Breakpoint[] | SignalObject;

// ---- Amplitude envelopes ---------------------------------------------------------------------

export interface AdsrEnvelope {
  /** Seconds from silence to full level. Default 0.002. */
  attack?: number;
  /** Seconds held at full level. Default 0. */
  hold?: number;
  /**
   * Seconds to fall to `sustain`. With the default `exp` curve this is the time to fall 60 dB toward the
   * sustain level, so `decay: 0.3` with `sustain: 0` is gone in 0.3 s.
   */
  decay?: number;
  /** Level held after the decay, 0 to 1. Default 0 when `decay` is set, else 1. */
  sustain?: number;
  /** Seconds to fall from the level at `gate` to silence (60 dB with `exp`). Default 0.01. */
  release?: number;
  /** Seconds after the start when the release begins. Default: the event's `dur`, else never. */
  gate?: number;
  curve?: 'exp' | 'linear';
}

/** Free-form envelope: levels 0 to 1. With the `exp` curve, levels are interpolated in decibels. */
export interface PointsEnvelope {
  points: Breakpoint[];
  curve?: Curve;
}

export type Envelope = AdsrEnvelope | PointsEnvelope;

// ---- Sources --------------------------------------------------------------------------------

export type FilterType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peak'
  | 'allpass'
  | 'lowshelf'
  | 'highshelf';

/** A filter inside a voice, so each event gets its own sweep. */
export interface VoiceFilter {
  /** Filter shape. Default `lowpass`. */
  mode?: FilterType;
  cutoff: ParamValue;
  /** Resonance. 0.707 is flat; 5 rings. Default 0.707. */
  q?: ParamValue;
  /** dB, for `peak`, `lowshelf` and `highshelf`. */
  gain?: number;
  /** 12 or 24 dB per octave. Default 12. */
  slope?: 12 | 24;
  /** How much the cutoff follows the voice's pitch, 0 to 1. Default 0. */
  keytrack?: number;
}

/**
 * A sound source. `type` picks the generator (see the node catalog: `sfxgen guide`); its own parameters sit
 * beside these common ones.
 */
export interface SourceSpec {
  type: string;
  /** dB. Default 0. */
  gain?: number;
  /** Amplitude envelope. Each source type has its own default. */
  env?: Envelope;
  /** Semitones added to every pitched parameter. Can move over time: a whole-voice pitch sweep. */
  pitch?: ParamValue;
  filter?: VoiceFilter;
  [param: string]: unknown;
}

// ---- Tracks and events -------------------------------------------------------------------------

/** One trigger of a track's source. */
export interface TrackEvent {
  /** Seconds from the track's start. */
  t: number;
  /** Semitones of transposition. Default 0. */
  pitch?: number;
  /** Velocity 0 to 1: scales level (and brightness, where a source uses it). Default 1. */
  vel?: number;
  /** Seconds the note is held: the envelope's gate. */
  dur?: number;
}

/** Shorthand for a run of events: ratchets, bounces, rolls, stutters. */
export interface Repeat {
  count: number;
  /** Seconds between the first two events. */
  interval: number;
  /** Each interval is the previous one times this. Below 1 speeds up (a bouncing ball), above 1 slows down. */
  accel?: number;
  /** Random timing, ± seconds. */
  jitter?: number;
  /** dB added per repeat (negative fades out). */
  decay?: number;
  /** Semitones added per repeat. */
  pitchStep?: number;
  /** Random pitch, ± semitones. */
  pitchJitter?: number;
  /** Random velocity, ± 0 to 1. */
  velJitter?: number;
  /** Held length of each event, seconds. */
  dur?: number;
}

export interface EffectSpec {
  type: string;
  /** Lets controls and edits address this effect by name instead of position. */
  id?: string;
  bypass?: boolean;
  /** Wet amount 0 to 1 for any effect. Default 1. */
  mix?: number;
  [param: string]: unknown;
}

export interface Track {
  /** Unique within the patch: letters, digits, `_` and `-`. Paths use it: `tracks.<id>.source.freq`. */
  id: string;
  name?: string;
  /** UI ink colour, a CSS colour. */
  color?: string;
  /** Why this layer exists, written for the person who will tweak it. */
  note?: string;
  /** Seconds from the start of the patch. Default 0. */
  start?: number;
  /** Seconds after which the source is cut, with a short fade; effect tails still ring. Default: no cut. */
  length?: number;
  /** dB. Default 0. */
  gain?: number;
  /** -1 (left) to 1 (right). Only heard in stereo output. Default 0. */
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  source: SourceSpec;
  /** When the source plays: seconds, or event objects. Default: once at 0. Ignored when `repeat` is set. */
  events?: (number | TrackEvent)[];
  repeat?: Repeat;
  fx?: EffectSpec[];
  /** Bus id to send level in dB, after this track's effects. */
  sends?: Record<string, number>;
}

export interface Bus {
  id: string;
  name?: string;
  fx?: EffectSpec[];
  /** dB. Default 0. */
  gain?: number;
}

export interface Normalize {
  /** `peak` sets the highest sample, `loudness` the integrated loudness in LUFS, `none` leaves the level alone. */
  mode: 'peak' | 'loudness' | 'none';
  /** dBFS for `peak` (default -1), LUFS for `loudness` (default -16). */
  target?: number;
  /** For `loudness`: the highest peak allowed, dBFS (default -0.3). A sound that would pass it stays quieter. */
  ceiling?: number;
}

export interface Master {
  /** dB, after the effects. Default 0. */
  gain?: number;
  fx?: EffectSpec[];
  /** Default: peak at -1 dBFS. */
  normalize?: Normalize;
  /** Seconds. Default 0.0005, enough to avoid a click. */
  fadeIn?: number;
  /** Seconds. Default: 4% of the duration, between 5 ms and 150 ms. Loops are never faded. */
  fadeOut?: number;
  /** Remove DC offset. Default true. */
  dcBlock?: boolean;
}

export interface OutputSettings {
  /** Default 48000. */
  sampleRate?: number;
  /** Default 1. Stereo makes `pan` and stereo effects audible. */
  channels?: 1 | 2;
  /** WAV export: 16 or 24-bit integer, or 32-bit float. Default 16. */
  bitDepth?: 16 | 24 | 32;
}

export interface LoopSettings {
  /**
   * `wrap`: whatever rings past the end is added back onto the start, so the loop sounds as if it had always
   * been playing. Every layer should start from silence. `crossfade`: the end fades into the start.
   */
  mode: 'wrap' | 'crossfade';
  /** Seconds, for `crossfade`. Default 0.05. */
  crossfade?: number;
}

// ---- Controls: the knobs a person sees first -------------------------------------------------

export type MapCurve = 'linear' | 'exp' | 'smooth' | number;

export interface ControlTarget {
  /**
   * Dot path to a parameter. In arrays a segment picks the item with that `id`, else a position:
   * `tracks.body.source.freq`, `tracks.body.fx.space.mix`, `master.gain`, `tracks.hit.source.env.decay`.
   */
  path: string;
  /**
   * - `set` (default): the parameter becomes the mapped value.
   * - `mul`: multiplies the parameter, envelopes and all (from/to are factors).
   * - `add`: adds to it.
   * - `stretch`: multiplies the times of the parameter's breakpoints.
   */
  mode?: 'set' | 'mul' | 'add' | 'stretch';
  /** Value at the control's minimum. Default for `set`: the parameter's range. */
  from?: number;
  /** Value at the control's maximum. */
  to?: number;
  /**
   * Value at the control's `default` (or its middle when it has none): the mapping runs from → via → to, so a knob
   * can rest exactly on the mixed level and still sweep either side of it.
   */
  via?: number;
  /** Default `linear`, or `exp` when both ends are positive and the parameter is on a log scale. */
  curve?: MapCurve;
}

export interface ControlOption {
  label: string;
  /** Path to value: applied when this option is chosen. */
  set?: Record<string, unknown>;
}

export interface Control {
  /** Unique within the patch. */
  id: string;
  label: string;
  /** One line telling a person what the knob does to the sound. */
  hint?: string;
  group?: string;
  /** Current value, between min and max. For `select` and `toggle`, the option's index. */
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Value to reset to. Default: the value the patch was saved with. */
  default?: number;
  /** How the knob responds. `exp` spreads a wide positive range evenly. */
  scale?: 'linear' | 'exp';
  widget?: 'knob' | 'slider' | 'toggle' | 'select';
  options?: ControlOption[];
  targets?: ControlTarget[];
  /** ± amount, in the control's units, that variations may move this control. */
  vary?: number;
}

// ---- The patch -------------------------------------------------------------------------------

export interface Patch {
  format: typeof FORMAT_ID;
  name: string;
  description?: string;
  tags?: string[];
  author?: string;
  license?: string;
  /** Seconds, or `auto`: until the last layer has rung out (capped by `maxDuration`). */
  duration: number | 'auto';
  /** Cap for `auto`, seconds. Default 10. */
  maxDuration?: number;
  /** Seed for every random choice. Same seed, same sound. Default 1. */
  seed?: number;
  output?: OutputSettings;
  /** Present when the patch is a seamless loop of exactly `duration` seconds. */
  loop?: LoopSettings;
  tracks: Track[];
  buses?: Bus[];
  master?: Master;
  controls?: Control[];
  /** Free-form notes: provenance, the template it came from, the agent's intent. Never read by the renderer. */
  meta?: Record<string, unknown>;
}
