/**
 * Everything: every parameter of the selected track, or of the master and the patch. The fields are generated from
 * the node metadata (ParamMeta), so a new source or effect shows up here without any editor code.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BUS_FIELDS,
  COMMON_EFFECT_PARAMS,
  COMMON_SOURCE_PARAMS,
  ENVELOPE_FIELDS,
  MASTER_FIELDS,
  PATCH_FIELDS,
  REPEAT_FIELDS,
  TRACK_FIELDS,
  getEffect,
  getPath,
  getSource,
  listEffects,
  listSources,
  type AdsrEnvelope,
  type Breakpoint,
  type Envelope,
  type NodeDef,
  type ParamMap,
  type ParamMeta,
  type Patch,
  type TrackEvent,
} from '../../core';
import { renderEnvelope } from '../../core/params';
import { audition } from '../controller';
import { prefersReducedMotion, useAppliedPatch } from '../hooks';
import { INKS, controlColor, trackInk } from '../lib/inks';
import { parseValue } from '../lib/knob';
import {
  addEffect,
  changeSourceType,
  duplicateTrack,
  effectSegment,
  getChain,
  moveEffect,
  moveSetValue,
  mutate,
  pinControl,
  pinKind,
  readSignal,
  removeEffect,
  removeTrack,
  setAt,
  uniqueId,
  writeSignal,
} from '../lib/patchOps';
import { canonPath, drivenPaths, type Driver } from '../lib/paths';
import { SELECT_MASTER, editor, useEditor, type EditorState } from '../store';
import { CurveEditor } from './CurveEditor';
import { Icon } from './Icon';
import { Knob } from './Knob';
import { Flash, Segmented, Switch } from './Widgets';

/** What the fields read and write: the open patch, or the project (its shared master chain). */
export interface Scope {
  read(s: EditorState): unknown;
  write(fn: (root: never) => unknown, tag: string | null): void;
  /** Can its parameters be pinned into the controls? */
  pins: boolean;
}

export const patchScope: Scope = {
  read: (s) => s.patch,
  write: (fn, tag) => editor().edit(fn as (p: Patch) => Patch, tag),
  pins: true,
};

export const projectScope: Scope = {
  read: (s) => s.project,
  // The fields edit the project's own settings; the sounds ride along untouched, so no patch is copied or re-saved.
  write: (fn, tag) => editor().editProject((p) => ({ ...(fn({ ...p, sounds: [] } as never) as typeof p), sounds: p.sounds }), tag),
  pins: false,
};

interface Ctx {
  applied: Patch;
  drivers: Map<string, Driver[]>;
  ink: string;
  scope: Scope;
  /** The control being hovered or turned: its colour and the canonical paths it drives, to light them up here. */
  follow?: { color: string; paths: string[] };
}
const EMPTY_APPLIED: Patch = { format: 'sfxgen/1', name: '', duration: 'auto', tracks: [] };
export const EverythingContext = createContext<Ctx>({ applied: EMPTY_APPLIED, drivers: new Map(), ink: 'var(--ink)', scope: patchScope });

/** Fields under this edit the project instead of the open patch. */
export function ProjectFields({ ink, children }: { ink?: string; children: ReactNode }) {
  const ctx = useMemo(() => ({ applied: EMPTY_APPLIED, drivers: new Map(), ink: ink ?? 'var(--ink)', scope: projectScope }), [ink]);
  return <EverythingContext.Provider value={ctx}>{children}</EverythingContext.Provider>;
}

function humanize(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function commit(): void {
  useEditor.getState().seal();
  audition();
}

/** Writes a value, first creating the group it lives in when that group only exists as defaults. */
function useWrite(path: string, materialize?: { path: string; value: unknown }) {
  const { scope } = useContext(EverythingContext);
  return (value: unknown) =>
    scope.write((p: unknown) => {
      let next = p;
      if (materialize && getPath(p, materialize.path) === undefined) next = setAt(next, materialize.path, materialize.value);
      return setAt(next, path, value);
    }, `p:${path}`);
}

// ---- One parameter ----------------------------------------------------------------------------

const SIGN: Record<Driver['mode'], string> = { set: '=', option: '=', mul: '×', add: '+', stretch: '↔' };

/** The controls that drive this parameter, as highlighter tags that lead to them. */
function Drivers({ drivers }: { drivers?: Driver[] }) {
  const focusControl = useEditor((s) => s.focusControl);
  if (!drivers?.length) return null;
  return (
    <span className="drivers">
      {drivers.map((d) => (
        <button
          key={`${d.control.id}:${d.mode}`}
          type="button"
          className="driver"
          title={`Set by the “${d.control.label}” control. Click to show it`}
          onClick={() => focusControl(d.control.id)}
        >
          {SIGN[d.mode]} {d.control.label}
        </button>
      ))}
    </span>
  );
}

function PinButton({ path, meta, value, drivers }: { path: string; meta: ParamMeta; value: unknown; drivers?: Driver[] }) {
  const edit = useEditor((s) => s.edit);
  const focusControl = useEditor((s) => s.focusControl);
  if (drivers?.length || !pinKind(meta, value)) return null;
  return (
    <button
      type="button"
      className="pin"
      aria-label="Add to Easy control"
      title="Add to Easy control"
      onClick={() => {
        const pinned = pinControl(useEditor.getState().patch, path);
        if (!pinned) return;
        edit(pinned.patch);
        focusControl(pinned.id);
      }}
    >
      <Icon name="pin" size={13} />
    </button>
  );
}

interface FieldProps {
  path: string;
  name: string;
  meta: ParamMeta;
  /** Shown when the patch gives no value and the metadata has no default (a source's own envelope times). */
  fallback?: unknown;
  materialize?: { path: string; value: unknown };
}

function ParamField({ path, name, meta, fallback, materialize }: FieldProps) {
  const { applied, drivers, ink, scope, follow } = useContext(EverythingContext);
  const raw = useEditor((s) => getPath(scope.read(s), path));
  const canon = useEditor((s) => (scope.pins ? canonPath(s.patch, path) : `project.${path}`));
  const write = useWrite(path, materialize);
  const driving = drivers.get(canon);
  const overridden = !!driving?.some((d) => d.mode === 'set' || d.mode === 'option');
  const value = overridden ? getPath(applied, path) : raw;
  // A number a control sets can still be turned: the control's range for it moves (the 1:N binding stays), so the
  // knob lands where it was put and the control keeps working around it.
  const moveDriven = (v: number) => scope.write((p: unknown) => moveSetValue(p as Patch, path, v) ?? p, `p:${path}`);
  const label = meta.label ?? humanize(name);
  // What it does, in plain words: the tooltip of the whole field, so it shows over the knob or switch itself.
  const hint = meta.hint ?? meta.doc;
  const dflt = meta.default ?? fallback;
  const pin = scope.pins ? <PinButton path={path} meta={meta} value={raw} drivers={driving} /> : null;
  const tags = <Drivers drivers={driving} />;
  // Lit in the control's colour while that control is hovered or turned (also when it drives a parent, as a
  // stretch of the whole envelope does).
  const followed = !!follow && follow.paths.some((p) => canon === p || canon.startsWith(`${p}.`));
  const flash = (
    <>
      <Flash id={`p:${canon}`} />
      {followed && <span className="following" style={{ '--c': follow!.color } as React.CSSProperties} />}
    </>
  );

  if (meta.kind === 'object' && meta.fields) return <GroupField path={path} name={name} meta={meta} />;

  if (meta.kind === 'number' || meta.kind === 'signal') {
    const signal = readSignal(value);
    const range = { min: meta.min ?? 0, max: meta.max ?? 1, scale: meta.scale, step: meta.step };
    if (meta.kind === 'signal' && signal.points) {
      return (
        <div className="param param-wide" title={hint}>
          {flash}
          <div className="param-head">
            <span className="param-label">
              {label}
              {signal.mods > 0 && <em className="mods">+{signal.mods} mod</em>}
            </span>
            {tags}
            <span className="param-tools">
              <button
                type="button"
                className="pin"
                title="Use one fixed value"
                aria-label={`Flatten ${label} to one value`}
                onClick={() => {
                  write(writeSignal(raw, { constant: signal.points![0][1] }));
                  commit();
                }}
              >
                <Icon name="flat" size={13} />
              </button>
              {pin}
            </span>
          </div>
          <CurveEditor label={label} points={signal.points} meta={meta} curve={signal.curve} ink={ink} onChange={(points) => write(writeSignal(raw, { points }))} onCommit={commit} />
        </div>
      );
    }
    const number = signal.constant ?? (typeof dflt === 'number' ? dflt : undefined);
    const isDefault = raw === undefined;
    // Only a patch's parameters have controls; a project's settings never do.
    const movable = overridden && !!scope.pins;
    return (
      <div className={`param${isDefault && !overridden ? ' is-default' : ''}${overridden ? (movable ? ' is-bound' : ' is-driven') : ''}`} title={hint}>
        {flash}
        <Knob
          label={label}
          value={number}
          range={range}
          unit={meta.unit}
          defaultValue={typeof dflt === 'number' && !overridden ? dflt : undefined}
          onReset={overridden ? undefined : () => write(undefined)}
          hardMin={meta.hardMin}
          hardMax={meta.hardMax}
          size={46}
          ink={ink}
          disabled={overridden && !movable}
          onChange={(v) => (overridden ? moveDriven(v) : write(meta.kind === 'signal' ? writeSignal(raw, { constant: v }) : v))}
          onCommit={commit}
        />
        <span className="param-label">
          {label}
          {signal.mods > 0 && <em className="mods">+{signal.mods} mod</em>}
        </span>
        {tags}
        <span className="param-tools">
          {meta.kind === 'signal' && !overridden && (
            <button
              type="button"
              className="pin"
              title="Change it over time"
              aria-label={`Draw a curve for ${label}`}
              onClick={() => {
                const v = number ?? range.min;
                write(writeSignal(raw, { points: [[0, v], [0.2, v]] }));
              }}
            >
              <Icon name="curve" size={13} />
            </button>
          )}
          {pin}
        </span>
      </div>
    );
  }

  if (meta.kind === 'enum' && meta.options) {
    const current = String(value ?? dflt ?? meta.options[0]);
    const numeric = meta.options.every((o) => /^-?\d+(\.\d+)?$/.test(o));
    const set = (o: string) => {
      write(numeric ? Number(o) : o);
      commit();
    };
    return (
      <div className={`param param-enum${meta.options.length > 4 ? '' : ' param-wide'}${overridden ? ' is-driven' : ''}`} title={hint}>
        {flash}
        <div className="param-head">
          <span className="param-label">
            {label}
          </span>
          {tags}
          <span className="param-tools">{pin}</span>
        </div>
        {meta.options.length > 4 ? (
          <select className="select" value={current} disabled={overridden} aria-label={label} onChange={(e) => set(e.target.value)}>
            {meta.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <Segmented label={label} size="sm" value={current} disabled={overridden} options={meta.options.map((o) => ({ value: o, label: o }))} onChange={set} />
        )}
      </div>
    );
  }

  if (meta.kind === 'bool') {
    return (
      <div className={`param param-bool${overridden ? ' is-driven' : ''}`} title={hint}>
        {flash}
        <Switch
          label={label}
          checked={Boolean(value ?? dflt)}
          disabled={overridden}
          onChange={(on) => {
            write(on === Boolean(meta.default) ? undefined : on);
            commit();
          }}
        />
        {tags}
        <span className="param-tools">{pin}</span>
      </div>
    );
  }

  if (meta.kind === 'string') {
    return (
      <label className="param param-text param-wide" title={hint}>
        <span className="param-label">{label}</span>
        <input className="text" value={typeof value === 'string' ? value : ''} spellCheck={false} onChange={(e) => write(e.target.value || undefined)} />
      </label>
    );
  }

  return <JsonField path={path} label={label} doc={hint} />;
}

/** Anything the metadata describes only loosely (lists, future kinds): edit it as JSON. */
function JsonField({ path, label, doc }: { path: string; label: string; doc?: string }) {
  const { scope } = useContext(EverythingContext);
  const raw = useEditor((s) => getPath(scope.read(s), path));
  const write = useWrite(path);
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const text = draft ?? (raw === undefined ? '' : JSON.stringify(raw));
  return (
    <label className="param param-text param-wide" title={doc}>
      <span className="param-label">{label}</span>
      <textarea
        className={`text mono${bad ? ' is-bad' : ''}`}
        rows={2}
        value={text}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          try {
            write(draft.trim() === '' ? undefined : JSON.parse(draft));
            setBad(false);
            setDraft(null);
            commit();
          } catch {
            setBad(true);
          }
        }}
      />
    </label>
  );
}

/** An optional group of parameters (a voice filter): a switch, then its fields. */
function GroupField({ path, name, meta }: { path: string; name: string; meta: ParamMeta }) {
  const { scope } = useContext(EverythingContext);
  const present = useEditor((s) => getPath(scope.read(s), path) !== undefined);
  const write = useWrite(path);
  const fields = meta.fields ?? {};
  const turnOn = () => {
    // Start from the defaults of the fields that move, so the group does something audible straight away.
    const seed: Record<string, unknown> = {};
    for (const [k, m] of Object.entries(fields)) if (m.kind === 'signal' && m.default !== undefined) seed[k] = m.default;
    write(seed);
  };
  return (
    <fieldset className="group">
      <legend title={meta.hint ?? meta.doc}>
        <Switch
          label={meta.label ?? humanize(name)}
          checked={present}
          onChange={(on) => {
            if (on) turnOn();
            else write(undefined);
            commit();
          }}
        />
      </legend>
      {present && <Fields base={path} params={fields} />}
    </fieldset>
  );
}

export function Fields({ base, params, skip, fallbacks, materialize }: { base: string; params: ParamMap; skip?: string[]; fallbacks?: Record<string, unknown>; materialize?: FieldProps['materialize'] }) {
  const names = Object.keys(params).filter((n) => !skip?.includes(n));
  // Knobs first, then the wide things, so the grid packs without holes.
  const small = names.filter((n) => params[n].kind === 'number' || params[n].kind === 'signal' || params[n].kind === 'bool');
  const rest = names.filter((n) => !small.includes(n));
  return (
    <div className="fields">
      {[...rest.filter((n) => params[n].kind === 'enum'), ...small, ...rest.filter((n) => params[n].kind !== 'enum')].map((n) => (
        <ParamField key={n} path={`${base}.${n}`} name={n} meta={params[n]} fallback={fallbacks?.[n]} materialize={materialize} />
      ))}
    </div>
  );
}

// ---- Sections ---------------------------------------------------------------------------------

/** A sheet's section. `hint` says what it is for, in its title's tooltip. */
export function Section({ title, tag, hint, children, tools }: { title: string; tag?: string; hint?: string; children: ReactNode; tools?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h3 className="legend-title" title={hint}>
          {title}
        </h3>
        {tag && <span className="section-tag">{tag}</span>}
        <span className="section-tools">{tools}</span>
      </header>
      {children}
    </section>
  );
}

function NodeSelect({ label, value, nodes, onChange, placeholder }: { label: string; value: string; nodes: NodeDef[]; onChange: (type: string) => void; placeholder?: string }) {
  const groups = useMemo(() => {
    const out = new Map<string, NodeDef[]>();
    for (const n of nodes) out.set(n.category, [...(out.get(n.category) ?? []), n]);
    return [...out.entries()];
  }, [nodes]);
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => e.target.value && onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {!placeholder && !nodes.some((n) => n.type === value) && <option value={value}>{value} (unknown)</option>}
      {groups.map(([category, list]) => (
        <optgroup key={category} label={category}>
          {list.map((n) => (
            <option key={n.type} value={n.type}>
              {n.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function EnvelopePreview({ env }: { env: Envelope }) {
  const d = useMemo(() => {
    const adsr = env as AdsrEnvelope;
    const gate = adsr.gate ?? Infinity;
    const sr = 400;
    const total = Math.min(8, (adsr.attack ?? 0.002) + (adsr.hold ?? 0) + (adsr.decay ?? 0.3) + (Number.isFinite(gate) ? gate + (adsr.release ?? 0.01) : 0)) * 1.1 + 0.02;
    const n = Math.max(8, Math.round(total * sr));
    const buf = renderEnvelope(env, n, sr, gate);
    let path = 'M0 40';
    const step = Math.max(1, Math.floor(n / 120));
    for (let i = 0; i < n; i += step) path += `L${((i / n) * 200).toFixed(1)} ${(40 - Math.min(1, buf[i]) * 36).toFixed(1)}`;
    return `${path}L200 40Z`;
  }, [env]);
  return (
    <svg className="env-preview" viewBox="0 0 200 42" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function EnvelopeSection({ trackId, defaultEnv }: { trackId: string; defaultEnv: Envelope }) {
  const { ink } = useContext(EverythingContext);
  const path = `tracks.${trackId}.source.env`;
  const raw = useEditor((s) => getPath(s.patch, path) as Envelope | undefined);
  const edit = useEditor((s) => s.edit);
  const env = raw ?? defaultEnv;
  const points = 'points' in env ? env.points : null;
  const toPoints = () => {
    const a = env as AdsrEnvelope;
    const attack = a.attack ?? 0.002;
    const decay = a.decay ?? 0.3;
    const pts: Breakpoint[] = [[0, 0], [attack, 1], [Number((attack + (a.hold ?? 0) + decay).toFixed(4)), a.sustain ?? 0]];
    edit((p) => setAt(p, path, { points: pts }));
  };
  return (
    <Section
      title="Envelope"
      tag={points ? 'points' : 'ADSR'}
      tools={
        <button type="button" className="key key-sm" onClick={() => (points ? edit((p) => setAt(p, path, undefined)) : toPoints())}>
          {points ? 'Back to ADSR' : 'Draw it'}
        </button>
      }
    >
      {points ? (
        <CurveEditor label="Envelope" points={points} meta={{ min: 0, max: 1 }} ink={ink} onChange={(pts) => edit((p) => setAt(p, `${path}.points`, pts), `p:${path}`)} onCommit={commit} />
      ) : (
        <>
          <EnvelopePreview env={env} />
          <Fields base={path} params={ENVELOPE_FIELDS} fallbacks={defaultEnv as Record<string, unknown>} materialize={{ path, value: defaultEnv }} />
        </>
      )}
    </Section>
  );
}

function NumInput({ label, value, unit, onChange }: { label: string; value: number | undefined; unit?: string; onChange: (v: number | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="text mono num-input"
      aria-label={label}
      title={label}
      placeholder="–"
      inputMode="decimal"
      value={draft ?? (value === undefined ? '' : String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      onBlur={() => {
        if (draft === null) return;
        const parsed = draft.trim() === '' ? undefined : parseValue(draft, unit);
        setDraft(null);
        if (parsed !== null) onChange(parsed);
      }}
    />
  );
}

function EventsSection({ trackId }: { trackId: string }) {
  const base = `tracks.${trackId}`;
  const events = useEditor((s) => getPath(s.patch, `${base}.events`) as (number | TrackEvent)[] | undefined);
  const hasRepeat = useEditor((s) => getPath(s.patch, `${base}.repeat`) !== undefined);
  const edit = useEditor((s) => s.edit);
  const mode = hasRepeat ? 'repeat' : events && events.length > 0 ? 'events' : 'once';
  const setMode = (m: string) => {
    edit((p) =>
      mutate(p, (d) => {
        const t = d.tracks.find((x) => x.id === trackId);
        if (!t) return;
        if (m !== 'repeat') delete t.repeat;
        if (m !== 'events') delete t.events;
        if (m === 'repeat') t.repeat ??= { count: 3, interval: 0.1 };
        if (m === 'events') t.events ??= [0, 0.15];
      }),
    );
    commit();
  };
  const list = (events ?? []).map((e) => (typeof e === 'number' ? { t: e } : e));
  const setEvents = (next: TrackEvent[]) => {
    // Keep the short form (a bare time) where an event carries nothing else.
    const tidy = next.map((e) => (e.pitch === undefined && e.vel === undefined && e.dur === undefined ? e.t : e));
    edit((p) => setAt(p, `${base}.events`, tidy));
    commit();
  };
  return (
    <Section title="Events" tag={mode}>
      <Segmented
        label="When the source plays"
        size="sm"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'once', label: 'Once' },
          { value: 'events', label: 'Events' },
          { value: 'repeat', label: 'Repeat' },
        ]}
      />
      {mode === 'repeat' && <Fields base={`${base}.repeat`} params={REPEAT_FIELDS} />}
      {mode === 'events' && (
        <div className="events">
          <div className="events-row events-head">
            <span>time s</span>
            <span>pitch st</span>
            <span>vel</span>
            <span>dur s</span>
            <span />
          </div>
          {list.map((e, i) => {
            const patchEvent = (change: Partial<TrackEvent>) => setEvents(list.map((x, j) => (j === i ? { ...x, ...change } : x)));
            return (
              <div key={i} className="events-row">
                <NumInput label={`Event ${i + 1} time`} unit="s" value={e.t} onChange={(v) => patchEvent({ t: Math.max(0, v ?? 0) })} />
                <NumInput label={`Event ${i + 1} pitch`} value={e.pitch} onChange={(v) => patchEvent({ pitch: v })} />
                <NumInput label={`Event ${i + 1} velocity`} value={e.vel} onChange={(v) => patchEvent({ vel: v })} />
                <NumInput label={`Event ${i + 1} duration`} unit="s" value={e.dur} onChange={(v) => patchEvent({ dur: v })} />
                <button type="button" className="pin" aria-label={`Remove event ${i + 1}`} disabled={list.length <= 1} onClick={() => setEvents(list.filter((_, j) => j !== i))}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            );
          })}
          <button type="button" className="key key-sm" onClick={() => setEvents([...list, { t: Number(((list[list.length - 1]?.t ?? 0) + 0.1).toFixed(3)) }])}>
            <Icon name="plus" size={13} /> Event
          </button>
        </div>
      )}
    </Section>
  );
}

export function FxChain({ chainPath, title }: { chainPath: string; title: string }) {
  const { scope } = useContext(EverythingContext);
  const root = useEditor((s) => scope.read(s));
  const chain = useMemo(() => getChain(root, chainPath), [root, chainPath]);
  const effects = useMemo(() => listEffects(), []);
  const act = (fn: (p: unknown) => unknown) => {
    scope.write(fn, null);
    commit();
  };
  return (
    <>
      {chain.map((fx, i) => {
        const def = getEffect(fx.type);
        const base = `${chainPath}.${effectSegment(fx, i)}`;
        return (
          <Section
            key={`${i}:${fx.type}`}
            title={def?.label ?? fx.type}
            tag={`${title} · ${i + 1}/${chain.length}`}
            hint={def?.hint ?? def?.doc}
            tools={
              <>
                <Switch label={`${def?.label ?? fx.type} on`} hideLabel checked={!fx.bypass} onChange={(on) => act((p) => setAt(p, `${base}.bypass`, on ? undefined : true))} />
                <button type="button" className="pin" aria-label="Move earlier" title="Move earlier" disabled={i === 0} onClick={() => act((p) => moveEffect(p, chainPath, i, -1))}>
                  <Icon name="up" size={13} />
                </button>
                <button type="button" className="pin" aria-label="Move later" title="Move later" disabled={i === chain.length - 1} onClick={() => act((p) => moveEffect(p, chainPath, i, 1))}>
                  <Icon name="down" size={13} />
                </button>
                <button type="button" className="pin" aria-label={`Remove ${def?.label ?? fx.type}`} title="Remove this effect" onClick={() => act((p) => removeEffect(p, chainPath, i))}>
                  <Icon name="trash" size={13} />
                </button>
              </>
            }
          >
            <div className={fx.bypass ? 'is-bypassed' : ''}>
              {def ? (
                <Fields base={base} params={{ ...def.params, mix: COMMON_EFFECT_PARAMS.mix }} />
              ) : (
                <JsonField path={base} label="Unknown effect" doc="This editor does not know this effect type; edit it as JSON." />
              )}
            </div>
          </Section>
        );
      })}
      <div className="section section-add">
        <NodeSelect label={`Add an effect to ${title}`} value="" nodes={effects} placeholder={`＋ Add an effect to ${title}…`} onChange={(type) => act((p) => addEffect(p, chainPath, type))} />
      </div>
    </>
  );
}

function TrackSheet({ trackId }: { trackId: string }) {
  const track = useEditor((s) => s.patch.tracks.find((t) => t.id === trackId));
  const index = useEditor((s) => s.patch.tracks.findIndex((t) => t.id === trackId));
  const buses = useEditor((s) => s.patch.buses);
  const only = useEditor((s) => s.patch.tracks.length <= 1);
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const sources = useMemo(() => listSources(), []);
  if (!track) return null;
  const base = `tracks.${trackId}`;
  const def = getSource(track.source.type);
  const ink = trackInk(track, index);
  const { env: _env, filter, ...commonKnobs } = COMMON_SOURCE_PARAMS;
  const busFields: ParamMap = Object.fromEntries((buses ?? []).map((b) => [b.id, { ...BUS_FIELDS.gain, label: `Send to ${b.name ?? b.id}`, doc: 'Level sent to this bus, dB.', hint: 'How much of this layer goes to the bus', default: undefined }]));

  return (
    <div className="sheets">
      <Section
        title="Layer"
        tag={trackId}
        tools={
          <>
            <button
              type="button"
              className="pin"
              title="Duplicate this layer"
              aria-label="Duplicate this layer"
              onClick={() => {
                const dup = duplicateTrack(useEditor.getState().patch, trackId);
                if (!dup) return;
                edit(dup.patch);
                select(dup.id);
              }}
            >
              <Icon name="copy" size={13} />
            </button>
            <button type="button" className="pin" title="Delete this layer" aria-label="Delete this layer" disabled={only} onClick={() => edit((p) => removeTrack(p, trackId))}>
              <Icon name="trash" size={13} />
            </button>
          </>
        }
      >
        <label className="param param-text param-wide" title="Name of this layer">
          <span className="param-label">Name</span>
          <input className="text" value={track.name ?? ''} placeholder={trackId} onChange={(e) => edit((p) => setAt(p, `${base}.name`, e.target.value || undefined), `p:${base}.name`)} />
        </label>
        <label className="param param-text param-wide" title="Why this layer is here">
          <span className="param-label">Note</span>
          <textarea className="text" rows={2} value={track.note ?? ''} placeholder="Why this layer exists" onChange={(e) => edit((p) => setAt(p, `${base}.note`, e.target.value || undefined), `p:${base}.note`)} />
        </label>
        <div className="ink-picker" role="radiogroup" aria-label="Ink">
          {INKS.map((k) => (
            <button
              key={k.hex}
              type="button"
              role="radio"
              aria-checked={ink.toLowerCase() === k.hex.toLowerCase()}
              aria-label={k.name}
              title={k.name}
              style={{ background: k.hex }}
              onClick={() => edit((p) => setAt(p, `${base}.color`, k.hex))}
            />
          ))}
        </div>
        <Fields base={base} params={TRACK_FIELDS} skip={['mute', 'solo']} />
        {Object.keys(busFields).length > 0 && <Fields base={`${base}.sends`} params={busFields} />}
      </Section>

      <Section title="Source" tag={def?.category ?? 'unknown'} hint={def?.hint ?? def?.doc}>
        <NodeSelect
          label="Source type"
          value={track.source.type}
          nodes={sources}
          onChange={(type) => {
            edit((p) => changeSourceType(p, trackId, type));
            commit();
          }}
        />
        {def ? <Fields base={`${base}.source`} params={{ ...def.params, ...commonKnobs }} /> : <JsonField path={`${base}.source`} label="Unknown source" />}
      </Section>

      {def && <EnvelopeSection trackId={trackId} defaultEnv={def.defaultEnv} />}

      <Section title="Voice filter" tag="per event">
        <ParamField path={`${base}.source.filter`} name="filter" meta={filter} />
      </Section>

      <EventsSection trackId={trackId} />
      <FxChain chainPath={`${base}.fx`} title={track.name ?? trackId} />
    </div>
  );
}

function MasterSheet() {
  const patch = useEditor((s) => s.patch);
  const edit = useEditor((s) => s.edit);
  const act = (fn: (p: Patch) => Patch, tag?: string) => edit(fn, tag);
  const auto = patch.duration === 'auto';
  const normalize = patch.master?.normalize?.mode ?? 'peak';
  // In a set, the project's (or the group's) levelling takes this setting's place.
  const overruled = useEditor((s) => {
    const sound = s.project.sounds[s.current];
    return !!sound && (!!s.project.normalize || !!s.project.groups?.find((g) => g.id === sound.group)?.normalize);
  });
  return (
    <div className="sheets">
      <Section title="Patch" tag={patch.format}>
        <label className="param param-text param-wide" title="What this sound is for">
          <span className="param-label">Description</span>
          <textarea className="text" rows={3} value={patch.description ?? ''} placeholder="What this sound is, for whoever opens it next" onChange={(e) => act((p) => setAt(p, 'description', e.target.value || undefined), 'p:description')} />
        </label>
        <div className="fields">
          <div className="param param-wide param-enum" title="Let it end when it fades out, or give it a fixed length">
            <span className="param-label">Length</span>
            <Segmented
              label="Length"
              size="sm"
              value={auto ? 'auto' : 'fixed'}
              options={[
                { value: 'auto', label: 'Auto', title: 'Ends when the sound fades out' },
                { value: 'fixed', label: 'Fixed' },
              ]}
              onChange={(v) => {
                const length = useEditor.getState().view?.duration ?? 1;
                act((p) => setAt(p, 'duration', v === 'auto' ? 'auto' : Number(length.toFixed(3))));
                commit();
              }}
            />
          </div>
          {!auto && <ParamField path="duration" name="duration" meta={PATCH_FIELDS.duration} />}
          <ParamField path="seed" name="seed" meta={PATCH_FIELDS.seed} />
          <div className="param param-wide param-enum" title="Mono or stereo">
            <span className="param-label">Output</span>
            <Segmented
              label="Channels"
              size="sm"
              value={patch.output?.channels ?? 1}
              options={[
                { value: 1, label: 'Mono' },
                { value: 2, label: 'Stereo' },
              ]}
              onChange={(v) => {
                act((p) => setAt(p, 'output.channels', v));
                commit();
              }}
            />
          </div>
          <div className="param param-wide param-enum" title="Make it loop seamlessly">
            <span className="param-label">Loop</span>
            <Segmented
              label="Loop"
              size="sm"
              value={patch.loop?.mode ?? 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'wrap', label: 'Wrap', title: 'The tail wraps round to the start, for a seamless loop' },
                { value: 'crossfade', label: 'Crossfade' },
              ]}
              onChange={(v) => {
                const length = useEditor.getState().view?.duration ?? 1;
                act((p) => {
                  const next = setAt(p, 'loop', v === 'off' ? undefined : { mode: v });
                  // A loop needs a fixed length.
                  return v !== 'off' && next.duration === 'auto' ? setAt(next, 'duration', Number(length.toFixed(3))) : next;
                });
                commit();
              }}
            />
          </div>
        </div>
      </Section>

      <Section title="Master" tag="after every layer">
        <Fields base="master" params={MASTER_FIELDS} />
        <div className="fields">
          <div className="param param-wide param-enum" title="Bring the finished sound to a set level">
            <span className="param-label">Normalise</span>
            <Segmented
              label="Normalise"
              size="sm"
              value={normalize}
              options={[
                { value: 'peak', label: 'Peak' },
                { value: 'loudness', label: 'Loudness' },
                { value: 'none', label: 'None' },
              ]}
              onChange={(v) => {
                act((p) => setAt(p, 'master.normalize', v === 'peak' ? undefined : { mode: v }));
                commit();
              }}
            />
          </div>
          {normalize !== 'none' && (
            <NormalizeTarget mode={normalize} />
          )}
        </div>
        {overruled && (
          <p className="section-doc" title="Change it in Settings or in the mixer">
            The set’s levelling replaces this one.
          </p>
        )}
      </Section>
      <FxChain chainPath="master.fx" title="master" />

      {(patch.buses ?? []).map((bus) => (
        <BusSheet key={bus.id} id={bus.id} name={bus.name} />
      ))}
      <div className="section section-add">
        <button
          type="button"
          className="key key-sm"
          onClick={() =>
            act((p) =>
              mutate(p, (d) => {
                d.buses = [...(d.buses ?? []), { id: uniqueId('bus', (d.buses ?? []).map((b) => b.id)) }];
              }),
            )
          }
        >
          <Icon name="plus" size={15} /> Bus (a shared effect send)
        </button>
      </div>
    </div>
  );
}

function NormalizeTarget({ mode }: { mode: 'peak' | 'loudness' }) {
  const { ink } = useContext(EverythingContext);
  const target = useEditor((s) => s.patch.master?.normalize?.target);
  const edit = useEditor((s) => s.edit);
  const dflt = mode === 'peak' ? -1 : -16;
  const set = (v: number | undefined) => edit((p) => mutate(p, (d) => void (d.master = { ...d.master, normalize: { mode, ...(v === undefined ? {} : { target: v }) } })), 'p:master.normalize.target');
  return (
    <div className="param" title="The level to bring it to">
      <Knob
        label="Normalise target"
        value={target ?? dflt}
        range={mode === 'peak' ? { min: -24, max: 0, step: 0.1 } : { min: -36, max: -6, step: 0.5 }}
        unit={mode === 'peak' ? 'dB' : 'LUFS'}
        defaultValue={dflt}
        onReset={() => set(undefined)}
        size={46}
        ink={ink}
        onChange={set}
        onCommit={commit}
      />
      <span className="param-label">Target</span>
    </div>
  );
}

function BusSheet({ id, name }: { id: string; name?: string }) {
  const edit = useEditor((s) => s.edit);
  return (
    <>
      <Section
        title={name ?? id}
        tag="bus"
        hint="Send layers here from each layer’s settings"
        tools={
          <button
            type="button"
            className="pin"
            aria-label={`Remove bus ${id}`}
            title="Remove this bus"
            onClick={() =>
              edit((p) =>
                mutate(p, (d) => {
                  d.buses = (d.buses ?? []).filter((b) => b.id !== id);
                  if (d.buses.length === 0) delete d.buses;
                  for (const t of d.tracks) {
                    if (t.sends) delete t.sends[id];
                    if (t.sends && Object.keys(t.sends).length === 0) delete t.sends;
                  }
                }),
              )
            }
          >
            <Icon name="trash" size={13} />
          </button>
        }
      >
        <Fields base={`buses.${id}`} params={BUS_FIELDS} />
      </Section>
      <FxChain chainPath={`buses.${id}.fx`} title={name ?? id} />
    </>
  );
}

export function Everything() {
  const patch = useEditor((s) => s.patch);
  const selected = useEditor((s) => s.selected);
  const select = useEditor((s) => s.select);
  const applied = useAppliedPatch();
  const index = patch.tracks.findIndex((t) => t.id === selected);
  const ink = index >= 0 ? trackInk(patch.tracks[index], index) : 'var(--ink)';
  const activeId = useEditor((s) => s.activeControl);
  const follow = useMemo(() => {
    const at = (patch.controls ?? []).findIndex((c) => c.id === activeId);
    if (at < 0) return undefined;
    const c = patch.controls![at];
    const targets = [...(c.targets ?? []).map((t) => t.path), ...(c.options ?? []).flatMap((o) => Object.keys(o.set ?? {}))];
    return { color: controlColor(at), paths: targets.map((p) => canonPath(patch, p)), raw: targets };
  }, [patch, activeId]);
  const followKey = follow ? `${activeId}:${follow.paths.join(',')}` : '';
  const body = useRef<HTMLDivElement>(null);

  // Bring what the control drives into view: open the right sheet, then scroll to the first lit parameter.
  useEffect(() => {
    if (!follow) return;
    const sheets = follow.raw.map((p) => {
      const segs = p.split('.');
      if (segs[0] !== 'tracks') return SELECT_MASTER;
      const track = patch.tracks.find((t) => t.id === segs[1]) ?? (/^\d+$/.test(segs[1]) ? patch.tracks[Number(segs[1])] : undefined);
      return track?.id;
    }).filter((x): x is string => !!x);
    const now = useEditor.getState().selected;
    if (sheets.length > 0 && !sheets.includes(now)) select(sheets[0]);
    // A short wait, so passing over a knob on the way elsewhere does not move the page.
    const timer = setTimeout(() => {
      body.current?.querySelector('.following')?.parentElement?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }, 140);
    return () => clearTimeout(timer);
    // Only when the control (or what it drives) changes, not on every value it passes through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  const ctx = useMemo(() => ({ applied, drivers: drivenPaths(patch), ink, scope: patchScope, follow }), [applied, patch, ink, follow]);
  return (
    <div ref={body} className="everything" style={{ '--c': ink } as React.CSSProperties}>
      <header className="everything-head">
        <div className="tabs" role="tablist" aria-label="What to edit">
          {patch.tracks.map((t, i) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === selected} className={`tab${t.id === selected ? ' is-on' : ''}`} style={{ '--c': trackInk(t, i) } as React.CSSProperties} onClick={() => select(t.id)}>
              <i className="dot" />
              {t.name ?? t.id}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={selected === SELECT_MASTER} className={`tab${selected === SELECT_MASTER ? ' is-on' : ''}`} onClick={() => select(SELECT_MASTER)}>
            Master &amp; patch
          </button>
        </div>
      </header>
      <EverythingContext.Provider value={ctx}>{index >= 0 ? <TrackSheet key={selected} trackId={selected} /> : <MasterSheet />}</EverythingContext.Provider>
    </div>
  );
}
