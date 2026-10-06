/**
 * Header-level checks on data-URI images so a truncated or mislabeled logo
 * upload is skipped instead of taking the PDF or deck down with it.
 */

/**
 * Intrinsic pixel (or unit) dimensions of a data-URI image — PNG, JPEG, GIF,
 * WEBP (VP8/VP8L/VP8X) and SVG (width/height attrs or viewBox). Returns
 * undefined when the format can't be read; callers then fall back to the raw box.
 */
export function imageDims(dataUri: string): { w: number; h: number } | undefined {
  const m = dataUri.match(/^data:image\/([a-z+.-]+);base64,(.*)$/i);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase();
  const buf = Buffer.from(m[2]!, 'base64');
  try {
    if (kind === 'svg+xml') {
      const svg = buf.toString('utf8');
      const attr = (name: string) => {
        const a = svg.match(new RegExp(`<svg[^>]*\\b${name}="([0-9.]+)(?:px)?"`, 'i'));
        return a ? Number(a[1]) : undefined;
      };
      const w = attr('width');
      const h = attr('height');
      if (w && h) return { w, h };
      const vb = svg.match(/<svg[^>]*\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i);
      if (vb) return { w: Number(vb[1]), h: Number(vb[2]) };
      return undefined;
    }
    if (kind === 'png' && buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if ((kind === 'jpeg' || kind === 'jpg') && buf[0] === 0xff && buf[1] === 0xd8) {
      // Walk JPEG segments to a SOFn marker carrying the frame size.
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1]!;
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return undefined;
    }
    if (kind === 'gif' && buf.length >= 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (kind === 'webp' && buf.length >= 30 && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
      }
      if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * True when a PNG or JPEG data URI is complete enough for pdfmake/pdfkit to
 * decode: the declared type matches the magic bytes, the header yields
 * dimensions, and the file carries its terminator (IEND / FFD9), which a
 * truncated upload never does.
 */
export function isRenderableRaster(dataUri: string): boolean {
  const m = dataUri.match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return false;
  const kind = m[1]!.toLowerCase();
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2]!, 'base64');
  } catch {
    return false;
  }
  if (buf.length < 64) return false;
  if (!imageDims(dataUri)) return false;
  if (kind === 'png') {
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
    // The IEND chunk type sits 8 bytes from the end (type + CRC).
    return buf.subarray(buf.length - 8, buf.length - 4).toString('ascii') === 'IEND';
  }
  // JPEG: SOI at the start, EOI at the end.
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}
