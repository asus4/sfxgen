/**
 * Review on disk: takes folders, the review file through `sfxgen serve`, and `sfxgen review` as an agent runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../src/node/server';
import { FileWorkspace, listPatchFiles, listTakes } from '../src/node/file-workspace';
import { callTool } from '../src/core/agent/tools';
import { soundVersion, type Patch } from '../src/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(ROOT, 'src', 'node', 'cli.ts');

const patch = (name: string, freq = 440): Patch => ({
  format: 'sfxgen/1',
  name,
  duration: 'auto',
  tracks: [{ id: 'a', source: { type: 'osc', wave: 'sine', freq, env: { decay: 0.1 } } }],
  controls: [{ id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.a.source.freq', mode: 'set', from: 220, to: 880 }] }],
});
const json = (p: Patch) => `${JSON.stringify(p, null, 2)}\n`;

let dir: string;
let server: RunningServer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sfxgen-review-'));
  await mkdir(join(dir, 'hum.takes'));
  await writeFile(join(dir, 'beep.sfx.json'), json(patch('beep')));
  await writeFile(join(dir, 'hum.sfx.json'), json(patch('hum', 110)));
  await writeFile(join(dir, 'hum.takes', 'low.sfx.json'), json(patch('hum', 80)));
  await writeFile(join(dir, 'hum.takes', 'original.sfx.json'), json(patch('hum', 110)));
  server = await startServer({ root: dir, port: 0, webDir: join(dir, 'no-web'), log: () => {} });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init);

/** Reads server-sent events until one `event` frame arrives (or the timeout), returning its data. */
async function nextEvent(event: string, action: () => Promise<unknown>): Promise<unknown> {
  const ctrl = new AbortController();
  const res = await api('/api/events', { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let found: unknown;
  const deadline = setTimeout(() => ctrl.abort(), 4000);
  const reading = (async () => {
    try {
      while (found === undefined) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (frame.includes(`event: ${event}`)) found = JSON.parse(frame.split('data: ')[1]);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  await action();
  await reading;
  clearTimeout(deadline);
  ctrl.abort();
  return found;
}

function sfxgen(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('takes on disk', () => {
  it('are not sounds of their own, and are listed by the sound they belong to', async () => {
    expect((await listPatchFiles(dir)).map((f) => f.path)).toEqual(['beep.sfx.json', 'hum.sfx.json']);
    const takes = await listTakes(dir);
    expect(Object.keys(takes)).toEqual(['hum.sfx.json']);
    expect(takes['hum.sfx.json'].map((t) => t.path)).toEqual(['hum.takes/low.sfx.json', 'hum.takes/original.sfx.json']);
    const { files } = await (await api('/api/files')).json();
    expect(files.map((f: { path: string }) => f.path)).toEqual(['beep.sfx.json', 'hum.sfx.json']);
    const body = await (await api('/api/takes')).json();
    expect(body.takes['hum.sfx.json']).toHaveLength(2);
  });
});

describe('the review through the server', () => {
  it('starts empty, takes a verdict, announces it and writes the file', async () => {
    const empty = await (await api('/api/review')).json();
    expect(empty).toEqual({ path: 'sfxgen.review.json', review: { format: 'sfxgen-review/1', sounds: {} } });

    const entry = { status: 'approved', at: new Date().toISOString(), version: soundVersion(patch('beep')), changes: [{ path: 'controls.pitch.value', before: 0.5, after: 0.7 }] };
    const event = await nextEvent('review', () =>
      api('/api/review?origin=human', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sound: 'beep.sfx.json', entry }) }),
    );
    expect(event).toMatchObject({ path: 'sfxgen.review.json', origin: 'human', sound: 'beep.sfx.json' });
    const onDisk = JSON.parse(await readFile(join(dir, 'sfxgen.review.json'), 'utf8'));
    expect(onDisk.sounds['beep.sfx.json']).toEqual(entry);

    const bad = await api('/api/review', { method: 'PUT', body: JSON.stringify({ sound: 'beep.sfx.json', entry: { status: 'maybe' } }) });
    expect(bad.status).toBe(422);
    expect((await api('/api/review', { method: 'PUT', body: JSON.stringify({ entry }) })).status).toBe(400);
  });

  it('reports it to an agent, and a change to the sound undoes it', async () => {
    const ws = new FileWorkspace(dir);
    const { report } = await ws.getReview();
    expect(report.counts).toEqual({ sounds: 2, unreviewed: 1, needsWork: 0, approved: 1 });
    expect(report.rows[1]).toMatchObject({ name: 'hum', takes: ['low', 'original'], takeInUse: 'original' });
    const tool = await callTool(ws, 'get_review', {});
    expect(tool.text).toContain('#1 beep: approved');
    expect(tool.text).toContain('the person changed: Pitch 0.5 -> 0.7');

    await writeFile(join(dir, 'beep.sfx.json'), json(patch('beep', 500)));
    expect((await ws.getReview()).report.rows[0]).toMatchObject({ status: 'unreviewed', changedSince: true });
    await writeFile(join(dir, 'beep.sfx.json'), json(patch('beep')));
  });
});

describe('sfxgen review', () => {
  it('prints the new verdicts once, then marks them read', () => {
    const first = sfxgen('review');
    expect(first.code).toBe(0);
    expect(first.out).toContain('2 sounds · 1 not reviewed · 0 need work · 1 approved');
    expect(first.out).toContain('#1 beep: approved');
    expect(first.out).toContain('Not reviewed (1): #2 hum (2 takes)');
    const second = sfxgen('review');
    expect(second.out).toContain('No new verdicts');
    expect(sfxgen('review', '--all').out).toContain('#1 beep: approved');
    const data = JSON.parse(sfxgen('review', '--json').out);
    expect(data.counts.approved).toBe(1);
    expect(sfxgen('review', '--timeout', '1').code).toBe(2);
  });

  it('waits for new verdicts and gives up after its timeout', () => {
    const r = sfxgen('review', '--wait', '--timeout', '1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('No new verdicts in 1 s');
  });
});
