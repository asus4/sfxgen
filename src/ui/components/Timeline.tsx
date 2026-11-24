/**
 * The stage and the lanes, on one time axis. The stage overprints every audible track in its ink (multiply on
 * paper, screen on black) under a key-line of the finished mix; the lanes show each track where it starts.
 */
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { player } from '../audio';
import { audition, playNow, rollTake, stop, surpriseMe } from '../controller';
import { fitCanvas, prefersReducedMotion, timeTicks, useSize, useStable } from '../hooks';
import { trackInk } from '../lib/inks';
import { formatValue } from '../lib/knob';
import { addTrack, mutate, setAt } from '../lib/patchOps';
import { computePeaks, lerpPeaks, type Peaks } from '../lib/peaks';
import type { RenderView, SpectrogramGrid } from '../renderProtocol';
import { SELECT_MASTER, useEditor } from '../store';
import { Die, Icon } from './Icon';
import { Segmented, Switch } from './Widgets';

function fillWave(ctx: CanvasRenderingContext2D, p: Peaks, w: number, h: number, scale = 0.92): void {
  const mid = h / 2;
  const amp = (h / 2) * scale;
  const n = p.bins;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    // Ink always reaches the zero line, so a waveform slow enough to resolve prints as solid lobes, not a hairline.
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

function strokeWave(ctx: CanvasRenderingContext2D, p: Peaks, w: number, h: number, scale = 0.92): void {
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

interface Layer {
  id: string;
  ink: string;
  peaks: Peaks;
}

function audibleIds(tracks: { id: string; mute?: boolean; solo?: boolean }[]): Set<string> {
  const anySolo = tracks.some((t) => t.solo && !t.mute);
  return new Set(tracks.filter((t) => !t.mute && (!anySolo || t.solo)).map((t) => t.id));
}

// ---- Stage --------------------------------------------------------------------------------------

function WaveCanvas({ view, width, height }: { view: RenderView | null; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useEditor((s) => s.theme);
  const tracks = useEditor((s) => s.patch.tracks);
  const inks = useStable(tracks.map((t, i) => ({ id: t.id, ink: trackInk(t, i), mute: t.mute, solo: t.solo })));
  const bins = Math.max(16, Math.min(1400, Math.round(width)));

  const target = useMemo(() => {
    if (!view || width < 2) return null;
    const audible = audibleIds(inks);
    const layers: Layer[] = [];
    for (const t of view.tracks) {
      const ink = inks.find((x) => x.id === t.id);
      if (!ink || !audible.has(t.id)) continue;
      layers.push({ id: t.id, ink: ink.ink, peaks: computePeaks(t.buffer, view.sampleRate, t.start, view.duration, bins) });
    }
    const mix = computePeaks(view.channels[0], view.sampleRate, 0, view.duration, bins);
    return { layers, mix };
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
    const key = getComputedStyle(el).getPropertyValue('--key').trim() || '#111';
    const draw = (now: number) => {
      const raw = length === 0 ? 1 : Math.min(1, (now - startedAt) / length);
      const t = 1 - Math.pow(1 - raw, 3);
      const ctx = fitCanvas(el, width, height);
      if (!ctx) return;
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply';
      const current = new Map<string, Peaks>();
      for (const layer of target.layers) {
        const p = lerpPeaks(from.layers.get(layer.id), layer.peaks, t);
        current.set(layer.id, p);
        ctx.fillStyle = layer.ink;
        fillWave(ctx, p, width, height);
      }
      const mix = lerpPeaks(from.mix, target.mix, t);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = key;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      strokeWave(ctx, mix, width, height);
      shown.current = { layers: current, mix };
      if (raw < 1) raf.current = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [target, width, height, theme]);

  return <canvas ref={canvas} className="stage-canvas" style={{ width, height }} />;
}

/** Paper to blue to pink to yellow: the spectrogram printed with three inks. */
function spectroColor(level: number, dark: boolean): [number, number, number, number] {
  const stops: [number, number, number][] = dark
    ? [[11, 11, 13], [0, 80, 170], [255, 72, 176], [255, 232, 0]]
    : [[241, 242, 244], [0, 120, 191], [255, 72, 176], [40, 12, 30]];
  const x = Math.pow(level / 255, dark ? 1.1 : 1.3) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, level < 6 ? 0 : 255];
}

function SpectroCanvas({ grid, width, height }: { grid: SpectrogramGrid | null; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useEditor((s) => s.theme);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !grid) return;
    el.width = grid.width;
    el.height = grid.height;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(grid.width, grid.height);
    const lut = Array.from({ length: 256 }, (_, i) => spectroColor(i, theme === 'dark'));
    for (let i = 0; i < grid.data.length; i++) {
      const c = lut[grid.data[i]];
      image.data[i * 4] = c[0];
      image.data[i * 4 + 1] = c[1];
      image.data[i * 4 + 2] = c[2];
      image.data[i * 4 + 3] = c[3];
    }
    ctx.putImageData(image, 0, 0);
  }, [grid, theme]);
  const marks = [100, 1000, 10000].filter((hz) => grid && hz > grid.minHz && hz < grid.maxHz);
  return (
    <>
      <canvas ref={canvas} className="stage-canvas stage-spectro" style={{ width, height }} />
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

function Stage() {
  const plot = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(plot);
  const view = useEditor((s) => s.view);
  const spectro = useEditor((s) => s.spectro);
  const stageView = useEditor((s) => s.stageView);
  const playing = useEditor((s) => s.playing);
  const rendering = useEditor((s) => s.rendering);
  const error = useEditor((s) => s.renderError);
  const name = useEditor((s) => s.patch.name);
  const seed = useEditor((s) => s.patch.seed ?? 1);
  const loop = useEditor((s) => !!s.patch.loop);
  const edit = useEditor((s) => s.edit);
  const duration = view?.duration ?? 0;
  const length = formatValue(duration, 's');

  const onPlotClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!view || width <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    void playNow(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * view.duration);
  };

  return (
    <div className="stage">
      <div className="stage-top">
        <input
          className="title-input display"
          value={name}
          aria-label="Patch name"
          spellCheck={false}
          onChange={(e) => edit((p) => mutate(p, (d) => void (d.name = e.target.value)), 'name')}
        />
        <div className="stage-actions">
          <button type="button" className="btn btn-ink-yellow" onClick={rollTake} title="Same sound, new random seed">
            <Die seed={seed} /> <span>Another take</span>
          </button>
          <button type="button" className="btn btn-ink-blue" onClick={surpriseMe} title="Every knob somewhere new">
            <Icon name="spark" /> <span>Surprise me</span>
          </button>
        </div>
      </div>
      <div className="stage-body">
        <div className="stage-side">
          <button
            type="button"
            className={`play${playing ? ' is-playing' : ''}`}
            aria-label={playing ? 'Stop' : 'Play'}
            aria-keyshortcuts="Space"
            title="Play (Space)"
            onClick={() => (playing ? stop() : void playNow())}
          >
            <Icon name={playing ? 'stop' : 'play'} size={40} fill />
          </button>
          <dl className="readout">
            <div>
              <dt>length</dt>
              <dd>
                {length.text}
                <small>{length.unit}</small>
                {loop && <small className="loop-tag">loop</small>}
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
        </div>
        <div className="stage-plot-wrap">
          <div ref={plot} className={`stage-plot view-${stageView}`} onPointerDown={onPlotClick} role="img" aria-label="Waveform of the mix. Click to play from a point.">
            <span className="reg reg-tl" />
            <span className="reg reg-br" />
            <span className="midline" />
            {stageView === 'wave' ? <WaveCanvas view={view} width={width} height={height} /> : <SpectroCanvas grid={spectro} width={width} height={height} />}
            <span className="playhead" />
            <Stamp />
            {error && <p className="stage-error">Render failed: {error}</p>}
          </div>
          <Ruler duration={duration} width={width} />
        </div>
      </div>
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
    fillWave(ctx, computePeaks(rendered.buffer, view.sampleRate, rendered.start, view.duration, bins), width, height, 0.86);
  }, [view, rendered, ink, width, height]);
  return <canvas ref={canvas} className="lane-canvas" style={{ width, height }} />;
}

function Lane({ index }: { index: number }) {
  const track = useEditor((s) => s.patch.tracks[index]);
  const view = useEditor((s) => s.view);
  const selected = useEditor((s) => s.selected === s.patch.tracks[index]?.id);
  const everything = useEditor((s) => s.everything);
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const plot = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(plot);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  if (!track) return null;
  const ink = trackInk(track, index);
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
    <div className={`lane${selected ? ' is-selected' : ''}${track.mute ? ' is-muted' : ''}`} style={{ '--c': ink } as React.CSSProperties}>
      <div className="lane-head">
        <button
          type="button"
          className="swatch"
          aria-pressed={selected}
          aria-label={`Select track ${track.name ?? track.id}`}
          title={everything ? 'Show this track below' : 'Select this track'}
          onClick={() => select(track.id)}
        />
        <button type="button" className="lane-name" onClick={() => select(track.id)} title={track.note}>
          {track.name ?? track.id}
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

function Lanes() {
  const count = useEditor((s) => s.patch.tracks.length);
  const masterSelected = useEditor((s) => s.selected === SELECT_MASTER);
  const everything = useEditor((s) => s.everything);
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const stageView = useEditor((s) => s.stageView);
  const autoAudition = useEditor((s) => s.autoAudition);
  const setSettings = useEditor((s) => s.setSettings);
  const warnings = useEditor((s) => s.view?.warnings);
  return (
    <div className="lanes" role="group" aria-label="Tracks">
      {Array.from({ length: count }, (_, i) => (
        <Lane key={i} index={i} />
      ))}
      <div className="lanes-foot">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            const { patch, id } = addTrack(useEditor.getState().patch);
            edit(patch);
            select(id);
            useEditor.getState().setSettings({ everything: true });
          }}
        >
          <Icon name="plus" size={15} /> Layer
        </button>
        {everything && (
          <button type="button" className={`btn btn-quiet${masterSelected ? ' is-on' : ''}`} aria-pressed={masterSelected} onClick={() => select(SELECT_MASTER)}>
            <Icon name="sliders" size={15} /> Master &amp; patch
          </button>
        )}
        <span className="spacer" />
        {warnings && warnings.length > 0 && (
          <span className="warn" title={warnings.join('\n')}>
            {warnings.length === 1 ? warnings[0] : `${warnings.length} warnings`}
          </span>
        )}
        <Switch label="Play on release" checked={autoAudition} onChange={(on) => setSettings({ autoAudition: on })} />
        <Segmented
          label="Stage view"
          size="sm"
          value={stageView}
          onChange={(v) => setSettings({ stageView: v })}
          options={[
            { value: 'wave', label: <><Icon name="wave" size={15} /> Wave</> },
            { value: 'spectro', label: <><Icon name="spectro" size={15} /> Spectrum</> },
          ]}
        />
      </div>
    </div>
  );
}

/** Stage and lanes, with one playhead moved by a CSS variable so playback costs no React renders. */
export function Timeline() {
  const root = useRef<HTMLElement>(null);
  const playing = useEditor((s) => s.playing);
  const duration = useEditor((s) => s.view?.duration ?? 0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!playing || duration <= 0) {
      el.style.setProperty('--ph', '-1');
      return;
    }
    let raf = 0;
    const tick = () => {
      const pos = player.position();
      el.style.setProperty('--ph', pos === null ? '-1' : String(Math.min(1, pos / duration)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);
  return (
    <section ref={root} className="timeline sheet" aria-label="Sound">
      <Stage />
      <Lanes />
    </section>
  );
}
