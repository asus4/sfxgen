/** A tiny zip writer: files are stored, not compressed (WAVs barely compress), each with its CRC-32. */

let table: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, with `/` separators. */
  name: string;
  data: Uint8Array;
}

/** Keeps paths inside the archive: no drive letters, no leading slash, no `..`. */
export function safeZipName(name: string): string {
  const parts = name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..' && !/^[A-Za-z]:$/.test(p));
  return parts.join('/') || 'file';
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function makeZip(entries: ZipEntry[], date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, day } = dosTime(date);
  const seen = new Set<string>();
  const files = entries.map((e) => {
    // Two entries with one name would make an archive some tools refuse.
    let name = safeZipName(e.name);
    for (let i = 2; seen.has(name); i++) name = safeZipName(e.name).replace(/(\.[^./]*)?$/, `-${i}$1`);
    seen.add(name);
    return { name: enc.encode(name), data: e.data, crc: crc32(e.data) };
  });
  const size = files.reduce((n, f) => n + 30 + f.name.length + f.data.length + 46 + f.name.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  const header = (f: (typeof files)[number], central: boolean, offset: number) => {
    view.setUint32(at, central ? 0x02014b50 : 0x04034b50, true);
    at += 4;
    if (central) {
      view.setUint16(at, 20, true); // made by
      at += 2;
    }
    view.setUint16(at, 20, true); // version needed
    view.setUint16(at + 2, 0x0800, true); // UTF-8 names
    view.setUint16(at + 4, 0, true); // stored
    view.setUint16(at + 6, time, true);
    view.setUint16(at + 8, day, true);
    view.setUint32(at + 10, f.crc, true);
    view.setUint32(at + 14, f.data.length, true);
    view.setUint32(at + 18, f.data.length, true);
    view.setUint16(at + 22, f.name.length, true);
    view.setUint16(at + 24, 0, true); // extra
    at += 26;
    if (central) {
      // comment length, disk, internal attributes (2 each), external attributes (4), then the local header's offset.
      view.setUint32(at + 10, offset, true);
      at += 14;
    }
    out.set(f.name, at);
    at += f.name.length;
  };
  for (const f of files) {
    offsets.push(at);
    header(f, false, 0);
    out.set(f.data, at);
    at += f.data.length;
  }
  const centralStart = at;
  files.forEach((f, i) => header(f, true, offsets[i]));
  const centralSize = at - centralStart;
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
