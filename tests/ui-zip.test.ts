import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, makeZip, safeZipName } from '../src/ui/lib/zip';

const text = (s: string) => new TextEncoder().encode(s);

/** Reads a zip back by its central directory, the way an unzip tool does. */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  expect(at + view.getUint32(end + 12, true)).toBe(end);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(dataAt, dataAt + size);
    out.push({ name, crc, data: method === 0 ? raw : new Uint8Array(inflateRawSync(raw)) });
    at += 46 + nameLen;
  }
  return out;
}

describe('zip writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes an archive that reads back, entry for entry', () => {
    const big = new Uint8Array(70000).map((_, i) => (i * 31) % 251);
    const zip = makeZip([
      { name: 'out/Sword_Hit.wav', data: big },
      { name: 'out/ui/クリック.wav', data: text('click') },
      { name: 'empty.wav', data: new Uint8Array(0) },
    ]);
    expect(String.fromCharCode(zip[0], zip[1])).toBe('PK');
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(['out/Sword_Hit.wav', 'out/ui/クリック.wav', 'empty.wav']);
    expect([...files[0].data]).toEqual([...big]);
    expect(new TextDecoder().decode(files[1].data)).toBe('click');
    for (const f of files) expect(f.crc).toBe(crc32(f.data));
  });

  it('keeps names inside the archive and unique', () => {
    expect(safeZipName('../../Assets/Audio/a.wav')).toBe('Assets/Audio/a.wav');
    expect(safeZipName('/abs/b.wav')).toBe('abs/b.wav');
    expect(safeZipName('C:\\x\\c.wav')).toBe('x/c.wav');
    expect(safeZipName('..')).toBe('file');
    const names = readZip(makeZip([{ name: 'a.wav', data: text('1') }, { name: './a.wav', data: text('2') }, { name: 'a.wav', data: text('3') }])).map((f) => f.name);
    expect(names).toEqual(['a.wav', 'a-2.wav', 'a-3.wav']);
  });
});
