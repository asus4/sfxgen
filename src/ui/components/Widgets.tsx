/** Small shared widgets: segmented choices, switches, the highlighter flash. */
import type { ReactNode } from 'react';
import { useEditor } from '../store';

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}) {
  return (
    <div className={`seg seg-${props.size ?? 'md'}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? 'is-on' : ''}
          title={o.title}
          disabled={props.disabled}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { label: string; checked: boolean; onChange: (on: boolean) => void; size?: 'sm' | 'lg'; disabled?: boolean; hideLabel?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.hideLabel ? props.label : undefined}
      className={`switch switch-${props.size ?? 'sm'}${props.checked ? ' is-on' : ''}`}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {!props.hideLabel && <span className="switch-label">{props.label}</span>}
    </button>
  );
}

/** A highlighter swipe that replays whenever the store flashes this key. */
export function Flash({ id }: { id: string }) {
  const nonce = useEditor((s) => s.flash[id]);
  if (!nonce) return null;
  return <span key={nonce} className="flash" aria-hidden="true" />;
}
