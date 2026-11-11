// make_document: pictures from her own library or uploads, measured and (for PDF) prepared. JPEG
// goes into a PDF as it is (DCTDecode); PNG is unpacked with node:zlib and its rows unfiltered, so
// colour and transparency become two Flate images. GIF and WebP pictures go into Word, PowerPoint
// and HTML as they are; in a PDF they become their caption.
import { deflateSync, inflateSync } from 'node:zlib';
import type { Picture } from './spec.ts';

/** Width and height of a JPEG, PNG, GIF or WebP picture, or undefined. */
export function measure(bytes: Buffer): Picture | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return { mime: 'image/png', bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return { mime: 'image/gif', bytes, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = bytes.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') return { mime: 'image/webp', bytes, width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { mime: 'image/webp', bytes, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = bytes.readUInt32LE(21);
      return { mime: 'image/webp', bytes, width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return undefined;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: 'image/jpeg', bytes, width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return undefined;
}

/** JPEG colour components (1 grey, 3 RGB, 4 CMYK). */
export function jpegComponents(bytes: Buffer): number {
  let i = 2;
  while (i + 9 < bytes.length) {
    const marker = bytes[i + 1];
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return bytes[i + 9];
    i += 2 + len;
  }
  return 3;
}

export interface PdfImage {
  width: number;
  height: number;
  /** The image dictionary entries and stream for the colour image. */
  dict: string;
  data: Buffer;
  /** A soft mask (alpha), when the PNG has one. */
  mask?: { dict: string; data: Buffer };
}

/** A picture as PDF image objects, or undefined when PDF can't take it (GIF, WebP, odd PNGs). */
export function pdfImage(p: Picture): PdfImage | undefined {
  if (p.mime === 'image/jpeg') {
    const n = jpegComponents(p.bytes);
    const cs = n === 1 ? '/DeviceGray' : n === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    return { width: p.width, height: p.height, dict: `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${n === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''}`, data: p.bytes };
  }
  if (p.mime !== 'image/png') return undefined;
  return pngForPdf(p.bytes);
}

function pngForPdf(buf: Buffer): PdfImage | undefined {
  let i = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  const idat: Buffer[] = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const kind = buf.subarray(i + 4, i + 8).toString('latin1');
    const data = buf.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = Buffer.from(data);
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  if (!w || !h || interlace || w * h > 25_000_000) return undefined;
  const raw = Buffer.concat(idat);
  if ((type === 0 || type === 2 || type === 3) && depth <= 8) {
    const colors = type === 2 ? 3 : 1;
    const cs = type === 3 && palette ? `[/Indexed /DeviceRGB ${palette.length / 3 - 1} <${palette.toString('hex')}>]` : type === 2 ? '/DeviceRGB' : '/DeviceGray';
    return { width: w, height: h, dict: `/ColorSpace ${cs} /BitsPerComponent ${depth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${depth} /Columns ${w} >>`, data: raw };
  }
  if ((type !== 4 && type !== 6) || depth !== 8) return undefined;
  // Grey+alpha or RGBA, 8 bits: unfilter the rows, then split colour and alpha.
  const ch = type === 6 ? 4 : 2;
  const stride = w * ch;
  let px: Buffer;
  try {
    px = inflateSync(raw);
  } catch {
    return undefined;
  }
  if (px.length < h * (stride + 1)) return undefined;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = px[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0;
      const b = y ? out[dst - stride + x] : 0;
      const c = x >= ch && y ? out[dst - stride + x - ch] : 0;
      const v = px[src + x];
      let r: number;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + x] = r & 0xff;
    }
  }
  const colors = ch - 1;
  const color = Buffer.alloc(w * h * colors);
  const alpha = Buffer.alloc(w * h);
  for (let p = 0, c = 0; p < w * h; p++) {
    for (let k = 0; k < colors; k++) color[c++] = out[p * ch + k];
    alpha[p] = out[p * ch + colors];
  }
  return {
    width: w,
    height: h,
    dict: `/ColorSpace ${colors === 3 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode`,
    data: deflateSync(color),
    mask: { dict: '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', data: deflateSync(alpha) },
  };
}

/** The size to show a picture at (points), inside a box, never larger than its own 96-dpi size. */
export function fitSize(p: { width: number; height: number }, maxW: number, maxH: number): { w: number; h: number } {
  const w0 = Math.max(1, p.width * 0.75);
  const h0 = Math.max(1, p.height * 0.75);
  const s = Math.min(1, maxW / w0, maxH / h0);
  return { w: w0 * s, h: h0 * s };
}
