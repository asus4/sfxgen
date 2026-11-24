/** The top of the device: logo, the project (and the projects kept in this browser), file keys, the agent's status. */
import { useRef, useState } from 'react';
import { copyShareLink, createProject, deleteProject, exportBundle, exportJson, importFile, saveProjectFile, switchProject } from '../controller';
import { useEditor } from '../store';
import { Icon } from './Icon';

/** The latest thing that happened, in one line; the agent's lines are lit. A click opens the notes. */
function Ticker() {
  const last = useEditor((s) => s.activity[0]);
  if (!last) return null;
  const who = { agent: 'agent', human: 'you', file: 'file', system: 'sfxgen' }[last.origin];
  return (
    <button type="button" key={last.id} className={`ticker from-${last.origin}`} title="Open the notes and the activity log" onClick={() => useEditor.setState({ surface: 'notes' })}>
      <b>{who}</b>
      <span>{last.text}</span>
    </button>
  );
}

function AgentStatus() {
  const webmcp = useEditor((s) => s.webmcp);
  const live = webmcp !== 'pending' && webmcp.count > 0;
  const why =
    'WebMCP lets an agent in the browser use this editor as tools. It needs Chrome 149+ or Edge 150+ with the WebMCP origin trial (or flag) on. ' +
    'Add ?webmcp=shim to the address to try it with a built-in stand-in.';
  return (
    <span className={`pill${live ? ' pill-on' : ' pill-off'}`} title={live ? `Tools registered on ${webmcp.api}` : why} tabIndex={0}>
      <i className="led" />
      {webmcp === 'pending' ? 'WebMCP…' : live ? `WebMCP · ${webmcp.count} tools` : 'WebMCP unavailable'}
    </span>
  );
}

/** The project's name, and behind it the list of projects in this browser (or the served folder's state). */
function ProjectKey() {
  const name = useEditor((s) => s.project.name);
  const count = useEditor((s) => s.project.sounds.length);
  const serve = useEditor((s) => s.serve);
  const library = useEditor((s) => s.library);
  const open = useEditor((s) => s.projectsOpen);
  const [confirm, setConfirm] = useState<string | null>(null);
  const close = () => {
    setConfirm(null);
    useEditor.setState({ projectsOpen: false });
  };
  const state = serve.info ? (serve.save === 'saving' ? 'saving' : serve.save === 'error' ? 'not saved' : serve.projectSaved ? 'live' : 'no project file') : 'in this browser';
  return (
    <div className="project-key">
      <button type="button" className={`key key-project save-${serve.info ? serve.save : 'local'}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => useEditor.setState({ projectsOpen: !open })}>
        <i className="led" />
        <span className="project-name">{name || 'Untitled set'}</span>
        <small>
          {count} sound{count === 1 ? '' : 's'} · {state}
        </small>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <>
          <div className="scrim scrim-clear" onClick={close} />
          <div className="popover" role="dialog" aria-label="Projects">
            {serve.info ? (
              <>
                <p className="legend">served folder</p>
                <p className="popover-text mono">{serve.info.root ?? ''}</p>
                <p className="popover-text">
                  {serve.projectSaved
                    ? `Project file: ${serve.projectPath ?? 'sfxgen.project.json'}. Edits here are written to disk; edits on disk show up here.`
                    : 'This folder has no project file. Its patches are shown as a set; levels, groups and settings are not kept until you save one.'}
                </p>
                {!serve.projectSaved && (
                  <button
                    type="button"
                    className="key is-on"
                    onClick={() => {
                      void saveProjectFile();
                      close();
                    }}
                  >
                    <Icon name="save" size={14} /> Save project file
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="legend">projects in this browser</p>
                <ul className="project-list">
                  {library.items.map((item) => (
                    <li key={item.id} className={item.id === library.current ? 'is-current' : ''}>
                      <button
                        type="button"
                        className="project-item"
                        onClick={() => {
                          switchProject(item.id);
                          close();
                        }}
                      >
                        <i className="led" />
                        {item.name || 'Untitled set'}
                      </button>
                      {confirm === item.id ? (
                        <button
                          type="button"
                          className="key key-sm key-danger"
                          onClick={() => {
                            deleteProject(item.id);
                            setConfirm(null);
                          }}
                        >
                          Delete for good
                        </button>
                      ) : (
                        <button type="button" className="tool" aria-label={`Delete project ${item.name}`} title="Delete this project" onClick={() => setConfirm(item.id)}>
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button
                    type="button"
                    className="key"
                    onClick={() => {
                      createProject();
                      close();
                    }}
                  >
                    <Icon name="plus" size={13} /> New project
                  </button>
                  <button type="button" className="key" onClick={exportBundle} title="This project as one .sfxproj.json file">
                    <Icon name="save" size={13} /> Bundle
                  </button>
                </div>
                <p className="popover-text">Rename a project under Project. Drop a .sfxproj.json anywhere to open a bundle.</p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function TopStrip() {
  const file = useRef<HTMLInputElement>(null);
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const theme = useEditor((s) => s.theme);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const setSettings = useEditor((s) => s.setSettings);
  return (
    <header className="strip">
      <a className="logo" href="./" aria-label="sfxgen">
        sfx<b>gen</b>
      </a>
      <span className="zone-num">01</span>
      <ProjectKey />
      <nav className="strip-keys" aria-label="File">
        <button type="button" className="key" onClick={() => useEditor.setState({ gallery: { open: true, mode: 'replace' } })} aria-keyshortcuts="G" title="Template gallery (G)">
          <Icon name="grid" size={16} /> <span>Gallery</span>
        </button>
        <button type="button" className="key" onClick={() => file.current?.click()} title="Add a .sfx.json to the set, or open a .sfxproj.json bundle (or drop one anywhere)">
          <Icon name="open" size={16} /> <span>Open</span>
        </button>
        <button type="button" className="key" onClick={exportJson} title="Download the open sound as .sfx.json">
          <Icon name="save" size={16} /> <span>Save</span>
        </button>
        <button type="button" className="key" onClick={() => useEditor.setState({ exportOpen: true })} title="Export WAV: this sound or the whole set">
          <Icon name="export" size={16} /> <span>Export</span>
        </button>
        <button type="button" className="key" onClick={() => void copyShareLink()} title="Copy a link with the open sound inside it">
          <Icon name="link" size={16} /> <span>Share</span>
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
      <Ticker />
      <div className="strip-end">
        <button type="button" className="key key-icon" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)">
          <Icon name="undo" size={16} />
        </button>
        <button type="button" className="key key-icon" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)">
          <Icon name="redo" size={16} />
        </button>
        <AgentStatus />
        <button type="button" className="key key-icon" onClick={() => setSettings({ theme: theme === 'dark' ? 'light' : 'dark' })} aria-label={theme === 'dark' ? 'Switch to the light finish' : 'Switch to the dark finish'} title="Light or dark finish">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
      </div>
    </header>
  );
}
