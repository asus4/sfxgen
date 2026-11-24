/**
 * The knob: a flat cap inside a ring that lights up to its value. It turns; it never moves. Drag up and down, wheel
 * while focused, arrow and page keys, Home and End, Shift for fine moves, double-click to reset, click the value to
 * type one.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatValue, parseValue, positionToValue, stepByKey, valueToPosition, type KnobRange } from '../lib/knob';

export interface KnobProps {
  label: string;
  value: number | undefined;
  range: KnobRange;
  unit?: string;
  /** Double-click goes here. */
  defaultValue?: number;
  /** Double-click calls this instead, for parameters that reset by being removed. */
  onReset?: () => void;
  onChange: (value: number) => void;
  /** The gesture ended: a drag was released, a key came up, the wheel stopped. */
  onCommit?: () => void;
  size?: number;
  ink?: string;
  disabled?: boolean;
  /** Typed values may go beyond the knob's travel, up to these. */
  hardMin?: number;
  hardMax?: number;
  describedBy?: string;
  /** Hide the value readout under the dial (the caller shows its own). */
  bare?: boolean;
}

const START = 135;
const SWEEP = 270;

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
}

function arc(from: number, to: number, r: number): string {
  const [x0, y0] = polar(from, r);
  const [x1, y1] = polar(to, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function Knob(props: KnobProps) {
  const { label, value, range, unit = '', size = 64, ink = 'var(--ink)', disabled = false } = props;
  const dial = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; position: number } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressed, setPressed] = useState(false);
  const [typing, setTyping] = useState<string | null>(null);
  // The latest props for listeners that are attached once.
  const live = useRef(props);
  live.current = props;

  const unset = value === undefined || !Number.isFinite(value);
  const position = unset ? 0 : valueToPosition(value, range);
  const angle = START + SWEEP * position;
  const shown = unset ? { text: '—', unit: '' } : formatValue(value, unit);
  const defaultPosition = props.defaultValue !== undefined ? valueToPosition(props.defaultValue, range) : null;

  const moveTo = (pos: number) => {
    const p = live.current;
    const next = positionToValue(pos, p.range);
    if (next !== p.value) p.onChange(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { y: e.clientY, position };
    setPressed(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Incremental, so pressing Shift mid-drag slows down from where the knob is instead of jumping.
    const dy = e.clientY - d.y;
    if (dy === 0) return;
    d.y = e.clientY;
    d.position = Math.min(1, Math.max(0, d.position - dy / (e.shiftKey ? 1800 : 180)));
    moveTo(d.position);
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setPressed(false);
    live.current.onCommit?.();
  };

  const reset = () => {
    if (disabled) return;
    const p = live.current;
    if (p.onReset) p.onReset();
    else if (p.defaultValue !== undefined) p.onChange(p.defaultValue);
    else return;
    p.onCommit?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      setTyping(unset ? '' : shown.text.replace('+', ''));
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      reset();
      return;
    }
    const start = unset ? positionToValue(0, range) : value;
    const next = stepByKey(start, e.key, e.shiftKey, range);
    if (next === null) return;
    e.preventDefault();
    if (next !== value) props.onChange(next);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (/^(Arrow|Page|Home|End)/.test(e.key)) props.onCommit?.();
  };

  // Wheel: only on the focused knob, so scrolling the page never turns a knob by accident.
  useEffect(() => {
    const el = dial.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const p = live.current;
      if (p.disabled || document.activeElement !== el) return;
      e.preventDefault();
      const from = p.value === undefined ? 0 : valueToPosition(p.value, p.range);
      const pos = Math.min(1, Math.max(0, from - e.deltaY / (e.shiftKey ? 6000 : 600)));
      let next = positionToValue(pos, p.range);
      // A stepped knob would swallow small wheel moves: take a step per notch instead.
      if (p.range.step && next === p.value) next = stepByKey(p.value ?? p.range.min, e.deltaY < 0 ? 'ArrowUp' : 'ArrowDown', false, p.range) ?? next;
      if (next !== p.value) p.onChange(next);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => live.current.onCommit?.(), 350);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    };
  }, []);

  const commitTyped = () => {
    if (typing === null) return;
    const parsed = parseValue(typing, unit);
    setTyping(null);
    if (parsed === null) return;
    const lo = props.hardMin ?? Math.min(range.min, range.max);
    const hi = props.hardMax ?? Math.max(range.min, range.max);
    props.onChange(Math.min(hi, Math.max(lo, parsed)));
    props.onCommit?.();
    dial.current?.focus();
  };

  const [ix0, iy0] = polar(angle, 15);
  const [ix1, iy1] = polar(angle, 29);

  return (
    <div className={`knob${disabled ? ' is-disabled' : ''}${pressed ? ' is-pressed' : ''}${unset ? ' is-unset' : ''}`} style={{ '--knob-ink': ink } as React.CSSProperties}>
      <div
        ref={dial}
        className="knob-dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={Math.min(range.min, range.max)}
        aria-valuemax={Math.max(range.min, range.max)}
        aria-valuenow={unset ? undefined : value}
        aria-valuetext={unset ? 'not set' : `${shown.text} ${shown.unit}`.trim()}
        aria-disabled={disabled || undefined}
        aria-describedby={props.describedBy}
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
          <path className="knob-track" d={arc(START, START + SWEEP, 44)} />
          {position > 0.002 && <path className="knob-arc" d={arc(START, START + Math.max(0.5, SWEEP * position), 44)} />}
          {defaultPosition !== null && (
            <circle className="knob-default" cx={polar(START + SWEEP * defaultPosition, 44)[0]} cy={polar(START + SWEEP * defaultPosition, 44)[1]} r="2" />
          )}
          <circle className="knob-cap" cx="50" cy="50" r="33" />
          <line className="knob-mark" x1={ix0} y1={iy0} x2={ix1} y2={iy1} />
        </svg>
      </div>
      {!props.bare &&
        (typing !== null ? (
          <input
            className="knob-input"
            autoFocus
            value={typing}
            aria-label={`${label} value`}
            onChange={(e) => setTyping(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitTyped}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTyped();
              else if (e.key === 'Escape') {
                setTyping(null);
                dial.current?.focus();
              }
              e.stopPropagation();
            }}
          />
        ) : (
          <button
            type="button"
            className="knob-value"
            tabIndex={-1}
            disabled={disabled}
            title="Click to type a value"
            onClick={() => setTyping(unset ? '' : shown.text.replace('+', ''))}
          >
            <span className="num">{shown.text}</span>
            {shown.unit && <span className="unit">{shown.unit}</span>}
          </button>
        ))}
    </div>
  );
}
