/**
 * The two control zones. Easy control: the few knobs the agent chose for a person to try, in one row, each in its
 * own colour (the display shows that colour where the control acts, and full control outlines what it drives), then
 * the two chance keys: another take and surprise me.
 * Full control: every parameter of the open sound; its tabs turn it into the mixer, the project or the notes. It
 * starts closed.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { Control } from '../../core';
import { audition, rollTake, surpriseMe } from '../controller';
import { controlColor } from '../lib/inks';
import { controlDefault, removeControl, setControlValue } from '../lib/patchOps';
import { useEditor, versionIn, type Surface as SurfaceMode } from '../store';
import { Everything } from './Everything';
import { Die, Icon } from './Icon';
import { Knob } from './Knob';
import { Mixer } from './Mixer';
import { ProjectSettings } from './ProjectSettings';
import { Notes } from './Display';
import { Flash, Segmented, Switch } from './Widgets';

function ControlCard({ control, index, size }: { control: Control; index: number; size: number }) {
  const edit = useEditor((s) => s.edit);
  const seal = useEditor((s) => s.seal);
  const saved = useEditor((s) => versionIn(s.saved, s.project.sounds[s.current])?.patch?.controls?.find((c) => c.id === control.id));
  const focus = useEditor((s) => (s.focus?.control === control.id ? s.focus.nonce : 0));
  const active = useEditor((s) => s.activeControl === control.id);
  const card = useRef<HTMLDivElement>(null);
  const color = controlColor(index);
  const hintId = `hint-${control.id}`;

  useEffect(() => {
    if (!focus || !card.current) return;
    card.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.current.querySelector<HTMLElement>('[role="slider"],button')?.focus({ preventScroll: true });
  }, [focus]);

  const set = (value: number) => edit((p) => setControlValue(p, control.id, value), `control:${control.id}`);
  const commit = () => {
    seal();
    audition();
  };
  // The display follows the control under the pointer or the keyboard.
  const follow = (on: boolean) => {
    const now = useEditor.getState().activeControl;
    if (on && now !== control.id) useEditor.setState({ activeControl: control.id });
    else if (!on && now === control.id) useEditor.setState({ activeControl: null });
  };

  const options = control.options ?? [];
  const isToggle = control.widget === 'toggle' && options.length === 2;
  const isSelect = !isToggle && options.length > 0;
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  const log = control.scale === 'exp' && min > 0 && max > 0;

  return (
    <div
      ref={card}
      className={`control${isSelect ? ' control-select' : ''}${active ? ' is-active' : ''}`}
      title={control.hint}
      style={{ '--c': color } as React.CSSProperties}
      onPointerEnter={() => follow(true)}
      onPointerLeave={() => follow(false)}
      onFocus={() => follow(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && follow(false)}
    >
      <Flash id={`c:${control.id}`} />
      <div className="control-label">
        <i className="control-dot" />
        {control.label}
      </div>
      {isToggle ? (
        <Switch
          label={options[Math.round(control.value)]?.label ?? ''}
          size="lg"
          checked={Math.round(control.value) === 1}
          onChange={(on) => {
            set(on ? 1 : 0);
            commit();
          }}
        />
      ) : isSelect ? (
        <Segmented
          label={control.label}
          size="lg"
          value={Math.round(control.value)}
          options={options.map((o, i) => ({ value: i, label: o.label }))}
          onChange={(i) => {
            set(i);
            commit();
          }}
        />
      ) : (
        <Knob
          label={control.label}
          value={control.value}
          range={{ min, max, scale: log ? 'log' : 'linear', step: control.step }}
          unit={control.unit}
          defaultValue={controlDefault(control, saved)}
          size={size}
          ink={color}
          describedBy={control.hint ? hintId : undefined}
          onChange={set}
          onCommit={commit}
        />
      )}
      {control.hint && (
        <p id={hintId} className="sr-only">
          {control.hint}
        </p>
      )}
      <button type="button" className="control-remove" aria-label={`Remove the ${control.label} control`} title="Remove this control" onClick={() => edit((p) => removeControl(p, control.id))}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

const KNOB = 50;

/** Another take (a new seed) and surprise me (every easy control somewhere new, and a new seed). */
function ChanceKeys({ controls }: { controls: Control[] }) {
  const seed = useEditor((s) => s.patch.seed ?? 1);
  return (
    <div className="chance" role="group" aria-label="Let chance decide">
      <button type="button" className="key key-chance" onClick={rollTake} title="Another take: the same sound with a new random seed, then play it">
        <Die seed={seed} size={22} />
        <span>Another take</span>
        <small>same sound, new seed</small>
      </button>
      <button
        type="button"
        className="key key-chance"
        onClick={surpriseMe}
        title={controls.length ? 'Surprise me: every easy control somewhere new, then play it' : 'Surprise me: this sound has no easy controls, so only the seed changes'}
      >
        <Icon name="spark" size={22} />
        <span>Surprise me</span>
        {controls.length > 0 ? (
          <small className="chance-dots" aria-hidden="true">
            {controls.map((c, i) => (
              <i key={c.id} style={{ '--c': controlColor(i) } as React.CSSProperties} />
            ))}
          </small>
        ) : (
          <small>a new seed</small>
        )}
      </button>
    </div>
  );
}

/** Easy control: the patch's controls in one row (it scrolls sideways when there are many), then the chance keys. */
export function EasyStrip() {
  const controls = useEditor((s) => s.patch.controls);
  const hint = useEditor((s) => s.patch.controls?.find((c) => c.id === s.activeControl)?.hint);
  const groups = useMemo(() => {
    const out: { name: string; items: { control: Control; index: number }[] }[] = [];
    (controls ?? []).forEach((control, index) => {
      const name = control.group ?? '';
      let g = out.find((x) => x.name === name);
      if (!g) out.push((g = { name, items: [] }));
      g.items.push({ control, index });
    });
    return out;
  }, [controls]);
  return (
    <section className="zone zone-easy" aria-label="Easy control">
      <div className="easy-side">
        <span className="zone-num">04</span>
        <h2 className="zone-title">Easy control</h2>
        <p className="zone-note" aria-hidden="true">
          {hint ?? 'drag up or down · double-click resets · plays on release'}
        </p>
      </div>
      <div className="easy-row">
        <div className="easy-knobs">
          {groups.length === 0 && <p className="empty">This sound has no easy controls yet: pin the parameters worth playing with from Full control.</p>}
          {groups.map((g) => (
            <div key={g.name} className="easy-group">
              {g.name && <span className="legend">{g.name}</span>}
              {g.items.map(({ control, index }) => (
                <ControlCard key={control.id} control={control} index={index} size={KNOB} />
              ))}
            </div>
          ))}
        </div>
        <ChanceKeys controls={controls ?? []} />
      </div>
    </section>
  );
}

const TABS: { id: SurfaceMode; label: string; title: string }[] = [
  { id: 'sound', label: 'Sound', title: 'Every parameter of the open sound (E)' },
  { id: 'mixer', label: 'Mix', title: 'Balance the set (M)' },
  { id: 'project', label: 'Project', title: 'What the whole set shares' },
  { id: 'notes', label: 'Notes', title: 'What the agent wrote, and who changed what' },
];

const NOTES = {
  sound: 'every parameter · pin one to make it an easy control',
  mixer: 'each sound’s level in the set, after levelling',
  project: 'what every sound in the set shares',
  notes: 'what the agent wrote, and who changed what',
} as const;

/** Full control: everything about the open sound, or the mixer, the project, the notes. Closed, only its head shows. */
export function Surface() {
  const surface = useEditor((s) => s.surface);
  const open = useEditor((s) => s.fullOpen);
  const fresh = useEditor((s) => ((!s.fullOpen || s.surface !== 'notes') && s.activity[0]?.origin === 'agent' ? s.activity[0].id : 0));
  const toggle = () => useEditor.getState().setSettings({ fullOpen: !open });
  return (
    <section className={`zone zone-surface surface-${surface}${open ? '' : ' is-closed'}`} aria-label="Full control">
      <header className="zone-head">
        <span className="zone-num">05</span>
        <h2 className="zone-title">
          <button type="button" className="zone-toggle" aria-expanded={open} aria-controls={open ? 'full-control' : undefined} title={open ? 'Close full control' : 'Open full control'} onClick={toggle}>
            <span className="zone-chevron">
              <Icon name="down" size={14} />
            </span>
            Full control
          </button>
        </h2>
        <div className="seg" role="tablist" aria-label="What full control shows">
          {TABS.map((t) => {
            const on = open && surface === t.id;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} aria-controls={open ? 'full-control' : undefined} className={on ? 'is-on' : ''} title={t.title} onClick={() => useEditor.getState().showSurface(t.id)}>
                {t.label}
                {t.id === 'notes' && fresh > 0 && <i key={fresh} className="led led-agent" />}
              </button>
            );
          })}
        </div>
        <span className="zone-note">{open ? NOTES[surface] : 'every parameter, the mix, the project and the notes'}</span>
      </header>
      {open && (
        <div className="zone-body" id="full-control">
          {surface === 'sound' && <Everything />}
          {surface === 'mixer' && <Mixer />}
          {surface === 'project' && <ProjectSettings />}
          {surface === 'notes' && <Notes />}
        </div>
      )}
    </section>
  );
}
