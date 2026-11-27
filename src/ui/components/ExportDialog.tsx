/** Export: the open sound as WAV (bit depth, channels, sample rate, varied takes), or the whole set at once. */
import { useEffect, useRef, useState } from 'react';
import { soundExportPath, soundName } from '../../core';
import { exportJson, exportSet, exportWav, type ExportOptions } from '../controller';
import { dbText } from '../lib/projectOps';
import { useEditor } from '../store';
import { Icon } from './Icon';
import { Segmented, Switch } from './Widgets';

export function ExportDialog() {
  const open = useEditor((s) => s.exportOpen);
  // A string, so the selector's result is stable between renders.
  const outputKey = useEditor((s) => JSON.stringify({ ...(s.patch.output ?? {}), ...(s.project.output ?? {}) }));
  const canVary = useEditor((s) => (s.patch.controls ?? []).some((c) => c.vary));
  const served = useEditor((s) => !!s.serve.info);
  const count = useEditor((s) => s.project.sounds.filter((x) => !x.skip).length);
  const target = useEditor((s) => (s.project.sounds[s.current] ? soundExportPath(s.project, s.project.sounds[s.current]) : ''));
  const name = useEditor((s) => (s.project.sounds[s.current] ? soundName(s.project.sounds[s.current]) : ''));
  const [opts, setOpts] = useState<ExportOptions>({ bitDepth: 16, channels: 1, sampleRate: 48000, takes: 1, toFolder: false });
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const o = JSON.parse(outputKey) as { bitDepth?: 16 | 24 | 32; channels?: 1 | 2; sampleRate?: number };
    setOpts((prev) => ({ ...prev, bitDepth: o.bitDepth ?? 16, channels: o.channels ?? 1, sampleRate: o.sampleRate ?? 48000, toFolder: served }));
    first.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, outputKey, served]);

  if (!open) return null;
  const close = () => useEditor.setState({ exportOpen: false });
  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => setOpts((o) => ({ ...o, [key]: value }));
  const rates = [...new Set([22050, 44100, 48000, 96000, opts.sampleRate])].sort((a, b) => a - b);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    await job();
    setBusy(false);
    close();
  };

  return (
    <div className="modal-layer">
      <div className="scrim" onClick={close} />
      <div className="modal panel" role="dialog" aria-modal="true" aria-label="Export">
        <header className="drawer-head">
          <h2 className="panel-title">Export</h2>
          <button type="button" className="key key-icon" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <p className="legend form-legend">this sound · {name}</p>
        <div className="form" ref={first}>
          <div className="form-row">
            <span>Bit depth</span>
            <Segmented label="Bit depth" size="sm" value={opts.bitDepth} onChange={(v) => set('bitDepth', v)} options={[{ value: 16, label: '16' }, { value: 24, label: '24' }, { value: 32, label: '32 float' }]} />
          </div>
          <div className="form-row">
            <span>Channels</span>
            <Segmented label="Channels" size="sm" value={opts.channels} onChange={(v) => set('channels', v)} options={[{ value: 1, label: 'Mono' }, { value: 2, label: 'Stereo' }]} />
          </div>
          <div className="form-row">
            <span>Sample rate</span>
            <Segmented label="Sample rate" size="sm" value={opts.sampleRate} onChange={(v) => set('sampleRate', v)} options={rates.map((r) => ({ value: r, label: `${r / 1000}k` }))} />
          </div>
          <div
            className="form-row"
            title={
              canVary
                ? 'Each extra take gets a new seed and moves the controls as far as their “vary” amounts allow'
                : 'Each extra take gets a new seed. Give controls a “vary” amount in the patch to let takes differ more'
            }
          >
            <span>Takes</span>
            <Segmented label="Takes" size="sm" value={opts.takes} onChange={(v) => set('takes', v)} options={[1, 3, 5, 8].map((n) => ({ value: n, label: n === 1 ? 'Just this' : `${n}` }))} />
          </div>
          {served && (
            <div className="form-row">
              <span>Where</span>
              <Switch label={`Write to ${target}`} checked={opts.toFolder} onChange={(on) => set('toFolder', on)} />
            </div>
          )}
          <div className="row form-actions">
            <button type="button" className="key" onClick={exportJson}>
              <Icon name="save" size={14} /> .sfx.json
            </button>
            <span className="spacer" />
            <button type="button" className="key is-on" disabled={busy} onClick={() => void run(() => exportWav(opts))}>
              <Icon name="export" size={14} /> {busy ? 'Rendering…' : opts.takes > 1 ? `Export ${opts.takes} WAVs` : 'Export WAV'}
            </button>
          </div>
        </div>
        <p className="legend form-legend">the whole set · {count} sound{count === 1 ? '' : 's'}</p>
        <div className="form">
          <div className="row form-actions">
            <span className="spacer" />
            <button
              type="button"
              className="key is-on"
              disabled={busy}
              title={`Every sound, as the project renders it (its output, levelling, shared chain and mixer level)${served ? ', written to its export path' : ', in one zip'}`}
              onClick={() => void run(exportSet)}
            >
              <Icon name="export" size={14} /> Export the set
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** What an export of the set wrote: one row per sound, with its measurements and anything worth knowing. */
export function BuildReport() {
  const rows = useEditor((s) => s.buildRows);
  if (!rows) return null;
  const close = () => useEditor.setState({ buildRows: null });
  const failed = rows.filter((r) => (r as { error?: string }).error).length;
  return (
    <div className="modal-layer">
      <div className="scrim" onClick={close} />
      <div className="modal modal-wide panel" role="dialog" aria-modal="true" aria-label="Export report">
        <header className="drawer-head">
          <h2 className="panel-title">
            {rows.length - failed} exported{failed ? ` · ${failed} failed` : ''}
          </h2>
          <button type="button" className="key key-icon" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="report">
          <div className="report-row report-head">
            <span>sound</span>
            <span>to</span>
            <span>length</span>
            <span>peak</span>
            <span>LUFS</span>
          </div>
          {rows.map((r) => {
            const error = (r as { error?: string }).error;
            return (
              <div key={r.name} className={`report-row${error ? ' is-error' : ''}`}>
                <b>{r.name}</b>
                <span className="mono">{r.export}</span>
                <span>{error ? '–' : `${r.duration.toFixed(2)} s`}</span>
                <span className={r.peakDb > -0.05 && !error ? 'is-hot' : ''}>{error ? '–' : dbText(r.peakDb)}</span>
                <span>{error ? '–' : dbText(r.lufs)}</span>
                {(error || r.warnings.length > 0) && <p>{error ?? r.warnings.join(' · ')}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
