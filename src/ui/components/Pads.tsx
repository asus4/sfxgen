/**
 * The pads: one per sound in the project, listed down the sidebar. A press opens the sound and plays it; number
 * keys do the same. The LED shows the first state that applies: playing (green), touched by an agent since you last
 * opened it (magenta), approved (off), flagged as needing work (a red ring), changed by you and not yet decided
 * (orange), not reviewed (red). A sound with takes opens them like a folder under its pad. Under the open sound's
 * pad, two keys approve it or flag it, then open the next one to review.
 */
import { useEffect, useMemo, useRef } from 'react';
import { describeChange } from '../../core';
import { exportSet, giveVerdict, openNextUnreviewed, pickTake, pressPad, toggleTakes } from '../controller';
import { groupInk, patchOf, soundKey } from '../lib/projectOps';
import { changesOf, reviewCounts, statusOf, takeInUse } from '../lib/review';
import { useEditor, versionIn, type Take } from '../store';
import { Icon } from './Icon';

function MiniWave({ peaks }: { peaks?: Float32Array }) {
  const d = useMemo(() => {
    if (!peaks) return '';
    const bins = peaks.length / 2;
    let top = '';
    let bottom = '';
    for (let i = 0; i < bins; i++) {
      const x = ((i + 0.5) / bins) * 100;
      top += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${(12 - Math.min(1, Math.max(0, peaks[i * 2 + 1])) * 11 - 0.4).toFixed(1)}`;
      bottom = `L${x.toFixed(1)} ${(12 - Math.max(-1, Math.min(0, peaks[i * 2])) * 11 + 0.4).toFixed(1)}${bottom}`;
    }
    return `${top}${bottom}Z`;
  }, [peaks]);
  return (
    <svg className="pad-wave" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={d || 'M0 12H100'} />
    </svg>
  );
}

const REVIEW_SAYS = { unreviewed: 'not reviewed', 'needs-work': 'needs work', approved: 'approved' } as const;

function Pad({ index }: { index: number }) {
  const sound = useEditor((s) => s.project.sounds[index]);
  const selected = useEditor((s) => s.current === index);
  const key = sound ? soundKey(sound) : '';
  const playing = useEditor((s) => s.playingKey === key);
  const touched = useEditor((s) => key in s.padTouched);
  const peaks = useEditor((s) => s.measured[key]?.peaks);
  const ink = useEditor((s) => groupInk(s.project, sound?.group));
  const review = useEditor((s) => statusOf(s, s.project.sounds[index]));
  const takes = useEditor((s) => (sound?.file ? s.takes[sound.file] : undefined));
  // Edited: a person changed it since an agent last wrote it (or since it was opened).
  const edited = useEditor((s) => {
    const before = versionIn(s.baseline, sound);
    return !!sound && !!before && (before.patch !== sound.patch || (before.gain ?? 0) !== (sound.gain ?? 0));
  });
  const item = useRef<HTMLDivElement>(null);
  // The open sound (and its review keys) stays in view as Approve and Needs work move down the list.
  useEffect(() => {
    if (selected) item.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  if (!sound) return null;
  const name = patchOf(sound).name || key;
  // One LED, the first state that applies; the words name every state, for the tooltip and screen readers.
  const state = playing ? 'playing' : touched ? 'agent' : review === 'approved' ? 'idle' : review === 'needs-work' ? 'needs-work' : edited ? 'edited' : 'unreviewed';
  const says = [playing && 'playing', touched && 'changed by an agent', edited && 'changed by you', REVIEW_SAYS[review]].filter(Boolean).join(', ');
  return (
    <div className={`pad-item${selected ? ' is-open' : ''}`} ref={item}>
      <button
        type="button"
        className={`pad${selected ? ' is-selected' : ''}${sound.skip ? ' is-skipped' : ''}`}
        data-state={state}
        data-review={review}
        aria-pressed={selected}
        aria-label={`Pad ${index + 1}: ${name}, ${says}`}
        aria-keyshortcuts={index < 10 ? String((index + 1) % 10) : undefined}
        title={`${name}${sound.file ? ` · ${sound.file}` : ''} · ${says}`}
        style={{ '--c': ink } as React.CSSProperties}
        onClick={() => pressPad(index)}
      >
        <span className="pad-num">{index + 1}</span>
        <span className="pad-body">
          <span className="pad-name">{name}</span>
          <MiniWave peaks={peaks} />
        </span>
        <i className="led" />
        {ink && <i className="pad-group" />}
      </button>
      {takes && takes.length > 0 && <Takes index={index} name={name} soundKey={key} takes={takes} />}
      {selected && <ReviewKeys />}
    </div>
  );
}

/** A sound's takes, like a folder under its pad: the one in use is checked, and a click uses another. */
function Takes({ index, name, soundKey: key, takes }: { index: number; name: string; soundKey: string; takes: Take[] }) {
  const open = useEditor((s) => !!s.takesOpen[key]);
  const inUse = useEditor((s) => {
    const t = takeInUse(s, s.project.sounds[index]);
    return t ? `${t.changed ? '*' : ''}${t.take.path}` : '';
  });
  const changed = inUse.startsWith('*');
  const inUsePath = changed ? inUse.slice(1) : inUse;
  const label = takes.find((t) => t.path === inUsePath)?.label;
  return (
    <>
      <button type="button" className="pad-takes-toggle" aria-expanded={open} title={open ? 'Hide the takes' : 'Show the takes: other versions of this sound'} onClick={() => toggleTakes(index)}>
        <Icon name="down" size={11} />
        <span>
          {takes.length} take{takes.length === 1 ? '' : 's'}
          {label ? ` · ${label}${changed ? ', changed' : ''}` : ''}
        </span>
      </button>
      {open && (
        <div className="pad-takes" role="group" aria-label={`Takes of ${name}`}>
          {takes.map((t) => {
            const on = t.path === inUsePath;
            return (
              <button
                key={t.path}
                type="button"
                className="take"
                aria-pressed={on}
                title={on ? `In use${changed ? ', with your changes' : ''}` : `Use “${t.label}” for ${name} and play it ( [ and ] step through the takes)`}
                onClick={() => void pickTake(index, t.path)}
              >
                <i className="take-radio" aria-hidden="true" />
                <span className="take-name">{t.label}</span>
                {on && changed && <i className="led led-edited" aria-label="changed by you" />}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Approve the open sound or flag it as needing work; either one opens the next sound to review. */
function ReviewKeys() {
  const status = useEditor((s) => statusOf(s, s.project.sounds[s.current]));
  const changes = useEditor((s) => {
    const sound = s.project.sounds[s.current];
    return changesOf(s, sound).map((c) => describeChange(c, patchOf(sound)).replace(' -> ', ' → ')).join(', ');
  });
  const count = changes ? changes.split(', ').length : 0;
  const what = changes ? `, with your changes: ${changes}` : '';
  return (
    <div className="review-keys" role="group" aria-label="Review the open sound">
      <button
        type="button"
        className="key key-approve"
        aria-pressed={status === 'approved'}
        aria-keyshortcuts="A"
        title={status === 'approved' ? 'Approved. Press again to take it back.' : `Approve this version (A)${what}. Then the next sound to review opens.`}
        onClick={() => giveVerdict('approved')}
      >
        <Icon name="check" size={14} />
        <span>{status === 'approved' ? 'Approved' : 'Approve'}</span>
        {count > 0 && status !== 'approved' && <small>{count}</small>}
      </button>
      <button
        type="button"
        className="key key-needs-work"
        aria-pressed={status === 'needs-work'}
        aria-keyshortcuts="N"
        title={status === 'needs-work' ? 'Flagged. Press again to take it back.' : `Needs work (N)${what}: say what in the chat with your agent. Then the next sound to review opens.`}
        onClick={() => giveVerdict('needs-work')}
      >
        <span>Needs work</span>
      </button>
    </div>
  );
}

/** How many sounds wait for a verdict; a click opens the next one. */
function ReviewCount() {
  const left = useEditor((s) => reviewCounts(s).unreviewed);
  if (left === 0) return <span className="pads-reviewed">all reviewed</span>;
  return (
    <button type="button" className="pads-review" title="Open the next sound nobody has reviewed, and play it" onClick={openNextUnreviewed}>
      <i className="led" aria-hidden="true" />
      {left} to review
    </button>
  );
}

/**
 * The empty slot after the last pad. Most people add a sound by picking one, so it opens the gallery (which also
 * offers a blank sound or a file).
 */
function AddSlot() {
  return (
    <button
      type="button"
      className="pad-add"
      title="Add a sound: pick one from the gallery, or start blank or from a file"
      onClick={() => useEditor.setState({ gallery: { open: true, mode: 'add' } })}
    >
      <span className="pad-add-icon">
        <Icon name="plus" size={14} />
      </span>
      <span className="pad-add-text">
        <b>Add a sound</b>
        <small>
          <Icon name="grid" size={11} /> from the gallery
        </small>
      </span>
    </button>
  );
}

/** The sidebar: the project's sounds as a list of pads (a row of them on a phone). */
export function Pads() {
  const count = useEditor((s) => s.project.sounds.length);
  return (
    <aside className="zone zone-pads" aria-label="Sounds">
      <header className="pads-head">
        <span className="zone-num">02</span>
        <h2 className="zone-title">Sounds</h2>
        <span className="zone-note">{count}</span>
        <ReviewCount />
      </header>
      <div className="pads-body">
        <div className="pad-list" role="group" aria-label="Pads">
          {Array.from({ length: count }, (_, i) => (
            <Pad key={i} index={i} />
          ))}
        </div>
        <AddSlot />
      </div>
      <footer className="pads-foot">
        <button type="button" className="key" title="Export every sound of the set" onClick={() => void exportSet()}>
          <Icon name="export" size={15} /> <span>Export set</span>
        </button>
      </footer>
    </aside>
  );
}
