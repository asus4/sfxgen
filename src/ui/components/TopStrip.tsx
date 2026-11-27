/** The top of the device: logo, the project (and the projects kept in this browser), file keys, the agent's status. */
import { useRef, useState } from 'react';
import { copyShareLink, createProject, deleteProject, exportBundle, exportJson, importFile, saveProjectFile, switchProject } from '../controller';
import { useEditor } from '../store';
import { GitHubMark, Icon } from './Icon';
import { AgentStatus } from './WebMcpStatus';

const REPO = 'https://github.com/asus4/sfxgen';

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
  const state = serve.info ? (serve.save === 'saving' ? 'saving…' : serve.save === 'error' ? 'not saved' : serve.projectSaved ? 'saved to disk' : 'no project file yet') : 'saved in this browser';
  return (
    <div className="project-key">
      <button
        type="button"
        className={`key key-project save-${serve.info ? serve.save : 'local'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${count} sound${count === 1 ? '' : 's'} · ${state}`}
        onClick={() => useEditor.setState({ projectsOpen: !open })}
      >
        <span className="project-name">{name || 'Untitled set'}</span>
        {serve.info && serve.save === 'error' && <small>not saved</small>}
        <Icon name="down" size={14} />
      </button>
      {open && (
        <>
          <div className="scrim scrim-clear" onClick={close} />
          <div className="popover" role="dialog" aria-label="Projects">
            {serve.info ? (
              <>
                <p className="legend">served folder</p>
                <p className="popover-text mono" title="Changes here and on disk stay in sync">
                  {serve.info.root ?? ''}
                  {serve.projectSaved && (
                    <>
                      <br />
                      {serve.projectPath ?? 'sfxgen.project.json'}
                    </>
                  )}
                </p>
                {!serve.projectSaved && (
                  <button
                    type="button"
                    className="key is-on"
                    title="Keep levels, groups and settings for this folder"
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
                    title="Start an empty project"
                    onClick={() => {
                      createProject();
                      close();
                    }}
                  >
                    <Icon name="plus" size={13} /> New project
                  </button>
                  <button type="button" className="key" onClick={exportBundle} title="Download the whole project as one file">
                    <Icon name="save" size={13} /> Bundle
                  </button>
                </div>
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
        <button type="button" className="key" onClick={() => useEditor.setState({ gallery: { open: true, mode: 'replace' } })} aria-keyshortcuts="G" title="Browse sounds (G)">
          <Icon name="grid" size={16} /> <span>Gallery</span>
        </button>
        <button type="button" className="key" onClick={() => file.current?.click()} title="Open a sound or project file. You can also drop or paste one">
          <Icon name="open" size={16} /> <span>Open</span>
        </button>
        <button type="button" className="key" onClick={exportJson} title="Download this sound as a file">
          <Icon name="save" size={16} /> <span>Save</span>
        </button>
        <button type="button" className="key" onClick={() => useEditor.setState({ exportOpen: true })} title="Export audio">
          <Icon name="export" size={16} /> <span>Export</span>
        </button>
        <button type="button" className="key" onClick={() => void copyShareLink()} title="Copy a link to this sound">
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
      <div className="strip-end">
        <button type="button" className="key key-icon" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)">
          <Icon name="undo" size={16} />
        </button>
        <button type="button" className="key key-icon" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)">
          <Icon name="redo" size={16} />
        </button>
        <AgentStatus />
        <button type="button" className="key key-icon" onClick={() => setSettings({ theme: theme === 'dark' ? 'light' : 'dark' })} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <a className="key key-icon" href={REPO} target="_blank" rel="noopener" aria-label="sfxgen on GitHub" title="Open the GitHub repository">
          <GitHubMark size={16} />
        </a>
      </div>
    </header>
  );
}
