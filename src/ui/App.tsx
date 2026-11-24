import { useEffect, useState } from 'react';
import { importFile, onGlobalKey, start } from './controller';
import { EasyStrip, Surface } from './components/ControlsPanel';
import { Display } from './components/Display';
import { BuildReport, ExportDialog } from './components/ExportDialog';
import { Gallery } from './components/Gallery';
import { Pads } from './components/Pads';
import { TopStrip } from './components/TopStrip';
import { useEditor } from './store';

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    void start();
    const onKeyUp = (e: KeyboardEvent) => {
      // Space is "play" everywhere; stop a focused button from also being pressed by it.
      if (e.code === 'Space' && e.target instanceof HTMLButtonElement) e.preventDefault();
    };
    window.addEventListener('keydown', onGlobalKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onGlobalKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  return (
    <div
      className={`app${dropping ? ' is-dropping' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const files = [...e.dataTransfer.files].filter((f) => f.name.endsWith('.json'));
        if (files.length === 0) useEditor.getState().toast('Drop .sfx.json files, or a .sfxproj.json bundle', 'error');
        // One after another, so each new pad gets its own unique name.
        void (async () => {
          for (const f of files) await importFile(f);
        })();
      }}
    >
      <div className="device">
        <TopStrip />
        <Pads />
        <Display />
        <EasyStrip />
        <Surface />
      </div>
      <Gallery />
      <ExportDialog />
      <BuildReport />
      <Toasts />
      {dropping && <div className="drop-hint">Drop to add to the set</div>}
    </div>
  );
}
