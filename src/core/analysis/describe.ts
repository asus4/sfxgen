/**
 * describe(): the analysis in a few plain lines an agent can act on: level, shape in time, where the energy sits
 * and how it moves, pitch, stereo, then warnings about anything that will sound wrong.
 */
import type { Analysis, BandEnergy } from './index';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "A3", or "A3 +23 cents" when it is 20 cents or more off the note. */
export function noteName(hz: number): string {
  if (!(hz > 0)) return '';
  const midi = 69 + 12 * Math.log2(hz / 440);
  const near = Math.round(midi);
  const cents = Math.round((midi - near) * 100);
  const name = `${NOTE_NAMES[((near % 12) + 12) % 12]}${Math.floor(near / 12) - 1}`;
  return Math.abs(cents) >= 20 ? `${name} ${cents > 0 ? '+' : ''}${cents} cents` : name;
}

/** "55 Hz", "220 Hz", "3.1 kHz", "12 kHz". */
export function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '0 Hz';
  if (hz < 100) return `${Math.round(hz * 10) / 10} Hz`.replace('.0 Hz', ' Hz');
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  if (hz < 10000) return `${(hz / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
  return `${Math.round(hz / 1000)} kHz`;
}

/** "0.4 ms", "2 ms", "45 ms", "0.12 s", "1.5 s". */
export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0 ms';
  if (s < 0.001) return `${(s * 1000).toFixed(1)} ms`;
  if (s < 0.01) return `${(s * 1000).toFixed(1).replace(/\.0$/, '')} ms`;
  if (s < 0.1) return `${Math.round(s * 1000)} ms`;
  if (s < 10) return `${s.toFixed(2)} s`;
  return `${s.toFixed(1)} s`;
}

const db1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);
const pct = (db: number): number => Math.round(100 * 10 ** (db / 10));

const BAND_NAMES: Record<string, string> = {
  sub: 'the sub-bass (below 60 Hz)',
  low: 'the lows (60-250 Hz)',
  'low-mid': 'the low-mids (250-800 Hz)',
  mid: 'the mids (800 Hz-2.5 kHz)',
  'high-mid': 'the high-mids (2.5-6 kHz)',
  high: 'the highs (6-12 kHz)',
  air: 'the air band (above 12 kHz)',
};

const bandKey = (b: BandEnergy): string => b.band.split(' ')[0];
const shareAbove = (a: Analysis, hz: number): number => a.bands.filter((b) => b.lo >= hz).reduce((s, b) => s + 10 ** (b.db / 10), 0);
const shareBelow = (a: Analysis, hz: number): number => a.bands.filter((b) => b.hi <= hz).reduce((s, b) => s + 10 ** (b.db / 10), 0);
const toDb = (share: number): number => (share > 1e-12 ? 10 * Math.log10(share) : -120);

function levelLine(a: Analysis): string {
  const crest =
    a.crestDb >= 20
      ? 'very spiky (a short hit in a lot of space)'
      : a.crestDb >= 14
        ? 'punchy and transient'
        : a.crestDb >= 9
          ? 'moderately dynamic'
          : 'dense and steady';
  const tp = a.truePeakDb > a.peakDb + 0.3 ? ` (true peak ${db1(a.truePeakDb)})` : '';
  return `Peak ${db1(a.peakDb)} dBFS${tp}, ${db1(a.lufs)} LUFS, crest ${Math.round(a.crestDb)} dB: ${crest}.`;
}

function timeLine(a: Analysis): string {
  const parts: string[] = [];
  const attack = a.attackMs / 1000;
  if (attack < 0.001) parts.push('Attack under 1 ms');
  else if (attack > 0.05) parts.push(`Attack ${formatSeconds(attack)} (a swell)`);
  else parts.push(`Attack ${formatSeconds(attack)}`);
  if (a.startSeconds >= 0.005) parts.push(`starts at ${formatSeconds(a.startSeconds)}`);
  parts.push(`loudest at ${formatSeconds(a.peakTimeMs / 1000)}`);
  const reached20 = a.audibleSeconds < a.duration - 0.002 || a.tailDb < -20;
  if (reached20) parts.push(`falls 20 dB in ${formatSeconds(a.decay20Seconds)}`);
  if (a.tailDb > -30) parts.push(`still at ${Math.round(a.tailDb)} dB when it ends at ${formatSeconds(a.duration)}`);
  else if (a.duration - a.audibleSeconds > 0.05) parts.push(`gone by ${formatSeconds(a.audibleSeconds)}, then silence to ${formatSeconds(a.duration)}`);
  else if (a.tailDb > -50) parts.push(`fades out by the end at ${formatSeconds(a.duration)}`);
  else parts.push(`gone by ${formatSeconds(a.audibleSeconds)}`);
  return parts.join(', ') + '.';
}

/** How a run of times is spaced, in words. */
function rhythmOf(t: number[]): string {
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (gaps.every((g) => Math.abs(g - mean) <= 0.15 * mean)) return `evenly, every ${formatSeconds(mean)}`;
  if (gaps[gaps.length - 1] < 0.7 * gaps[0]) return 'gaps shrink: speeding up';
  if (gaps[gaps.length - 1] > 1.4 * gaps[0]) return 'gaps grow: slowing down';
  return 'unevenly';
}

/**
 * The coarse events, when they say something the onsets don't (8 steps where the onsets count every heel and toe)
 * and can be trusted: a clear pulse to group by, or none at all. A loose pulse (an accelerating bounce, a ratchet
 * ringing between its teeth) groups badly, so then the onsets stand alone.
 */
function eventLine(a: Analysis): string | null {
  const e = a.events ?? [];
  if (e.length < 2 || e.length >= a.onsets.length) return null;
  if (a.pulseSeconds > 0 && a.pulseStrength < 0.45) return null;
  const at = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1)).replace(/^0\.00$/, '0');
  const list = e.length > 12 ? `from ${at(e[0])} to ${at(e[e.length - 1])} s` : `at ${e.map(at).join(', ')} s`;
  const pulse = a.pulseSeconds > 0 ? `; a steady pulse every ${formatSeconds(a.pulseSeconds)}` : '';
  return `Counted as a listener would: ${e.length} events, ${list} (${rhythmOf(e)}${pulse}).`;
}

function onsetLine(a: Analysis): string | null {
  const t = a.onsets;
  if (t.length < 2) return null;
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  const rhythm = rhythmOf(t);
  const at = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1)).replace(/^0\.00$/, '0');
  if (t.length === 2) return `2 hits, ${formatSeconds(gaps[0])} apart (at ${at(t[0])} and ${at(t[1])} s).`;
  if (t.length > 8) {
    const span = t[t.length - 1] - t[0];
    const rate = span > 0 ? (t.length - 1) / span : 0;
    return `${t.length}${t.length >= 64 ? '+' : ''} separate hits from ${at(t[0])} to ${at(t[t.length - 1])} s (about ${Math.round(rate)} per second, ${rhythm}): it reads as a roll or texture.`;
  }
  const list = t.map(at);
  return `${t.length} hits, at ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} s (${rhythm}).`;
}

function spectrumLine(a: Analysis): string {
  const sorted = [...a.bands].sort((x, y) => y.db - x.db);
  const top = sorted[0];
  const names = [BAND_NAMES[bandKey(top)]];
  if (sorted[1] && sorted[1].db >= top.db - 3) names.push(BAND_NAMES[bandKey(sorted[1])]);
  const above6 = toDb(shareAbove(a, 6000));
  const below250 = toDb(shareBelow(a, 250));
  let top6: string;
  if (above6 < -30) top6 = 'almost nothing above 6 kHz: muffled';
  else if (above6 < -20) top6 = 'little above 6 kHz: dark';
  else if (above6 < -10) top6 = 'some top end above 6 kHz';
  else if (above6 < -4) top6 = `${pct(above6)}% above 6 kHz: bright`;
  else top6 = `${pct(above6)}% above 6 kHz: hissy, very bright`;
  const thin = below250 < -20 && !['sub', 'low'].includes(bandKey(top)) ? '; little below 250 Hz: thin' : '';
  return `Energy sits in ${names.join(' and ')}; ${top6}${thin}.`;
}

function centroidLine(a: Analysis, pitchFalls: boolean, pitchRises: boolean): string {
  const [c0, c1, c2] = a.centroidThirds;
  const overall = `Centroid ${formatHz(a.centroidHz)}`;
  if (!(c0 > 0 && c2 > 0)) return `${overall}.`;
  const ratio = c2 / c0;
  if (c1 > 1.4 * Math.max(c0, c2)) return `${overall}; brightest in the middle (${formatHz(c0)}, ${formatHz(c1)}, ${formatHz(c2)}).`;
  if (c1 < Math.min(c0, c2) / 1.4) return `${overall}; darkest in the middle (${formatHz(c0)}, ${formatHz(c1)}, ${formatHz(c2)}).`;
  if (ratio < 0.67) {
    const what = ratio < 0.5 || pitchFalls ? 'a downward sweep' : 'it darkens as it goes';
    return `${overall}; falls from ${formatHz(c0)} to ${formatHz(c2)}: ${what}.`;
  }
  if (ratio > 1.5) {
    const what = ratio > 2 || pitchRises ? 'an upward sweep' : 'it brightens as it goes';
    return `${overall}; rises from ${formatHz(c0)} to ${formatHz(c2)}: ${what}.`;
  }
  if (Math.abs(ratio - 1) < 0.1 && Math.abs(c1 / c0 - 1) < 0.1) return `${overall}, steady throughout.`;
  return `${overall}, fairly steady (${formatHz(c0)}, ${formatHz(c1)}, ${formatHz(c2)} over the thirds).`;
}

/**
 * Are the peaks whole multiples of one fundamental (the pitch, or the lowest peak divided by 1 to 4, so a chord of
 * harmonic notes counts)? Each must lie within 8% of the fundamental from a multiple. Null when too few to say.
 */
function harmonic(peaks: { hz: number }[], f0: number | null): boolean | null {
  if (peaks.length < 2) return null;
  const lowest = Math.min(...peaks.map((p) => p.hz));
  const bases = [...(f0 ? [f0, f0 / 2] : []), lowest, lowest / 2, lowest / 3, lowest / 4].filter((b) => b >= 25);
  return bases.some((base) =>
    peaks.every((p) => {
      const ratio = p.hz / base;
      return ratio >= 0.97 && Math.abs(ratio - Math.round(ratio)) <= 0.08;
    }),
  );
}

function pitchLine(a: Analysis): string {
  const clarity = a.pitchClarity.toFixed(2);
  // Peaks in frequency order, the strongest marked.
  const strongest = a.peaks[0]?.hz;
  const partials = [...a.peaks.slice(0, 5)]
    .sort((x, y) => x.hz - y.hz)
    .map((p) => formatHz(p.hz) + (p.hz === strongest && a.peaks.length > 1 ? ' (strongest)' : ''));
  const h = harmonic(a.peaks, a.pitchHz);
  const partialText =
    partials.length >= 2
      ? `; tonal peaks at ${partials.join(', ')}${h === false ? ': inharmonic, metallic or bell-like' : h ? ': harmonic' : ''}`
      : '';
  if (a.pitchHz !== null) {
    const track = a.pitchTrack;
    const first = track[0]?.[1] ?? a.pitchHz;
    const last = track[track.length - 1]?.[1] ?? a.pitchHz;
    const hi = Math.max(...track.map((p) => p[1]), a.pitchHz);
    const lo = Math.min(...track.map((p) => p[1]), a.pitchHz);
    const glide = 12 * Math.log2(last / first);
    if (Math.abs(glide) >= 2) {
      const span = track.length > 1 ? ` over ${formatSeconds(track[track.length - 1][0] - track[0][0])}` : '';
      return `Pitch glides ${glide < 0 ? 'down' : 'up'} from about ${formatHz(first)} to ${formatHz(last)}${span}, clarity ${clarity}${partialText}.`;
    }
    if (12 * Math.log2(hi / lo) >= 2) {
      const shape = hi > Math.max(first, last) * 1.06 ? `rises to ${formatHz(hi)} and comes back` : `dips to ${formatHz(lo)} and comes back`;
      return `Pitched around ${formatHz(a.pitchHz)} (${noteName(a.pitchHz)}); it ${shape}, clarity ${clarity}${partialText}.`;
    }
    return `Pitched: about ${formatHz(a.pitchHz)} (${noteName(a.pitchHz)}), clarity ${clarity}${partialText}.`;
  }
  if (partials.length > 0) {
    const kind = h === false ? ': inharmonic, metallic or bell-like' : h ? ': harmonic, but too short or noisy for a clear pitch' : ': a resonance';
    return `No single pitch; tonal peaks at ${partials.join(', ')}${kind}.`;
  }
  const zcr = a.zeroCrossRate >= 1000 ? `${(a.zeroCrossRate / 1000).toFixed(1)}k` : `${a.zeroCrossRate}`;
  return `Unpitched, noise-like (clarity ${clarity}, ${zcr} zero crossings per second).`;
}

function stereoLine(a: Analysis): string | null {
  const c = a.stereoCorrelation;
  if (c === null) return null;
  if (c >= 0.95) return `Stereo, but nearly mono (correlation ${c.toFixed(2)}).`;
  if (c >= 0.5) return `Stereo with some width (correlation ${c.toFixed(2)}); safe in mono.`;
  if (c >= -0.1) return `Very wide stereo (correlation ${c.toFixed(2)}); it loses some body in mono.`;
  return `Warning: left and right are out of phase (correlation ${c.toFixed(2)}): it thins out or vanishes in mono.`;
}

export interface DescribeOptions {
  /** The sound is a seamless loop: its start and end are not judged as a one-shot's, the seam is. */
  loop?: boolean;
}

function warnings(a: Analysis, loop = false): string[] {
  const out: string[] = [];
  if (a.clippedSamples > 0) {
    out.push(`Warning: ${a.clippedSamples} sample${a.clippedSamples === 1 ? '' : 's'} at full scale: clipping. Keep master.normalize on (peak -1 dB) or lower the gain.`);
  } else if (a.truePeakDb > 0) {
    out.push(`Warning: true peak ${db1(a.truePeakDb)} dBTP: it clips between samples on playback; lower the peak target (master.normalize.target -2) or soften the sharpest transient.`);
  }
  if (Math.abs(a.dcOffset) >= 0.01) out.push(`Warning: DC offset ${a.dcOffset.toFixed(3)}: thumps on start and stop; keep master.dcBlock on.`);
  if (loop) {
    // Where the end meets the start there should be no step bigger than the ones inside the sound.
    if (a.seamDb > a.maxStepDb + 3 && a.seamDb > -50) {
      out.push(`Warning: the loop seam jumps ${db1(a.seamDb)} dBFS between the last and first sample, ${db1(a.seamDb - a.maxStepDb)} dB more than the largest step inside (${db1(a.maxStepDb)}): it will tick on every repeat. Use loop mode "crossfade" or let every layer start and end from silence.`);
    }
  } else {
    if (a.firstSampleDb > -40) out.push(`Warning: starts at ${Math.round(a.firstSampleDb)} dBFS instead of silence: a click. Add a fade-in (master.fadeIn).`);
    if (a.lastSampleDb > -40) out.push(`Warning: ends at ${Math.round(a.lastSampleDb)} dBFS instead of silence: a click when it stops. Add a fade-out (master.fadeOut).`);
    else if (a.tailDb > -30) {
      out.push(`Warning: still sounding at the end (${Math.round(a.tailDb)} dB below the peak): cut off. Use "duration": "auto" or a longer duration, unless it is a loop.`);
    }
  }
  if (a.startSeconds > 0.02) out.push(`Warning: ${formatSeconds(a.startSeconds)} of silence before it starts; a game sound should start at once.`);
  const sub = a.bands.find((b) => bandKey(b) === 'sub');
  const below250 = toDb(shareBelow(a, 250));
  if (sub && sub.db > -10) {
    out.push(`Warning: ${pct(sub.db)}% of the energy is below 60 Hz, which laptop and phone speakers can't play; add some harmonics (drive) or a higher layer so it still reads.`);
  } else if (below250 > -0.5) {
    out.push(`Warning: ${pct(below250)}% of the energy is below 250 Hz; on small speakers it will be faint. Add upper harmonics or a click layer.`);
  }
  if (a.peakDb < -20) out.push(`Warning: very quiet, peaking at ${Math.round(a.peakDb)} dBFS.`);
  return out;
}

/** The summary as separate lines (4 to 8 for a normal sound). */
export function describeLines(a: Analysis, opts: DescribeOptions = {}): string[] {
  if (a.peakDb <= -100 || a.duration <= 0) {
    return ['Silent: nothing above -100 dBFS. Check for muted tracks, very low gains, or envelopes that never open.'];
  }
  const track = a.pitchTrack;
  const glide = track.length > 1 ? 12 * Math.log2(track[track.length - 1][1] / track[0][1]) : 0;
  const lines = [levelLine(a), timeLine(a)];
  const hits = onsetLine(a);
  if (hits) lines.push(hits);
  const events = eventLine(a);
  if (events) lines.push(events);
  if (opts.loop) lines.push(`Loop: seam ${db1(a.seamDb)} dBFS against a largest inner step of ${db1(a.maxStepDb)}${a.seamDb <= a.maxStepDb + 3 ? ': seamless' : ''}.`);
  lines.push(spectrumLine(a), centroidLine(a, glide <= -2, glide >= 2), pitchLine(a));
  const stereo = stereoLine(a);
  if (stereo) lines.push(stereo);
  const warn = warnings(a, opts.loop === true);
  if (lines.length + warn.length <= 8) return [...lines, ...warn];
  // Keep it to 8 lines: fold the warnings into one.
  if (warn.length > 0) lines.push('Warnings: ' + warn.map((w) => w.replace(/^Warning: /, '')).join(' '));
  return lines.slice(0, 8);
}

/** Plain-language summary of an analysis, a few short lines. */
export function describe(a: Analysis, opts: DescribeOptions = {}): string {
  return describeLines(a, opts).join('\n');
}
