/** A horizontal fader: the knob's manners (drag, keys, Shift for fine, double-click to reset) on a straight track. */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { positionToValue, stepByKey, valueToPosition, type KnobRange } from '../lib/knob';

export interface FaderProps {
  label: string;
  value: number;
  range: KnobRange;
  defaultValue?: number;
  valueText?: string;
  ink?: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
}

export function Fader({ label, value, range, defaultValue, valueText, ink, onChange, onCommit }: FaderProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; position: number } | null>(null);
  const [active, setActive] = useState(false);
  const position = valueToPosition(value, range);
  const zero = defaultValue !== undefined ? valueToPosition(defaultValue, range) : null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { x: e.clientX, position };
    setActive(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const width = track.current?.clientWidth ?? 0;
    if (!d || width <= 0) return;
    const dx = e.clientX - d.x;
    if (dx === 0) return;
    d.x = e.clientX;
    d.position = Math.min(1, Math.max(0, d.position + dx / (width * (e.shiftKey ? 10 : 1))));
    const next = positionToValue(d.position, range);
    if (next !== value) onChange(next);
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    onCommit?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && defaultValue !== undefined) {
      e.preventDefault();
      onChange(defaultValue);
      return;
    }
    const next = stepByKey(value, e.key, e.shiftKey, range);
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  return (
    <div
      ref={track}
      className={`fader${active ? ' is-active' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      style={{ '--c': ink, '--pos': position } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        if (defaultValue === undefined) return;
        onChange(defaultValue);
        onCommit?.();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => /^(Arrow|Page|Home|End|Delete|Backspace)/.test(e.key) && onCommit?.()}
    >
      <span className="fader-slot" />
      {zero !== null && <span className="fader-zero" style={{ left: `${zero * 100}%` }} />}
      <span className="fader-cap" />
    </div>
  );
}
