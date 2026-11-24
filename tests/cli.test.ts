/**
 * The CLI end to end: each command run through tsx in a temporary folder, as an agent would run it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTemplates } from '../src/core/templates';
import { buildSchema } from '../src/core/agent/schema';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(ROOT, 'src', 'node', 'cli.ts');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

let dir = '';

function sfxgen(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (file: string) => readFileSync(join(dir, file));
const readJson = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfxgen-cli-'));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('sfxgen CLI', () => {
  it('prints help for itself and every command, and its version', () => {
    const main = sfxgen('--help');
    expect(main.code).toBe(0);
    for (const c of ['render', 'analyze', 'validate', 'guide', 'schema', 'templates', 'new', 'diff', 'sync', 'serve', 'mcp']) {
      expect(main.out).toContain(`  ${c}`);
      const help = sfxgen(c, '--help');
      expect(help.code, c).toBe(0);
      expect(help.out, c).toContain(`Usage: sfxgen ${c}`);
      expect(help.out, c).toContain('Examples:');
    }
    expect(sfxgen('--version').out.trim()).toBe(VERSION);
  });

  it('starts a patch from a template with a control set', () => {
    const r = sfxgen('new', 'impacts/thud', '-o', 'door.sfx.json', '--set', 'weight=0.8');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Next: sfxgen render door.sfx.json');
    const patch = readJson('door.sfx.json');
    expect(patch.controls.find((c: { id: string }) => c.id === 'weight').value).toBe(0.8);
    expect(patch.meta.template).toBe('impacts/thud');
    // It won't overwrite without --force.
    expect(sfxgen('new', 'impacts/thud', '-o', 'door.sfx.json').code).toBe(1);
    expect(sfxgen('new', 'thud', '-o', 'door.sfx.json', '--force').code).toBe(0);
    writeFileSync(join(dir, 'door.sfx.json'), JSON.stringify({ ...patch }, null, 2));
  });

  it('validates, with exit code 1 and a suggestion on errors', () => {
    expect(sfxgen('validate', 'door.sfx.json').code).toBe(0);
    writeFileSync(join(dir, 'bad.sfx.json'), JSON.stringify({ format: 'sfxgen/1', name: 'bad', duration: 'auto', tracks: [{ id: 'a', source: { type: 'osk' } }] }));
    writeFileSync(join(dir, 'broken.sfx.json'), '{ "format": ');
    const r = sfxgen('validate', 'door.sfx.json', 'bad.sfx.json', 'broken.sfx.json');
    expect(r.code).toBe(1);
    expect(r.out).toContain('did you mean "osc"?');
    expect(r.out).toContain('not valid JSON');
    expect(r.out).toContain('3 patches: 1 ok, 2 with errors');
    const json = JSON.parse(sfxgen('validate', 'bad.sfx.json', '--json').out);
    expect(json[0].ok).toBe(false);
  });

  it('renders a WAV, its spectrogram and its analysis', () => {
    const r = sfxgen('render', 'door.sfx.json', '--png', '--analyze');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Rendered door\.sfx\.json -> door\.wav \(.* 48000 Hz mono 16-bit/);
    expect(r.out).toContain('The spectrogram: door.png');
    expect(r.out).toMatch(/Attack .*loudest at/);
    expect(r.out).toContain('envelope  |');
    expect(r.out).toContain('bands     sub <60');
    expect(read('door.wav').subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect([...read('door.png').subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('renders variations the way the editor exports them', () => {
    const r = sfxgen('render', 'door.sfx.json', '--variations', '3', '-o', 'takes/door.wav');
    expect(r.code, r.err).toBe(0);
    for (const n of ['01', '02', '03']) expect(existsSync(join(dir, 'takes', `door-${n}.wav`))).toBe(true);
    // The first take is the patch itself.
    expect(read('takes/door-01.wav').equals(read('door.wav'))).toBe(true);
    expect(read('takes/door-02.wav').equals(read('door.wav'))).toBe(false);
  });

  it('honours --sr, --channels, --bits, --seed and --set by path', () => {
    const first = readJson('door.sfx.json').tracks[0].id;
    const r = sfxgen('render', 'door.sfx.json', '-o', 'alt.wav', '--sr', '44100', '--channels', '2', '--bits', '24', '--seed', '9', '--set', `tracks.${first}.gain=-3`, '--json');
    expect(r.code, r.err).toBe(0);
    const take = JSON.parse(r.out).takes[0];
    expect([take.sampleRate, take.channels, take.bitDepth, take.seed]).toEqual([44100, 2, 24, 9]);
    const wav = read('alt.wav');
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt16LE(34)).toBe(24);
  });

  it('analyzes a WAV and a patch, as text or JSON', () => {
    const json = JSON.parse(sfxgen('analyze', 'door.wav', '--json').out);
    expect(json.analysis.peakDb).toBeCloseTo(-1, 0);
    expect(json.summary.length).toBeGreaterThanOrEqual(4);
    const text = sfxgen('analyze', 'door.sfx.json', '--png', 'shot.png');
    expect(text.code, text.err).toBe(0);
    expect(text.out).toMatch(/^door\.sfx\.json: rendered/);
    expect(text.out).toContain('faint horizontal lines at 100 Hz, 1 kHz, 10 kHz');
    expect(existsSync(join(dir, 'shot.png'))).toBe(true);
    expect(sfxgen('analyze', 'door.wav', '--seed', '3').code).toBe(2);
  });

  it('diffs two patches by path', () => {
    const patch = readJson('door.sfx.json');
    patch.controls[0].value = 0.3;
    patch.tracks[0].gain = -7.5;
    writeFileSync(join(dir, 'door2.sfx.json'), JSON.stringify(patch, null, 2));
    const r = sfxgen('diff', 'door.sfx.json', 'door2.sfx.json');
    expect(r.code).toBe(0);
    expect(r.out).toContain('~ controls.weight.value: 0.8 -> 0.3');
    expect(r.out).toMatch(new RegExp(`[~+] tracks\\.${patch.tracks[0].id}\\.gain: .*-7\\.5`));
    expect(r.out).toContain('2 changes');
    expect(sfxgen('diff', 'door.sfx.json', 'door.sfx.json').out.trim()).toBe('no changes');
    const json = JSON.parse(sfxgen('diff', 'door.sfx.json', 'door2.sfx.json', '--json').out);
    expect(json).toContainEqual({ path: 'controls.weight.value', before: 0.8, after: 0.3 });
  });

  it('prints the guide, one node, and refuses unknown ones', () => {
    const all = sfxgen('guide');
    expect(all.code).toBe(0);
    expect(all.out).toContain('## Controls');
    expect(all.out).toContain('## Sources in detail');
    expect(all.out).toContain('## Templates');
    const osc = sfxgen('guide', '--type', 'osc');
    expect(osc.out).toContain('| `freq` | signal |');
    expect(osc.out).toContain('## Common source parameters');
    const bad = sfxgen('guide', '--type', 'osk');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('did you mean "osc"?');
    expect(sfxgen('guide', '--section', 'overview').out).not.toContain('## Sources in detail');
  });

  it('writes the JSON Schema, which every template satisfies', async () => {
    const r = sfxgen('schema', '--write');
    expect(r.code, r.err).toBe(0);
    const schema = readJson('schema/sfxgen.schema.json');
    expect(schema).toEqual(JSON.parse(JSON.stringify(buildSchema())));
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    // ajv comes with the MCP SDK; check the schema with it when it is there.
    const name = 'ajv/dist/2020';
    const mod = await import(/* @vite-ignore */ name).catch(() => null);
    if (!mod) {
      expect(existsSync(join(ROOT, 'node_modules', 'ajv')), 'ajv is installed but did not load').toBe(false);
      return;
    }
    const Ajv = mod.default ?? mod;
    const validate = new Ajv({ strict: true, strictTuples: false, allErrors: true }).compile(schema);
    for (const t of allTemplates()) expect(validate(t.patch), `${t.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    expect(validate({ format: 'sfxgen/1', name: 'x', duration: 'auto', tracks: [{ id: 'a', source: { type: 'osc', frq: 440 } }] })).toBe(false);
  });

  it('lists and searches templates', () => {
    const r = sfxgen('templates');
    expect(r.code).toBe(0);
    expect(r.out).toContain('impacts/thud');
    const json = JSON.parse(sfxgen('templates', '--search', 'laser', '--json').out);
    expect(json.map((t: { id: string }) => t.id)).toContain('scifi/laser-zap');
    expect(sfxgen('templates', '--category', 'nope').code).toBe(1);
  });

  it('explains usage mistakes with exit code 2', () => {
    const unknown = sfxgen('rendr');
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('did you mean "render"?');
    const option = sfxgen('render', 'door.sfx.json', '--pgn');
    expect(option.code).toBe(2);
    expect(option.err).toContain('did you mean "--png"?');
    expect(sfxgen('render').code).toBe(2);
    expect(sfxgen('render', 'door.sfx.json', '--bits', '12').code).toBe(2);
    const missing = sfxgen('render', 'nothing.sfx.json');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no such file');
    const control = sfxgen('render', 'door.sfx.json', '--set', 'wieght=1');
    expect(control.code).toBe(1);
    expect(control.err).toContain('did you mean "weight"?');
  });

  describe('sync, tracks and --set', () => {
    const write = (file: string, patch: unknown) => writeFileSync(join(dir, file), JSON.stringify(patch, null, 2));
    const base = () => ({
      format: 'sfxgen/1',
      name: 'layers',
      duration: 'auto',
      tracks: [
        { id: 'main', source: { type: 'osc', wave: 'sine', freq: 300, env: { attack: 0.001, decay: 0.3 } } },
        { id: 'faint', gain: -45, source: { type: 'noise', color: 'pink', env: { attack: 0.001, decay: 0.1 } } },
      ],
      controls: [{ id: 'punch', label: 'Punch', value: 0.25, targets: [{ path: 'tracks.faint.gain', mode: 'set', from: -60, to: -30 }] }],
    });

    it('sync writes control values into the base, --check changes nothing and exits 1', () => {
      write('sync-me.sfx.json', base());
      const check = sfxgen('sync', 'sync-me.sfx.json', '--check');
      expect(check.code).toBe(1);
      expect(check.out).toContain('tracks.faint.gain');
      expect(readJson('sync-me.sfx.json').tracks[1].gain).toBe(-45);
      const run = sfxgen('sync', 'sync-me.sfx.json');
      expect(run.code).toBe(0);
      expect(run.out).toContain('synced');
      expect(readJson('sync-me.sfx.json').tracks[1].gain).toBe(-52.5);
      expect(sfxgen('sync', 'sync-me.sfx.json', '--check').code).toBe(0);
      expect(sfxgen('sync').code).toBe(2);
    });

    it('analyze --tracks and render --tracks list each layer and mark the inaudible one', () => {
      write('layers.sfx.json', base());
      const a = sfxgen('analyze', 'layers.sfx.json', '--tracks');
      expect(a.code).toBe(0);
      expect(a.out).toMatch(/track\s+source\s+peak dBFS\s+LUFS\s+energy %/);
      expect(a.out).toMatch(/faint\s+noise.*inaudible/);
      expect(a.out).not.toMatch(/main\s+osc.*inaudible/);
      const json = JSON.parse(sfxgen('analyze', 'layers.sfx.json', '--tracks', '--json').out);
      expect(json.tracks.map((t: { id: string }) => t.id)).toEqual(['main', 'faint']);
      expect(json.tracks[1].inaudible).toBe(true);
      expect(json.tracks[0].sharePct).toBeGreaterThan(99);
      const r = sfxgen('render', 'layers.sfx.json', '--tracks', '-o', 'layers-out.wav');
      expect(r.code).toBe(0);
      expect(r.out).toContain('inaudible');
      expect(sfxgen('analyze', 'layers-out.wav', '--tracks').code).toBe(2);
    });

    it('warns when --set targets a path a control sets, and creates master.normalize parents', () => {
      write('owned.sfx.json', base());
      const r = sfxgen('render', 'owned.sfx.json', '--set', 'tracks.faint.gain=-10', '-o', 'owned.wav');
      expect(r.code).toBe(0);
      expect(r.err).toContain('tracks.faint.gain is set by control "punch"; use --set punch=<value>, or sfxgen sync after editing');
      const n = sfxgen('render', 'owned.sfx.json', '--set', 'master.normalize.mode=none', '-o', 'owned2.wav');
      expect(n.code).toBe(0);
      expect(n.err).not.toContain('no parameter');
    });

    it('analyses a loop without the one-shot start and end warnings', () => {
      write('loopy.sfx.json', {
        format: 'sfxgen/1',
        name: 'loopy',
        duration: 1,
        loop: { mode: 'wrap' },
        tracks: [{ id: 'hum', source: { type: 'osc', wave: 'sine', freq: 100, env: { attack: 0.001, sustain: 1 } } }],
      });
      const r = sfxgen('analyze', 'loopy.sfx.json');
      expect(r.code).toBe(0);
      expect(r.out).toContain('Loop: seam');
      expect(r.out).not.toContain('still sounding at the end');
    });
  });
});
