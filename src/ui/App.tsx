import { useEffect, useState } from 'react';
import { importFile, onGlobalKey, start } from './controller';
import { AgentPanel } from './components/AgentPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { Everything } from './components/Everything';
import { ExportDialog } from './components/ExportDialog';
import { Gallery } from './components/Gallery';
import { Header } from './components/Header';
import { Timeline } from './components/Timeline';
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
  const everything = useEditor((s) => s.everything);
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
        const file = [...e.dataTransfer.files].find((f) => f.name.endsWith('.json'));
        if (file) void importFile(file);
        else useEditor.getState().toast('Drop a .sfx.json file', 'error');
      }}
    >
      <Header />
      <main className="main">
        <div className="top">
          <Timeline />
          <AgentPanel />
        </div>
        <ControlsPanel />
        {everything && <Everything />}
      </main>
      <footer className="colophon">
        <span>
          <kbd>Space</kbd> play · <kbd>G</kbd> gallery · <kbd>E</kbd> everything · <kbd>⌘Z</kbd> undo · drop a <code>.sfx.json</code> anywhere
        </span>
        <span>sfxgen · sounds as JSON, printed in ink</span>
      </footer>
      <Gallery />
      <ExportDialog />
      <Toasts />
      {dropping && <div className="drop-hint display">Drop it on the press</div>}
    </div>
  );
}
