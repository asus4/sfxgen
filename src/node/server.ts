/**
 * `sfxgen serve`: hosts the built editor and a small API over the `*.sfx.json` files under a directory, so a
 * person edits the same files an agent writes. Node `http` only; bound to 127.0.0.1.
 *
 * API (docs/DESIGN.md): GET /api/info, /api/files, /api/file?path=, PUT /api/file?path=&origin=, PUT /api/wav?path=,
 * GET|PUT /api/project, POST /api/build, GET /api/takes, GET|PUT /api/review, POST /api/play?path=,
 * POST /api/focus?path=&control=, GET /api/events (server-sent events).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Project } from '../core/project/project';
import { formatJson } from '../core/format/json';
import { validatePatch } from '../core/format/validate';
import { validateProject } from '../core/project/project';
import { FileWorkspace, PATCH_EXT, listPatchFiles, listTakes } from './file-workspace';
import { validateReviewEntry, type ReviewEntry } from '../core/project/review';
import pkg from '../../package.json';

export interface ServerOptions {
  /** Directory whose *.sfx.json files the editor may open and save. */
  root: string;
  port: number;
  /** Open the editor in the default browser. */
  open?: boolean;
  /** Built editor to serve (default: dist/web next to the CLI). */
  webDir?: string;
  /** Patch to open first, relative to root. */
  file?: string;
  /** Where messages go (default console.log). */
  log?: (message: string) => void;
  /** Host to bind. Default 127.0.0.1; leave it. */
  host?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  root: string;
  /** Open editor pages listening for events. */
  clientCount(): number;
  /** Sends a server-sent event to every open editor. */
  broadcast(event: string, data: unknown): void;
  close(): Promise<void>;
}

const DEV_ORIGIN = 'http://localhost:5178';
const IGNORED = new Set(['node_modules', '.git', 'dist']);
const MAX_JSON = 8 * 1024 * 1024;
const MAX_WAV = 128 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function findWebDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/node/cli.js -> dist/web; src/node/server.ts -> <repo>/dist/web
  for (const candidate of [join(here, '..', 'web'), join(here, '..', '..', 'dist', 'web')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return join(here, '..', '..', 'dist', 'web');
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL was printed; the person can open it */
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `Request body is larger than ${Math.round(limit / 1048576)} MB.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const MISSING_PAGE = `<!doctype html><meta charset="utf-8"><title>sfxgen</title>
<body style="font:16px/1.5 system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">
<h1>The editor is not built yet</h1>
<p>The sfxgen server is running, but there is no built editor to show.</p>
<p>Run <code>npm run build:web</code> in the sfxgen folder, then reload this page.
For development, run <code>npm run dev</code> and open <a href="http://localhost:5178">localhost:5178</a>.</p>
<p>The API is working: <a href="/api/info">/api/info</a>, <a href="/api/files">/api/files</a>.</p></body>`;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const root = resolve(opts.root);
  const stats = await stat(root).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`${root} is not a directory.`);
  const ws = new FileWorkspace(root);
  const webDir = findWebDir(opts.webDir);
  const host = opts.host ?? '127.0.0.1';

  // ---- Events -----------------------------------------------------------------------------
  const clients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };

  // The last content seen for each file, so a PUT from the editor is not announced again as a disk change.
  const known = new Map<string, string>();
  const pending = new Map<string, NodeJS.Timeout>();

  const eventFor = (path: string) => (path === ws.projectFile ? 'project' : path === ws.reviewFile ? 'review' : 'file');

  async function onDiskChange(path: string): Promise<void> {
    let text: string;
    let mtime = 0;
    try {
      text = await readFile(join(root, ...path.split('/')), 'utf8');
      mtime = Math.round((await stat(join(root, ...path.split('/')))).mtimeMs);
    } catch {
      known.delete(path);
      broadcast(eventFor(path), { path, mtime: 0, origin: 'disk', deleted: true });
      return;
    }
    if (known.get(path) === text) return;
    known.set(path, text);
    broadcast(eventFor(path), { path, mtime, origin: 'disk' });
  }

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const parts = filename.toString().split(sep);
      if (parts.some((p) => IGNORED.has(p))) return;
      const path = parts.join('/');
      if (!path.endsWith(PATCH_EXT) && path !== ws.projectFile && path !== ws.reviewFile) return;
      clearTimeout(pending.get(path));
      pending.set(
        path,
        setTimeout(() => {
          pending.delete(path);
          void onDiskChange(path);
        }, 80),
      );
    });
    watcher.on('error', () => {});
  } catch (err) {
    log(`Watching ${root} for changes is not available (${(err as Error).message}); the editor will not see edits made outside it.`);
  }

  // ---- Requests ---------------------------------------------------------------------------
  let boundPort = opts.port;
  const ownOrigins = (): string[] => [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, DEV_ORIGIN];

  function rel(url: URL): string {
    const p = url.searchParams.get('path');
    if (!p) throw new HttpError(400, 'Missing ?path=.');
    try {
      return ws.confine(p);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = url.pathname.slice('/api'.length);
    const method = req.method ?? 'GET';

    if (route === '/info' && method === 'GET') {
      return sendJson(res, 200, { mode: 'serve', version: pkg.version, root });
    }
    if (route === '/files' && method === 'GET') {
      return sendJson(res, 200, { files: await listPatchFiles(root) });
    }
    if (route === '/file' && method === 'GET') {
      const path = rel(url);
      if (!path.endsWith(PATCH_EXT)) throw new HttpError(400, `Only ${PATCH_EXT} files are served.`);
      let text: string;
      try {
        text = await readFile(ws.absolute(path), 'utf8');
      } catch {
        throw new HttpError(404, `No patch file ${path}.`);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(text);
    }
    if (route === '/file' && method === 'PUT') {
      const path = rel(url);
      if (!path.endsWith(PATCH_EXT)) throw new HttpError(400, `Patch files end in ${PATCH_EXT}.`);
      const origin = url.searchParams.get('origin') === 'agent' ? 'agent' : 'human';
      let patch: unknown;
      try {
        patch = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `The body is not valid JSON: ${(err as Error).message}`);
      }
      const v = validatePatch(patch);
      if (!v.ok) return sendJson(res, 422, { error: 'The patch has errors; nothing was written.', errors: v.errors, warnings: v.warnings });
      const text = formatJson(patch);
      const abs = ws.absolute(path);
      await mkdir(dirname(abs), { recursive: true });
      known.set(path, text);
      await writeFile(abs, text);
      const mtime = Math.round((await stat(abs)).mtimeMs);
      broadcast('file', { path, mtime, origin });
      return sendJson(res, 200, { path, mtime, warnings: v.warnings });
    }
    if (route === '/wav' && method === 'PUT') {
      const path = rel(url);
      if (!path.endsWith('.wav')) throw new HttpError(400, 'WAV paths end in .wav.');
      const body = await readBody(req, MAX_WAV);
      const abs = ws.absolute(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body);
      return sendJson(res, 200, { path, bytes: body.length });
    }
    if (route === '/project' && method === 'GET') {
      const got = await ws.getProject();
      return sendJson(res, 200, { path: got?.path ?? ws.projectFile, saved: got?.saved ?? false, project: got?.project ?? null });
    }
    if (route === '/project' && method === 'PUT') {
      const origin = url.searchParams.get('origin') === 'agent' ? 'agent' : 'human';
      let project: unknown;
      try {
        project = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `The body is not valid JSON: ${(err as Error).message}`);
      }
      const v = validateProject(project);
      if (!v.ok) return sendJson(res, 422, { error: 'The project has errors; nothing was written.', errors: v.errors, warnings: v.warnings });
      known.set(ws.projectFile, formatJson(project));
      try {
        await ws.setProject(project as Project, { origin });
      } catch (err) {
        known.delete(ws.projectFile);
        return sendJson(res, 422, { error: (err as Error).message, errors: [{ path: 'sounds', message: (err as Error).message }], warnings: [] });
      }
      const mtime = Math.round((await stat(ws.projectPath)).mtimeMs);
      broadcast('project', { path: ws.projectFile, mtime, origin });
      return sendJson(res, 200, { path: ws.projectFile, mtime, warnings: v.warnings });
    }
    if (route === '/takes' && method === 'GET') {
      return sendJson(res, 200, { takes: await listTakes(root) });
    }
    if (route === '/review' && method === 'GET') {
      return sendJson(res, 200, { path: ws.reviewFile, review: await ws.readReviewFile() });
    }
    if (route === '/review' && method === 'PUT') {
      // One sound's verdict at a time, merged into the file here, so the editor and an agent's reads don't clash.
      const origin = url.searchParams.get('origin') === 'agent' ? 'agent' : 'human';
      let body: { sound?: unknown; entry?: unknown };
      try {
        body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')) as typeof body;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `The body is not valid JSON: ${(err as Error).message}`);
      }
      if (typeof body?.sound !== 'string' || !body.sound) throw new HttpError(400, 'Expected { sound, entry }: the sound\'s file (or name) and its verdict, or null to clear it.');
      const issues = body.entry === null ? [] : validateReviewEntry(body.entry);
      if (issues.length) return sendJson(res, 422, { error: 'The verdict has errors; nothing was written.', errors: issues, warnings: [] });
      const { review, text } = await ws.setVerdict(body.sound, (body.entry ?? null) as ReviewEntry | null);
      known.set(ws.reviewFile, text);
      broadcast('review', { path: ws.reviewFile, origin, sound: body.sound });
      return sendJson(res, 200, { path: ws.reviewFile, review });
    }
    if (route === '/build' && method === 'POST') {
      let only: string[] | undefined;
      const raw = (await readBody(req, MAX_JSON)).toString('utf8').trim();
      if (raw) {
        try {
          const body = JSON.parse(raw) as { only?: unknown };
          if (body.only !== undefined) {
            if (!Array.isArray(body.only) || body.only.some((n) => typeof n !== 'string')) throw new HttpError(400, '`only` is a list of sound names.');
            only = body.only as string[];
          }
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, `The body is not valid JSON: ${(err as Error).message}`);
        }
      }
      try {
        return sendJson(res, 200, { rows: await ws.buildProject({ only }) });
      } catch (err) {
        throw new HttpError(422, (err as Error).message);
      }
    }
    if (route === '/play' && method === 'POST') {
      const path = rel(url);
      broadcast('play', { path });
      return sendJson(res, 200, { path, clients: clients.size });
    }
    if (route === '/focus' && method === 'POST') {
      const path = rel(url);
      broadcast('focus', { path, control: url.searchParams.get('control') ?? undefined });
      return sendJson(res, 200, { path, clients: clients.size });
    }
    if (route === '/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n: connected\n\n');
      clients.add(res);
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(beat);
        clients.delete(res);
      });
      return;
    }
    throw new HttpError(404, `No such API route: ${method} ${url.pathname}.`);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    const indexPath = join(webDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(MISSING_PAGE);
    }
    let file = normalize(join(webDir, pathname));
    if (file !== webDir && !file.startsWith(webDir + sep)) throw new HttpError(403, 'Forbidden.');
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) {
      // A request for a file with an extension is a real miss; anything else is the app's own route.
      if (extname(pathname)) throw new HttpError(404, 'Not found.');
      file = indexPath;
      info = await stat(file);
    }
    const ext = extname(file).toLowerCase();
    const immutable = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return void res.end();
    res.end(await readFile(file));
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // Only a page served from here (or the Vite dev server) may talk to the API: no DNS rebinding, no other sites.
        const hostName = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (hostName !== '127.0.0.1' && hostName !== 'localhost' && hostName !== '[::1]') throw new HttpError(403, 'Forbidden host.');
        const origin = req.headers.origin;
        if (url.pathname.startsWith('/api/')) {
          if (origin) {
            if (!ownOrigins().includes(origin)) throw new HttpError(403, 'Forbidden origin.');
            if (origin === DEV_ORIGIN) {
              res.setHeader('access-control-allow-origin', DEV_ORIGIN);
              res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
              res.setHeader('access-control-allow-headers', 'content-type');
              res.setHeader('vary', 'origin');
            }
          }
          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return void res.end();
          }
          return await api(req, res, url);
        }
        return await serveStatic(req, res, url);
      } catch (err) {
        if (res.headersSent) return void res.end();
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      fail(err.code === 'EADDRINUSE' ? new Error(`Port ${opts.port} is already in use. Pick another with --port, or use 0 for any free port.`) : err);
    });
    server.listen(opts.port, host, ok);
  });
  boundPort = (server.address() as AddressInfo).port;
  const base = `http://${host}:${boundPort}`;
  const url = opts.file ? `${base}/?file=${encodeURIComponent(opts.file)}` : `${base}/`;
  const proj = await ws.getProject().catch(() => null);
  log(`sfxgen editor: ${url}\n  patch files: ${root}\n  ${proj?.saved ? `project: ${proj.project.name} (${ws.projectFile}, ${proj.project.sounds.length} sound${proj.project.sounds.length === 1 ? '' : 's'})` : `no project file (${ws.projectFile}); create one with \`sfxgen project init\` or from the editor`}`);
  if (!existsSync(join(webDir, 'index.html'))) log('  (the editor is not built: run `npm run build:web`; the API still works)');
  if (opts.open) openBrowser(url);

  return {
    url,
    port: boundPort,
    root,
    clientCount: () => clients.size,
    broadcast,
    async close() {
      watcher?.close();
      for (const t of pending.values()) clearTimeout(t);
      for (const c of clients) c.end();
      clients.clear();
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
    },
  };
}
