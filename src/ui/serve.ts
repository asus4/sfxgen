/** The local editor server (`sfxgen serve`): files on disk, saved both ways. See docs/DESIGN.md. */
import type { Patch } from '../core';

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

export interface ServeEvents {
  file(e: { path: string; mtime?: number; origin?: string; deleted?: boolean }): void;
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
  on('play');
  on('focus');
  return () => source.close();
}
