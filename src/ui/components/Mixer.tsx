/**
 * The mixer: every sound of the set with its level (a gain after levelling), its loudness and peak as the project
 * renders it, and a play key. Sounds sit in their groups; a group can be played in turn and matched to one loudness.
 */
import { useMemo, useState } from 'react';
import type { Normalize, ProjectGroup, ProjectSound, SoundLevel } from '../../core';
import { deleteSound, matchLoudnessOf, playSet, playSound, stop } from '../controller';
import { INKS } from '../lib/inks';
import { addGroup, dbText, groupInk, levelOf, patchOf, removeGroup, soundKey, suggestTarget, updateGroup, updateSound } from '../lib/projectOps';
import { useEditor } from '../store';
import { Fader } from './Fader';
import { Icon } from './Icon';

const GAIN = { min: -24, max: 12, step: 0.1 };
/** The meter's span, dB. */
const FLOOR = -48;

const meterPos = (db: number) => (Number.isFinite(db) ? Math.max(0, Math.min(1, 1 - db / FLOOR)) : 0);

function NumBox({ label, value, unit, onChange }: { label: string; value: number; unit: string; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="numbox" title={label}>
      <input
        aria-label={label}
        inputMode="decimal"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        onBlur={() => {
          const v = Number(draft);
          if (draft !== null && draft.trim() !== '' && Number.isFinite(v)) onChange(v);
          setDraft(null);
        }}
      />
      <span>{unit}</span>
    </label>
  );
}

function Row({ index }: { index: number }) {
  const sound = useEditor((s) => s.project.sounds[index]) as ProjectSound | undefined;
  const key = sound ? soundKey(sound) : '';
  const measured = useEditor((s) => s.measured[key]);
  const groups = useEditor((s) => s.project.groups);
  const ink = useEditor((s) => groupInk(s.project, sound?.group));
  const open = useEditor((s) => s.current === index);
  const playing = useEditor((s) => s.playingKey === key);
  const only = useEditor((s) => s.project.sounds.length <= 1);
  const editProject = useEditor((s) => s.editProject);
  if (!sound) return null;
  const level = levelOf(sound, measured);
  const gain = sound.gain ?? 0;
  const hot = !!level && level.peakDb > -0.05;
  const stale = !measured;
  return (
    <div className={`mix-row${open ? ' is-open' : ''}${sound.skip ? ' is-skipped' : ''}`} style={{ '--c': ink } as React.CSSProperties}>
      <button type="button" className={`mix-play${playing ? ' is-on' : ''}`} aria-label={`${playing ? 'Stop' : 'Play'} ${key}`} onClick={() => (playing ? stop() : void playSound(index))}>
        <span>{index + 1}</span>
        <Icon name={playing ? 'stop' : 'play'} size={12} fill />
      </button>
      <button type="button" className="mix-name" title="Open this sound" onClick={() => useEditor.getState().openSound(index)}>
        {patchOf(sound).name || key}
        {sound.file && <small>{sound.file}</small>}
      </button>
      <select
        className="mix-group"
        aria-label={`Group of ${key}`}
        title="Which group this sound is in"
        value={sound.group ?? ''}
        onChange={(e) => editProject((p) => updateSound(p, index, { group: e.target.value || undefined }))}
      >
        <option value="">no group</option>
        {(groups ?? []).map((g) => (
          <option key={g.id} value={g.id}>
            {g.label ?? g.id}
          </option>
        ))}
      </select>
      <Fader
        label={`Level of ${key}`}
        title="Level of this sound in the set"
        value={gain}
        range={GAIN}
        defaultValue={0}
        valueText={`${dbText(gain)} dB`}
        ink={ink}
        onChange={(v) => editProject((p) => updateSound(p, index, { gain: v }), `gain:${key}`)}
        onCommit={() => {
          useEditor.getState().seal();
          void playSound(index);
        }}
      />
      <output className="mix-gain">{dbText(gain)}</output>
      <div className={`mix-meter${hot ? ' is-hot' : ''}${stale ? ' is-stale' : ''}`} title={level ? `Peak ${dbText(level.peakDb)} dB · loudness ${dbText(level.lufs)} LUFS` : 'Measuring…'}>
        <span className="mix-peak" style={{ width: `${meterPos(level?.peakDb ?? -Infinity) * 100}%` }} />
        {level && Number.isFinite(level.lufs) && <span className="mix-lufs" style={{ left: `${meterPos(level.lufs) * 100}%` }} />}
      </div>
      <output className="mix-num" title="Loudness (LUFS)">{dbText(level?.lufs)}</output>
      <output className={`mix-num${hot ? ' is-hot' : ''}`} title="Peak level (dB)">{dbText(level?.peakDb)}</output>
      <button
        type="button"
        className={`tool${sound.skip ? ' is-on' : ''}`}
        aria-pressed={!!sound.skip}
        aria-label={`Leave ${key} out of exports`}
        title="Skip when exporting"
        onClick={() => editProject((p) => updateSound(p, index, { skip: sound.skip ? undefined : true }))}
      >
        <Icon name="power" size={13} />
      </button>
      <button type="button" className="tool" aria-label={`Remove ${key} from the project`} title="Remove from project" disabled={only} onClick={() => deleteSound(index)}>
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}

const LEVELLING: { value: string; label: string }[] = [
  { value: '', label: 'project levelling' },
  { value: 'peak', label: 'peak' },
  { value: 'loudness', label: 'loudness' },
  { value: 'none', label: 'no levelling' },
];

function GroupBlock({ group, indexes, target, ceiling }: { group: ProjectGroup | null; indexes: number[]; target: number; ceiling: number }) {
  const editProject = useEditor((s) => s.editProject);
  const ink = useEditor((s) => groupInk(s.project, group?.id));
  const setNormalize = (mode: string, value?: number) => {
    if (!group) return;
    const normalize: Normalize | undefined = mode ? { mode: mode as Normalize['mode'], ...(value !== undefined ? { target: value } : {}) } : undefined;
    editProject((p) => updateGroup(p, group.id, { normalize }));
  };
  const mode = group?.normalize?.mode ?? '';
  return (
    <div className="mix-group-block" style={{ '--c': ink } as React.CSSProperties}>
      <header className="mix-group-head">
        {group ? (
          <>
            <button
              type="button"
              className="swatch"
              aria-label="Change this group’s ink"
              title="Change colour"
              onClick={() => {
                const at = INKS.findIndex((k) => k.hex.toLowerCase() === (ink ?? '').toLowerCase());
                editProject((p) => updateGroup(p, group.id, { color: INKS[(at + 1) % INKS.length].hex }));
              }}
            />
            <input className="mix-group-name" aria-label="Group name" title="Rename the group" value={group.label ?? group.id} onChange={(e) => editProject((p) => updateGroup(p, group.id, { label: e.target.value }), `group:${group.id}`)} />
            <select className="mix-levelling" aria-label="How this group is levelled" title="How this group is levelled" value={mode} onChange={(e) => setNormalize(e.target.value)}>
              {LEVELLING.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {(mode === 'peak' || mode === 'loudness') && (
              <NumBox label="Levelling target" unit={mode === 'peak' ? 'dB' : 'LUFS'} value={group.normalize?.target ?? (mode === 'peak' ? -1 : -16)} onChange={(v) => setNormalize(mode, v)} />
            )}
          </>
        ) : (
          <span className="legend">No group</span>
        )}
        <span className="spacer" />
        <button type="button" className="key key-sm" title="Play this group" disabled={indexes.length === 0} onClick={() => void playSet(group?.id ?? null)}>
          <Icon name="play" size={11} fill /> <span>Play</span>
        </button>
        <button type="button" className="key key-sm" title={`Make these equally loud (${target} LUFS)`} disabled={indexes.length === 0} onClick={() => void matchLoudnessOf(group?.id ?? null, target, ceiling)}>
          <span>Match</span>
        </button>
        {group && (
          <button type="button" className="tool" aria-label={`Delete group ${group.label ?? group.id}`} title="Delete the group, keep its sounds" onClick={() => editProject((p) => removeGroup(p, group.id))}>
            <Icon name="close" size={13} />
          </button>
        )}
      </header>
      {indexes.map((i) => (
        <Row key={i} index={i} />
      ))}
      {indexes.length === 0 && <p className="empty" title="Choose this group on a sound’s row to add it">No sounds in this group.</p>}
    </div>
  );
}

export function Mixer() {
  const project = useEditor((s) => s.project);
  const measured = useEditor((s) => s.measured);
  const editProject = useEditor((s) => s.editProject);
  const setPlaying = useEditor((s) => s.playing);
  const levels = useMemo(() => project.sounds.map((x) => levelOf(x, measured[soundKey(x)])).filter((l): l is SoundLevel => l !== null), [project, measured]);
  const [target, setTarget] = useState<number | null>(null);
  const [ceiling, setCeiling] = useState(-1);
  const goal = target ?? suggestTarget(levels);
  const byGroup = (id: string | null) => project.sounds.map((x, i) => ({ x, i })).filter(({ x }) => (x.group ?? null) === id || (id === null && !project.groups?.some((g) => g.id === x.group))).map(({ i }) => i);
  const loose = byGroup(null);
  return (
    <div className="mixer">
      <div className="mix-bar">
        <button type="button" className={`key${setPlaying ? ' is-on' : ''}`} onClick={() => (setPlaying ? stop() : void playSet())} title="Play all sounds">
          <Icon name={setPlaying ? 'stop' : 'play'} size={14} fill /> <span>{setPlaying ? 'Stop' : 'Play the set'}</span>
        </button>
        <span className="spacer" />
        <span className="legend">match to</span>
        <NumBox label="Loudness to match to" unit="LUFS" value={goal} onChange={setTarget} />
        <span className="legend">ceiling</span>
        <NumBox label="Highest peak allowed" unit="dB" value={ceiling} onChange={(v) => setCeiling(Math.min(0, v))} />
        <button type="button" className="key" onClick={() => void matchLoudnessOf('*', goal, ceiling)} title="Make all sounds equally loud">
          <span>Match all</span>
        </button>
        <button type="button" className="key" onClick={() => editProject((p) => addGroup(p, `Group ${(p.groups?.length ?? 0) + 1}`).project)}>
          <Icon name="plus" size={13} /> <span>Group</span>
        </button>
      </div>
      {(loose.length > 0 || !project.groups?.length) && <GroupBlock group={null} indexes={loose} target={goal} ceiling={ceiling} />}
      {(project.groups ?? []).map((g) => (
        <GroupBlock key={g.id} group={g} indexes={byGroup(g.id)} target={goal} ceiling={ceiling} />
      ))}
    </div>
  );
}
