/**
 * The display: a dark screen with the open sound's waveform (every audible track in its ink, screened over black,
 * under the outline of the finished mix), the lanes, the readouts and the agent's log. While a control is hovered
 * or turned the screen switches to that control's colour and shows where it acts. Play sits in the screen's head;
 * the dice and surprise me sit beside the easy controls they move.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { player } from '../audio';
import { audition, playNow, stop } from '../controller';
import { fitCanvas, prefersReducedMotion, timeTicks, useSize, useStable } from '../hooks';
import { controlColor, trackInk } from '../lib/inks';
import { formatValue } from '../lib/knob';
import { addTrack, mutate, setAt } from '../lib/patchOps';
import { controlTracks, describeControl } from '../lib/paths';
import { computePeaks, lerpPeaks, type Peaks } from '../lib/peaks';
import { dbText, soundKey } from '../lib/projectOps';
import type { RenderView, SpectrogramGrid } from '../renderProtocol';
import { useEditor, type Activity } from '../store';
import { Icon } from './Icon';

const DIM = '#3a3d44';

function fillWave(ctx: CanvasRenderingContext2D, p: Peaks, w: number, h: number, scale = 0.9): void {
  const mid = h / 2;
  const amp = (h / 2) * scale;
  const n = p.bins;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    // The fill always reaches the zero line, so a waveform slow enough to resolve shows as solid lobes, not a hairline.
    const y = mid - Math.min(1.05, Math.max(0, p.data[i * 2 + 1])) * amp - 0.5;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    ctx.lineTo((i / n) * w, mid - Math.max(-1.05, Math.min(0, p.data[i * 2])) * amp + 0.5);
  }
  ctx.closePath();
  ctx.fill();
}

function strokeWave(ctx: CanvasRenderingContext2D, p: Peaks, w: number, h: number, scale = 0.9): void {
  const mid = h / 2;
  const amp = (h / 2) * scale;
  const n = p.bins;
  for (const side of [1, 0]) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const y = mid - Math.max(-1.05, Math.min(1.05, p.data[i * 2 + side])) * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function audibleIds(tracks: { id: string; mute?: boolean; solo?: boolean }[]): Set<string> {
  const anySolo = tracks.some((t) => t.solo && !t.mute);
  return new Set(tracks.filter((t) => !t.mute && (!anySolo || t.solo)).map((t) => t.id));
}

/** The control the display is following, with its colour and the tracks it acts on. */
function useActiveControl() {
  const id = useEditor((s) => s.activeControl);
  const patch = useEditor((s) => s.patch);
  return useMemo(() => {
    const index = (patch.controls ?? []).findIndex((c) => c.id === id);
    if (index < 0) return null;
    const control = patch.controls![index];
    return { control, color: controlColor(index), tracks: controlTracks(patch, control), what: describeControl(patch, control) };
  }, [id, patch]);
}

// ---- Scope ------------------------------------------------------------------------------------

function WaveCanvas({ view, width, height }: { view: RenderView | null; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tracks = useEditor((s) => s.patch.tracks);
  const active = useActiveControl();
  // While a control is active its tracks take its colour and the rest go dark.
  const paint = (id: string, ink: string) => (!active ? ink : active.tracks === 'all' || active.tracks.has(id) ? active.color : DIM);
  const inks = useStable(tracks.map((t, i) => ({ id: t.id, ink: paint(t.id, trackInk(t, i)), mute: t.mute, solo: t.solo })));
  const bins = Math.max(16, Math.min(1400, Math.round(width)));

  const target = useMemo(() => {
    if (!view || width < 2) return null;
    const audible = audibleIds(inks);
    const layers: { id: string; ink: string; peaks: Peaks }[] = [];
    for (const t of view.tracks) {
      const ink = inks.find((x) => x.id === t.id);
      if (!ink || !audible.has(t.id)) continue;
      layers.push({ id: t.id, ink: ink.ink, peaks: computePeaks(t.buffer, view.sampleRate, t.start, view.duration, bins) });
    }
    // Dim layers first, so the lit ones sit on top.
    layers.sort((a, b) => Number(b.ink === DIM) - Number(a.ink === DIM));
    return { layers, mix: computePeaks(view.channels[0], view.sampleRate, 0, view.duration, bins) };
  }, [view, inks, bins, width]);

  // What is on screen now, so a new render morphs from wherever the last morph had got to.
  const shown = useRef<{ layers: Map<string, Peaks>; mix?: Peaks }>({ layers: new Map() });
  const raf = useRef(0);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !target || width < 2 || height < 2) return;
    const from = { layers: new Map(shown.current.layers), mix: shown.current.mix };
    const startedAt = performance.now();
    const length = prefersReducedMotion() ? 0 : 170;
    const draw = (now: number) => {
      const raw = length === 0 ? 1 : Math.min(1, (now - startedAt) / length);
      const t = 1 - Math.pow(1 - raw, 3);
      const ctx = fitCanvas(el, width, height);
      if (!ctx) return;
      ctx.globalCompositeOperation = 'screen';
      const current = new Map<string, Peaks>();
      for (const layer of target.layers) {
        const p = lerpPeaks(from.layers.get(layer.id), layer.peaks, t);
        current.set(layer.id, p);
        ctx.fillStyle = layer.ink;
        fillWave(ctx, p, width, height);
      }
      const mix = lerpPeaks(from.mix, target.mix, t);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(244, 245, 240, 0.92)';
      ctx.lineWidth = 1.1;
      ctx.lineJoin = 'round';
      strokeWave(ctx, mix, width, height);
      shown.current = { layers: current, mix };
      if (raw < 1) raf.current = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [target, width, height]);

  return <canvas ref={canvas} className="scope-canvas" style={{ width, height }} />;
}

/** Black to slate to teal to sand: quiet to loud, in the display's calm colours. */
function spectroColor(level: number): [number, number, number, number] {
  const stops: [number, number, number][] = [[10, 11, 13], [58, 78, 132], [94, 168, 167], [240, 228, 196]];
  const x = Math.pow(level / 255, 1.1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, level < 6 ? 0 : 255];
}

function SpectroCanvas({ grid, width, height }: { grid: SpectrogramGrid | null; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !grid) return;
    el.width = grid.width;
    el.height = grid.height;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(grid.width, grid.height);
    const lut = Array.from({ length: 256 }, (_, i) => spectroColor(i));
    for (let i = 0; i < grid.data.length; i++) {
      const c = lut[grid.data[i]];
      image.data[i * 4] = c[0];
      image.data[i * 4 + 1] = c[1];
      image.data[i * 4 + 2] = c[2];
      image.data[i * 4 + 3] = c[3];
    }
    ctx.putImageData(image, 0, 0);
  }, [grid]);
  const marks = [100, 1000, 10000].filter((hz) => grid && hz > grid.minHz && hz < grid.maxHz);
  return (
    <>
      <canvas ref={canvas} className="scope-canvas scope-spectro" style={{ width, height }} />
      {grid &&
        marks.map((hz) => (
          <span key={hz} className="hz-mark" style={{ bottom: `${(Math.log(hz / grid.minHz) / Math.log(grid.maxHz / grid.minHz)) * 100}%` }}>
            {hz >= 1000 ? `${hz / 1000}k` : hz}
          </span>
        ))}
    </>
  );
}

function Ruler({ duration, width }: { duration: number; width: number }) {
  const ticks = timeTicks(duration, Math.max(2, Math.floor(width / 64)));
  // Labels that would run into the previous one are dropped; their tick marks stay.
  let free = -Infinity;
  return (
    <div className="ruler" aria-hidden="true">
      {ticks.map((t) => {
        const text = t === 0 ? '0' : t < 1 ? `${Math.round(t * 1000)}ms` : `${t}s`;
        const x = (t / duration) * width;
        const w = text.length * 6.2 + 6;
        const flip = x + w > width;
        const left = flip ? x - w : x;
        const show = left >= free;
        if (show) free = left + w + 4;
        return (
          <span key={t} className={`tick${flip ? ' is-flipped' : ''}`} style={{ left: `${(t / duration) * 100}%` }}>
            {show && <i>{text}</i>}
          </span>
        );
      })}
    </div>
  );
}

function Stamp() {
  const stamp = useEditor((s) => s.stamp);
  if (!stamp) return null;
  return (
    <div key={stamp.nonce} className="stamp" role="status">
      {stamp.text}
    </div>
  );
}

function Scope() {
  const plot = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(plot);
  const view = useEditor((s) => s.view);
  const spectro = useEditor((s) => s.spectro);
  const stageView = useEditor((s) => s.stageView);
  const error = useEditor((s) => s.renderError);
  const active = useActiveControl();
  const duration = view?.duration ?? 0;

  const onPlotClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!view || width <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    void playNow(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * view.duration);
  };

  return (
    <div className="scope">
      <div className="scope-row">
        <div ref={plot} className={`scope-plot view-${stageView}`} onPointerDown={onPlotClick} role="img" aria-label="Waveform of the sound. Click to play from a point.">
          <span className="midline" />
          {stageView === 'wave' ? <WaveCanvas view={view} width={width} height={height} /> : <SpectroCanvas grid={spectro} width={width} height={height} />}
          <span className="playhead" />
          {active && (
            <p className="mapping" style={{ '--c': active.color } as React.CSSProperties}>
              <b>{active.control.label}</b>
              <span>{active.what}</span>
            </p>
          )}
          <Stamp />
          {error ? (
            <p className="scope-note is-error">Render failed: {error}</p>
          ) : (
            view && view.warnings.length > 0 && !active && (
              <p className="scope-note" title={view.warnings.join('\n')}>
                {view.warnings.length === 1 ? view.warnings[0] : `${view.warnings.length} warnings`}
              </p>
            )
          )}
        </div>
        <div className="meter" aria-hidden="true">
          <span className="meter-fill" />
        </div>
      </div>
      <Ruler duration={duration} width={width} />
    </div>
  );
}

// ---- Lanes --------------------------------------------------------------------------------------

function LaneCanvas({ view, trackId, ink, width, height }: { view: RenderView | null; trackId: string; ink: string; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const rendered = view?.tracks.find((t) => t.id === trackId);
  useEffect(() => {
    const el = canvas.current;
    if (!el || width < 2) return;
    const ctx = fitCanvas(el, width, height);
    if (!ctx || !view || !rendered) return;
    const bins = Math.max(16, Math.min(1200, Math.round(width)));
    ctx.fillStyle = ink;
    fillWave(ctx, computePeaks(rendered.buffer, view.sampleRate, rendered.start, view.duration, bins), width, height, 0.84);
  }, [view, rendered, ink, width, height]);
  return <canvas ref={canvas} className="lane-canvas" style={{ width, height }} />;
}

function Lane({ index }: { index: number }) {
  const track = useEditor((s) => s.patch.tracks[index]);
  const view = useEditor((s) => s.view);
  const selected = useEditor((s) => s.selected === s.patch.tracks[index]?.id);
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const active = useActiveControl();
  const plot = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(plot);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  if (!track) return null;
  const own = trackInk(track, index);
  const lit = !!active && (active.tracks === 'all' || active.tracks.has(track.id));
  const ink = !active ? own : lit ? active.color : DIM;
  const duration = view?.duration ?? 1;
  const start = track.start ?? 0;
  const renderedStart = view?.tracks.find((t) => t.id === track.id)?.start ?? start;
  // Until the new render lands, slide the old picture: the drag is felt at once.
  const shift = width > 0 ? ((start - renderedStart) / duration) * width : 0;
  const path = `tracks.${track.id}`;

  const setStart = (next: number) => {
    const v = Math.max(0, Number(next.toFixed(4)));
    edit((p) => setAt(p, `${path}.start`, v === 0 ? undefined : v), `start:${track.id}`);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start, moved: false };
    select(track.id);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || width <= 0) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    setStart(d.start + (dx / width) * duration * (e.shiftKey ? 0.1 : 1));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      useEditor.getState().seal();
      audition();
    }
  };
  const toggle = (key: 'mute' | 'solo') => edit((p) => setAt(p, `${path}.${key}`, track[key] ? undefined : true));

  return (
    <div className={`lane${selected ? ' is-selected' : ''}${track.mute ? ' is-muted' : ''}${lit ? ' is-lit' : ''}`} style={{ '--c': ink } as React.CSSProperties}>
      <div className="lane-head">
        <button type="button" className="lane-name" aria-pressed={selected} onClick={() => select(track.id)} title={track.note ?? 'Select this layer'}>
          <i className="lane-dot" />
          <span>{track.name ?? track.id}</span>
          <small>{String(track.source?.type ?? '')}</small>
        </button>
        <div className="ms">
          <button type="button" aria-pressed={!!track.mute} aria-label={`Mute ${track.id}`} title="Mute" className="ms-m" onClick={() => toggle('mute')}>
            M
          </button>
          <button type="button" aria-pressed={!!track.solo} aria-label={`Solo ${track.id}`} title="Solo" className="ms-s" onClick={() => toggle('solo')}>
            S
          </button>
        </div>
      </div>
      <div
        ref={plot}
        className="lane-plot"
        role="slider"
        tabIndex={0}
        aria-label={`${track.name ?? track.id} start time`}
        aria-valuemin={0}
        aria-valuemax={Number(duration.toFixed(3))}
        aria-valuenow={start}
        aria-valuetext={`starts at ${Math.round(start * 1000)} ms`}
        title="Drag to move this layer in time"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onFocus={() => select(track.id)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.001 : 0.01;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setStart(start + step);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setStart(start - step);
          else if (e.key === 'Home') setStart(0);
          else return;
          e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (/^(Arrow|Home)/.test(e.key)) {
            useEditor.getState().seal();
            audition();
          }
        }}
      >
        <div className="lane-slide" style={{ transform: `translateX(${shift.toFixed(1)}px)` }}>
          <LaneCanvas view={view} trackId={track.id} ink={ink} width={width} height={height} />
        </div>
        {start > 0 && <span className="lane-start" style={{ left: `${Math.min(100, (start / duration) * 100)}%` }}>{Math.round(start * 1000)}ms</span>}
        <span className="playhead" />
      </div>
    </div>
  );
}

/** The layers as lanes, and under the last one the key that adds another. */
function Lanes() {
  const count = useEditor((s) => s.patch.tracks.length);
  const edit = useEditor((s) => s.edit);
  return (
    <div className="lanes" role="group" aria-label="Layers">
      {Array.from({ length: count }, (_, i) => (
        <Lane key={i} index={i} />
      ))}
      <div className="lane lane-more">
        <button
          type="button"
          className="screen-key lane-add"
          title="Add a layer to this sound"
          onClick={() => {
            const { patch, id } = addTrack(useEditor.getState().patch);
            edit(patch);
            useEditor.getState().select(id);
            useEditor.getState().showSurface('sound');
          }}
        >
          <Icon name="plus" size={13} /> <span>Add layer</span>
        </button>
      </div>
    </div>
  );
}

// ---- Readouts and the agent's log -----------------------------------------------------------------

function Readouts() {
  const view = useEditor((s) => s.view);
  const rendering = useEditor((s) => s.rendering);
  const loop = useEditor((s) => !!s.patch.loop);
  const measured = useEditor((s) => (s.project.sounds[s.current] ? s.measured[soundKey(s.project.sounds[s.current])] : undefined));
  const gain = useEditor((s) => s.project.sounds[s.current]?.gain ?? 0);
  const stable = measured ? { lufs: measured.lufs + gain, peak: measured.peakDb + gain } : null;
  const length = formatValue(view?.duration ?? 0, 's');
  const hot = !!stable && stable.peak > -0.05;
  return (
    <dl className="readouts">
      <div>
        <dt>len</dt>
        <dd>
          {length.text}
          <small>{length.unit}</small>
          {loop && <small className="loop-tag">loop</small>}
        </dd>
      </div>
      <div>
        <dt>peak</dt>
        <dd className={hot ? 'is-hot' : ''}>
          {dbText(stable?.peak)}
          <small>dB</small>
        </dd>
      </div>
      <div>
        <dt>loud</dt>
        <dd>
          {dbText(stable?.lufs)}
          <small>LUFS</small>
        </dd>
      </div>
      <div>
        <dt>render</dt>
        <dd className={rendering ? 'is-busy' : ''}>
          {view ? Math.max(1, Math.round(view.timeMs)) : '–'}
          <small>ms</small>
        </dd>
      </div>
    </dl>
  );
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const WHO: Record<Activity['origin'], string> = { agent: 'agent', human: 'you', file: 'file', system: 'sfxgen' };

/** The agent's presence: what it wrote about the sound and its layers, and who changed what. */
export function Notes() {
  const description = useEditor((s) => s.patch.description);
  const soundNote = useEditor((s) => s.project.sounds[s.current]?.note);
  const tracks = useEditor((s) => s.patch.tracks);
  const activity = useEditor((s) => s.activity);
  const select = useEditor((s) => s.select);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setNow(Date.now()), [activity]);
  const notes = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.note);
  return (
    <div className="log">
      <h2 className="log-title">notes</h2>
      <div className="log-notes">
        {soundNote && <p className="log-text is-set">{soundNote}</p>}
        {description ? <p className="log-text">{description}</p> : !soundNote && <p className="log-text is-empty">No description yet. An agent, or you under Everything, can say what this sound is for.</p>}
        {notes.map(({ t, i }) => (
          <button key={t.id} type="button" className="log-track" onClick={() => select(t.id)} style={{ '--c': trackInk(t, i) } as React.CSSProperties}>
            <b>{t.name ?? t.id}</b> {t.note}
          </button>
        ))}
      </div>
      <h2 className="log-title">activity</h2>
      <ol className="log-feed" aria-live="polite">
        {activity.slice(0, 40).map((a) => (
          <li key={a.id} className={`from-${a.origin}`}>
            <span className="who">{WHO[a.origin]}</span>
            <span className="what">{a.text}</span>
            <time>{ago(a.at, now)}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- The zone -----------------------------------------------------------------------------------

/** Loudness of the mix over time, 0..1 per column, for the meter that follows the playhead. */
function envelope(view: RenderView | null, bins = 240): Float32Array {
  const out = new Float32Array(bins);
  if (!view) return out;
  const ch = view.channels[0];
  const per = Math.max(1, Math.floor(ch.length / bins));
  for (let b = 0; b < bins; b++) {
    let peak = 0;
    for (let i = b * per; i < Math.min(ch.length, (b + 1) * per); i++) if (Math.abs(ch[i]) > peak) peak = Math.abs(ch[i]);
    // -48 dB to 0 dB across the meter.
    out[b] = peak > 0 ? Math.max(0, Math.min(1, 1 + (20 * Math.log10(peak)) / 48)) : 0;
  }
  return out;
}

export function Display() {
  const root = useRef<HTMLElement>(null);
  const playing = useEditor((s) => s.playing);
  const openIsPlaying = useEditor((s) => s.playing && (!s.playingKey || s.playingKey === (s.project.sounds[s.current] ? soundKey(s.project.sounds[s.current]) : '')));
  const view = useEditor((s) => s.view);
  const name = useEditor((s) => s.patch.name);
  const index = useEditor((s) => s.current);
  const stageView = useEditor((s) => s.stageView);
  const setSettings = useEditor((s) => s.setSettings);
  const edit = useEditor((s) => s.edit);
  const duration = view?.duration ?? 0;
  const env = useMemo(() => envelope(view), [view]);

  // The playhead and the meter move by CSS variables, so playback costs no React renders.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!openIsPlaying || duration <= 0) {
      el.style.setProperty('--ph', '-1');
      el.style.setProperty('--lv', '0');
      return;
    }
    let raf = 0;
    let level = 0;
    const tick = () => {
      const pos = player.position();
      const at = pos === null ? -1 : Math.min(1, pos / duration);
      const target = at < 0 ? 0 : env[Math.min(env.length - 1, Math.floor(at * env.length))];
      // Fast up, slow down, like a peak meter.
      level = target > level ? target : level + (target - level) * 0.18;
      el.style.setProperty('--ph', String(at));
      el.style.setProperty('--lv', level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [openIsPlaying, duration, env]);

  return (
    <section ref={root} className="zone zone-display" aria-label="Display">
      <div className="screen">
        <header className="screen-head">
          <button
            type="button"
            className={`screen-play${playing ? ' is-on' : ''}`}
            aria-label={playing ? 'Stop' : 'Play'}
            aria-keyshortcuts="Space"
            title="Play (Space)"
            onClick={() => (playing ? stop() : void playNow())}
          >
            <Icon name={playing ? 'stop' : 'play'} size={18} fill />
          </button>
          <span className="screen-num">{String(index + 1).padStart(2, '0')}</span>
          <input
            className="title-input"
            value={name}
            aria-label="Sound name"
            spellCheck={false}
            onChange={(e) => edit((p) => mutate(p, (d) => void (d.name = e.target.value)), 'name')}
          />
          <Readouts />
          <div className="screen-tools">
            <button
              type="button"
              className="screen-key"
              aria-pressed={stageView === 'spectro'}
              title="Waveform or spectrum"
              onClick={() => setSettings({ stageView: stageView === 'wave' ? 'spectro' : 'wave' })}
            >
              <Icon name={stageView === 'wave' ? 'spectro' : 'wave'} size={15} /> <span>{stageView === 'wave' ? 'spectrum' : 'wave'}</span>
            </button>
          </div>
        </header>
        <Scope />
        <Lanes />
      </div>
    </section>
  );
}
