/** The project: what every sound in the set shares. Output format, levelling, the shared master chain, exports. */
import { useRef } from 'react';
import type { Normalize, OutputSettings, Project } from '../../core';
import { audition, exportBundle, exportSet, importFile, saveProjectFile } from '../controller';
import { useEditor } from '../store';
import { FxChain, ProjectFields, Section } from './Everything';
import { Icon } from './Icon';
import { Knob } from './Knob';
import { Segmented } from './Widgets';

function commit(): void {
  useEditor.getState().seal();
  audition();
}

export function ProjectSettings() {
  const project = useEditor((s) => s.project);
  const serve = useEditor((s) => s.serve);
  const editProject = useEditor((s) => s.editProject);
  const file = useRef<HTMLInputElement>(null);
  const set = (change: Partial<Project>, tag?: string) =>
    editProject((p) => {
      const next = { ...p, ...change };
      for (const k of Object.keys(change) as (keyof Project)[]) if (change[k] === undefined) delete next[k];
      return next;
    }, tag);
  const setOutput = <K extends keyof OutputSettings>(key: K, value: OutputSettings[K] | undefined) => {
    const output = { ...(project.output ?? {}), [key]: value };
    if (value === undefined) delete output[key];
    set({ output: Object.keys(output).length ? output : undefined });
    commit();
  };
  const mode = project.normalize?.mode ?? '';
  const setNormalize = (m: string, target?: number) => {
    const normalize: Normalize | undefined = m ? { mode: m as Normalize['mode'], ...(target !== undefined ? { target } : {}) } : undefined;
    set({ normalize }, 'normalize');
  };
  const targetDefault = mode === 'loudness' ? -16 : -1;

  return (
    <div className="sheets">
      <Section title="Set" tag={serve.info ? (serve.projectPath ?? 'no project file yet') : 'kept in this browser'}>
        <label className="param param-text param-wide" title="Name of this project">
          <span className="param-label">Name</span>
          <input className="text" value={project.name} onChange={(e) => set({ name: e.target.value }, 'name')} />
        </label>
        <label className="param param-text param-wide" title="What these sounds are for">
          <span className="param-label">Description</span>
          <textarea className="text" rows={2} value={project.description ?? ''} placeholder="What these sounds are for" onChange={(e) => set({ description: e.target.value || undefined }, 'description')} />
        </label>
        <label className="param param-text param-wide" title="Where exported files go">
          <span className="param-label">Export folder</span>
          <input className="text mono" value={project.outDir ?? ''} placeholder="out" spellCheck={false} onChange={(e) => set({ outDir: e.target.value || undefined }, 'outDir')} />
        </label>
        <div className="row">
          {serve.info && !serve.projectSaved && (
            <button
              type="button"
              className="key is-on"
              title="Keep levels, groups and settings for this folder"
              onClick={() => void saveProjectFile()}
            >
              <Icon name="save" size={14} /> <span>Save project file</span>
            </button>
          )}
          <button type="button" className="key" onClick={() => void exportSet()}>
            <Icon name="export" size={14} /> <span>Export set</span>
          </button>
          <button type="button" className="key" onClick={exportBundle} title="Download the whole project as one file">
            <Icon name="save" size={14} /> <span>Bundle</span>
          </button>
          <button type="button" className="key" onClick={() => file.current?.click()} title="Open a sound or project file">
            <Icon name="open" size={14} /> <span>Import</span>
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
        </div>
      </Section>

      <Section title="Output" hint="Applies to every sound">
        <div className="fields">
          <div className="param param-wide param-enum" title="One sample rate for every sound, or each its own">
            <span className="param-label">Sample rate</span>
            <Segmented
              label="Sample rate"
              size="sm"
              value={project.output?.sampleRate ?? 0}
              options={[{ value: 0, label: 'per sound' }, ...[22050, 44100, 48000, 96000].map((r) => ({ value: r, label: `${r / 1000}k` }))]}
              onChange={(v) => setOutput('sampleRate', v || undefined)}
            />
          </div>
          <div className="param param-wide param-enum" title="Mono or stereo for every sound, or each its own">
            <span className="param-label">Channels</span>
            <Segmented
              label="Channels"
              size="sm"
              value={project.output?.channels ?? 0}
              options={[
                { value: 0, label: 'per sound' },
                { value: 1, label: 'mono' },
                { value: 2, label: 'stereo' },
              ]}
              onChange={(v) => setOutput('channels', (v || undefined) as 1 | 2 | undefined)}
            />
          </div>
          <div className="param param-wide param-enum" title="One bit depth for every sound, or each its own">
            <span className="param-label">Bit depth</span>
            <Segmented
              label="Bit depth"
              size="sm"
              value={project.output?.bitDepth ?? 0}
              options={[
                { value: 0, label: 'per sound' },
                { value: 16, label: '16' },
                { value: 24, label: '24' },
                { value: 32, label: '32 float' },
              ]}
              onChange={(v) => setOutput('bitDepth', (v || undefined) as 16 | 24 | 32 | undefined)}
            />
          </div>
        </div>
      </Section>

      <Section title="Levelling" hint="Brings every sound to the same level before the mixer. A group’s own setting wins">
        <div className="fields">
          <div className="param param-wide param-enum" title="How every sound is levelled">
            <span className="param-label">Every sound is brought to</span>
            <Segmented
              label="Levelling"
              size="sm"
              value={mode}
              options={[
                { value: '', label: 'its own', title: 'Each sound keeps its own setting' },
                { value: 'peak', label: 'a peak' },
                { value: 'loudness', label: 'a loudness' },
                { value: 'none', label: 'nothing' },
              ]}
              onChange={(v) => {
                setNormalize(v);
                commit();
              }}
            />
          </div>
          {(mode === 'peak' || mode === 'loudness') && (
            <div className="param" title="The level to bring every sound to">
              <Knob
                label="Levelling target"
                value={project.normalize?.target ?? targetDefault}
                range={mode === 'peak' ? { min: -24, max: 0, step: 0.1 } : { min: -36, max: -6, step: 0.5 }}
                unit={mode === 'peak' ? 'dB' : 'LUFS'}
                defaultValue={targetDefault}
                size={46}
                onChange={(v) => setNormalize(mode, v)}
                onCommit={commit}
              />
              <span className="param-label">Target</span>
            </div>
          )}
          <div className="param" title="Level of the whole set">
            <Knob
              label="Shared master gain"
              value={project.master?.gain ?? 0}
              range={{ min: -24, max: 24, step: 0.1 }}
              unit="dB"
              defaultValue={0}
              size={46}
              onChange={(v) => set({ master: { ...(project.master ?? {}), gain: v } }, 'master.gain')}
              onCommit={commit}
            />
            <span className="param-label">Set gain</span>
          </div>
        </div>
      </Section>

      <ProjectFields>
        <FxChain chainPath="master.fx" title="the whole set" />
      </ProjectFields>
    </div>
  );
}
