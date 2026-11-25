import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../src/node/server';
import { FileWorkspace } from '../src/node/file-workspace';
import { callTool } from '../src/core/agent/tools';
import type { Patch } from '../src/core';

const patch = (name: string): Patch => ({
  format: 'sfxgen/1',
  name,
  duration: 'auto',
  tracks: [{ id: 'a', source: { type: 'osc', wave: 'sine', freq: 440, env: { decay: 0.1 } } }],
});

let dir: string;
let webDir: string;
let server: RunningServer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sfxgen-server-'));
  webDir = await mkdtemp(join(tmpdir(), 'sfxgen-web-'));
  await mkdir(join(dir, 'sub'));
  await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'beep.sfx.json'), JSON.stringify(patch('beep')));
  await writeFile(join(dir, 'sub', 'boop.sfx.json'), JSON.stringify(patch('boop')));
  await writeFile(join(dir, 'node_modules', 'x.sfx.json'), JSON.stringify(patch('hidden')));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>editor</title>');
  await writeFile(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  server = await startServer({ root: dir, port: 0, webDir, log: () => {} });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
  await rm(webDir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init);

/** Reads server-sent events until `want` frames of `event` arrive (or the timeout), returning their data. */
async function collect(event: string, action: () => Promise<unknown>, want = 1): Promise<unknown[]> {
  const ctrl = new AbortController();
  const res = await api('/api/events', { signal: ctrl.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const found: unknown[] = [];
  let buffer = '';
  const deadline = setTimeout(() => ctrl.abort(), 4000);
  const reading = (async () => {
    try {
      while (found.length < want) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (frame.includes(`event: ${event}`)) found.push(JSON.parse(frame.split('data: ')[1]));
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

describe('serve API', () => {
  it('reports info and lists patch files, skipping node_modules', async () => {
    const info = await (await api('/api/info')).json();
    expect(info).toMatchObject({ mode: 'serve', root: dir });
    expect(typeof info.version).toBe('string');
    const { files } = await (await api('/api/files')).json();
    expect(files.map((f: { path: string }) => f.path)).toEqual(['beep.sfx.json', 'sub/boop.sfx.json']);
    expect(files[0]).toMatchObject({ name: 'beep' });
    expect(typeof files[0].mtime).toBe('number');
  });

  it('reads a patch and refuses paths outside the root', async () => {
    const got = await (await api('/api/file?path=sub/boop.sfx.json')).json();
    expect(got.name).toBe('boop');
    expect((await api('/api/file?path=missing.sfx.json')).status).toBe(404);
    expect((await api(`/api/file?path=${encodeURIComponent('../secret.sfx.json')}`)).status).toBe(400);
    expect((await api('/api/file')).status).toBe(400);
  });

  it('writes a valid patch as 2-space JSON and rejects an invalid one with 422', async () => {
    const put = (body: unknown) =>
      api('/api/file?path=new.sfx.json&origin=human', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await put(patch('new'));
    expect(ok.status).toBe(200);
    const text = await readFile(join(dir, 'new.sfx.json'), 'utf8');
    expect(text).toBe(`${JSON.stringify(patch('new'), null, 2)}\n`);

    const broken = patch('new');
    (broken.tracks[0].source as Record<string, unknown>).type = 'oscc';
    const bad = await put(broken);
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('path');
    expect(await readFile(join(dir, 'new.sfx.json'), 'utf8')).toBe(text);
    expect((await api('/api/file?path=new.sfx.json', { method: 'PUT', body: '{nope' })).status).toBe(400);
  });

  it('stores exported WAV bytes', async () => {
    const res = await api('/api/wav?path=out/beep.wav', { method: 'PUT', body: new Uint8Array([82, 73, 70, 70]) });
    expect(res.status).toBe(200);
    expect([...(await readFile(join(dir, 'out', 'beep.wav')))]).toEqual([82, 73, 70, 70]);
    expect((await api('/api/wav?path=x.txt', { method: 'PUT', body: 'x' })).status).toBe(400);
  });

  it('sends a file event after a disk write, and an origin-tagged one for a PUT without a disk echo', async () => {
    const disk = await collect('file', () => writeFile(join(dir, 'beep.sfx.json'), JSON.stringify(patch('beep v2'))));
    expect(disk[0]).toMatchObject({ path: 'beep.sfx.json', origin: 'disk' });
    expect((disk[0] as { mtime: number }).mtime).toBeGreaterThan(0);

    const events = await collect(
      'file',
      async () => {
        await api('/api/file?path=beep.sfx.json&origin=human', { method: 'PUT', body: JSON.stringify(patch('by person')) });
        await new Promise((r) => setTimeout(r, 400));
      },
      2,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: 'beep.sfx.json', origin: 'human' });
  });

  it('broadcasts play and focus to open editors', async () => {
    const play = await collect('play', () => api('/api/play?path=beep.sfx.json', { method: 'POST' }));
    expect(play).toEqual([{ path: 'beep.sfx.json' }]);
    const focus = await collect('focus', () => api('/api/focus?path=beep.sfx.json&control=size', { method: 'POST' }));
    expect(focus).toEqual([{ path: 'beep.sfx.json', control: 'size' }]);
  });

  it('serves the editor with MIME types and falls back to index.html', async () => {
    const index = await api('/');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('editor');
    expect((await api('/assets/app.js')).headers.get('content-type')).toContain('text/javascript');
    expect(await (await api('/some/route')).text()).toContain('editor');
    expect((await api('/missing.js')).status).toBe(404);
    expect((await api(`/${encodeURIComponent('../etc/passwd')}`)).status).not.toBe(200);
  });

  it('only talks to its own pages and the dev server', async () => {
    expect((await api('/api/info', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const dev = await api('/api/info', { headers: { origin: 'http://localhost:5178' } });
    expect(dev.status).toBe(200);
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://localhost:5178');
  });

  it('shows a helpful page when the editor is not built', async () => {
    const bare = await startServer({ root: dir, port: 0, webDir: join(dir, 'no-such-dir'), log: () => {} });
    try {
      const text = await (await fetch(bare.url)).text();
      expect(text).toContain('npm run build:web');
    } finally {
      await bare.close();
    }
  });
});

describe('file workspace through the server', () => {
  it('play says how to open an editor when no sfxgen serve has this folder', async () => {
    const ws = new FileWorkspace(dir);
    const r = await callTool(ws, 'play', { file: 'beep.sfx.json' });
    expect(r).toMatchObject({ data: { played: false } });
    expect(r.text).toContain('sfxgen serve');
  });

  it('rejects refs that escape the root and diffs a person\'s edit', async () => {
    const ws = new FileWorkspace(dir);
    await expect(ws.getPatch('../outside.sfx.json')).rejects.toThrow(/outside/);
    await expect(ws.getPatch('/etc/passwd')).rejects.toThrow();
    await ws.setPatch(patch('mine'), { ref: 'mine.sfx.json' });
    expect(JSON.parse(await readFile(join(dir, 'mine.sfx.json'), 'utf8')).name).toBe('mine');
    const edited = patch('mine');
    edited.tracks[0].gain = -6;
    await writeFile(join(dir, 'mine.sfx.json'), JSON.stringify(edited));
    expect(await ws.getHumanChanges('mine.sfx.json')).toEqual([{ path: 'tracks.a.gain', before: undefined, after: -6 }]);
    expect(await ws.list()).toContain('mine.sfx.json');
  });
});
