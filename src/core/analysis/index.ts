/**
 * Measurements an agent reads instead of listening: level, loudness, envelope, spectrum and how they move.
 *
 * CONTRACT (owned by the analysis module; other modules code against these signatures):
 *
 *   analyze(channels, sampleRate) -> Analysis
 *   describe(analysis) -> string            plain-language summary, a few short lines
 *   spectrogram(channels, sampleRate, opts) -> { width, height, rgba, caption }   image data, waveform strip on top
 *   encodePng(width, height, rgba) -> Promise<Uint8Array>                 CompressionStream, so Node and browsers
 *
 * The implementations live in sibling files; this file re-exports them.
 *
 * Every dB value is a finite number: silence reads -120 (JSON has no -Infinity). Values are rounded to what is
 * worth reading (0.01 dB, 0.1 Hz, 0.01 ms) so the JSON stays short.
 *
 * The time measures come from one envelope: a 1 ms RMS (the loudest channel), made ripple-free with the smaller of
 * a 10 ms look-ahead and look-back maximum. That follows a rise or a fall without shifting it and stays steady on
 * tones down to about 45 Hz.
 */
export interface BandEnergy {
  /** Label such as "sub <60", "low 60-250". */
  band: string;
  lo: number;
  hi: number;
  /** Share of the total energy, dB (0 = all of it). */
  db: number;
}

/** A tonal peak of the average spectrum: a partial, a resonance or a harmonic. */
export interface SpectralPeak {
  hz: number;
  /** Level relative to the strongest peak, dB (0 for the strongest). */
  db: number;
}

export interface Analysis {
  sampleRate: number;
  channels: number;
  /** Seconds. */
  duration: number;
  peakDb: number;
  /** Peak between the samples (4x oversampled, as in BS.1770-4), dBTP. */
  truePeakDb: number;
  rmsDb: number;
  /** Integrated loudness, LUFS. */
  lufs: number;
  lufsMomentaryMax: number;
  /** Peak to RMS, dB: high is punchy and transient, low is dense and compressed. */
  crestDb: number;
  /** Milliseconds from the start until the envelope first comes within 0.5 dB of its maximum. */
  peakTimeMs: number;
  /** Milliseconds for the envelope to rise from 10% to 90% of its maximum. */
  attackMs: number;
  /** Seconds of silence before the sound starts: the envelope first comes within 40 dB of its peak. */
  startSeconds: number;
  /** Seconds until the envelope stays 60 dB below its peak (or the end). */
  audibleSeconds: number;
  /**
   * Seconds for the envelope to fall 20 dB after its loud part (the last moment within 1 dB of the maximum): a
   * decay measure that works on short sounds. When it never falls that far, the time left to the end (see tailDb).
   */
  decay20Seconds: number;
  /**
   * Level still sounding as the last stretch (5% of the length, 2 to 200 ms) begins, relative to the peak, dB: the
   * quietest point of its first half, so a last tick that lands in it and dies does not count. Above -30: cut off.
   */
  tailDb: number;
  /** |first sample| and |last sample|, dBFS. A sound should start and end near silence, or it clicks. */
  firstSampleDb: number;
  lastSampleDb: number;
  /**
   * For loops: the jump from the last sample to the first (the seam when it repeats), and the largest step between
   * neighbouring samples inside the sound, both in dBFS. A seam well above the largest step clicks.
   */
  seamDb: number;
  maxStepDb: number;
  /**
   * Seconds at which a new hit starts, at most 64: the energy rises 8 dB or more, quickly (a slow swell, beating
   * partials or tremolo don't count).
   */
  onsets: number[];
  /**
   * The main events on a coarse scale, seconds: what a listener would count (steps, knocks, shots), not every sharp
   * rise. A heel and its toe, or a burst of grains, are one event here; two events are at least 90 ms apart.
   */
  events: number[];
  /** The main repeat period, seconds (a step, a gallop, a loop's beat), or 0 when nothing repeats three times. */
  pulseSeconds: number;
  /** How clearly it repeats, 0 to 1 (the autocorrelation of its loudness rises at that period). */
  pulseStrength: number;
  /** Spectral centroid, Hz, over the whole sound and in thirds of the audible part (start, middle, end). */
  centroidHz: number;
  centroidThirds: [number, number, number];
  /** Frequency below which 85% of the energy lies, Hz. */
  rolloffHz: number;
  bands: BandEnergy[];
  /** Up to 5 tonal peaks of the average spectrum (15 dB or more above their surroundings), loudest first. */
  peaks: SpectralPeak[];
  /** Strongest pitch, Hz, and how clearly pitched the sound is (0 noise .. 1 pure tone). Null when unpitched. */
  pitchHz: number | null;
  pitchClarity: number;
  /** The pitch over the strongest pitched stretch, up to 8 points of [seconds, Hz]; empty when unpitched. */
  pitchTrack: [number, number][];
  /** Zero crossings per second over the audible part: high for noise and hiss. */
  zeroCrossRate: number;
  dcOffset: number;
  /** Samples at or above full scale. */
  clippedSamples: number;
  /** Left/right correlation for stereo (1 = mono, 0 = wide, negative = phasey); null for mono. */
  stereoCorrelation: number | null;
  /** Envelope in dBFS, 40 points over the duration (the loudest moment of each fortieth), for a quick look at the shape. */
  envelopeDb: number[];
}

export { analyze, BANDS, FLOOR_DB } from './metrics';
export { describe, describeLines, formatHz, formatSeconds, noteName, type DescribeOptions } from './describe';
export { spectrogram, type SpectrogramImage, type SpectrogramOptions } from './spectrogram';
export { encodePng } from './png';
export { loudness, kWeighted } from './loudness';
