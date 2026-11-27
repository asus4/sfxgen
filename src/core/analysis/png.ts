/**
 * A small PNG encoder for the spectrogram: 8-bit RGB (or RGBA when any pixel is translucent), one IDAT chunk,
 * adaptive per-row filters. It compresses with the global CompressionStream ('deflate' is the zlib format PNG
 * wants), which Node and browsers both have, so the same code runs in the CLI and the editor.
 * Without CompressionStream it falls back to stored (uncompressed) deflate blocks: larger, still valid.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, as PNG uses) of the bytes. */
export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream of stored blocks (no compression), for environments without CompressionStream. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(data);
  out[o++] = ad >>> 24;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return zlibStored(data);
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Scanlines, each prefixed with the filter (0-4) that gives the smallest sum of absolute signed bytes. */
function filterRows(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const upLeft = i >= bpp ? up[i - bpp] : 0;
        let v: number;
        switch (f) {
          case 0:
            v = row[i];
            break;
          case 1:
            v = row[i] - left;
            break;
          case 2:
            v = row[i] - up[i];
            break;
          case 3:
            v = row[i] - ((left + up[i]) >> 1);
            break;
          default:
            v = row[i] - paeth(left, up[i], upLeft);
        }
        v &= 0xff;
        c[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const o = y * (stride + 1);
    out[o] = best;
    out.set(candidates[best], o + 1);
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes RGBA pixels (row-major, top row first) as a PNG file. */
export async function encodePng(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0 && h > 0)) throw new Error(`encodePng: bad size ${width}x${height}`);
  if (rgba.length !== w * h * 4) throw new Error(`encodePng: expected ${w * h * 4} bytes of RGBA, got ${rgba.length}`);
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bpp = opaque ? 3 : 4;
  const stride = w * bpp;
  let raw: Uint8Array;
  if (opaque) {
    raw = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      raw[j] = rgba[i];
      raw[j + 1] = rgba[i + 1];
      raw[j + 2] = rgba[i + 2];
    }
  } else {
    raw = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB or RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const idat = await zlib(filterRows(raw, h, stride, bpp));
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
