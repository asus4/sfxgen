/** Export WAV: bit depth, channels, sample rate and how many varied takes. */
import { useEffect, useRef, useState } from 'react';
import { exportJson, exportWav, type ExportOptions } from '../controller';
import { useEditor } from '../store';
import { Icon } from './Icon';
import { Segmented, Switch } from './Widgets';

export function ExportDialog() {
  const open = useEditor((s) => s.exportOpen);
  const output = useEditor((s) => s.patch.output);
  const canVary = useEditor((s) => (s.patch.controls ?? []).some((c) => c.vary));
  const served = useEditor((s) => !!s.serve.info && !!s.serve.path);
  const [opts, setOpts] = useState<ExportOptions>({ bitDepth: 16, channels: 1, sampleRate: 48000, takes: 1, toFolder: false });
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setOpts((o) => ({ ...o, bitDepth: output?.bitDepth ?? 16, channels: output?.channels ?? 1, sampleRate: output?.sampleRate ?? 48000, toFolder: served }));
    first.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, output, served]);

  if (!open) return null;
  const close = () => useEditor.setState({ exportOpen: false });
  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => setOpts((o) => ({ ...o, [key]: value }));
  const rates = [...new Set([22050, 44100, 48000, 96000, opts.sampleRate])].sort((a, b) => a - b);

  return (
    <div className="modal-layer">
      <div className="scrim" onClick={close} />
      <div className="modal sheet" role="dialog" aria-modal="true" aria-label="Export">
        <header className="drawer-head">
          <h2 className="display misreg">Export</h2>
          <button type="button" className="btn btn-icon" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="form" ref={first}>
          <div className="form-row">
            <span>Bit depth</span>
            <Segmented label="Bit depth" value={opts.bitDepth} onChange={(v) => set('bitDepth', v)} options={[{ value: 16, label: '16' }, { value: 24, label: '24' }, { value: 32, label: '32 float' }]} />
          </div>
          <div className="form-row">
            <span>Channels</span>
            <Segmented label="Channels" value={opts.channels} onChange={(v) => set('channels', v)} options={[{ value: 1, label: 'Mono' }, { value: 2, label: 'Stereo' }]} />
          </div>
          <div className="form-row">
            <span>Sample rate</span>
            <Segmented label="Sample rate" value={opts.sampleRate} onChange={(v) => set('sampleRate', v)} options={rates.map((r) => ({ value: r, label: `${r / 1000}k` }))} />
          </div>
          <div className="form-row">
            <span>Takes</span>
            <Segmented label="Takes" value={opts.takes} onChange={(v) => set('takes', v)} options={[1, 3, 5, 8].map((n) => ({ value: n, label: n === 1 ? 'Just this' : `${n}` }))} />
          </div>
          {opts.takes > 1 && (
            <p className="form-note">
              {canVary
                ? 'Each extra take gets a new seed and moves the controls as far as their “vary” amounts allow.'
                : 'Each extra take gets a new seed. Give controls a “vary” amount in the patch to let takes differ more.'}
            </p>
          )}
          {served && (
            <div className="form-row">
              <span>Where</span>
              <Switch label="Write beside the patch file" checked={opts.toFolder} onChange={(on) => set('toFolder', on)} />
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={exportJson}>
            <Icon name="save" /> .sfx.json
          </button>
          <button
            type="button"
            className="btn btn-ink-pink btn-big"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await exportWav(opts);
              setBusy(false);
              close();
            }}
          >
            <Icon name="export" /> {busy ? 'Printing…' : opts.takes > 1 ? `Export ${opts.takes} WAVs` : 'Export WAV'}
          </button>
        </footer>
      </div>
    </div>
  );
}
