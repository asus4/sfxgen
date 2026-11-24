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
  it('lists the twelve shared tools with strict schemas and real descriptions', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'describe_format', 'list_templates', 'new_from_template', 'get_patch', 'set_patch', 'edit_patch',
      'set_controls', 'render_and_analyze', 'play', 'export_wav', 'get_human_changes', 'list_patches',
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
