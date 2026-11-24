import { describe, expect, it } from 'vitest';
import { TOOLS, callTool, checkArgs } from '../src/core/agent/tools';
import { MemoryWorkspace } from '../src/core/agent/memory-workspace';
import { diffValues } from '../src/core/agent/diff';
import { decodeWav, type Patch } from '../src/core';

const sound = (): Patch => ({
  format: 'sfxgen/1',
  name: 'test zap',
  duration: 'auto',
  seed: 3,
  tracks: [
    { id: 'zap', source: { type: 'osc', wave: 'saw', freq: [[0, 2400], [0.2, 180]], env: { attack: 0.001, decay: 0.2 } } },
    { id: 'air', gain: -8, source: { type: 'noise', color: 'pink', env: { attack: 0.001, decay: 0.1 } } },
  ],
  controls: [{ id: 'pitch', label: 'Pitch', value: 1, vary: 0.2, targets: [{ path: 'tracks.zap.source.freq', mode: 'mul', from: 0.5, to: 2 }] }],
});

const fresh = () => new MemoryWorkspace({ patches: { 'zap.sfx.json': sound() } });

describe('tool definitions', () => {
  it('lists the seventeen shared tools with strict schemas and real descriptions', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'describe_format', 'list_templates', 'new_from_template', 'get_patch', 'set_patch', 'edit_patch',
      'set_controls', 'sync_controls', 'render_and_analyze', 'play', 'export_wav', 'get_human_changes', 'list_patches',
      'get_project', 'edit_project', 'build_project', 'balance_project',
    ]);
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      for (const [key, prop] of Object.entries(t.inputSchema.properties ?? {})) expect(prop.description, `${t.name}.${key}`).toBeTruthy();
    }
  });

  it('rejects unknown and mistyped arguments, and parses stringified objects', async () => {
    const ws = fresh();
    const bad = await callTool(ws, 'get_patch', { fil: 'zap.sfx.json' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('did you mean "file"');
    expect((await callTool(ws, 'export_wav', { variations: 99 })).isError).toBe(true);
    expect((await callTool(ws, 'nope', {})).text).toContain('Unknown tool');
    expect(checkArgs(TOOLS[4].inputSchema, { patch: JSON.stringify(sound()) })).toMatchObject({ patch: { name: 'test zap' } });
  });
});

describe('describe_format, templates', () => {
  it('describes the catalog and one node', async () => {
    const ws = fresh();
    expect((await callTool(ws, 'describe_format', {})).text).toContain('osc');
    const one = await callTool(ws, 'describe_format', { node: 'osc' });
    expect(one.text).toContain('freq');
    const miss = await callTool(ws, 'describe_format', { node: 'ocs' });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain('osc');
  });

  it('lists templates and creates a patch from one', async () => {
    const ws = new MemoryWorkspace();
    const list = await callTool(ws, 'list_templates', { query: 'thud' });
    expect(list.text).toContain('impacts/thud');
    expect((await callTool(ws, 'list_templates', { category: 'nope' })).isError).toBe(true);

    const made = await callTool(ws, 'new_from_template', { template: 'impacts/thud', file: 'a.sfx.json', controls: { weight: 0.9 }, seed: 11 });
    expect(made.isError).toBeUndefined();
    const p = await ws.getPatch('a.sfx.json');
    expect(p.seed).toBe(11);
    expect(p.controls?.find((c) => c.id === 'weight')?.value).toBe(0.9);
    expect(p.meta?.template).toBe('impacts/thud');

    expect((await callTool(ws, 'new_from_template', { template: 'impacts/thudd' })).text).toContain('impacts/thud');
    expect((await callTool(ws, 'new_from_template', { template: 'impacts/thud', controls: { wieght: 1 } })).text).toContain('weight');
    const again = await callTool(ws, 'new_from_template', { template: 'impacts/thud', file: 'a.sfx.json' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('overwrite');
  });
});

describe('patch tools', () => {
  it('gets a patch and lists patches', async () => {
    const ws = fresh();
    const got = await callTool(ws, 'get_patch', {});
    expect((got.data as Patch).name).toBe('test zap');
    expect((await callTool(ws, 'list_patches', {})).text).toContain('zap.sfx.json');
    expect((await callTool(new MemoryWorkspace(), 'get_patch', {})).isError).toBe(true);
  });

  it('set_patch validates before saving', async () => {
    const ws = fresh();
    const ok = await callTool(ws, 'set_patch', { patch: { ...sound(), name: 'renamed' } });
    expect(ok.isError).toBeUndefined();
    expect((await ws.getPatch()).name).toBe('renamed');

    const broken = sound();
    (broken.tracks[0].source as Record<string, unknown>).type = 'oscc';
    const bad = await callTool(ws, 'set_patch', { patch: broken });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('osc');
    expect((await ws.getPatch()).tracks[0].source.type).toBe('osc');
  });

  it('edit_patch sets, unsets, adds and removes, and is atomic', async () => {
    const ws = fresh();
    const r = await callTool(ws, 'edit_patch', {
      set: { 'tracks.zap.source.freq': [[0, 3000], [0.2, 100]], 'master.gain': -3 },
      unset: ['tracks.air.gain'],
      add_track: { id: 'sub', source: { type: 'osc', wave: 'sine', freq: 50, env: { decay: 0.3 } } },
    });
    expect(r.isError).toBeUndefined();
    const p = await ws.getPatch();
    expect((p.tracks[0].source.freq as number[][])[0][1]).toBe(3000);
    expect(p.master?.gain).toBe(-3);
    expect(p.tracks.find((t) => t.id === 'air')?.gain).toBeUndefined();
    expect(p.tracks.map((t) => t.id)).toEqual(['zap', 'air', 'sub']);

    const removed = await callTool(ws, 'edit_patch', { remove_track: 'zap' });
    expect(removed.text).toContain('Controls now broken');

    const before = JSON.stringify(await ws.getPatch());
    const nope = await callTool(ws, 'edit_patch', { set: { 'tracks.ghost.source.freq': 1, 'master.gain': -9 } });
    expect(nope.isError).toBe(true);
    expect(nope.text).toContain('no track "ghost"');
    const invalid = await callTool(ws, 'edit_patch', { set: { duration: -2 } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(await ws.getPatch())).toBe(before);
    expect((await callTool(ws, 'edit_patch', {})).isError).toBe(true);
    expect((await callTool(ws, 'edit_patch', { remove_track: 'zapp' })).text).toContain('zap');
  });

  it('set_controls checks every target path', async () => {
    const ws = fresh();
    const good = await callTool(ws, 'set_controls', {
      controls: [
        { id: 'size', label: 'Size', value: 0.5, targets: [{ path: 'tracks.zap.source.env.decay', mode: 'mul', from: 0.5, to: 2 }, { path: 'tracks.air.gain', mode: 'add', from: -6, to: 3 }] },
      ],
    });
    expect(good.isError).toBeUndefined();
    expect((await ws.getPatch()).controls?.map((c) => c.id)).toEqual(['size']);

    const bad = await callTool(ws, 'set_controls', { controls: [{ id: 'x', label: 'X', value: 0, targets: [{ path: 'tracks.zap.source.frq' }] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('tracks.zap.source.frq');
    expect((await ws.getPatch()).controls?.map((c) => c.id)).toEqual(['size']);

    const dup = await callTool(ws, 'set_controls', { controls: [{ id: 'a', label: 'A', value: 0 }, { id: 'a', label: 'B', value: 0 }] });
    expect(dup.isError).toBe(true);
  });
});

describe('render, play, export', () => {
  it('render_and_analyze describes, measures and can attach a spectrogram', async () => {
    const ws = fresh();
    const r = await callTool(ws, 'render_and_analyze', { spectrogram: true });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Rendered "test zap"');
    expect((r.data as { analysis: { peakDb: number } }).analysis.peakDb).toBeLessThan(0);
    expect(r.image?.mimeType).toBe('image/png');
    expect([...r.image!.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const plain = await callTool(ws, 'render_and_analyze', { analyze: false, describe: false });
    expect(plain.image).toBeUndefined();
    expect((plain.data as Record<string, unknown>).analysis).toBeUndefined();
  });

  it('render_and_analyze refuses a broken patch with the issues', async () => {
    const broken = sound();
    broken.duration = -1 as unknown as number;
    const r = await callTool(new MemoryWorkspace({ patches: { 'b.sfx.json': broken } }), 'render_and_analyze', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('duration');
  });

  it('play reports through the workspace', async () => {
    const ws = fresh();
    expect((await callTool(ws, 'play', {})).data).toMatchObject({ played: true });
    expect(ws.played).toEqual(['zap.sfx.json']);
  });

  it('export_wav writes one file or several variations', async () => {
    const ws = fresh();
    const one = await callTool(ws, 'export_wav', { bit_depth: 24 });
    expect(one.isError).toBeUndefined();
    expect(ws.exports.has('zap.sfx.json.wav')).toBe(true);

    expect((await callTool(ws, 'export_wav', { variations: 3, path: 'out/zap' })).isError).toBeUndefined();
    expect([...ws.exports.keys()].filter((k) => k.startsWith('out/'))).toEqual(['out/zap-01.wav', 'out/zap-02.wav', 'out/zap-03.wav']);
    const a = decodeWav(ws.exports.get('out/zap-01.wav')!);
    const b = decodeWav(ws.exports.get('out/zap-02.wav')!);
    expect(a.sampleRate).toBe(48000);
    expect(Buffer.from(ws.exports.get('out/zap-01.wav')!).equals(Buffer.from(ws.exports.get('out/zap-02.wav')!))).toBe(false);
    expect(a.channels[0].length).toBeGreaterThan(0);
    expect(b.channels[0].length).toBeGreaterThan(0);
  });
});

describe('human changes', () => {
  it('reports what a person changed, and the agent write resets it', async () => {
    const ws = fresh();
    expect((await callTool(ws, 'get_human_changes', {})).text).toContain('No changes');
    const p = await ws.getPatch();
    p.tracks[0].gain = -4;
    p.controls![0].value = 0.25;
    await ws.setPatch(p, { origin: 'human' });
    const r = await callTool(ws, 'get_human_changes', {});
    const changes = (r.data as { changes: { path: string; before: unknown; after: unknown }[] }).changes;
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'tracks.zap.gain', before: undefined, after: -4 },
        { path: 'controls.pitch.value', before: 1, after: 0.25 },
      ]),
    );
    const edit = await callTool(ws, 'edit_patch', { set: { 'master.gain': -1 } });
    expect(edit.text).toContain('a person changed 2');
    expect((await callTool(ws, 'get_human_changes', {})).text).toContain('No changes');
  });

  it('diffValues addresses items by id', () => {
    const d = diffValues({ tracks: [{ id: 'a', gain: 1 }, { id: 'b' }] }, { tracks: [{ id: 'a', gain: 2 }] });
    expect(d).toEqual([
      { path: 'tracks.a.gain', before: 1, after: 2 },
      { path: 'tracks.b', before: { id: 'b' }, after: undefined },
    ]);
  });
});

describe('project tools', () => {
  const second = (): Patch => ({
    format: 'sfxgen/1',
    name: 'loud',
    duration: 'auto',
    tracks: [{ id: 'n', source: { type: 'noise', color: 'white', env: { attack: 0.001, decay: 0.3 } } }],
  });
  const withProject = () =>
    new MemoryWorkspace({
      patches: { 'zap.sfx.json': sound(), 'loud.sfx.json': second() },
      project: { format: 'sfxgen-project/1', name: 'Set', groups: [{ id: 'fx' }], sounds: [{ file: 'zap.sfx.json', group: 'fx' }, { file: 'loud.sfx.json', group: 'fx', note: 'harsh' }] },
    });

  it('get_project describes the project, and measures it on request', async () => {
    const ws = withProject();
    const plain = await callTool(ws, 'get_project', {});
    expect(plain.text).toContain('Project "Set"');
    expect(plain.text).toContain('out/zap.wav');
    expect((plain.data as { sounds: unknown[] }).sounds).toHaveLength(2);
    const measured = await callTool(ws, 'get_project', { measure: true });
    const sounds = (measured.data as { sounds: { name: string; lufs: number; peakDb: number }[] }).sounds;
    expect(sounds.map((x) => x.name)).toEqual(['zap', 'loud']);
    expect(sounds[0].lufs).toBeLessThan(0);
    expect(measured.text).toContain('LUFS');
    // Without a saved project the patches form an unsaved one; with nothing there is none.
    const unsaved = new MemoryWorkspace({ patches: { 'a.sfx.json': sound() } });
    expect((await callTool(unsaved, 'get_project', {})).text).toContain('not saved yet');
    expect((await callTool(new MemoryWorkspace(), 'get_project', {})).isError).toBe(true);
  });

  it('edit_project addresses sounds by name and validates before saving', async () => {
    const ws = withProject();
    const ok = await callTool(ws, 'edit_project', { set: { 'sounds.loud.gain': -6, 'normalize': { mode: 'peak', target: -3 } }, unset: ['sounds.loud.note'] });
    expect(ok.isError).toBeUndefined();
    expect(ws.project?.sounds[1]).toMatchObject({ gain: -6 });
    expect(ws.project?.sounds[1].note).toBeUndefined();
    expect(ws.project?.normalize).toEqual({ mode: 'peak', target: -3 });

    const before = JSON.stringify(ws.project);
    expect((await callTool(ws, 'edit_project', { set: { 'sounds.zapp.gain': 1 } })).text).toContain('zap');
    expect((await callTool(ws, 'edit_project', { set: { 'sounds.zap.group': 'nope' } })).isError).toBe(true);
    expect((await callTool(ws, 'edit_project', { add_sound: { file: 'missing.sfx.json' } })).isError).toBe(true);
    expect((await callTool(ws, 'edit_project', { add_sound: { file: 'zap.sfx.json' } })).text).toContain('named "zap"');
    expect((await callTool(ws, 'edit_project', {})).isError).toBe(true);
    expect(JSON.stringify(ws.project)).toBe(before);

    await ws.setPatch({ ...sound(), name: 'extra' }, { ref: 'extra.sfx.json' });
    expect((await callTool(ws, 'edit_project', { add_sound: { file: 'extra.sfx.json', group: 'fx', gain: -2 } })).isError).toBeUndefined();
    expect(ws.project?.sounds.map((x) => x.file)).toEqual(['zap.sfx.json', 'loud.sfx.json', 'extra.sfx.json']);
    expect((await callTool(ws, 'edit_project', { remove_sound: 'extra' })).isError).toBeUndefined();
    expect((await callTool(ws, 'edit_project', { remove_sound: 'extra' })).isError).toBe(true);
  });

  it('a first edit on an unsaved project creates the project', async () => {
    const ws = new MemoryWorkspace({ patches: { 'a.sfx.json': sound() } });
    const r = await callTool(ws, 'edit_project', { set: { name: 'New' } });
    expect(r.text).toContain('Created the project file');
    expect(ws.project?.name).toBe('New');
  });

  it('balance_project suggests, then applies gains that match the target', async () => {
    const ws = withProject();
    const target = -26;
    const suggestion = await callTool(ws, 'balance_project', { target_lufs: target });
    expect(suggestion.text).toContain('Suggested');
    expect(ws.project?.sounds[0].gain).toBeUndefined();
    const applied = await callTool(ws, 'balance_project', { target_lufs: target, apply: true });
    expect(applied.text).toContain('Wrote');
    const after = await callTool(ws, 'get_project', { measure: true });
    for (const x of (after.data as { sounds: { lufs: number }[] }).sounds) expect(x.lufs).toBeCloseTo(target, 0);
    expect((await callTool(ws, 'balance_project', { target_lufs: target, group: 'zz' })).isError).toBe(true);
    // The ceiling holds a sound back rather than letting it clip.
    const held = await callTool(withProject(), 'balance_project', { target_lufs: -3, ceiling_db: -6 });
    expect(held.text).toContain('ceiling');
    const gains = (held.data as { levels: { name: string; peakDb: number; gain: number }[]; gains: Record<string, number> });
    for (const l of gains.levels) expect(l.peakDb - l.gain + gains.gains[l.name]).toBeLessThanOrEqual(-5.9);
    // Per-group targets.
    const grouped = await callTool(withProject(), 'balance_project', { target_lufs: -20, group_targets: { fx: -30 } });
    expect((grouped.data as { gains: Record<string, number> }).gains.zap).toBeLessThan(-5);
  });

  it('build_project writes WAVs at the export paths and reports a failing sound', async () => {
    const ws = withProject();
    const r = await callTool(ws, 'build_project', {});
    expect(r.isError).toBeUndefined();
    expect([...ws.exports.keys()].sort()).toEqual(['out/loud.wav', 'out/zap.wav']);
    expect(r.text).toContain('out/zap.wav');
    const one = await callTool(withProject(), 'build_project', { only: ['zap'] });
    expect((one.data as { rows: unknown[] }).rows).toHaveLength(1);
    expect((await callTool(withProject(), 'build_project', { only: ['zapp'] })).text).toContain('zap');
    ws.patches.delete('loud.sfx.json');
    const failing = await callTool(ws, 'build_project', {});
    expect(failing.isError).toBe(true);
    expect(failing.text).toContain('ERROR');
  });
});

describe('sync_controls and tracks', () => {
  it('sync_controls writes control values into the patch, once', async () => {
    const ws = fresh();
    const p = await ws.getPatch();
    p.controls = [{ id: 'level', label: 'Level', value: 0.5, targets: [{ path: 'tracks.air.gain', mode: 'set', from: -30, to: -10 }] }];
    await ws.setPatch(p);
    const r = await callTool(ws, 'sync_controls', {});
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('tracks.air.gain');
    expect((await ws.getPatch()).tracks[1].gain).toBe(-20);
    expect((await callTool(ws, 'sync_controls', {})).text).toContain('Already in sync');
  });

  it('edit_patch says when a control overrides the value it just set', async () => {
    const ws = fresh();
    const p = await ws.getPatch();
    p.controls = [{ id: 'level', label: 'Level', value: 0.5, targets: [{ path: 'tracks.air.gain', mode: 'set', from: -30, to: -10 }] }];
    await ws.setPatch(p);
    const r = await callTool(ws, 'edit_patch', { set: { 'tracks.air.gain': -3 } });
    expect(r.text).toContain('set by control "level"');
  });

  it('render_and_analyze tracks: true lists each layer and flags a faint one', async () => {
    const ws = fresh();
    const p = await ws.getPatch();
    p.tracks[1].gain = -50;
    await ws.setPatch(p);
    const r = await callTool(ws, 'render_and_analyze', { tracks: true });
    expect(r.isError).toBeUndefined();
    const tracks = (r.data as { tracks: { id: string; inaudible: boolean; sharePct: number }[] }).tracks;
    expect(tracks.map((t) => t.id)).toEqual(['zap', 'air']);
    expect(tracks[1].inaudible).toBe(true);
    expect(tracks[0].inaudible).toBe(false);
    expect(r.text).toContain('inaudible');
    expect((await callTool(ws, 'render_and_analyze', {})).data).not.toHaveProperty('tracks');
  });

  it('render_and_analyze describes a loop with its seam instead of start and end warnings', async () => {
    const ws = new MemoryWorkspace({
      patches: {
        'loop.sfx.json': { format: 'sfxgen/1', name: 'hum', duration: 1, loop: { mode: 'wrap' }, tracks: [{ id: 'h', source: { type: 'osc', wave: 'sine', freq: 100, env: { attack: 0.001, sustain: 1 } } }] },
      },
    });
    const r = await callTool(ws, 'render_and_analyze', {});
    expect(r.text).toContain('Loop: seam');
    expect(r.text).not.toContain('still sounding at the end');
  });
});
