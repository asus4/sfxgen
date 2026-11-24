/** Breakpoints as a picture: drag points, double-click the paper to add one, double-click a point to remove it. */
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Breakpoint, Curve, ParamMeta } from '../../core';
import { breakpointsAt } from '../../core/params';
import { useSize } from '../hooks';
import { formatValue, positionToValue, valueToPosition, type KnobRange } from '../lib/knob';
import { sortPoints } from '../lib/patchOps';

export interface CurveEditorProps {
  label: string;
  points: Breakpoint[];
  meta: Pick<ParamMeta, 'min' | 'max' | 'scale' | 'unit' | 'hardMin' | 'hardMax'>;
  /** How segments without their own curve are drawn. */
  curve?: Curve;
  ink?: string;
  onChange: (points: Breakpoint[]) => void;
  onCommit?: () => void;
  height?: number;
}

const PAD = 9;

export function CurveEditor({ label, points, meta, curve, ink = 'var(--pink)', onChange, onCommit, height = 92 }: CurveEditorProps) {
  const box = useRef<HTMLDivElement>(null);
  const { width } = useSize(box);
  const [active, setActive] = useState<number | null>(null);
  // The axes are frozen while a point is dragged, so the paper doesn't rescale under the pointer.
  const frozen = useRef<{ tMax: number; range: KnobRange } | null>(null);
  const dragging = useRef<number | null>(null);

  const sorted = useMemo(() => sortPoints(points), [points]);
  const defaultCurve: Curve = curve ?? (meta.scale === 'log' ? 'exp' : 'linear');

  const live = useMemo(() => {
    const values = sorted.map((p) => p[1]);
    const lo = Math.min(meta.min ?? Infinity, ...values);
    const hi = Math.max(meta.max ?? -Infinity, ...values);
    const pad = lo === hi ? Math.abs(lo) * 0.5 || 1 : 0;
    const range: KnobRange = { min: lo - pad, max: hi + pad, scale: meta.scale === 'log' && lo > 0 ? 'log' : 'linear' };
    const tMax = Math.max(0.02, sorted[sorted.length - 1]?.[0] ?? 0) * 1.25;
    return { tMax, range };
  }, [sorted, meta.min, meta.max, meta.scale]);
  const { tMax, range } = frozen.current ?? live;

  const w = Math.max(40, width);
  const x = (t: number) => PAD + (Math.min(t, tMax) / tMax) * (w - PAD * 2);
  const y = (v: number) => PAD + (1 - valueToPosition(v, range)) * (height - PAD * 2);
  const tAt = (px: number) => Math.max(0, ((px - PAD) / (w - PAD * 2)) * tMax);
  const vAt = (py: number) => positionToValue(1 - (py - PAD) / (height - PAD * 2), range);

  const path = useMemo(() => {
    if (sorted.length === 0) return '';
    const n = Math.max(24, Math.min(160, Math.round(w / 3)));
    let d = '';
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * tMax;
      d += `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${y(breakpointsAt(sorted, t, defaultCurve)).toFixed(1)}`;
    }
    return d;
    // x and y depend on exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, tMax, range, w, height, defaultCurve]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = box.current!.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  const round = (v: number) => Number(v.toPrecision(4));

  const movePoint = (index: number, t: number, v: number) => {
    const prev = sorted[index - 1]?.[0] ?? 0;
    const next = sorted[index + 1]?.[0] ?? Infinity;
    const lo = meta.hardMin ?? -Infinity;
    const hi = meta.hardMax ?? Infinity;
    const p = sorted[index];
    const mt = round(Math.min(next, Math.max(prev, t)));
    const mv = round(Math.min(hi, Math.max(lo, v)));
    const moved: Breakpoint = p[2] !== undefined ? [mt, mv, p[2]] : [mt, mv];
    onChange(sorted.map((q, i) => (i === index ? moved : q)));
  };

  const onPointDown = (index: number) => (e: PointerEvent<SVGCircleElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    dragging.current = index;
    frozen.current = live;
    setActive(index);
  };
  const onPointMove = (e: PointerEvent<SVGCircleElement>) => {
    const index = dragging.current;
    if (index === null) return;
    const { px, py } = local(e);
    movePoint(index, tAt(px), vAt(py));
  };
  const onPointUp = () => {
    if (dragging.current === null) return;
    dragging.current = null;
    frozen.current = null;
    onCommit?.();
  };

  const removePoint = (index: number) => {
    if (sorted.length <= 2) return;
    onChange(sorted.filter((_, i) => i !== index));
    setActive(null);
    onCommit?.();
  };

  const addPoint = (e: React.MouseEvent) => {
    const { px, py } = local(e);
    const p: Breakpoint = [round(tAt(px)), round(vAt(py))];
    const next = sortPoints([...sorted, p]);
    onChange(next);
    setActive(next.indexOf(p));
    onCommit?.();
  };

  const onPointKey = (index: number) => (e: KeyboardEvent<SVGCircleElement>) => {
    const [t, v] = sorted[index];
    const fine = e.shiftKey ? 0.1 : 1;
    const dt = tMax * 0.01 * fine;
    const pos = valueToPosition(v, range);
    if (e.key === 'ArrowLeft') movePoint(index, t - dt, v);
    else if (e.key === 'ArrowRight') movePoint(index, t + dt, v);
    else if (e.key === 'ArrowUp') movePoint(index, t, positionToValue(pos + 0.02 * fine, range));
    else if (e.key === 'ArrowDown') movePoint(index, t, positionToValue(pos - 0.02 * fine, range));
    else if (e.key === 'Delete' || e.key === 'Backspace') removePoint(index);
    else return;
    e.preventDefault();
  };

  const describe = (p: Breakpoint) => {
    const t = formatValue(p[0], 's');
    const v = formatValue(p[1], meta.unit);
    return `${t.text} ${t.unit} · ${v.text} ${v.unit}`.trim();
  };
  const shownPoint = active !== null ? sorted[active] : undefined;
  const top = formatValue(range.max, meta.unit);
  const bottom = formatValue(range.min, meta.unit);

  return (
    <div className="curve" style={{ '--knob-ink': ink } as React.CSSProperties}>
      <div ref={box} className="curve-box" style={{ height }}>
        <svg width={w} height={height} role="group" aria-label={`${label} curve, ${sorted.length} points`} onDoubleClick={addPoint}>
          <path className="curve-fill" d={path ? `${path}L${x(tMax).toFixed(1)} ${height - PAD}L${PAD} ${height - PAD}Z` : ''} />
          <path className="curve-line" d={path} />
          {sorted.map((p, i) => (
            <circle
              key={i}
              className={`curve-point${active === i ? ' is-active' : ''}`}
              cx={x(p[0])}
              cy={y(p[1])}
              r={6}
              tabIndex={0}
              role="slider"
              aria-label={`${label} point ${i + 1} of ${sorted.length}`}
              aria-valuenow={p[1]}
              aria-valuetext={describe(p)}
              onPointerDown={onPointDown(i)}
              onPointerMove={onPointMove}
              onPointerUp={onPointUp}
              onPointerCancel={onPointUp}
              onFocus={() => setActive(i)}
              onKeyDown={onPointKey(i)}
              onKeyUp={(e) => /^Arrow/.test(e.key) && onCommit?.()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(i);
              }}
            />
          ))}
        </svg>
        <span className="curve-axis curve-axis-top">
          {top.text}
          {top.unit}
        </span>
        <span className="curve-axis curve-axis-bottom">
          {bottom.text}
          {bottom.unit}
        </span>
        <span className="curve-axis curve-axis-time">{formatValue(tMax, 's').text + formatValue(tMax, 's').unit}</span>
      </div>
      <div className="curve-readout" aria-live="off">
        {shownPoint ? describe(shownPoint) : `${sorted.length} points · double-click to add`}
      </div>
    </div>
  );
}
