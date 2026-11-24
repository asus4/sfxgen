/** Share links: the patch as JSON, deflate-compressed and base64url-encoded in the URL hash (`#p=...`). */
import type { Patch } from '../../core';

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // A damaged link fails on the readable side; the writer's own rejections would only be noise.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function encodePatchHash(patch: Patch): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(patch));
  return `p=${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

/** The patch in a URL hash, or null when the hash holds none. Throws on a damaged link. */
export async function decodePatchHash(hash: string): Promise<unknown | null> {
  const m = /(?:^|[#&])p=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  const bytes = await pipe(fromBase64Url(m[1]), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}
