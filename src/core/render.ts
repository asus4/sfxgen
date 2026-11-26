/**
 * Renders a patch to samples. Pure and deterministic: the same patch, seed and sample rate give the same output in
 * the browser and in Node.
 *
 * Order: controls -> per track: events -> voices (source, voice filter, envelope) -> track effects -> gain, pan ->
 * sends to buses -> bus effects -> master effects -> loop folding -> DC, fades, normalisation.
 */
import type { EffectSpec, Envelope, Patch, ParamValue, SourceSpec, Track, TrackEvent } from './format/types';
import { applyControls } from './format/controls';
import { COMMON_EFFECT_PARAMS, COMMON_SOURCE_PARAMS, type FxContext, type ParamMeta, type VoiceContext } from './nodes';
import { getEffect, getSource, metaAt } from './registry';
import { compileSignal, constantOf, envelopeLength, renderEnvelope } from './params';
import { filterBuffer, dcBlock } from './dsp/filters';
import { Rng, hashString } from './dsp/rng';
import { allFinite, clamp, dbToGain, peak, smoothstep, type Buf } from './dsp/math';
import { loudness } from './analysis/loudness';
import type { FilterType } from './format/types';

export interface RenderOptions {
  /** Overrides the patch's output sample rate. */
  sampleRate?: number;
  /** Overrides the patch's output channel count. */
  channels?: 1 | 2;
  /** Return each track's own buffer (mono, after its effects and gain) for the editor's lanes. */
  keepTracks?: boolean;
  /** The caller has already applied the controls. */
  controlsApplied?: boolean;
  /** Reuses rendered tracks between calls; only tracks whose settings changed are rendered again. */
  cache?: TrackCache;
}

export interface TrackRender {
  id: string;
  /** Seconds from the start of the patch. */
  start: number;
  /** Mono, after the track's effects and gain, from the track's start. */
  buffer: Float32Array;
  peak: number;
}

export interface RenderResult {
  sampleRate: number;
  /** One or two channels, the finished sound. */
  channels: Float32Array[];
  /** Seconds. */
  duration: number;
  tracks?: TrackRender[];
  warnings: string[];
  /** Gain the normaliser applied, dB. */
  normalizeGainDb: number;
  timeMs: number;
}

/** Keeps rendered tracks (after their effects, before gain and pan) between renders. */
export class TrackCache {
  private map = new Map<string, Buf[]>();
  constructor(private readonly limit = 48) {}
  get(key: string): Buf[] | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: Buf[]): void {
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const first = this.map.keys().next().value as string;
      this.map.delete(first);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

const DEFAULT_SR = 48000;
const MAX_SECONDS = 60;

// ---- Events -------------------------------------------------------------------------------------

interface ResolvedEvent {
  t: number;
  pitch: number;
  vel: number;
  dur: number;
}

export function compileEvents(track: Track, rng: Rng, shared: Rng = rng): ResolvedEvent[] {
  const out: ResolvedEvent[] = [];
  const r = track.repeat;
  if (r && r.count >= 1) {
    const count = Math.min(Math.round(r.count), 512);
    // A group's tracks draw from one stream (the patch's, by the group's name), so their jitter matches.
    const jr = typeof r.group === 'string' && r.group ? shared.fork('repeat-group', r.group) : rng.fork('repeat');
    const accents = Array.isArray(r.accents) ? r.accents.filter((a) => typeof a === 'number' && Number.isFinite(a)) : [];
    const offsets = Array.isArray(r.offsets) ? r.offsets.filter((o) => typeof o === 'number' && Number.isFinite(o)) : [];
    let t = 0;
    let gap = Math.max(r.interval, 0.0005);
    const grouped = typeof r.group === 'string' && r.group.length > 0;
    // A group's tracks draw all three numbers on every repeat, whatever their amounts, so a member with no pitch
    // jitter stays in step with one that has it; each scales the shared draw by its own amount.
    const draw = (amount: number | undefined) => (grouped ? jr.uniform(-1, 1) * (amount ?? 0) : amount ? jr.uniform(-amount, amount) : 0);
    for (let k = 0; k < count; k++) {
      const jitter = draw(r.jitter);
      const accent = accents.length ? Math.max(0, accents[k % accents.length]) : 1;
      const vel = clamp(dbToGain((r.decay ?? 0) * k) * accent * (1 + draw(r.velJitter)), 0, 4);
      const pitch = (r.pitchStep ?? 0) * k + draw(r.pitchJitter);
      const offset = offsets.length ? offsets[k % offsets.length] : 0;
      out.push({ t: Math.max(0, t + jitter + offset), pitch, vel, dur: r.dur ?? Infinity });
      t += gap;
      gap *= r.accel ?? 1;
    }
  } else if (track.events && track.events.length > 0) {
    for (const e of track.events) {
      const ev: TrackEvent = typeof e === 'number' ? { t: e } : e;
      out.push({ t: Math.max(0, ev.t ?? 0), pitch: ev.pitch ?? 0, vel: clamp(ev.vel ?? 1, 0, 4), dur: ev.dur ?? Infinity });
    }
  } else {
    out.push({ t: 0, pitch: 0, vel: 1, dur: Infinity });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- Voices --------------------------------------------------------------------------------------

function sourceMeta(source: SourceSpec, name: string): ParamMeta {
  const def = getSource(source.type);
  return def?.params[name] ?? COMMON_SOURCE_PARAMS[name] ?? { kind: 'signal', doc: '' };
}

/** Seconds one event of this source lasts, or Infinity if it would sustain forever. */
export function voiceLength(source: SourceSpec, gate: number): number {
  const def = getSource(source.type);
  if (!def) return 0;
  const env: Envelope = source.env ?? def.defaultEnv;
  const fromEnv = envelopeLength(env, gate);
  const natural = def.naturalLength ? def.naturalLength(source) : Infinity;
  return Math.min(fromEnv, natural);
}

/** Renders one event: the source, its voice filter, envelope, gain and velocity. Mono or stereo. */
export function renderVoice(
  source: SourceSpec,
  ev: ResolvedEvent,
  n: number,
  sr: number,
  rng: Rng,
  warnings: string[],
  opts: { fadeTail?: boolean } = {},
): Buf[] {
  const def = getSource(source.type);
  if (!def || n <= 0) return [new Float64Array(Math.max(n, 0))];
  // The voice's pitch curve: its `pitch` parameter (semitones, may move) plus the event's transposition.
  const pitchSt = compileSignal(source.pitch as ParamValue | undefined, COMMON_SOURCE_PARAMS.pitch, { sr, n, rng: rng.fork('pitch') });
  const pitchRatio = new Float64Array(n);
  for (let i = 0; i < n; i++) pitchRatio[i] = Math.pow(2, (pitchSt[i] + ev.pitch) / 12);
  const p0 = pitchRatio[0];
  const ctx: VoiceContext = {
    sr,
    n,
    gate: ev.dur,
    vel: ev.vel,
    rng,
    pitchRatio,
    signal: (name, value) =>
      compileSignal((value ?? source[name]) as ParamValue | undefined, sourceMeta(source, name), {
        sr,
        n,
        rng: rng.fork('param', name),
        pitchRatio,
      }),
    num: (name, value) => constantOf((value ?? source[name]) as ParamValue | undefined, sourceMeta(source, name), p0),
    signalOf: (value, meta, key) => compileSignal(value, meta, { sr, n, rng: rng.fork('nested', key ?? meta.doc), pitchRatio }),
    numOf: (value, meta) => constantOf(value, meta, p0),
    warn: (message) => warnings.push(`source ${source.type}: ${message}`),
  };
  let out: Buf[];
  try {
    const raw = def.render(source, ctx);
    out = Array.isArray(raw) ? raw : [raw];
  } catch (err) {
    warnings.push(`source ${source.type}: ${(err as Error).message}`);
    return [new Float64Array(n)];
  }
  // The voice filter: one sweep per event.
  const f = source.filter;
  if (f && typeof f === 'object') {
    const fields = COMMON_SOURCE_PARAMS.filter.fields!;
    const cutoff = compileSignal(f.cutoff, fields.cutoff, { sr, n, rng: rng.fork('fc') });
    const keytrack = clamp(f.keytrack ?? 0, 0, 1);
    if (keytrack > 0) for (let i = 0; i < n; i++) cutoff[i] *= Math.pow(pitchRatio[i], keytrack);
    const q = compileSignal(f.q, fields.q, { sr, n, rng: rng.fork('fq') });
    const mode = (f.mode ?? 'lowpass') as FilterType;
    out = out.map((ch) => filterBuffer(ch, mode, cutoff, q, sr, { gainDb: f.gain ?? 0, slope: Number(f.slope ?? 12) === 24 ? 24 : 12 }));
  }
  // Envelope, gain and velocity.
  const env = renderEnvelope(source.env ?? def.defaultEnv, n, sr, ev.dur);
  const level = dbToGain(typeof source.gain === 'number' ? source.gain : 0) * ev.vel;
  // A voice cut short by the end of its track gets a 3 ms fade instead of a click.
  const tailFade = Math.min(n, Math.round(0.003 * sr));
  for (const ch of out) {
    for (let i = 0; i < n; i++) ch[i] *= env[i] * level;
    if (opts.fadeTail !== false && env[n - 1] > 1e-3) for (let i = 0; i < tailFade; i++) ch[n - 1 - i] *= i / tailFade;
  }
  return out;
}

// ---- Effects -------------------------------------------------------------------------------------

function effectMeta(spec: EffectSpec, name: string): ParamMeta {
  const def = getEffect(spec.type);
  return def?.params[name] ?? COMMON_EFFECT_PARAMS[name] ?? { kind: 'signal', doc: '' };
}

function toChannels(input: Buf[], channels: number): Buf[] {
  if (input.length === channels) return input;
  if (channels === 1) {
    const m = new Float64Array(input[0].length);
    for (let i = 0; i < m.length; i++) m[i] = (input[0][i] + input[1][i]) * 0.5;
    return [m];
  }
  return [input[0], input[0].slice()];
}

/** Runs an effect chain. `stereo` says whether the output is stereo (so widening effects may make two channels). */
export function runChain(
  input: Buf[],
  chain: EffectSpec[] | undefined,
  sr: number,
  rng: Rng,
  stereo: boolean,
  loop: boolean,
  warnings: string[],
  where: string,
): Buf[] {
  let buf = input;
  (chain ?? []).forEach((spec, k) => {
    if (!spec || spec.bypass) return;
    const def = getEffect(spec.type);
    if (!def) {
      warnings.push(`${where}: unknown effect "${spec.type}"`);
      return;
    }
    const fxRng = rng.fork('fx', spec.id ?? k);
    const ctx: FxContext = {
      sr,
      rng: fxRng,
      loop,
      signal: (name, n, value) => {
        const v = (value ?? spec[name]) as ParamValue | undefined;
        const first = firstBreakpointTime(v);
        if (first !== undefined && first >= n / sr) {
          warnings.push(`${where}: ${spec.type}.${name}'s breakpoints start at ${first} s, after its buffer ends (${(n / sr).toFixed(2)} s); effect times count from the start of the track`);
        }
        return compileSignal(v, effectMeta(spec, name), { sr, n, rng: fxRng.fork(name) });
      },
      num: (name, value) => constantOf((value ?? spec[name]) as ParamValue | undefined, effectMeta(spec, name)),
      signalOf: (value, meta, n, key) => compileSignal(value, meta, { sr, n, rng: fxRng.fork('nested', key ?? meta.doc) }),
      numOf: (value, meta) => constantOf(value, meta),
      warn: (message) => warnings.push(`${where}: ${spec.type}: ${message}`),
    };
    // Effects that return only their wet signal (reverb, delay) declare a lower default mix for inserts; on a bus,
    // which tracks send into, every effect is fully wet unless the patch says otherwise.
    const ownDefault = def.params.mix?.default;
    const defaultMix = where.startsWith('bus ') ? 1 : typeof ownDefault === 'number' ? ownDefault : 1;
    const mix = clamp(typeof spec.mix === 'number' ? spec.mix : defaultMix, 0, 1);
    if (mix <= 0) return;
    let dry = buf;
    if (stereo && def.widens && buf.length === 1) {
      buf = [buf[0], buf[0].slice()];
      dry = buf;
    }
    const dryCopy = mix < 1 ? dry.map((ch) => ch.slice()) : null;
    let wet: Buf[];
    try {
      wet = def.process(buf.map((ch) => ch), spec, ctx);
    } catch (err) {
      warnings.push(`${where}: effect ${spec.type} failed: ${(err as Error).message}`);
      return;
    }
    wet = toChannels(wet, stereo ? Math.max(wet.length, buf.length) : 1);
    if (dryCopy) {
      const d = toChannels(dryCopy, wet.length);
      const len = Math.max(wet[0].length, d[0].length);
      wet = wet.map((w, c) => {
        const o = new Float64Array(len);
        for (let i = 0; i < len; i++) o[i] = (i < d[c].length ? d[c][i] : 0) * (1 - mix) + (i < w.length ? w[i] : 0) * mix;
        return o;
      });
    }
    for (const ch of wet) {
      if (!allFinite(ch)) {
        warnings.push(`${where}: effect ${spec.type} produced invalid samples; they were zeroed`);
        for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
      }
    }
    buf = wet;
  });
  return buf;
}

/**
 * Seconds of buffer a chain needs for `seconds` of input: tails add, time effects stretch or shrink (`length`), and
 * the buffer must hold the longest stage (a sped-up sound still needs room for its source before the speed-up).
 */
/** Time of a parameter's first breakpoint, if it has breakpoints. */
function firstBreakpointTime(v: ParamValue | undefined): number | undefined {
  const pts = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray(v.env) ? v.env : undefined;
  if (!pts || pts.length === 0 || !Array.isArray(pts[0])) return undefined;
  return Math.min(...pts.map((p) => (Array.isArray(p) ? p[0] : Infinity)));
}

function chainEnd(chain: EffectSpec[] | undefined, seconds: number): number {
  let t = seconds;
  let longest = seconds;
  for (const spec of chain ?? []) {
    if (!spec || spec.bypass) continue;
    const def = getEffect(spec.type);
    if (def?.length) t = def.length(spec, t);
    else if (def?.tail) t += def.tail(spec);
    longest = Math.max(longest, t);
  }
  return longest;
}

// ---- Tracks ---------------------------------------------------------------------------------------

function trackKey(track: Track, sr: number, stereo: boolean, total: number, seed: number, loop: boolean): string {
  const { gain: _g, pan: _p, mute: _m, solo: _s, sends: _se, name: _n, color: _c, note: _no, ...rest } = track;
  return JSON.stringify([rest, sr, stereo, total, seed, loop]);
}

/** Renders a track's events and effects, from the track's start, `length` samples long. */
function renderTrackBody(
  track: Track,
  length: number,
  sr: number,
  stereo: boolean,
  loop: boolean,
  rng: Rng,
  warnings: string[],
  loopEnd?: number,
  shared: Rng = rng,
): Buf[] {
  const source = track.source;
  if (!source || !getSource(source.type)) {
    warnings.push(`track ${track.id}: unknown source "${source?.type}"`);
    return [new Float64Array(length)];
  }
  const events = compileEvents(track, rng, shared);
  // An effect that changes time (varispeed, doppler) may need more source than the output holds: a 2x speed-up
  // plays two seconds of source in one. Render the whole source then, and let placement crop the result.
  if ((track.fx ?? []).some((fx) => fx && !fx.bypass && getEffect(fx.type)?.length)) {
    let end = 0;
    for (const ev of events) {
      const len = voiceLength(source, ev.dur);
      if (Number.isFinite(len)) end = Math.max(end, ev.t + len);
    }
    length = Math.max(length, Math.min(Math.ceil((end + 0.01) * sr), Math.round(60 * sr)));
  }
  let channels = 1;
  const bufs: Buf[] = [new Float64Array(length)];
  events.forEach((ev, k) => {
    const at = Math.round(ev.t * sr);
    if (at >= length) return;
    const len = voiceLength(source, ev.dur);
    // In a wrap loop a sound that never ends is cut exactly at the loop's end, unfaded: it continues into the start
    // by itself, and what rang past the end would otherwise be added onto the start a second time.
    const sustainedInLoop = !Number.isFinite(len) && loopEnd !== undefined;
    const n = Number.isFinite(len)
      ? Math.min(Math.ceil((len + 0.005) * sr), length - at)
      : sustainedInLoop
        ? Math.max(0, Math.min(loopEnd! - at, length - at))
        : length - at;
    const voice = renderVoice(source, ev, n, sr, rng.fork('event', k), warnings, { fadeTail: !sustainedInLoop });
    if (voice.length === 2 && stereo && channels === 1) {
      bufs.push(bufs[0].slice());
      channels = 2;
    }
    const v = toChannels(voice, channels);
    for (let c = 0; c < channels; c++) {
      const dst = bufs[c];
      const src = v[c];
      const m = Math.min(src.length, dst.length - at);
      for (let i = 0; i < m; i++) dst[at + i] += src[i];
    }
  });
  if (typeof track.length === 'number' && track.length > 0) {
    const cut = Math.round(track.length * sr);
    const fade = Math.round(0.005 * sr);
    for (const b of bufs) {
      for (let i = Math.max(0, cut - fade); i < b.length; i++) b[i] *= i >= cut ? 0 : (cut - i) / fade;
    }
  }
  return runChain(bufs, track.fx, sr, rng.fork('chain'), stereo, loop, warnings, `track ${track.id}`);
}

function applyGainPan(bufs: Buf[], gainDb: number, pan: number, stereo: boolean): Buf[] {
  const g = dbToGain(gainDb);
  if (!stereo) {
    const out = bufs[0].slice();
    for (let i = 0; i < out.length; i++) out[i] *= g;
    return [out];
  }
  const p = clamp(pan, -1, 1);
  if (bufs.length === 1) {
    const gl = Math.cos(((p + 1) * Math.PI) / 4) * Math.SQRT2 * g;
    const gr = Math.sin(((p + 1) * Math.PI) / 4) * Math.SQRT2 * g;
    const l = bufs[0].map((v) => v * gl);
    const r = bufs[0].map((v) => v * gr);
    return [l, r];
  }
  // Balance for stereo material.
  const gl = (p > 0 ? 1 - p : 1) * g;
  const gr = (p < 0 ? 1 + p : 1) * g;
  return [bufs[0].map((v) => v * gl), bufs[1].map((v) => v * gr)];
}

// ---- Duration ------------------------------------------------------------------------------------

/** Seconds until every track has rung out, for `duration: "auto"`. */
export function estimateDuration(patch: Patch, warnings: string[] = []): number {
  const seedRng = new Rng(hashString('sfxgen', patch.seed ?? 1));
  let end = 0;
  for (const track of patch.tracks ?? []) {
    if (track.mute || !track.source) continue;
    const events = compileEvents(track, seedRng.fork('track', track.id), seedRng);
    let trackEnd = 0;
    for (const ev of events) {
      let len = voiceLength(track.source, ev.dur);
      if (!Number.isFinite(len)) {
        if (typeof track.length !== 'number') warnings.push(`track ${track.id}: its sound never ends; give the envelope a decay or gate, set the track's length, or set a fixed duration`);
        len = 2;
      }
      trackEnd = Math.max(trackEnd, ev.t + len);
    }
    if (typeof track.length === 'number') trackEnd = Math.min(trackEnd, track.length);
    end = Math.max(end, (track.start ?? 0) + chainEnd(track.fx, trackEnd));
  }
  const busEnd = Math.max(end, ...(patch.buses ?? []).map((b) => chainEnd(b.fx, end)));
  return chainEnd(patch.master?.fx, busEnd);
}

/**
 * A fixed-length patch (a loop above all) whose track plays one voice with no `env` gets that source's default
 * envelope, a one-shot: noise fades in 0.3 s, so a 4 s hum layer is silent after its first moment. Say so.
 */
function warnEarlyEnds(patch: Patch, duration: number, loop: boolean, warnings: string[]): void {
  for (const track of patch.tracks ?? []) {
    const source = track.source;
    if (track.mute || !source || source.env !== undefined || track.repeat || (track.events && track.events.length > 1)) continue;
    const def = getSource(source.type);
    if (!def) continue;
    const ev = track.events?.[0];
    const at = (track.start ?? 0) + (typeof ev === 'number' ? ev : (ev?.t ?? 0));
    const dur = typeof ev === 'object' && ev?.dur !== undefined ? ev.dur : Infinity;
    const ends = at + voiceLength(source, dur);
    if (Number.isFinite(ends) && ends < 0.5 * duration && envelopeLength(def.defaultEnv, dur) < 0.5 * duration) {
      warnings.push(
        `track ${track.id}: its ${source.type} source has no env, so it plays its default one-shot envelope and stops at ` +
          `${ends.toFixed(2)} s of this ${duration} s ${loop ? 'loop' : 'sound'}; to sustain it, give it "env": { "attack": 0.01, "sustain": 1 }`,
      );
    }
  }
}

// ---- The whole patch --------------------------------------------------------------------------

export function render(input: Patch, opts: RenderOptions = {}): RenderResult {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const warnings: string[] = [];
  let patch = input;
  if (!opts.controlsApplied && input.controls && input.controls.length > 0) {
    const applied = applyControls(input, metaAt);
    patch = applied.patch;
    warnings.push(...applied.warnings);
  }
  const sr = Math.round(clamp(opts.sampleRate ?? patch.output?.sampleRate ?? DEFAULT_SR, 8000, 192000));
  const stereo = (opts.channels ?? patch.output?.channels ?? 1) === 2;
  const loop = patch.loop;
  const seed = patch.seed ?? 1;
  const root = new Rng(hashString('sfxgen', seed));

  // Length.
  let duration: number;
  const auto = patch.duration === 'auto' || typeof patch.duration !== 'number';
  if (auto) {
    if (loop) warnings.push('a loop needs a fixed duration; using the estimated length');
    duration = clamp(estimateDuration(patch, warnings), 0.02, patch.maxDuration ?? 10);
  } else {
    duration = clamp(patch.duration as number, 0.001, MAX_SECONDS);
  }
  if (!auto) warnEarlyEnds(patch, duration, !!loop, warnings);
  const loopTail = loop ? Math.min(Math.max(estimateDuration(patch) - duration, 0) + 0.05, MAX_SECONDS) : 0;
  const crossfade = loop?.mode === 'crossfade' ? clamp(loop.crossfade ?? 0.05, 0.001, duration / 2) : 0;
  const N = Math.max(1, Math.round(duration * sr));
  const total = loop ? N + Math.round((loop.mode === 'crossfade' ? crossfade : loopTail) * sr) : N;

  const outCh = stereo ? 2 : 1;
  const mix: Buf[] = Array.from({ length: outCh }, () => new Float64Array(total));
  const buses = new Map<string, Buf[]>();
  for (const bus of patch.buses ?? []) buses.set(bus.id, Array.from({ length: outCh }, () => new Float64Array(total)));

  const tracks = patch.tracks ?? [];
  const anySolo = tracks.some((t) => t.solo && !t.mute);
  const trackRenders: TrackRender[] = [];
  const seenIds = new Set<string>();
  for (const track of tracks) {
    if (!track || typeof track !== 'object') continue;
    if (seenIds.has(track.id)) warnings.push(`track id "${track.id}" is used twice; paths will only reach the first`);
    seenIds.add(track.id);
    const audible = !track.mute && (!anySolo || track.solo);
    if (!audible && !opts.keepTracks) continue;
    const startS = Math.max(0, track.start ?? 0);
    const at = Math.round(startS * sr);
    const length = total - at;
    if (length <= 0) continue;
    const key = trackKey(track, sr, stereo, total, seed, !!loop) + (loop ? `|${loop.mode}:${N}` : '');
    let body = opts.cache?.get(key);
    if (!body) {
      const loopEnd = loop?.mode === 'wrap' ? N - at : undefined;
      body = renderTrackBody(track, length, sr, stereo, !!loop, root.fork('track', track.id), warnings, loopEnd, root);
      opts.cache?.set(key, body);
    }
    const placed = applyGainPan(body, track.gain ?? 0, track.pan ?? 0, stereo);
    if (opts.keepTracks) {
      const mono = new Float32Array(placed[0].length);
      for (let i = 0; i < mono.length; i++) mono[i] = placed.length === 2 ? (placed[0][i] + placed[1][i]) * 0.5 : placed[0][i];
      trackRenders.push({ id: track.id, start: startS, buffer: mono, peak: peak(mono) });
    }
    if (!audible) continue;
    for (let c = 0; c < outCh; c++) {
      const src = placed[Math.min(c, placed.length - 1)];
      const dst = mix[c];
      const m = Math.min(src.length, total - at);
      for (let i = 0; i < m; i++) dst[at + i] += src[i];
    }
    for (const [busId, sendDb] of Object.entries(track.sends ?? {})) {
      const bus = buses.get(busId);
      if (!bus) {
        warnings.push(`track ${track.id}: no bus "${busId}"`);
        continue;
      }
      const g = dbToGain(sendDb);
      for (let c = 0; c < outCh; c++) {
        const src = placed[Math.min(c, placed.length - 1)];
        const m = Math.min(src.length, total - at);
        for (let i = 0; i < m; i++) bus[c][at + i] += src[i] * g;
      }
    }
  }

  // Buses.
  for (const bus of patch.buses ?? []) {
    const buf = buses.get(bus.id)!;
    const processed = toChannels(runChain(buf, bus.fx, sr, root.fork('bus', bus.id), stereo, !!loop, warnings, `bus ${bus.id}`), outCh);
    const g = dbToGain(bus.gain ?? 0);
    for (let c = 0; c < outCh; c++) {
      const m = Math.min(processed[c].length, total);
      for (let i = 0; i < m; i++) mix[c][i] += processed[c][i] * g;
    }
  }

  // Master.
  const master = patch.master ?? {};
  let out = toChannels(runChain(mix, master.fx, sr, root.fork('master'), stereo, !!loop, warnings, 'master'), outCh);
  const mg = dbToGain(master.gain ?? 0);
  out = out.map((ch) => {
    const o = new Float64Array(total);
    const m = Math.min(ch.length, total);
    for (let i = 0; i < m; i++) o[i] = ch[i] * mg;
    return o;
  });

  // Loops: fold the tail back onto the start.
  if (loop) {
    out = out.map((ch) => {
      const o = ch.subarray(0, N).slice();
      if (loop.mode === 'crossfade') {
        const x = Math.min(total - N, N);
        for (let i = 0; i < x; i++) {
          const a = Math.sin((0.5 * Math.PI * i) / x);
          const b = Math.cos((0.5 * Math.PI * i) / x);
          o[i] = o[i] * a + ch[N + i] * b;
        }
      } else {
        for (let i = N; i < total; i++) o[(i - N) % N] += ch[i];
      }
      return o;
    });
  }

  // DC, fades.
  if (master.dcBlock !== false) {
    if (loop) {
      for (const ch of out) {
        let mean = 0;
        for (let i = 0; i < ch.length; i++) mean += ch[i];
        mean /= ch.length;
        for (let i = 0; i < ch.length; i++) ch[i] -= mean;
      }
    } else {
      out.forEach((ch) => dcBlock(ch, sr));
    }
  }
  let length = out[0].length;
  if (auto && !loop) {
    // Trim what has faded below -70 dB of the peak: below that a 16-bit export is near silence anyway, and the final
    // fade takes care of what is left.
    const p = Math.max(...out.map(peak));
    const floor = p * Math.pow(10, -70 / 20);
    let last = 0;
    for (const ch of out) for (let i = ch.length - 1; i > last; i--) if (Math.abs(ch[i]) > floor) { last = i; break; }
    length = Math.min(length, last + Math.round(0.01 * sr) + 1);
    out = out.map((ch) => ch.subarray(0, length).slice());
  }
  if (!loop) {
    const fadeIn = Math.round(clamp(master.fadeIn ?? 0.0005, 0, length / sr) * sr);
    const fadeOutS = master.fadeOut ?? clamp((length / sr) * 0.04, 0.005, 0.15);
    const fadeOut = Math.round(clamp(fadeOutS, 0, length / sr) * sr);
    for (const ch of out) {
      for (let i = 0; i < fadeIn; i++) ch[i] *= smoothstep(i / fadeIn);
      for (let i = 0; i < fadeOut; i++) ch[length - 1 - i] *= smoothstep(i / fadeOut);
    }
    if (master.dcBlock !== false) {
      // A 10 Hz high-pass can't settle within a very short clip, and the fades shift the mean again, so take out what
      // DC is left with a window that is zero at both ends: the mean goes to zero and the edges stay untouched.
      for (const ch of out) {
        let sum = 0;
        let wsum = 0;
        for (let i = 0; i < length; i++) {
          sum += ch[i];
          wsum += Math.sin((Math.PI * (i + 0.5)) / length) ** 2;
        }
        const k = wsum > 0 ? sum / wsum : 0;
        for (let i = 0; i < length; i++) ch[i] -= k * Math.sin((Math.PI * (i + 0.5)) / length) ** 2;
      }
    }
  }

  // Normalise.
  let normalizeGainDb = 0;
  const norm = master.normalize ?? { mode: 'peak' as const };
  const p = Math.max(...out.map(peak));
  if (p <= 0) warnings.push('the patch renders silence');
  else if (norm.mode === 'peak') {
    normalizeGainDb = (norm.target ?? -1) - 20 * Math.log10(p);
  } else if (norm.mode === 'loudness') {
    const l = loudness(out, sr).integrated;
    if (Number.isFinite(l)) {
      normalizeGainDb = (norm.target ?? -16) - l;
      const peakAfter = 20 * Math.log10(p) + normalizeGainDb;
      const ceiling = norm.ceiling ?? -0.3;
      if (peakAfter > ceiling) {
        // A ceiling chosen in the patch is a decision, not a problem; only the safety ceiling warns.
        if (norm.ceiling === undefined) warnings.push(`loudness target ${norm.target ?? -16} LUFS would clip; limited to a -0.3 dBFS peak`);
        normalizeGainDb -= peakAfter - ceiling;
      }
    }
  } else if (p > 1) {
    warnings.push(`the output peaks at ${(20 * Math.log10(p)).toFixed(1)} dBFS and will clip on export`);
  }
  const ng = dbToGain(normalizeGainDb);
  const channels = out.map((ch) => {
    const f = new Float32Array(length);
    for (let i = 0; i < length; i++) f[i] = ch[i] * ng;
    return f;
  });
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    sampleRate: sr,
    channels,
    duration: length / sr,
    tracks: opts.keepTracks ? trackRenders.map((t) => ({ ...t, buffer: t.buffer.map((v) => v * ng), peak: t.peak * ng })) : undefined,
    warnings: [...new Set(warnings)],
    normalizeGainDb,
    timeMs: ended - started,
  };
}
