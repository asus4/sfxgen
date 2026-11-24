import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWorkspace } from '../src/node/file-workspace';
import { startServer, type RunningServer } from '../src/node/server';
import { main } from '../src/node/cli';
import { callTool } from '../src/core/agent/tools';
import { decodeWav, type Patch, type Project } from '../src/core';
import { analyze } from '../src/core/analysis';

const patch = (name: string, freq = 440): Patch => ({
  format: 'sfxgen/1',
  name,
  duration: 'auto',
  tracks: [{ id: 'a', source: { type: 'osc', wave: 'sine', freq, env: { attack: 0.002, decay: 0.15 } } }],
});

const peakDbOf = (ch: Float32Array[]) => analyze(ch, 48000).peakDb;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sfxgen-project-'));
  await mkdir(join(dir, 'ui'));
  await writeFile(join(dir, 'hit.sfx.json'), JSON.stringify(patch('hit', 220)));
  await writeFile(join(dir, 'ui', 'click.sfx.json'), JSON.stringify(patch('click', 1800)));
});

const readProject = async (): Promise<Project> => JSON.parse(await readFile(join(dir, 'sfxgen.project.json'), 'utf8'));

describe('FileWorkspace projects', () => {
  it('describes the folder as an unsaved project, then saves and rereads it', async () => {
    const ws = new FileWorkspace(dir);
    const first = await ws.getProject();
    expect(first).toMatchObject({ saved: false, path: 'sfxgen.project.json' });
    expect(first!.project.sounds.map((s) => s.file)).toEqual(['hit.sfx.json', 'ui/click.sfx.json']);

    const project = { ...first!.project, name: 'Game', groups: [{ id: 'ui' }] };
    project.sounds[1] = { ...project.sounds[1], group: 'ui', gain: -2 };
    await ws.setProject(project, { origin: 'human' });
    const text = await readFile(join(dir, 'sfxgen.project.json'), 'utf8');
    expect(text).toBe(`${JSON.stringify(project, null, 2)}\n`);
    const again = await ws.getProject();
    expect(again).toMatchObject({ saved: true });
    expect(again!.project.sounds[1]).toMatchObject({ group: 'ui', gain: -2 });
  });

  it('rejects an invalid project and keeps agents\' exports inside the root', async () => {
    const ws = new FileWorkspace(dir);
    const project = (await ws.getProject())!.project;
    await expect(ws.setProject({ ...project, sounds: [{ file: 'a.sfx.json', group: 'nope' }] })).rejects.toThrow(/group/);
    expect(existsSync(join(dir, 'sfxgen.project.json'))).toBe(false);

    const outside = { ...project, sounds: [{ file: 'hit.sfx.json', export: '../Assets/hit.wav' }] };
    await expect(ws.setProject(outside, { origin: 'agent' })).rejects.toThrow(/outside the project folder/);
    await ws.setProject(outside, { origin: 'human' });
    // Once a person put it there, an agent editing other things leaves it alone.
    await ws.setProject({ ...outside, name: 'renamed' }, { origin: 'agent' });
    expect((await readProject()).name).toBe('renamed');
  });

  it('builds WAVs at the export paths, in project context, folders created', async () => {
    const project: Project = {
      format: 'sfxgen-project/1',
      name: 'Ctx',
      output: { sampleRate: 22050, channels: 1, bitDepth: 24 },
      normalize: { mode: 'peak', target: -6 },
      outDir: 'build',
      sounds: [
        { file: 'hit.sfx.json', gain: -3, export: 'game/Audio/Hit.wav' },
        { file: 'ui/click.sfx.json' },
        { patch: patch('inline tone', 600) },
        { file: 'skipped.sfx.json', skip: true, export: 'never.wav' },
        { file: 'gone.sfx.json' },
      ],
    };
    await writeFile(join(dir, 'skipped.sfx.json'), JSON.stringify(patch('skipped')));
    project.sounds[3] = { file: 'skipped.sfx.json', skip: true, export: 'never.wav' };
    await writeFile(join(dir, 'sfxgen.project.json'), JSON.stringify(project));

    const ws = new FileWorkspace(dir);
    const rows = await ws.buildProject();
    expect(rows.map((r) => r.name)).toEqual(['hit', 'click', 'inline-tone', 'gone']);
    const hit = decodeWav(new Uint8Array(await readFile(join(dir, 'game/Audio/Hit.wav'))));
    expect(hit.sampleRate).toBe(22050);
    expect(peakDbOf(hit.channels)).toBeCloseTo(-9, 0);
    expect(rows[0].peakDb).toBeCloseTo(-9, 0);
    expect(existsSync(join(dir, 'build/click.wav'))).toBe(true);
    expect(existsSync(join(dir, 'build/inline-tone.wav'))).toBe(true);
    expect(existsSync(join(dir, 'never.wav'))).toBe(false);
    expect(rows[3].error).toMatch(/No patch file/);

    const some = await ws.buildProject({ only: ['click'], dryRun: true });
    expect(some.map((r) => r.name)).toEqual(['click']);
  });
});

describe('server project routes', () => {
  let server: RunningServer;
  let webDir: string;
  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'sfxgen-web-'));
  });
  afterAll(async () => {
    await rm(webDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    server = await startServer({ root: dir, port: 0, webDir, log: () => {} });
    return async () => server.close();
  });
  const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init);

  it('GET/PUT /api/project, with 422 on errors, and a project event on change', async () => {
    const got = await (await api('/api/project')).json();
    expect(got).toMatchObject({ path: 'sfxgen.project.json', saved: false });
    expect(got.project.sounds).toHaveLength(2);

    const bad = await api('/api/project?origin=human', { method: 'PUT', body: JSON.stringify({ ...got.project, sounds: [{ file: 'x.sfx.json', group: 'zzz' }] }) });
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.errors[0].path).toContain('group');
    expect(existsSync(join(dir, 'sfxgen.project.json'))).toBe(false);

    const events: string[] = [];
    const ctrl = new AbortController();
    const res = await api('/api/events', { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const reading = (async () => {
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push(dec.decode(value));
        }
      } catch {
        /* aborted */
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    const ok = await api('/api/project?origin=human', { method: 'PUT', body: JSON.stringify({ ...got.project, name: 'Saved' }) });
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect((await readProject()).name).toBe('Saved');
    // A hand edit on disk is announced as a disk change.
    await writeFile(join(dir, 'sfxgen.project.json'), JSON.stringify({ ...got.project, name: 'By hand' }));
    await new Promise((r) => setTimeout(r, 500));
    ctrl.abort();
    await reading;
    const all = events.join('');
    expect(all).toContain('event: project');
    expect(all).toMatch(/"origin":"human"/);
    expect(all).toMatch(/"origin":"disk"/);
    expect(all.match(/"origin":"human"/g)).toHaveLength(1);
    expect(all.match(/event: project/g)).toHaveLength(2);
    expect(await (await api('/api/project')).json()).toMatchObject({ saved: true, project: { name: 'By hand' } });
  });

  it('POST /api/build renders the sounds, or only some', async () => {
    const project = { format: 'sfxgen-project/1', name: 'B', outDir: 'o', sounds: [{ file: 'hit.sfx.json' }, { file: 'ui/click.sfx.json', export: 'x/click.wav' }] };
    await writeFile(join(dir, 'sfxgen.project.json'), JSON.stringify(project));
    const all = await (await api('/api/build', { method: 'POST' })).json();
    expect(all.rows.map((r: { name: string }) => r.name)).toEqual(['hit', 'click']);
    expect(existsSync(join(dir, 'o/hit.wav'))).toBe(true);
    expect(existsSync(join(dir, 'x/click.wav'))).toBe(true);
    const one = await (await api('/api/build', { method: 'POST', body: JSON.stringify({ only: ['hit'] }) })).json();
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ name: 'hit', export: 'o/hit.wav' });
    expect((await api('/api/build', { method: 'POST', body: '{"only":"hit"}' })).status).toBe(400);
  });
});

/** Runs the CLI and returns its exit code and what it printed. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true));
  try {
    return { code: await main(argv), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe('CLI projects', () => {
  it('project init lists the patches and refuses to overwrite without --force', async () => {
    const a = await cli('project', 'init', dir, '--name', 'Mine');
    expect(a.code).toBe(0);
    const project = await readProject();
    expect(project).toMatchObject({ format: 'sfxgen-project/1', name: 'Mine' });
    expect(project.sounds.map((s) => s.file)).toEqual(['hit.sfx.json', 'ui/click.sfx.json']);
    const b = await cli('project', 'init', dir);
    expect(b.code).toBe(1);
    expect(b.err).toContain('--force');
    expect((await cli('project', 'init', dir, '--force')).code).toBe(0);
    expect((await cli('project', 'nope')).code).toBe(2);
  });

  it('build prints the table, honours --only and --dry-run, and exits 1 on a failing sound', async () => {
    await cli('project', 'init', dir);
    const dry = await cli('build', dir, '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('peak dBFS');
    expect(existsSync(join(dir, 'out'))).toBe(false);

    const real = await cli('build', dir, '--only', 'hit');
    expect(real.code).toBe(0);
    expect(real.out).toContain('out/hit.wav');
    expect(existsSync(join(dir, 'out/hit.wav'))).toBe(true);
    expect(existsSync(join(dir, 'out/click.wav'))).toBe(false);

    const wrong = await cli('build', dir, '--only', 'hitt');
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('hit');

    const project = await readProject();
    project.sounds.push({ file: 'missing.sfx.json' });
    await writeFile(join(dir, 'sfxgen.project.json'), JSON.stringify(project));
    const failing = await cli('build', join(dir, 'sfxgen.project.json'), '--json');
    expect(failing.code).toBe(1);
    expect(JSON.parse(failing.out).rows.find((r: { name: string }) => r.name === 'missing').error).toContain('No patch file');
    expect((await cli('build', join(dir, 'nowhere'))).code).toBe(1);
  });

  it('build without a project file says how to make one', async () => {
    const r = await cli('build', dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('project init');
  });

  it('project report lists levels per sound and group, and --match --write saves gains', async () => {
    await writeFile(
      join(dir, 'sfxgen.project.json'),
      JSON.stringify({ format: 'sfxgen-project/1', name: 'R', groups: [{ id: 'ui' }, { id: 'hits' }], sounds: [{ file: 'hit.sfx.json', group: 'hits' }, { file: 'ui/click.sfx.json', group: 'ui', gain: -8 }] }),
    );
    const r = await cli('project', 'report', dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LUFS min/);
    expect(r.out).toContain('hits');

    const m = await cli('project', 'report', dir, '--match', '-24', '--write');
    expect(m.code).toBe(0);
    expect(m.out).toContain('Applied gains');
    const gains = (await readProject()).sounds.map((s) => s.gain);
    expect(gains.every((g) => typeof g === 'number' && g < 0)).toBe(true);
    // Measured again, both now sit at the target.
    const json = JSON.parse((await cli('project', 'report', dir, '--json')).out);
    for (const s of json.sounds) expect(s.lufs).toBeCloseTo(-24, 0);
    expect((await cli('project', 'report', dir, '--write')).code).toBe(2);
    expect((await cli('project', 'report', dir, '--match', '-24', '--group', 'zz')).code).toBe(1);
  });

  it('render takes several patches into a folder, and renders in a project\'s context', async () => {
    const batch = await cli('render', join(dir, 'hit.sfx.json'), join(dir, 'ui/click.sfx.json'), '-o', join(dir, 'wavs') + '/');
    expect(batch.code).toBe(0);
    expect(existsSync(join(dir, 'wavs/hit.wav'))).toBe(true);
    expect(existsSync(join(dir, 'wavs/click.wav'))).toBe(true);
    const next = await cli('render', join(dir, 'hit.sfx.json'), join(dir, 'ui/click.sfx.json'));
    expect(next.code).toBe(0);
    expect(existsSync(join(dir, 'hit.wav'))).toBe(true);
    expect(existsSync(join(dir, 'ui/click.wav'))).toBe(true);
    const bad = await cli('render', join(dir, 'hit.sfx.json'), join(dir, 'ui/click.sfx.json'), '-o', join(dir, 'one.wav'));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('folder');

    await writeFile(
      join(dir, 'sfxgen.project.json'),
      JSON.stringify({ format: 'sfxgen-project/1', name: 'P', output: { sampleRate: 16000 }, normalize: { mode: 'peak', target: -6 }, sounds: [{ file: 'hit.sfx.json', gain: -4 }] }),
    );
    const inCtx = await cli('render', join(dir, 'hit.sfx.json'), '--project', dir, '-o', join(dir, 'ctx.wav'), '--json');
    expect(inCtx.code).toBe(0);
    const wav = decodeWav(new Uint8Array(await readFile(join(dir, 'ctx.wav'))));
    expect(wav.sampleRate).toBe(16000);
    expect(peakDbOf(wav.channels)).toBeCloseTo(-10, 0);
    expect(JSON.parse(inCtx.out).project).toBe('P');
  });
});

describe('tools on files', () => {
  it('edit_project, balance_project and build_project round trip through a FileWorkspace', async () => {
    const ws = new FileWorkspace(dir);
    const add = await callTool(ws, 'edit_project', { set: { name: 'Tool' }, remove_sound: 'click', add_sound: { file: 'ui/click.sfx.json', gain: -1 } });
    expect(add.isError).toBeUndefined();
    expect(await readProject()).toMatchObject({ name: 'Tool', sounds: [{ file: 'hit.sfx.json' }, { file: 'ui/click.sfx.json', gain: -1 }] });
    const out = await callTool(ws, 'edit_project', { set: { 'sounds.click.export': '../elsewhere/click.wav' } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('outside the project folder');
    const built = await callTool(ws, 'build_project', {});
    expect(built.isError).toBeUndefined();
    expect(existsSync(join(dir, 'out/click.wav'))).toBe(true);
  });
});
