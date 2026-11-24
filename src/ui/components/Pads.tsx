/**
 * The pads: one per sound in the project, listed down the sidebar. A press opens the sound and plays it; number
 * keys do the same. The LED tells its state: playing, changed by you, or touched by an agent since you last opened
 * it.
 */
import { useMemo } from 'react';
import { exportSet, pressPad } from '../controller';
import { groupInk, patchOf, soundKey } from '../lib/projectOps';
import { useEditor, versionIn } from '../store';
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

function Pad({ index }: { index: number }) {
  const sound = useEditor((s) => s.project.sounds[index]);
  const selected = useEditor((s) => s.current === index);
  const key = sound ? soundKey(sound) : '';
  const playing = useEditor((s) => s.playingKey === key);
  const touched = useEditor((s) => key in s.padTouched);
  const peaks = useEditor((s) => s.measured[key]?.peaks);
  const ink = useEditor((s) => groupInk(s.project, sound?.group));
  // Edited: a person changed it since an agent last wrote it (or since it was opened).
  const edited = useEditor((s) => {
    const before = versionIn(s.baseline, sound);
    return !!sound && !!before && (before.patch !== sound.patch || (before.gain ?? 0) !== (sound.gain ?? 0));
  });
  if (!sound) return null;
  const name = patchOf(sound).name || key;
  const state = playing ? 'playing' : touched ? 'agent' : edited ? 'edited' : 'idle';
  const says = { playing: 'playing', agent: 'changed by an agent', edited: 'changed by you', idle: '' }[state];
  return (
    <button
      type="button"
      className={`pad${selected ? ' is-selected' : ''}${sound.skip ? ' is-skipped' : ''}`}
      data-state={state}
      aria-pressed={selected}
      aria-label={`Pad ${index + 1}: ${name}${says ? `, ${says}` : ''}`}
      aria-keyshortcuts={index < 10 ? String((index + 1) % 10) : undefined}
      title={`${name}${sound.file ? ` · ${sound.file}` : ''}${says ? ` · ${says}` : ''}`}
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
        <button type="button" className="key key-sm" aria-label="Add a sound" title="Add a sound: from the gallery, a file or blank" onClick={() => useEditor.setState({ gallery: { open: true, mode: 'add' } })}>
          <Icon name="plus" size={12} /> Add
        </button>
      </header>
      <div className="pad-list" role="group" aria-label="Pads">
        {Array.from({ length: count }, (_, i) => (
          <Pad key={i} index={i} />
        ))}
      </div>
      <footer className="pads-foot">
        <button type="button" className="key" title="Export every sound of the set" onClick={() => void exportSet()}>
          <Icon name="export" size={15} /> <span>Export set</span>
        </button>
      </footer>
    </aside>
  );
}
