/** The local editor server (`sfxgen serve`): files on disk, saved both ways. See docs/DESIGN.md. */
import { readReview as readReviewData, type Patch, type Project, type Review, type ReviewEntry } from '../core';
import type { ProjectBuildRow } from '../core/agent/workspace';

export interface ServeInfo {
  mode: 'serve';
  version?: string;
  root?: string;
}

export interface ServeFile {
  path: string;
  name: string;
  mtime?: number;
}

const q = (path: string) => encodeURIComponent(path);

/** The server's info, or null when the editor is on its own (static hosting, `npm run dev` alone). */
export async function detectServer(timeoutMs = 1500): Promise<ServeInfo | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch('api/info', { signal: ctl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const info = (await res.json()) as Partial<ServeInfo>;
    return info.mode === 'serve' ? (info as ServeInfo) : null;
  } catch {
    return null;
  }
}

export async function listFiles(): Promise<ServeFile[]> {
  const res = await fetch('api/files');
  if (!res.ok) throw new Error(`could not list files (${res.status})`);
  const body = (await res.json()) as { files?: ServeFile[] };
  return body.files ?? [];
}

export async function readFile(path: string): Promise<unknown> {
  const res = await fetch(`api/file?path=${q(path)}`);
  if (!res.ok) throw new Error(`could not open ${path} (${res.status})`);
  return res.json();
}

export async function writeFile(path: string, patch: Patch, origin: 'human' | 'agent' = 'human'): Promise<void> {
  const res = await fetch(`api/file?path=${q(path)}&origin=${origin}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch, null, 2),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { issues?: { path: string; message: string }[]; error?: string };
      detail = body.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ?? body.error ?? '';
    } catch {
      // No JSON body.
    }
    throw new Error(`could not save ${path} (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}

export async function writeWav(path: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`api/wav?path=${q(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav' },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  if (!res.ok) throw new Error(`could not write ${path} (${res.status})`);
}

export interface ServedProject {
  /** The project file, relative to the root (or where it would be written). */
  path: string | null;
  /** False: there is no project file; `project` lists the folder's patches. */
  saved: boolean;
  project: Project;
}

/** The server's project, or null when this server has no project routes (an older build). */
export async function readProject(): Promise<ServedProject | null> {
  const res = await fetch('api/project', { headers: { accept: 'application/json' } });
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  if (!res.ok) throw new Error(`could not read the project (${res.status})`);
  const body = (await res.json()) as Partial<ServedProject>;
  if (!body.project) return null;
  return { path: body.path ?? null, saved: body.saved !== false, project: body.project };
}

async function failure(res: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    type Issues = { path: string; message: string }[];
    const body = (await res.json()) as { issues?: Issues; errors?: Issues; error?: string };
    detail = (body.errors ?? body.issues)?.map((i) => `${i.path}: ${i.message}`).join('; ') || body.error || '';
  } catch {
    // No JSON body.
  }
  return new Error(`${what} (${res.status})${detail ? `: ${detail}` : ''}`);
}

export async function writeProject(project: Project, origin: 'human' | 'agent' = 'human'): Promise<{ path?: string }> {
  const res = await fetch(`api/project?origin=${origin}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(project, null, 2),
  });
  if (!res.ok) throw await failure(res, 'could not save the project');
  try {
    return (await res.json()) as { path?: string };
  } catch {
    return {};
  }
}

/** Asks the server to render the project's sounds to their export paths. Null: this server cannot build. */
export async function build(only?: string[]): Promise<ProjectBuildRow[] | null> {
  const res = await fetch('api/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(only ? { only } : {}) });
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw await failure(res, 'the build failed');
  const body = (await res.json()) as { rows?: ProjectBuildRow[]; built?: ProjectBuildRow[] } | ProjectBuildRow[];
  return Array.isArray(body) ? body : (body.rows ?? body.built ?? []);
}

/** Each sound's takes (`<name>.takes/*.sfx.json`), by the sound's file. Null when this server has no takes route. */
export async function listTakes(): Promise<Record<string, ServeFile[]> | null> {
  const res = await fetch('api/takes', { headers: { accept: 'application/json' } });
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  if (!res.ok) throw new Error(`could not list takes (${res.status})`);
  return ((await res.json()) as { takes?: Record<string, ServeFile[]> }).takes ?? {};
}

/** The folder's sfxgen.review.json (empty when there is none). Null when this server has no review route. */
export async function readReview(): Promise<Review | null> {
  const res = await fetch('api/review', { headers: { accept: 'application/json' } });
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  if (!res.ok) throw new Error(`could not read the review (${res.status})`);
  return readReviewData(((await res.json()) as { review?: unknown }).review);
}

/** Sets one sound's verdict (null clears it) and returns the whole review as now on disk. */
export async function writeVerdict(sound: string, entry: ReviewEntry | null): Promise<Review> {
  const res = await fetch('api/review?origin=human', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sound, entry }) });
  if (!res.ok) throw await failure(res, 'could not save the verdict');
  return readReviewData(((await res.json()) as { review?: unknown }).review);
}

export interface ServeEvents {
  project(e: { path?: string; mtime?: number; origin?: string }): void;
  file(e: { path: string; mtime?: number; origin?: string; deleted?: boolean }): void;
  review(e: { path?: string; origin?: string; sound?: string }): void;
  play(e: { path?: string }): void;
  focus(e: { path?: string; control?: string }): void;
}

/** Follows the server's events. Returns a function that stops. */
export function followEvents(handlers: ServeEvents): () => void {
  const source = new EventSource('api/events');
  const on = <K extends keyof ServeEvents>(name: K) =>
    source.addEventListener(name, (e) => {
      try {
        (handlers[name] as (data: unknown) => void)(JSON.parse((e as MessageEvent<string>).data || '{}'));
      } catch {
        // A malformed event is not worth breaking the stream for.
      }
    });
  on('file');
  on('project');
  on('review');
  on('play');
  on('focus');
  return () => source.close();
}
