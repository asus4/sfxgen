/** WAV encoding and decoding: 16 and 24-bit PCM and 32-bit float, mono or stereo. */

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

/**
 * Encodes channels as a WAV file. 16-bit output gets TPDF dither, so quiet tails fade into noise instead of
 * stepping into silence.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: 16 | 24 | 32 = 16): Uint8Array {
  const nCh = channels.length;
  const n = channels[0]?.length ?? 0;
  const bytes = bitDepth / 8;
  const dataSize = n * nCh * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * bytes, true);
  v.setUint16(32, nCh * bytes, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  // A fixed dither sequence keeps exports byte-identical between runs.
  let seed = 0x1234567;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = channels[c][i];
      if (bitDepth === 32) {
        v.setFloat32(off, Number.isFinite(s) ? s : 0, true);
      } else if (bitDepth === 24) {
        const x = Math.max(-8388608, Math.min(8388607, Math.round((Number.isFinite(s) ? s : 0) * 8388607)));
        v.setUint8(off, x & 0xff);
        v.setUint8(off + 1, (x >> 8) & 0xff);
        v.setUint8(off + 2, (x >> 16) & 0xff);
      } else {
        const d = rand() - rand();
        const x = Math.max(-32768, Math.min(32767, Math.round((Number.isFinite(s) ? s : 0) * 32767 + d)));
        v.setInt16(off, x, true);
      }
      off += bytes;
    }
  }
  return new Uint8Array(buf);
}

/** Decodes PCM (8/16/24/32-bit) or 32/64-bit float WAV. Throws on anything else. */
export function decodeWav(data: Uint8Array): DecodedWav {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let format = 0;
  let nCh = 0;
  let sr = 0;
  let bits = 0;
  while (off + 8 <= data.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      nCh = v.getUint16(body + 2, true);
      sr = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      if (!nCh) throw new Error('WAV data before format');
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, data.length - body) / (bytes * nCh));
      const channels = Array.from({ length: nCh }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < nCh; c++) {
          let s: number;
          if (format === 3 && bits === 32) s = v.getFloat32(p, true);
          else if (format === 3 && bits === 64) s = v.getFloat64(p, true);
          else if (bits === 16) s = v.getInt16(p, true) / 32768;
          else if (bits === 24) {
            let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
            if (x & 0x800000) x |= ~0xffffff;
            s = x / 8388608;
          } else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
          else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
          else throw new Error(`unsupported WAV bit depth ${bits}`);
          channels[c][i] = s;
          p += bytes;
        }
      }
      return { sampleRate: sr, channels };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
