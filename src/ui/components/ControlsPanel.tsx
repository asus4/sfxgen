/** The controls: the few knobs the agent chose for a person to try. The default view. */
import { useEffect, useMemo, useRef } from 'react';
import type { Control } from '../../core';
import { audition } from '../controller';
import { inkAt } from '../lib/inks';
import { controlDefault, removeControl, setControlValue } from '../lib/patchOps';
import { useEditor } from '../store';
import { Icon } from './Icon';
import { Knob } from './Knob';
import { Flash, Segmented, Switch } from './Widgets';

function ControlCard({ control, index, big }: { control: Control; index: number; big: boolean }) {
  const edit = useEditor((s) => s.edit);
  const seal = useEditor((s) => s.seal);
  const everything = useEditor((s) => s.everything);
  const saved = useEditor((s) => s.saved.controls?.find((c) => c.id === control.id));
  const focus = useEditor((s) => (s.focus?.control === control.id ? s.focus.nonce : 0));
  const card = useRef<HTMLDivElement>(null);
  const ink = inkAt(index);
  const hintId = `hint-${control.id}`;

  useEffect(() => {
    if (!focus || !card.current) return;
    card.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.current.querySelector<HTMLElement>('[role="slider"],button')?.focus({ preventScroll: true });
  }, [focus]);

  const set = (value: number) => edit((p) => setControlValue(p, control.id, value), `control:${control.id}`);
  const commit = () => {
    seal();
    audition();
  };

  const options = control.options ?? [];
  const isToggle = control.widget === 'toggle' && options.length === 2;
  const isSelect = !isToggle && options.length > 0;
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  const log = control.scale === 'exp' && min > 0 && max > 0;

  return (
    <div ref={card} className={`control${isSelect ? ' control-select' : ''}`} style={{ '--c': ink } as React.CSSProperties}>
      <Flash id={`c:${control.id}`} />
      <div className="control-label display">{control.label}</div>
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
          size={big ? 128 : 104}
          ink={ink}
          describedBy={control.hint ? hintId : undefined}
          onChange={set}
          onCommit={commit}
        />
      )}
      {control.hint && (
        <p id={hintId} className="control-hint">
          {control.hint}
        </p>
      )}
      {everything && (
        <button type="button" className="control-remove" aria-label={`Remove the ${control.label} control`} title="Remove this control" onClick={() => edit((p) => removeControl(p, control.id))}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

export function ControlsPanel() {
  const controls = useEditor((s) => s.patch.controls);
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

  // A few controls get bigger knobs: the fewer the moves, the more each one matters.
  const big = (controls?.length ?? 0) <= 4;
  return (
    <section className={`controls sheet${big ? ' is-big' : ''}`} aria-label="Controls">
      <header className="panel-head">
        <h2 className="display">Controls</h2>
        <p>The moves that matter for this sound. Drag a knob up or down, double-click to reset.</p>
      </header>
      {groups.length === 0 ? (
        <p className="empty">
          This patch has no controls yet. Open <b>Everything</b> and pin the parameters worth playing with.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.name} className="control-group">
            {g.name && <h3 className="group-name">{g.name}</h3>}
            <div className="control-grid">
              {g.items.map(({ control, index }) => (
                <ControlCard key={control.id} control={control} index={index} big={big} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
