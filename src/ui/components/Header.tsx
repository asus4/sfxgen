/** The header: logo, gallery, files, export, share, undo, theme and the agent's status. */
import { useRef } from 'react';
import { copyShareLink, exportJson, importFile, openServeFile } from '../controller';
import { useEditor } from '../store';
import { Icon } from './Icon';

function AgentStatus() {
  const webmcp = useEditor((s) => s.webmcp);
  const serve = useEditor((s) => s.serve);
  const live = webmcp !== 'pending' && webmcp.count > 0;
  const why =
    'WebMCP lets an agent in the browser use this editor as tools. It needs Chrome 149+ or Edge 150+ with the WebMCP origin trial (or flag) on. ' +
    'Add ?webmcp=shim to the address to try it with a built-in stand-in.';
  return (
    <div className="status">
      {serve.info && (
        <label className={`pill pill-live save-${serve.save}`} title={serve.info.root ? `Serving ${serve.info.root}` : 'Connected to sfxgen serve'}>
          <i className="lamp" />
          <span className="sr-only">Open a file from the served folder</span>
          <select value={serve.path ?? ''} onChange={(e) => e.target.value && void openServeFile(e.target.value)}>
            <option value="">{serve.path ? serve.path : 'not saved to a file'}</option>
            {serve.files
              .filter((f) => f.path !== serve.path)
              .map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
          </select>
          <em>{serve.save === 'saving' ? 'saving' : serve.save === 'error' ? 'not saved' : serve.path ? 'live' : ''}</em>
        </label>
      )}
      <span className={`pill${live ? ' pill-on' : ' pill-off'}`} title={live ? `Tools registered on ${webmcp.api}` : why} tabIndex={0}>
        <Icon name="agent" size={14} fill={live} />
        {webmcp === 'pending' ? 'WebMCP…' : live ? `WebMCP · ${webmcp.count} tools` : 'WebMCP unavailable'}
      </span>
    </div>
  );
}

export function Header() {
  const file = useRef<HTMLInputElement>(null);
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const theme = useEditor((s) => s.theme);
  const everything = useEditor((s) => s.everything);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const setSettings = useEditor((s) => s.setSettings);
  return (
    <header className="header">
      <a className="logo display misreg" href="./" aria-label="sfxgen">
        sfx<span>gen</span>
      </a>
      <nav className="actions" aria-label="Patch">
        <button type="button" className="btn btn-ink-pink" onClick={() => useEditor.setState({ galleryOpen: true })} aria-keyshortcuts="G" title="Template gallery (G)">
          <Icon name="grid" /> <span>Gallery</span>
        </button>
        <span className="sep" />
        <button type="button" className="btn btn-icon" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)">
          <Icon name="undo" />
        </button>
        <button type="button" className="btn btn-icon" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)">
          <Icon name="redo" />
        </button>
        <span className="sep" />
        <button type="button" className="btn" onClick={() => file.current?.click()} title="Open a .sfx.json file (or drop one anywhere)">
          <Icon name="open" /> <span>Open</span>
        </button>
        <button type="button" className="btn" onClick={exportJson} title="Download the patch as .sfx.json">
          <Icon name="save" /> <span>Save</span>
        </button>
        <button type="button" className="btn" onClick={() => useEditor.setState({ exportOpen: true })} title="Export WAV">
          <Icon name="export" /> <span>Export</span>
        </button>
        <button type="button" className="btn" onClick={() => void copyShareLink()} title="Copy a link with this patch inside it">
          <Icon name="link" /> <span>Share</span>
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </nav>
      <div className="header-end">
        <AgentStatus />
        <button type="button" className={`btn${everything ? ' is-on' : ''}`} aria-pressed={everything} onClick={() => setSettings({ everything: !everything })} aria-keyshortcuts="E" title="Show every parameter (E)">
          <Icon name="sliders" /> <span>Everything</span>
        </button>
        <button type="button" className="btn btn-icon" onClick={() => setSettings({ theme: theme === 'dark' ? 'light' : 'dark' })} aria-label={theme === 'dark' ? 'Switch to paper' : 'Switch to black paper'} title="Light or dark paper">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
    </header>
  );
}
