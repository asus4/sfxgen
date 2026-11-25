import { describe, expect, it } from 'vitest';
import type { Patch } from '../src/core';
import { decodePatchHash, encodePatchHash, fromBase64Url, jsonIn, toBase64Url } from '../src/ui/lib/share';

const patch: Patch = {
  format: 'sfxgen/1',
  name: 'Zap ⚡ “quoted”',
  description: 'A falling saw. '.repeat(20),
  duration: 'auto',
  seed: 7,
  tracks: [{ id: 'zap', source: { type: 'osc', wave: 'saw', freq: [[0, 2400], [0.25, 180]] } }],
  controls: [{ id: 'pitch', label: 'Pitch', value: 0.5, targets: [{ path: 'tracks.zap.source.freq', mode: 'mul', from: 0.4, to: 2.2 }] }],
};

describe('share links', () => {
  it('round-trips bytes through base64url', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37) % 256);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...fromBase64Url(text)]).toEqual([...bytes]);
    for (const n of [0, 1, 2, 3, 4]) expect(fromBase64Url(toBase64Url(bytes.subarray(0, n))).length).toBe(n);
  });

  it('round-trips a patch through the URL hash, compressed', async () => {
    const hash = await encodePatchHash(patch);
    expect(hash).toMatch(/^p=[A-Za-z0-9_-]+$/);
    expect(hash.length).toBeLessThan(JSON.stringify(patch).length);
    expect(await decodePatchHash(`#${hash}`)).toEqual(patch);
    expect(await decodePatchHash(`#x=1&${hash}`)).toEqual(patch);
  });

  it('returns null when the hash holds no patch and throws on a damaged one', async () => {
    expect(await decodePatchHash('')).toBeNull();
    expect(await decodePatchHash('#section')).toBeNull();
    await expect(decodePatchHash('#p=AAAA_not-deflate')).rejects.toThrow();
  });
});

describe('pasted patches', () => {
  const json = JSON.stringify(patch, null, 2);

  it('takes the patch out of a chat answer copied whole', () => {
    const answer = `Here is a falling zap:\n\n\`\`\`json\n${json}\n\`\`\`\n\nPaste it into the editor. {not this}`;
    expect(JSON.parse(jsonIn(answer)!)).toEqual(patch);
  });

  it('takes a bare object, or one with words around it', () => {
    expect(JSON.parse(jsonIn(json)!)).toEqual(patch);
    expect(JSON.parse(jsonIn(`the patch: ${json} enjoy`)!)).toEqual(patch);
    expect(JSON.parse(jsonIn(`\`\`\`\r\n${json}\r\n\`\`\``)!)).toEqual(patch);
  });

  it('finds nothing in plain text', () => {
    expect(jsonIn('hello there')).toBeNull();
    expect(jsonIn('} backwards {')).toBeNull();
  });
});
